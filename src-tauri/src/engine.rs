//! Xray-core subprocess integration, local WinINet proxy lifecycle and HTTP real-delay.
//! The app does NOT claim success until an HTTPS 204 response travels through Xray.
//! The external Xray binary must be installed locally or explicitly provided via
//! SIMPLERAY_XRAY_PATH; no unverified binaries are downloaded or committed.
use serde::Serialize;
use serde_json::{json,Value};
use std::{fs,net::TcpListener,path::PathBuf,time::{Duration,Instant}};
use tauri::{AppHandle,Manager};
use tempfile::TempDir;
use tokio::{net::TcpStream,process::{Child,Command},sync::{Mutex,Semaphore},task::JoinSet,time::{sleep,timeout}};
use crate::system_proxy::{self,ProxyBackup};
use crate::switching::{self, HealthStatus, Monitor, Profile, SwitchDecision, SwitchMode, SwitchReason};

const PROBE_URL:&str="https://www.gstatic.com/generate_204";
const MAX_PROFILE_BYTES:usize=32768;
const STARTUP_TIMEOUT:Duration=Duration::from_secs(7);
const PROBE_TIMEOUT:Duration=Duration::from_secs(9);

#[derive(Debug,Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ConnectionStatus {
    pub state:String,
    pub server_id:Option<String>,
    pub system_proxy:bool,
    pub download_bps:f64,
    pub upload_bps:f64,
    pub traffic_available:bool,
    pub initial_latency_ms:Option<u64>,
    pub error:Option<String>,
    pub health:HealthStatus,
}
impl ConnectionStatus {
    fn off(error:Option<String>)->Self{Self{state:"disconnected".into(),server_id:None,system_proxy:false,download_bps:0.,upload_bps:0.,traffic_available:false,initial_latency_ms:None,error,health:HealthStatus::default()}}
}
#[derive(Debug,Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct LatencyResult {
    pub average_ms:Option<u64>,
    pub successful:u8,
    pub attempted:u8,
    pub samples_ms:Vec<u64>,
    pub reason:Option<String>,
}
struct StartedXray {
    child:Child,
    _temp_dir:TempDir,
    proxy_port:u16,
    api_port:Option<u16>,
}
struct Active {
    core:StartedXray,
    server_id:String,
    backup:ProxyBackup,
    last_poll:Instant,
    download_bps:f64,
    upload_bps:f64,
    traffic_available:bool,
    system_proxy:bool,
    initial_latency_ms:u64,
}
#[derive(Default)]
struct EngineRuntime {
    active: Option<Active>,
    last_error: Option<String>,
    monitor: Monitor,
    generation: u64,
    pending: bool,
}

pub struct EngineManager {
    runtime: Mutex<EngineRuntime>,
    active_probe: Mutex<()>,
    candidate_probes: Semaphore,
}

impl Default for EngineManager {
    fn default() -> Self {
        Self { runtime: Mutex::default(), active_probe: Mutex::default(), candidate_probes: Semaphore::new(4) }
    }
}

enum ConnectionChange {
    Manual,
    Suggested(SwitchDecision),
    Automatic(SwitchDecision),
    Undo,
}

struct SwitchRound {
    revision: u64,
    generation: u64,
    candidates: Vec<Profile>,
}

fn locate_xray(app:&AppHandle)->Result<PathBuf,String>{
    if let Some(path)=std::env::var_os("SIMPLERAY_XRAY_PATH") {
        let p=PathBuf::from(path);
        if p.is_absolute()&&p.is_file(){return Ok(p)}
        return Err("SIMPLERAY_XRAY_PATH must point to an existing absolute Xray executable".into())
    }
    // Bundled resources are resolved via Tauri, not guessed relative to cwd.
    if let Ok(resources)=app.path().resource_dir() {
        let staged=resources.join("binaries").join("xray.exe");
        if staged.is_file(){return Ok(staged)}
    }
    let current=std::env::current_exe().map_err(|_|"Cannot find application executable")?;
    let dir=current.parent().ok_or("Cannot locate executable directory")?;
    for p in [dir.join("xray.exe"),dir.join("resources").join("xray.exe"),dir.join("binaries").join("xray.exe"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join("xray.exe")] {
        if p.is_file(){return Ok(p)}
    }
    Err("Xray-core executable not installed. Place xray.exe beside SimpleRay or set SIMPLERAY_XRAY_PATH".into())
}
fn pick_port()->Result<u16,String>{
    let listener=TcpListener::bind("127.0.0.1:0").map_err(|_|"Could not allocate local proxy port")?;
    Ok(listener.local_addr().map_err(|_|"Could not inspect local port")?.port())
}
fn validate_outbound(outbound:&Value)->Result<(),String>{
    let data=serde_json::to_vec(outbound).map_err(|_|"Invalid outbound JSON")?;
    if data.len()>MAX_PROFILE_BYTES{return Err("Outbound configuration exceeds size limit".into())}
    let obj=outbound.as_object().ok_or("Outbound must be an object")?;
    if obj.len()>4||obj.keys().any(|key|!matches!(key.as_str(),"tag"|"protocol"|"settings"|"streamSettings")){
        return Err("Unexpected outbound fields".into())
    }
    if obj.get("tag").and_then(Value::as_str)!=Some("proxy") {return Err("Outbound tag must be proxy".into())}
    if !matches!(obj.get("protocol").and_then(Value::as_str),Some("vmess"|"vless"|"trojan"|"shadowsocks")){
        return Err("Unsupported outbound protocol".into())
    }
    if !obj.get("settings").is_some_and(Value::is_object){return Err("Missing outbound settings".into())}
    if obj.get("streamSettings").is_some_and(|v|!v.is_object()){return Err("Invalid transport settings".into())}
    Ok(())
}
fn xray_config(outbound:Value,proxy_port:u16,api_port:Option<u16>)->Value{
    let mut inbounds=vec![json!({"tag":"proxy-in","listen":"127.0.0.1","port":proxy_port,"protocol":"http","settings":{"timeout":60}})];
    let mut cfg=json!({"log":{"loglevel":"warning"},"inbounds":[],"outbounds":[outbound]});
    if let Some(port)=api_port{
        // Xray's gRPC API uses a loopback dokodemo-door inbound routed to
        // the synthetic API outbound. The API object does NOT have a `listen` key.
        inbounds.push(json!({"tag":"api-in","listen":"127.0.0.1","port":port,
            "protocol":"dokodemo-door","settings":{"address":"127.0.0.1"}}));
        cfg["api"]=json!({"tag":"api","services":["StatsService"]});
        cfg["routing"]=json!({"rules":[{"type":"field","inboundTag":["api-in"],"outboundTag":"api"}]});
        cfg["stats"]=json!({});
        cfg["policy"]=json!({"system":{"statsInboundUplink":true,"statsInboundDownlink":true}});
    }
    cfg["inbounds"]=json!(inbounds);cfg
}
fn user_data_dir(app:&AppHandle)->Result<PathBuf,String>{
    let path=app.path().app_local_data_dir().map_err(|_|"Application data directory unavailable")?;
    fs::create_dir_all(&path).map_err(|_|"Could not create local app folder")?;
    Ok(path)
}
async fn start_xray(app:&AppHandle,outbound:Value,stats:bool)->Result<StartedXray,String>{
    validate_outbound(&outbound)?;
    let bin=locate_xray(app)?;
    let proxy_port=pick_port()?;
    let api_port=if stats{let mut p=pick_port()?;while p==proxy_port{p=pick_port()?}Some(p)}else{None};
    let dir=tempfile::Builder::new().prefix("simpleray-run-").tempdir_in(user_data_dir(app)?)
        .map_err(|_|"Could not create temporary runtime directory")?;
    let config_path=dir.path().join("config.json");
    let config=xray_config(outbound,proxy_port,api_port);
    fs::write(&config_path,serde_json::to_vec(&config).map_err(|_|"Could not serialize runtime configuration")?)
        .map_err(|_|"Could not save Xray runtime configuration")?;
    // Core checks generated config before any process is started.
    let mut check=Command::new(&bin);
    #[cfg(target_os="windows")]
    check.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    // The official Xray ZIP includes geoip/geosite datasets alongside xray.exe.
    // Point Xray at the bundled resource directory on Windows NSIS installs.
    let assets=bin.parent().ok_or("Cannot locate Xray assets")?;
    check.env("XRAY_LOCATION_ASSET",assets);
    check.args(["run","-test","-config"]).arg(&config_path)
        .kill_on_drop(true).stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let check=timeout(Duration::from_secs(8),check.status()).await
        .map_err(|_|"Xray configuration validation timed out")?
        .map_err(|_|"Unable to execute Xray-core")?;
    if !check.success(){return Err("Xray rejected this profile (protocol or transport configuration)".into())}
    let mut command=Command::new(&bin);
    #[cfg(target_os="windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command.env("XRAY_LOCATION_ASSET",assets);
    command.args(["run","-config"]).arg(&config_path)
        .kill_on_drop(true).stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let mut child=command.spawn().map_err(|_|"Could not start Xray-core")?;
    let start=Instant::now();
    loop{
        if let Some(_status)=child.try_wait().map_err(|_|"Could not check Xray process")?{
            return Err("Xray exited before its HTTP proxy became ready".into());
        }
        if TcpStream::connect(("127.0.0.1",proxy_port)).await.is_ok(){break}
        if start.elapsed()>=STARTUP_TIMEOUT{
            let _=child.start_kill();
            return Err("Timed out waiting for the local Xray HTTP proxy".into());
        }
        sleep(Duration::from_millis(120)).await;
    }
    Ok(StartedXray{child,_temp_dir:dir,proxy_port,api_port})
}
async fn probe_once(port:u16)->Result<u64,String>{
    let proxy=reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
        .map_err(|_|"Cannot configure local HTTP proxy probe")?;
    let client=reqwest::Client::builder().proxy(proxy).timeout(PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none()).pool_max_idle_per_host(0)
        .build().map_err(|_|"Could not create HTTP probe")?;
    let start=Instant::now();
    let response=client.get(PROBE_URL).header(reqwest::header::CONNECTION,"close").send().await
        .map_err(|error|if error.is_timeout(){"Proxy request timed out"}else{"Proxy request failed"})?;
    if response.status()!=reqwest::StatusCode::NO_CONTENT{
        return Err("Proxy probe did not return HTTP 204".into())
    }
    Ok(start.elapsed().as_millis().max(1).min(u64::MAX as u128) as u64)
}
async fn kill(mut core:StartedXray){
    let _=core.child.kill().await;
    // TempDir drops here, removing per-session config containing credentials.
}
impl EngineManager {
    pub async fn connect(&self,app:&AppHandle,server_id:String,outbound:Value)->Result<ConnectionStatus,String>{
        if server_id.is_empty()||server_id.len()>256{return Err("Invalid selected server ID".into())}
        self.change_connection(app,Profile{server_id,outbound},ConnectionChange::Manual,None).await
    }

    async fn change_connection(
        &self, app: &AppHandle, profile: Profile, change: ConnectionChange, expected: Option<(u64, u64)>
    ) -> Result<ConnectionStatus, String> {
        let generation = {
            let mut runtime = self.runtime.lock().await;
            if expected.is_some_and(|(generation, revision)| {
                runtime.pending || runtime.generation != generation || runtime.monitor.revision != revision
            }) { return Err("The connection or switch settings changed".into()); }
            if runtime.active.as_ref().is_some_and(|active| active.server_id==profile.server_id) {
                return self.snapshot_locked(&runtime);
            }
            runtime.generation = runtime.generation.wrapping_add(1);
            runtime.pending = true;
            runtime.monitor.checking = false;
            runtime.monitor.suggestion = None;
            runtime.generation
        };
        let prepared = Self::prepare_connection(app,profile.outbound.clone()).await;
        let mut runtime = self.runtime.lock().await;
        if runtime.generation != generation { return Err("The connection request was superseded".into()); }
        runtime.pending = false;
        let result = async {
            let (new_core, initial_latency_ms) = prepared?;
            if expected.is_some_and(|(_, revision)| runtime.monitor.revision != revision) {
                return Err("The switch settings changed".into());
            }
            if let ConnectionChange::Suggested(decision) | ConnectionChange::Automatic(decision) = &change {
                let valid = match decision.reason {
                    SwitchReason::Recovery => runtime.monitor.failures >= 2 || runtime.active.is_none(),
                    SwitchReason::LowerLatency => runtime.monitor.failures < 2
                        && switching::qualifies(runtime.monitor.live.estimate(), Some(initial_latency_ms)),
                };
                if !valid { return Err("The latest test no longer qualifies for switching".into()); }
            }
            let backup=if let Some(active)=runtime.active.as_ref() {
                let mut snapshot=active.backup.clone();
                system_proxy::switch(app,&mut snapshot,active.core.proxy_port,new_core.proxy_port)?;
                snapshot
            } else {
                system_proxy::enable(app,new_core.proxy_port)?
            };
            if let Some(old)=runtime.active.take(){kill(old.core).await;}
            let previous = runtime.monitor.wanted.clone();
            let now=Instant::now();
            runtime.active=Some(Active{
                core:new_core,server_id:profile.server_id.clone(),backup,last_poll:now,
                download_bps:0.,upload_bps:0.,traffic_available:false,system_proxy:true,initial_latency_ms,
            });
            runtime.last_error=None;
            runtime.monitor.reset_session(Some(profile),Some(initial_latency_ms),now);
            if !matches!(change, ConnectionChange::Manual) {
                runtime.monitor.cooldown=Some(now+switching::SWITCH_COOLDOWN);
            }
            if let ConnectionChange::Automatic(decision) = change {
                runtime.monitor.switched=Some((decision,now+switching::UNDO_WINDOW));
                runtime.monitor.undo=previous.map(|profile|(profile,now+switching::UNDO_WINDOW));
            }
            self.snapshot_locked(&runtime)
        }.await;
        if result.is_err() && expected.is_some_and(|(_, revision)| runtime.monitor.revision == revision) {
            runtime.monitor.retry_later(Instant::now());
        }
        result
    }

    async fn prepare_connection(app:&AppHandle,outbound:Value)->Result<(StartedXray,u64),String>{
        let new_core=start_xray(app,outbound,true).await?;
        match probe_once(new_core.proxy_port).await {
            Ok(ms)=>Ok((new_core,ms)),
            Err(error)=>{
                kill(new_core).await;
                Err(format!("Connection verification failed: {error}"))
            }
        }
    }

    pub async fn configure_switching(&self,mode:SwitchMode,candidates:Vec<Profile>)->Result<(),String>{
        if candidates.len()>switching::MAX_CANDIDATES+1 {return Err("Too many monitored profiles".into());}
        for candidate in &candidates {
            if candidate.server_id.is_empty() || candidate.server_id.len()>256 {return Err("Invalid monitored profile".into());}
            validate_outbound(&candidate.outbound)?;
        }
        let mut runtime=self.runtime.lock().await;
        if runtime.monitor.mode!=mode || runtime.monitor.candidates!=candidates {
            runtime.monitor.mode=mode;
            runtime.monitor.candidates=candidates;
            runtime.monitor.reset_candidates(Instant::now());
        }
        Ok(())
    }

    pub async fn accept_switch(&self,app:&AppHandle,server_id:&str)->Result<ConnectionStatus,String>{
        let (profile,decision,version) = {
            let runtime=self.runtime.lock().await;
            let (decision, _) = runtime.monitor.suggestion.as_ref().filter(|(decision,expires)| {
                runtime.monitor.mode==SwitchMode::Suggest && decision.server_id==server_id && Instant::now()<*expires
            }).ok_or("That suggestion has expired")?;
            let profile=runtime.monitor.candidates.iter().find(|p|p.server_id==server_id).cloned()
                .ok_or("That server is no longer selected for monitoring")?;
            (profile,decision.clone(),(runtime.generation,runtime.monitor.revision))
        };
        self.change_connection(app,profile,ConnectionChange::Suggested(decision),Some(version)).await
    }

    pub async fn undo_switch(&self,app:&AppHandle)->Result<ConnectionStatus,String>{
        let (profile,version) = {
            let runtime=self.runtime.lock().await;
            let (profile,_)=runtime.monitor.undo.as_ref().filter(|(_,expires)| Instant::now()<*expires)
                .ok_or("The undo window has expired")?;
            (profile.clone(),(runtime.generation,runtime.monitor.revision))
        };
        self.change_connection(app,profile,ConnectionChange::Undo,Some(version)).await
    }
    pub async fn disconnect(&self,app:&AppHandle)->Result<ConnectionStatus,String>{
        let mut runtime=self.runtime.lock().await;
        runtime.generation=runtime.generation.wrapping_add(1);
        runtime.pending=false;
        runtime.monitor.checking=false;
        if let Some(active)=runtime.active.as_ref(){
            // Do not kill a working proxy if Windows refuses to restore settings:
            // otherwise clients would be redirected to a dead local port.
            system_proxy::restore(app,&active.backup,active.core.proxy_port)?;
        }
        if let Some(old)=runtime.active.take(){kill(old.core).await;}
        runtime.last_error=None;
        runtime.monitor.reset_session(None,None,Instant::now());
        Ok(ConnectionStatus::off(None))
    }
    pub async fn repair_system_proxy(&self, app: &AppHandle) -> Result<ConnectionStatus, String> {
        let mut runtime=self.runtime.lock().await;
        Self::reap_core(app,&mut runtime).await;
        let active=runtime.active.as_mut().ok_or("Connect a configuration first")?;
        let port=active.core.proxy_port;
        if !system_proxy::is_active(port)? {
            active.backup=system_proxy::enable(app,port)?;
        }
        active.system_proxy=true;
        self.snapshot_locked(&runtime)
    }
    pub async fn ping_active(&self, server_id: &str, scheduled: bool) -> Result<u64, String> {
        let _probe=match self.active_probe.try_lock() {
            Ok(guard)=>guard,
            Err(_)=>return Err("Live latency test already running".into()),
        };
        let (port,generation)={
            let mut runtime=self.runtime.lock().await;
            let active=runtime.active.as_ref().filter(|active| active.server_id==server_id)
                .ok_or("This configuration is no longer active")?;
            let port=active.core.proxy_port;
            if scheduled {
                if runtime.pending { return Err("Connection is changing".into()); }
                runtime.monitor.next_live=Some(Instant::now()+switching::LIVE_INTERVAL);
            }
            (port,runtime.generation)
        };
        let result=probe_once(port).await;
        let mut runtime=self.runtime.lock().await;
        if runtime.generation!=generation || !runtime.active.as_ref().is_some_and(|active| active.core.proxy_port==port
            && active.server_id==server_id) {
            return Err("The active connection changed during the probe".into());
        }
        if scheduled {
            runtime.monitor.record_scheduled(result.as_ref().ok().copied(),Instant::now());
        } else {
            runtime.monitor.record_live(result.as_ref().ok().copied());
        }
        result
    }

    fn snapshot_locked(&self,session:&EngineRuntime)->Result<ConnectionStatus,String>{
        let recovering=session.active.is_none() && session.monitor.wanted.is_some()
            && session.monitor.mode != SwitchMode::Off;
        let mut health=session.monitor.view(recovering,Instant::now());
        health.switching=session.pending && session.monitor.wanted.is_some();
        if let Some(active)=&session.active{
            Ok(ConnectionStatus{state:"connected".into(),server_id:Some(active.server_id.clone()),
                system_proxy:active.system_proxy,download_bps:active.download_bps,upload_bps:active.upload_bps,
                traffic_available:active.traffic_available,initial_latency_ms:Some(active.initial_latency_ms),health,
                error:(!active.system_proxy).then(||"Windows System Proxy is off. Restore it to route Windows traffic.".into())})
        }else{
            let mut status=ConnectionStatus::off(session.last_error.clone());
            status.health=health;
            if recovering {status.server_id=session.monitor.wanted.as_ref().map(|profile|profile.server_id.clone());}
            Ok(status)
        }
    }
    pub async fn status(&self,app:&AppHandle)->Result<ConnectionStatus,String>{
        let mut runtime=self.runtime.lock().await;
        Self::reap_core(app,&mut runtime).await;
        if let Some(active)=runtime.active.as_mut(){
            if active.last_poll.elapsed()>=Duration::from_millis(900){
                let elapsed=active.last_poll.elapsed().as_secs_f64().max(0.001);
                active.last_poll=Instant::now();
                active.system_proxy=matches!(system_proxy::is_active(active.core.proxy_port),Ok(true));
                if let Some(api_port)=active.core.api_port{
                    match query_traffic(app,api_port).await{
                        Ok((up,down))=>{
                            active.upload_bps=up as f64/elapsed;
                            active.download_bps=down as f64/elapsed;
                            active.traffic_available=true;
                        },
                        Err(_)=>{active.traffic_available=false;}
                    }
                }
            }
        }
        self.snapshot_locked(&runtime)
    }
    async fn reap_core(app:&AppHandle,runtime:&mut EngineRuntime) {
        if !runtime.active.as_mut().is_some_and(|active| !matches!(active.core.child.try_wait(),Ok(None))) {
            return;
        }
        let old=runtime.active.take().expect("active session exists");
        runtime.monitor.failures=2;
        runtime.monitor.last_ms=None;
        runtime.monitor.next_round=Some(Instant::now());
        let restored=system_proxy::restore(app,&old.backup,old.core.proxy_port).is_ok();
        kill(old.core).await;
        runtime.last_error=Some(if restored {
            "Xray-core exited unexpectedly. Windows System Proxy was released."
        } else {
            "Xray-core exited and Windows System Proxy could not be restored. Restart SimpleRay to retry."
        }.into());
    }
    pub async fn monitor_core(&self,app:&AppHandle) {
        loop {
            sleep(Duration::from_secs(1)).await;
            let mut runtime=self.runtime.lock().await;
            Self::reap_core(app,&mut runtime).await;
        }
    }

    pub async fn monitor_latency(&self) {
        loop {
            sleep(Duration::from_millis(250)).await;
            let id={
                let runtime=self.runtime.lock().await;
                if runtime.pending || runtime.monitor.next_live.is_none_or(|deadline|Instant::now()<deadline) {
                    continue;
                }
                runtime.active.as_ref().map(|active|active.server_id.clone())
            };
            if let Some(id)=id {let _=self.ping_active(&id,true).await;}
        }
    }

    pub async fn monitor_candidates(&self,app:&AppHandle) {
        loop {
            sleep(Duration::from_secs(1)).await;
            if let Some(round)=self.next_switch_round().await {
                self.run_switch_round(app,round).await;
            }
        }
    }

    async fn next_switch_round(&self)->Option<SwitchRound>{
        let mut runtime=self.runtime.lock().await;
        let now=Instant::now();
        let generation=runtime.generation;
        if runtime.pending || runtime.active.as_ref().is_some_and(|active| !active.system_proxy) {return None;}
        let monitor=&mut runtime.monitor;
        if monitor.mode==SwitchMode::Off || monitor.next_round.is_none_or(|deadline|now<deadline) {return None;}
        let active_id=&monitor.wanted.as_ref()?.server_id;
        let candidates:Vec<_>=monitor.candidates.iter().filter(|candidate| &candidate.server_id!=active_id)
            .take(switching::MAX_CANDIDATES).cloned().collect();
        if candidates.is_empty() {return None;}
        monitor.checking=true;
        monitor.round_started=Some(now);
        monitor.next_round=Some(now+switching::ROUND_INTERVAL);
        Some(SwitchRound{revision:monitor.revision,generation,candidates})
    }

    async fn run_switch_round(&self,app:&AppHandle,round:SwitchRound) {
        let mut jobs=JoinSet::new();
        for profile in round.candidates {
            let handle=app.clone();
            jobs.spawn(async move {
                let manager=handle.state::<EngineManager>();
                let result=manager.measure_candidate(&handle,profile.outbound,1).await.ok().and_then(|result|result.average_ms);
                (profile.server_id,result)
            });
        }
        let mut samples=Vec::new();
        while let Some(result)=jobs.join_next().await {
            if let Ok(sample)=result {samples.push(sample);}
        }
        let automatic={
            let now=Instant::now();
            let mut runtime=self.runtime.lock().await;
            if runtime.generation!=round.generation || runtime.monitor.revision!=round.revision {return;}
            let proxy_disabled=runtime.active.as_ref().is_some_and(|active|!active.system_proxy);
            let monitor=&mut runtime.monitor;
            monitor.checking=false;
            if proxy_disabled {monitor.suggestion=None;return;}
            let active_ms=monitor.live.estimate();
            let failed=monitor.failures>=2;
            for (id,latency) in &samples {
                monitor.history.observe(id,*latency,if failed {None} else {active_ms});
            }
            if failed && samples.iter().all(|(_,latency)|latency.is_none()) {
                monitor.retry_later(now);
                return;
            }
            monitor.retry_delay=None;
            monitor.next_round=monitor.round_started.map(|start|(start+switching::ROUND_INTERVAL).max(now));
            let decision=monitor.history.choose(active_ms,failed).filter(|decision| {
                decision.reason==SwitchReason::Recovery || monitor.cooldown.is_none_or(|until| now>=until)
            });
            match monitor.mode {
                SwitchMode::Suggest=>{
                    monitor.suggestion=decision.map(|decision|(decision,now+switching::ROUND_INTERVAL+Duration::from_secs(25)));
                    None
                },
                SwitchMode::Automatic=>decision.and_then(|decision| {
                    monitor.candidates.iter().find(|candidate|candidate.server_id==decision.server_id)
                        .cloned().map(|profile|(profile,decision))
                }),
                SwitchMode::Off=>None,
            }
        };
        if let Ok(status)=self.status(app).await {
            if let Some(decision)=status.health.suggestion.as_ref() {
                crate::tray::maybe_show_suggestion(app,&decision.server_id);
            }
        }
        if let Some((profile,decision))=automatic {
            let _=self.change_connection(app,profile,ConnectionChange::Automatic(decision),
                Some((round.generation,round.revision))).await;
        }
    }

    pub async fn measure_candidate(&self,app:&AppHandle,outbound:Value,samples:u8)->Result<LatencyResult,String>{
        let _permit=self.candidate_probes.acquire().await.map_err(|_|"Latency tester unavailable")?;
        ping_server(app,outbound,samples).await
    }

    pub async fn shutdown(&self,app:&AppHandle){let _=self.disconnect(app).await;}
}
async fn query_traffic(app:&AppHandle,port:u16)->Result<(u64,u64),String>{
    let xray=locate_xray(app)?;
    let mut command=Command::new(xray);
    #[cfg(target_os="windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    command.arg("api").arg("statsquery")
        .arg(format!("--server=127.0.0.1:{port}"))
        .arg("--pattern=inbound>>>proxy-in>>>traffic")
        .arg("--reset=true")
        .kill_on_drop(true).stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let output=timeout(Duration::from_secs(3),command.output()).await
        .map_err(|_|"Statistics query timed out")?
        .map_err(|_|"Statistics query failed")?;
    if !output.status.success(){return Err("Xray statistics API unavailable".into())}
    let parsed:Value=serde_json::from_slice(&output.stdout).map_err(|_|"Invalid statistics API response")?;
    let mut up=0u64;let mut down=0u64;
    for stat in parsed.get("stat").and_then(Value::as_array).ok_or("Missing statistics")? {
        let name=stat.get("name").and_then(Value::as_str).unwrap_or("");
        let count=stat.get("value").and_then(|v|v.as_str().and_then(|s|s.parse::<u64>().ok()).or_else(||v.as_u64())).unwrap_or(0);
        if name=="inbound>>>proxy-in>>>traffic>>>uplink"{up=up.saturating_add(count)}
        if name=="inbound>>>proxy-in>>>traffic>>>downlink"{down=down.saturating_add(count)}
    }
    Ok((up,down))
}
pub async fn ping_server(app:&AppHandle,outbound:Value,samples:u8)->Result<LatencyResult,String>{
    if ![1,2,3].contains(&samples){return Err("Ping measurements must be 1, 2 or 3".into())}
    let core=start_xray(app,outbound,false).await?;
    let mut values=Vec::new();let mut reason=None;
    for _ in 0..samples{
        match probe_once(core.proxy_port).await{
            Ok(ms)=>values.push(ms),
            Err(e)=>{
                if reason.is_none()||!e.contains("timed out") {
                    reason=Some(e);
                }
            }
        }
    }
    kill(core).await;
    let sum:u128=values.iter().map(|v|*v as u128).sum();
    let avg=if values.is_empty(){None}else{Some((sum/values.len() as u128).min(u64::MAX as u128) as u64)};
    Ok(LatencyResult{average_ms:avg,successful:values.len() as u8,attempted:samples,samples_ms:values,
        reason:if avg.is_none(){Some(reason.unwrap_or_else(||"No successful response".into()))}else{None}})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn rejects_arbitrary_outbound(){assert!(validate_outbound(&json!({"tag":"proxy","protocol":"freedom","settings":{}})).is_err());}
    #[test]fn configured_ports_are_local_only(){
        let value=xray_config(json!({"tag":"proxy","protocol":"trojan","settings":{}}),1234,Some(5678));
        assert_eq!(value["inbounds"][0]["listen"],"127.0.0.1");
        assert_eq!(value["inbounds"][1]["listen"],"127.0.0.1");
        assert_eq!(value["inbounds"][1]["port"],5678);
        assert_eq!(value["routing"]["rules"][0]["outboundTag"],"api");
        assert_eq!(value["api"]["tag"],"api");
    }
}

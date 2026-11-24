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
use crate::{diagnostics::Diagnostics, routing::{self,Mode,Routing}, tray::{self,ConnectionColor}};
use crate::system_proxy::{self,ProxyBackup};
use crate::server_test::{self, DownloadResult, ManualTest};
use crate::switching::{self, HealthStatus, Monitor, Profile, SwitchDecision, SwitchMode, SwitchReason};

const PROBE_URL:&str="https://www.gstatic.com/generate_204";
const TRACE_URL:&str="https://www.cloudflare.com/cdn-cgi/trace";
const RETRY_INTERVAL:Duration=Duration::from_secs(3);
#[derive(Clone, Copy)]
struct Probe { elapsed_ms:u64, ip:Option<std::net::IpAddr> }
const MAX_PROFILE_BYTES:usize=32768;
const STARTUP_TIMEOUT:Duration=Duration::from_secs(7);
const PROBE_TIMEOUT:Duration=Duration::from_secs(9);
const PRIMARY_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MANUAL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MANUAL_PRIMARY_TIMEOUT: Duration = Duration::from_secs(2);
const EXTENDED_PROBE_TIMEOUT: Duration = Duration::from_secs(12);
const PROBE_TIMED_OUT: &str = "Proxy request timed out";

#[derive(Clone, Copy)]
enum ProbeMode {
    Standard,
    Manual,
    Extended,
}

#[derive(Debug,Clone,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ConnectionStatus {
    pub state:String,
    pub server_id:Option<String>,
    pub system_proxy:bool,
    pub connection_mode:Mode,
    pub download_bps:f64,
    pub upload_bps:f64,
    pub traffic_available:bool,
    pub download_bytes:Option<u64>,
    pub upload_bytes:Option<u64>,
    pub initial_latency_ms:Option<u64>,
    pub last_good_ping_ms:Option<u64>,
    pub outage_seconds:Option<u64>,
    pub error:Option<String>,
    pub health:HealthStatus,
}
impl ConnectionStatus {
    fn off(error:Option<String>)->Self{Self{state:"disconnected".into(),server_id:None,system_proxy:false,connection_mode:Mode::SystemProxy,download_bps:0.,upload_bps:0.,traffic_available:false,download_bytes:None,upload_bytes:None,initial_latency_ms:None,last_good_ping_ms:None,outage_seconds:None,error,health:HealthStatus::default()}}
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
    probe_port:u16,
    api_port:Option<u16>,
}
#[derive(Clone, Copy, Default)]
struct TrafficBytes {
    up: u64,
    down: u64,
}
impl TrafficBytes {
    fn since(self, baseline: Self) -> Self {
        Self { up: self.up.saturating_sub(baseline.up), down: self.down.saturating_sub(baseline.down) }
    }
}
struct Active {
    core:StartedXray,
    server_id:String,
    backup:Option<ProxyBackup>,
    routing:Routing,
    last_poll:Instant,
    traffic_origin:TrafficBytes,
    last_traffic:TrafficBytes,
    last_traffic_at:Instant,
    download_bps:f64,
    upload_bps:f64,
    traffic_available:bool,
    system_proxy:bool,
    initial_latency_ms:u64,
}
impl Active {
    fn route_available(&self)->bool { self.routing.mode==Mode::Tun || self.system_proxy }
}
#[derive(Default)]
struct EngineRuntime {
    active: Option<Active>,
    last_error: Option<String>,
    monitor: Monitor,
    generation: u64,
    pending: bool,
    outage_since: Option<Instant>,
    first_failure: Option<Instant>,
    last_good_ping: Option<u64>,
    recovery_serial:u64,
}

pub struct EngineManager {
    runtime: Mutex<EngineRuntime>,
    active_probe: Mutex<()>,
    candidate_probes: Semaphore,
    network_events: Mutex<()>,
    manual_test: Mutex<ManualTest>,
}

impl Default for EngineManager {
    fn default() -> Self {
        Self { runtime: Mutex::default(), active_probe: Mutex::default(), candidate_probes: Semaphore::new(4), network_events: Mutex::new(()), manual_test: Mutex::default() }
    }
}

enum ConnectionChange {
    Manual,
    Retry,
    Suggested(SwitchDecision),
    Automatic(SwitchDecision),
    Undo,
    Recover(u64),
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
    if !matches!(obj.get("protocol").and_then(Value::as_str),Some("vmess"|"vless"|"trojan"|"shadowsocks"|"wireguard"|"hysteria"|"socks"|"http")){
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
async fn start_xray(app:&AppHandle,outbound:Value,stats:bool, route:Option<&Routing>)->Result<StartedXray,String>{
    validate_outbound(&outbound)?;
    let bin=locate_xray(app)?;
    let proxy_port=pick_port()?;
    let api_port=if stats{let mut p=pick_port()?;while p==proxy_port{p=pick_port()?}Some(p)}else{None};
    let probe_port=if route.is_some(){
        let mut port=pick_port()?;
        while port==proxy_port||Some(port)==api_port{port=pick_port()?}
        port
    }else{proxy_port};
    let dir=tempfile::Builder::new().prefix("simpleray-run-").tempdir_in(user_data_dir(app)?)
        .map_err(|_|"Could not create temporary runtime directory")?;
    let config_path=dir.path().join("config.json");
    let mut config=xray_config(outbound,proxy_port,api_port);
    if let Some(settings)=route { routing::config(&mut config,settings,probe_port); }
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
            if route.is_some_and(|settings|settings.mode==Mode::Tun) {
                return Err("Xray could not start TUN. Start SimpleRay as administrator and verify the Windows network adapter.".into());
            }
            return Err("Xray exited before its HTTP proxy became ready".into());
        }
        if TcpStream::connect(("127.0.0.1",probe_port)).await.is_ok(){
            if route.is_some_and(|settings|settings.mode==Mode::Tun) {
                if tun_is_ready() { break; }
            }else{break}
        }
        if start.elapsed()>=STARTUP_TIMEOUT{
            let _=child.start_kill();
            return Err(if route.is_some_and(|settings|settings.mode==Mode::Tun) {
                "TUN adapter did not become ready. Start SimpleRay as administrator."
            } else { "Timed out waiting for the local Xray HTTP proxy" }.into());
        }
        sleep(Duration::from_millis(120)).await;
    }
    Ok(StartedXray{child,_temp_dir:dir,proxy_port,probe_port,api_port})
}
fn tun_is_ready()->bool {
    if_addrs::get_if_addrs().is_ok_and(|interfaces| interfaces.iter().any(|interface|
        interface.ip().to_string()=="198.19.231.1"))
}
fn trace_address(text:&str)->Option<std::net::IpAddr> {
    text.lines().find_map(|line|line.strip_prefix("ip=").and_then(|ip|ip.trim().parse().ok()))
}
async fn probe_round(port: u16) -> Result<Probe, String> {
    probe_round_with_timeout(port, PRIMARY_PROBE_TIMEOUT).await
}

fn probe_client(port: u16, request_timeout: Duration) -> Result<reqwest::Client, String> {
    let proxy=reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
        .map_err(|_|"Cannot configure local HTTP proxy probe")?;
    reqwest::Client::builder().proxy(proxy).timeout(request_timeout)
        .redirect(reqwest::redirect::Policy::none()).pool_max_idle_per_host(0)
        .build().map_err(|_|"Could not create HTTP probe".into())
}

async fn trace_probe(client: &reqwest::Client) -> Option<Probe> {
    let start=Instant::now();
    let mut response=client.get(TRACE_URL).header(reqwest::header::CONNECTION,"close").send().await.ok()?;
    if response.status()!=reqwest::StatusCode::OK {return None}
    let mut text=Vec::new();
    while let Some(chunk)=response.chunk().await.ok()? {
        if text.len()+chunk.len()>8192 {return None}
        text.extend_from_slice(&chunk);
    }
    let ip = trace_address(std::str::from_utf8(&text).ok()?)?;
    Some(Probe{elapsed_ms:start.elapsed().as_millis().max(1) as u64,ip:Some(ip)})
}

async fn backup_probe(client: &reqwest::Client) -> Result<Probe, String> {
    let start=Instant::now();
    let response=client.get(PROBE_URL).header(reqwest::header::CONNECTION,"close").send().await
        .map_err(|error|if error.is_timeout(){PROBE_TIMED_OUT}else{"Proxy request failed"})?;
    if response.status()!=reqwest::StatusCode::NO_CONTENT{
        return Err("Proxy probe did not return HTTP 204".into());
    }
    Ok(Probe{elapsed_ms:start.elapsed().as_millis().max(1) as u64,ip:None})
}

async fn probe_round_with_timeout(port: u16, primary_timeout: Duration) -> Result<Probe, String> {
    let client = probe_client(port, PROBE_TIMEOUT)?;
    if let Some(probe) = timeout(primary_timeout, trace_probe(&client)).await.ok().flatten() {
        return Ok(probe);
    }
    backup_probe(&client).await
}

async fn extended_probe(port: u16) -> Result<Probe, String> {
    let client = probe_client(port, EXTENDED_PROBE_TIMEOUT)?;
    // Keep waiting on the first destination while the backup is testing.
    // This gives either destination time to report a genuinely slow response.
    extended_probe_with(trace_probe(&client), || backup_probe(&client), MANUAL_PRIMARY_TIMEOUT).await
}

async fn extended_probe_with<P, B, F>(primary: P, start_backup: B, head_start: Duration) -> Result<Probe, String>
where
    P: std::future::Future<Output = Option<Probe>>,
    B: FnOnce() -> F,
    F: std::future::Future<Output = Result<Probe, String>>,
{
    tokio::pin!(primary);
    tokio::select! {
        response = &mut primary => return match response {
            Some(probe) => Ok(probe),
            None => start_backup().await,
        },
        _ = sleep(head_start) => {},
    }
    let backup = start_backup();
    tokio::pin!(backup);
    tokio::select! {
        response = &mut primary => match response {
            Some(probe) => Ok(probe),
            None => backup.await,
        },
        response = &mut backup => match response {
            Ok(probe) => Ok(probe),
            Err(error) => primary.await.ok_or(error),
        },
    }
}

async fn probe_once(port: u16, mode: ProbeMode) -> Result<u64, String> {
    let probe = match mode {
        ProbeMode::Standard => probe_round(port).await?,
        ProbeMode::Manual => timeout(MANUAL_PROBE_TIMEOUT, probe_round_with_timeout(port, MANUAL_PRIMARY_TIMEOUT))
            .await
            .map_err(|_| PROBE_TIMED_OUT)??,
        ProbeMode::Extended => timeout(EXTENDED_PROBE_TIMEOUT, extended_probe(port))
            .await
            .map_err(|_| PROBE_TIMED_OUT)??,
    };
    Ok(probe.elapsed_ms)
}
async fn kill(mut core:StartedXray){
    let _=core.child.kill().await;
    // TempDir drops here, removing per-session config containing credentials.
}
impl EngineManager {
    pub async fn connect(&self,app:&AppHandle,server_id:String,outbound:Value,display_name:String)->Result<ConnectionStatus,String>{
        if server_id.is_empty()||server_id.len()>256{return Err("Invalid selected server ID".into())}
        self.change_connection(app,Profile{server_id,outbound,display_name:display_name.chars().take(160).collect()},ConnectionChange::Manual,None).await
    }

    async fn change_connection(
        &self, app: &AppHandle, profile: Profile, change: ConnectionChange, expected: Option<(u64, u64)>
    ) -> Result<ConnectionStatus, String> {
        let route=routing::load(app)?;
        let (generation,replace_tun) = {
            let mut runtime = self.runtime.lock().await;
            if matches!(change,ConnectionChange::Recover(serial) if serial!=runtime.recovery_serial){
                return Err("Network recovery was cancelled".into());
            }
            if expected.is_some_and(|(generation, revision)| {
                runtime.pending || runtime.generation != generation || runtime.monitor.revision != revision
            }) { return Err("The connection or switch settings changed".into()); }
            if !matches!(change,ConnectionChange::Recover(_)|ConnectionChange::Retry) && runtime.active.as_ref().is_some_and(|active| active.server_id==profile.server_id && active.routing==route) {
                return self.snapshot_locked(&runtime);
            }
            runtime.generation = runtime.generation.wrapping_add(1);
            runtime.pending = true;
            runtime.monitor.checking = false;
            runtime.monitor.suggestion = None;
            let replace_tun=route.mode==Mode::Tun && runtime.active.as_ref().is_some_and(|active|active.routing.mode==Mode::Tun);
            (runtime.generation,replace_tun)
        };
        let preflight=if replace_tun { Routing { mode:Mode::SystemProxy, ..route.clone() } } else { route.clone() };
        let prepared = Self::prepare_connection(app,profile.outbound.clone(),&preflight).await;
        let mut runtime = self.runtime.lock().await;
        if runtime.generation != generation { return Err("The connection request was superseded".into()); }
        runtime.pending = false;
        if matches!(change,ConnectionChange::Recover(serial) if serial!=runtime.recovery_serial){
            return Err("Network recovery was cancelled".into());
        }
        let result = async {
            let (mut new_core, mut probe) = prepared?;
            if expected.is_some_and(|(_, revision)| runtime.monitor.revision != revision) {
                return Err("The switch settings changed".into());
            }
            if let ConnectionChange::Suggested(decision) | ConnectionChange::Automatic(decision) = &change {
                let valid = match decision.reason {
                    SwitchReason::Recovery => runtime.monitor.failures >= 2 || runtime.active.is_none(),
                    SwitchReason::LowerLatency => runtime.monitor.failures < 2
                        && switching::qualifies(runtime.monitor.live.estimate(), Some(probe.elapsed_ms)),
                };
                if !valid { return Err("The latest test no longer qualifies for switching".into()); }
            }
            if replace_tun {
                kill(new_core).await;
                let old = runtime.active.take().ok_or("The active TUN session changed")?;
                let old_route=old.routing.clone();
                let old_profile=runtime.monitor.wanted.clone();
                kill(old.core).await;
                match Self::prepare_connection(app,profile.outbound.clone(),&route).await {
                    Ok((core,result))=>{new_core=core;probe=result;}
                    Err(error)=>{
                        if let Some(old_profile)=old_profile {
                            if let Ok((core,previous_probe))=Self::prepare_connection(app,old_profile.outbound.clone(),&old_route).await {
                                let now=Instant::now();
                                runtime.active=Some(Active{core,server_id:old_profile.server_id.clone(),backup:None,
                                    routing:old_route,last_poll:now,traffic_origin:TrafficBytes::default(),
                                    last_traffic:TrafficBytes::default(),last_traffic_at:now,download_bps:0.,upload_bps:0.,
                                    traffic_available:false,system_proxy:false,initial_latency_ms:previous_probe.elapsed_ms});
                                runtime.monitor.reset_session(Some(old_profile),Some(previous_probe.elapsed_ms),now);
                            }
                        }
                        return Err(error);
                    }
                }
            }
            // Read a starting point before enabling System Proxy for the new core.
            let traffic_origin=match new_core.api_port {
                Some(port)=>query_traffic(app,port,route.mode).await.unwrap_or_default(),
                None=>TrafficBytes::default(),
            };
            let previous_proxy=runtime.active.as_ref().and_then(|active|active.backup.as_ref().map(|backup|(backup,active.core.proxy_port)));
            let backup=match (route.mode,previous_proxy) {
                (Mode::SystemProxy,Some((backup,port)))=>{
                    let mut snapshot=(*backup).clone();
                    system_proxy::switch(app,&mut snapshot,port,new_core.proxy_port)?;
                    Some(snapshot)
                }
                (Mode::SystemProxy,None)=>Some(system_proxy::enable(app,new_core.proxy_port)?),
                (Mode::Tun,Some((backup,port)))=>{system_proxy::restore(app,backup,port)?;None}
                (Mode::Tun,None)=>None,
            };
            if let Some(old)=runtime.active.take(){kill(old.core).await;}
            let previous = runtime.monitor.wanted.clone();
            let now=Instant::now();
            let initial_latency_ms=probe.elapsed_ms;
            let system_proxy=backup.is_some();
            runtime.active=Some(Active{
                core:new_core,server_id:profile.server_id.clone(),backup,routing:route,last_poll:now,
                traffic_origin,last_traffic:traffic_origin,last_traffic_at:now,
                download_bps:0.,upload_bps:0.,traffic_available:false,system_proxy,initial_latency_ms,
            });
            runtime.last_error=None;
            runtime.outage_since=None;
            runtime.first_failure=None;
            runtime.last_good_ping=Some(initial_latency_ms);
            if let Some(ip)=probe.ip { app.state::<Diagnostics>().observation(app,&profile.server_id,ip); }
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
        if result.is_err() { app.state::<Diagnostics>().record("Connection start or switch failed."); }
        Self::sync_tray(app,&runtime);
        result
    }

    async fn prepare_connection(app:&AppHandle,outbound:Value,route:&Routing)->Result<(StartedXray,Probe),String>{
        let new_core=start_xray(app,outbound,true,Some(route)).await?;
        match probe_round(new_core.probe_port).await {
            Ok(probe)=>Ok((new_core,probe)),
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

    pub async fn tray_suggestion(&self)->Option<switching::TraySuggestion> {
        let runtime=self.runtime.lock().await;
        let monitor=&runtime.monitor;
        if runtime.pending || monitor.mode!=SwitchMode::Suggest {return None;}
        let (decision,expires)=monitor.suggestion.as_ref()?;
        if Instant::now()>=*expires {return None;}
        let profile=monitor.candidates.iter().find(|profile|profile.server_id==decision.server_id)?;
        Some(switching::TraySuggestion{
            generation:runtime.generation,
            revision:monitor.revision,
            name:profile.display_name.clone(),
            decision:decision.clone(),
        })
    }

    pub async fn accept_switch(
        &self,app:&AppHandle,server_id:&str,expected:Option<(u64,u64)>,
    )->Result<ConnectionStatus,String>{
        let (profile,decision,version) = {
            let runtime=self.runtime.lock().await;
            let version=(runtime.generation,runtime.monitor.revision);
            if expected.is_some_and(|expected|expected!=version) {
                return Err("That suggestion has expired".into());
            }
            let (decision, _) = runtime.monitor.suggestion.as_ref().filter(|(decision,expires)| {
                runtime.monitor.mode==SwitchMode::Suggest && decision.server_id==server_id && Instant::now()<*expires
            }).ok_or("That suggestion has expired")?;
            let profile=runtime.monitor.candidates.iter().find(|p|p.server_id==server_id).cloned()
                .ok_or("That server is no longer selected for monitoring")?;
            (profile,decision.clone(),version)
        };
        self.change_connection(app,profile,ConnectionChange::Suggested(decision),Some(version)).await
    }

    pub async fn retry(&self, app: &AppHandle, server_id: &str) -> Result<ConnectionStatus, String> {
        let (profile,version)={
            let runtime=self.runtime.lock().await;
            let profile=runtime.monitor.wanted.as_ref().filter(|profile|profile.server_id==server_id)
                .cloned().ok_or("The active server has changed")?;
            (profile,(runtime.generation,runtime.monitor.revision))
        };
        self.change_connection(app,profile,ConnectionChange::Retry,Some(version)).await
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
        if let Some((active,backup))=runtime.active.as_ref().and_then(|active|active.backup.as_ref().map(|backup|(active,backup))){
            // Do not kill a working proxy if Windows refuses to restore settings:
            // otherwise clients would be redirected to a dead local port.
            system_proxy::restore(app,backup,active.core.proxy_port)?;
        }
        if let Some(old)=runtime.active.take(){kill(old.core).await;}
        runtime.last_error=None;
        runtime.monitor.reset_session(None,None,Instant::now());
        runtime.outage_since=None;
        runtime.first_failure=None;
        runtime.last_good_ping=None;
        Self::sync_tray(app,&runtime);
        Ok(ConnectionStatus::off(None))
    }
    pub async fn repair_system_proxy(&self, app: &AppHandle) -> Result<ConnectionStatus, String> {
        let mut runtime=self.runtime.lock().await;
        Self::reap_core(app,&mut runtime).await;
        let active=runtime.active.as_mut().ok_or("Connect a configuration first")?;
        if active.routing.mode==Mode::Tun { return Err("TUN does not use Windows System Proxy".into()); }
        let port=active.core.proxy_port;
        if !system_proxy::is_active(port)? {
            active.backup=Some(system_proxy::enable(app,port)?);
        }
        active.system_proxy=true;
        self.snapshot_locked(&runtime)
    }
    pub async fn ping_active(&self, app:&AppHandle, server_id: &str, scheduled: bool) -> Result<u64, String> {
        let _probe=match self.active_probe.try_lock() {
            Ok(guard)=>guard,
            Err(_)=>return Err("Live latency test already running".into()),
        };
        let (port,generation,mode)={
            let mut runtime=self.runtime.lock().await;
            let active=runtime.active.as_ref().filter(|active| active.server_id==server_id)
                .ok_or("This configuration is no longer active")?;
            let port=active.core.probe_port;
            let mode=active.routing.mode;
            if scheduled {
                if runtime.pending { return Err("Connection is changing".into()); }
                runtime.monitor.next_live=Some(Instant::now()+switching::LIVE_INTERVAL);
            }
            (port,runtime.generation,mode)
        };
        let mut result=probe_round(port).await;
        if mode==Mode::Tun&&!tun_is_ready(){result=Err("The TUN adapter is unavailable".into());}
        let mut runtime=self.runtime.lock().await;
        if runtime.generation!=generation || !runtime.active.as_ref().is_some_and(|active| active.core.probe_port==port
            && active.server_id==server_id) {
            return Err("The active connection changed during the probe".into());
        }
        let milliseconds=result.as_ref().ok().map(|probe|probe.elapsed_ms);
        let now=Instant::now();
        if scheduled {
            runtime.monitor.record_scheduled(milliseconds,now);
            if runtime.monitor.failures==1 {runtime.monitor.next_live=Some(now+RETRY_INTERVAL);}
        } else if milliseconds.is_some() {
            runtime.monitor.record_scheduled(milliseconds,now);
        } else {
            runtime.monitor.record_live(None);
        }
        if let Some(ms)=milliseconds{
            runtime.outage_since=None;
            runtime.first_failure=None;
            runtime.last_good_ping=Some(ms);
        }else if scheduled{
            let began=*runtime.first_failure.get_or_insert(now);
            if runtime.monitor.failures>=2 && runtime.outage_since.is_none(){
                runtime.outage_since=Some(began);
                app.state::<Diagnostics>().record("Two health rounds failed for the active connection.");
            }
        }
        if let Ok(Probe{ip:Some(ip),..})=&result {
            app.state::<Diagnostics>().observation(app,server_id,*ip);
        }
        Self::sync_tray(app,&runtime);
        result.map(|probe|probe.elapsed_ms)
    }

    fn sync_tray(app:&AppHandle,runtime:&EngineRuntime){
        let color=if runtime.monitor.wanted.is_none(){ConnectionColor::Blue}
            else if runtime.outage_since.is_some(){ConnectionColor::Red}
            else if runtime.active.is_some(){ConnectionColor::Green}
            else{ConnectionColor::Blue};
        let profile=runtime.monitor.wanted.as_ref();
        let name=profile.map(|profile|profile.display_name.as_str()).filter(|name|!name.is_empty());
        let outage=runtime.outage_since.map(|since|since.elapsed().as_secs());
        tray::connection_icon(app,color,name,runtime.last_good_ping,outage);
    }
    pub async fn rename_active(&self,app:&AppHandle,id:&str,name:String){
        let mut runtime=self.runtime.lock().await;
        if let Some(profile)=runtime.monitor.wanted.as_mut().filter(|profile|profile.server_id==id){
            profile.display_name=name.chars().take(160).collect();
            Self::sync_tray(app,&runtime);
        }
    }
    pub async fn cancel_recovery(&self){
        let mut runtime=self.runtime.lock().await;
        runtime.recovery_serial=runtime.recovery_serial.wrapping_add(1);
    }
    pub async fn recover_network(&self,app:&AppHandle){
        let Ok(_event)=self.network_events.try_lock() else{return};
        let (profile,generation,serial)={
            let runtime=self.runtime.lock().await;
            if runtime.pending || runtime.active.is_none(){return}
            let Some(profile)=runtime.monitor.wanted.clone() else{return};
            (profile,runtime.generation,runtime.recovery_serial)
        };
        sleep(Duration::from_secs(2)).await;
        let unchanged=|runtime:&EngineRuntime| runtime.generation==generation && runtime.recovery_serial==serial && !runtime.pending;
        if !unchanged(&*self.runtime.lock().await){return}
        match self.ping_active(app,&profile.server_id,true).await {
            Ok(_)=>return,
            Err(error) if error=="Live latency test already running"=>return,
            _=>{}
        }
        let version={
            let runtime=self.runtime.lock().await;
            if !unchanged(&runtime){return}
            (runtime.generation,runtime.monitor.revision)
        };
        if self.change_connection(app,profile,ConnectionChange::Recover(serial),Some(version)).await.is_err() {
            app.state::<Diagnostics>().record("Recovery after a Windows network change failed.");
        }
    }

    fn snapshot_locked(&self,session:&EngineRuntime)->Result<ConnectionStatus,String>{
        let recovering=session.active.is_none() && session.monitor.wanted.is_some()
            && session.monitor.mode != SwitchMode::Off;
        let mut health=session.monitor.view(recovering,Instant::now());
        health.switching=session.pending && session.monitor.wanted.is_some();
        if let Some(active)=&session.active{
            let transferred=active.core.api_port.map(|_|active.last_traffic.since(active.traffic_origin));
            Ok(ConnectionStatus{state:"connected".into(),server_id:Some(active.server_id.clone()),
                system_proxy:active.system_proxy,connection_mode:active.routing.mode,download_bps:active.download_bps,upload_bps:active.upload_bps,
                traffic_available:active.traffic_available,
                download_bytes:transferred.map(|bytes|bytes.down),upload_bytes:transferred.map(|bytes|bytes.up),
                initial_latency_ms:Some(active.initial_latency_ms),last_good_ping_ms:session.last_good_ping,
                outage_seconds:session.outage_since.map(|since|since.elapsed().as_secs()),health,
                error:(!active.route_available()).then(||"Windows System Proxy is off. Restore it to route Windows traffic.".into())})
        }else{
            let mut status=ConnectionStatus::off(session.last_error.clone());
            status.health=health;
            status.last_good_ping_ms=session.last_good_ping;
            status.outage_seconds=session.outage_since.map(|since|since.elapsed().as_secs());
            if recovering||status.outage_seconds.is_some() {status.server_id=session.monitor.wanted.as_ref().map(|profile|profile.server_id.clone());}
            Ok(status)
        }
    }
    pub async fn status(&self,app:&AppHandle)->Result<ConnectionStatus,String>{
        let mut runtime=self.runtime.lock().await;
        Self::reap_core(app,&mut runtime).await;
        if let Some(active)=runtime.active.as_mut(){
            if active.last_poll.elapsed()>=Duration::from_millis(900){
                active.last_poll=Instant::now();
                active.system_proxy=active.backup.is_some()&&matches!(system_proxy::is_active(active.core.proxy_port),Ok(true));
                if let Some(api_port)=active.core.api_port{
                    match query_traffic(app,api_port,active.routing.mode).await{
                        Ok(totals)=>{
                            let elapsed=active.last_traffic_at.elapsed().as_secs_f64().max(0.001);
                            let delta=totals.since(active.last_traffic);
                            active.upload_bps=delta.up as f64/elapsed;
                            active.download_bps=delta.down as f64/elapsed;
                            active.last_traffic=totals;
                            active.last_traffic_at=Instant::now();
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
        let restored=old.backup.as_ref().is_none_or(|backup|system_proxy::restore(app,backup,old.core.proxy_port).is_ok());
        runtime.outage_since=Some(Instant::now());
        app.state::<Diagnostics>().record("Xray-core exited unexpectedly.");
        kill(old.core).await;
        runtime.last_error=Some(if restored {
            "Xray-core exited unexpectedly. The connection was released."
        } else {
            "Xray-core exited and Windows System Proxy could not be restored. Restart SimpleRay to retry."
        }.into());
        Self::sync_tray(app,runtime);
    }
    pub async fn monitor_core(&self,app:&AppHandle) {
        loop {
            sleep(Duration::from_secs(1)).await;
            let mut runtime=self.runtime.lock().await;
            Self::reap_core(app,&mut runtime).await;
            if runtime.outage_since.is_some(){Self::sync_tray(app,&runtime);}
        }
    }

    pub async fn monitor_latency(&self,app:&AppHandle) {
        loop {
            sleep(Duration::from_millis(250)).await;
            let id={
                let runtime=self.runtime.lock().await;
                if runtime.pending || runtime.monitor.next_live.is_none_or(|deadline|Instant::now()<deadline) {
                    continue;
                }
                runtime.active.as_ref().map(|active|active.server_id.clone())
            };
            if let Some(id)=id {let _=self.ping_active(app,&id,true).await;}
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
        if self.manual_test.lock().await.speed_running() { return None; }
        let mut runtime=self.runtime.lock().await;
        let now=Instant::now();
        let generation=runtime.generation;
        if runtime.pending || runtime.active.as_ref().is_some_and(|active| !active.route_available()) {return None;}
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
                let result=manager.measure_candidate(&handle,profile.outbound,1,None).await.ok().and_then(|result|result.average_ms);
                (profile.server_id,result)
            });
        }
        let mut samples=Vec::new();
        while let Some(result)=jobs.join_next().await {
            if let Ok(sample)=result {samples.push(sample);}
        }
        let automatic={
            let now=Instant::now();
            let speed_testing = self.manual_test.lock().await.speed_running();
            let mut runtime=self.runtime.lock().await;
            if runtime.generation!=round.generation || runtime.monitor.revision!=round.revision {return;}
            let proxy_disabled=runtime.active.as_ref().is_some_and(|active|!active.route_available());
            let monitor=&mut runtime.monitor;
            monitor.checking=false;
            if proxy_disabled {monitor.suggestion=None;return;}
            if speed_testing {
                monitor.next_round = Some(now);
                return;
            }
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
        if let Some((profile,decision))=automatic {
            if !self.manual_test.lock().await.speed_running() {
                let _=self.change_connection(app,profile,ConnectionChange::Automatic(decision),
                    Some((round.generation,round.revision))).await;
            }
        }
    }

    pub async fn measure_candidate(
        &self,app:&AppHandle,outbound:Value,samples:u8,progress:Option<tauri::ipc::Channel<LatencyResult>>,
    )->Result<LatencyResult,String>{
        let _permit=self.candidate_probes.acquire().await.map_err(|_|"Latency tester unavailable")?;
        let core = start_xray(app, outbound, false, None).await?;
        let result = sample_latency(core.proxy_port, samples, progress, ProbeMode::Standard).await;
        kill(core).await;
        result
    }

    pub async fn begin_manual_test(&self, speed: bool) -> Result<u32, String> {
        self.manual_test.lock().await.begin(speed)
    }

    pub async fn cancel_manual_test(&self, id: u32) {
        self.manual_test.lock().await.cancel(id);
    }

    pub async fn finish_manual_test(&self, id: u32) {
        self.manual_test.lock().await.finish(id);
    }

    pub async fn measure_manual_latency(
        &self, app: &AppHandle, id: u32, outbound: Value, samples: u8,
        progress: Option<tauri::ipc::Channel<LatencyResult>>, extended: bool,
    ) -> Result<LatencyResult, String> {
        if extended && samples != 1 {
            return Err("The extended ping must be a single attempt".into());
        }
        let mode = if extended { ProbeMode::Extended } else { ProbeMode::Manual };
        self.with_manual_proxy(app, id, outbound, |port| sample_latency(port, samples, progress, mode)).await
    }

    pub async fn measure_manual_download(
        &self, app: &AppHandle, id: u32, outbound: Value,
    ) -> Result<DownloadResult, String> {
        self.with_manual_proxy(app, id, outbound, server_test::measure_download).await
    }

    async fn with_manual_proxy<T, F, Fut>(
        &self, app: &AppHandle, id: u32, outbound: Value, measure: F,
    ) -> Result<T, String>
    where
        F: FnOnce(u16) -> Fut,
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        let mut cancel = self.manual_test.lock().await.subscribe(id)?;
        let (_permit, core) = tokio::select! {
            biased;
            _ = server_test::wait_until_cancelled(&mut cancel) => return Err(server_test::CANCELLED.into()),
            started = async {
                let permit = self.candidate_probes.acquire().await.map_err(|_| "Tester unavailable")?;
                let core = start_xray(app, outbound, false, None).await?;
                Ok::<_, String>((permit, core))
            } => started?,
        };
        let result = tokio::select! {
            biased;
            _ = server_test::wait_until_cancelled(&mut cancel) => Err(server_test::CANCELLED.into()),
            result = measure(core.proxy_port) => result,
        };
        kill(core).await;
        result
    }

    pub async fn shutdown(&self,app:&AppHandle){let _=self.disconnect(app).await;}
}
async fn query_traffic(app:&AppHandle,port:u16,mode:Mode)->Result<TrafficBytes,String>{
    let xray=locate_xray(app)?;
    let mut command=Command::new(xray);
    #[cfg(target_os="windows")]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let inbound=if mode==Mode::Tun{"tun-in"}else{"proxy-in"};
    let prefix=format!("inbound>>>{inbound}>>>traffic");
    let up=format!("{prefix}>>>uplink");
    let down=format!("{prefix}>>>downlink");
    command.arg("api").arg("statsquery")
        .arg(format!("--server=127.0.0.1:{port}"))
        .arg(format!("--pattern={prefix}"))
        .arg("--reset=false")
        .kill_on_drop(true).stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let output=timeout(Duration::from_secs(3),command.output()).await
        .map_err(|_|"Statistics query timed out")?
        .map_err(|_|"Statistics query failed")?;
    if !output.status.success(){return Err("Xray statistics API unavailable".into())}
    let parsed:Value=serde_json::from_slice(&output.stdout).map_err(|_|"Invalid statistics API response")?;
    let mut traffic=TrafficBytes::default();
    for stat in parsed.get("stat").and_then(Value::as_array).ok_or("Missing statistics")? {
        let name=stat.get("name").and_then(Value::as_str).unwrap_or("");
        let count=stat.get("value").and_then(|v|v.as_str().and_then(|s|s.parse::<u64>().ok()).or_else(||v.as_u64())).unwrap_or(0);
        if name==up{traffic.up=traffic.up.saturating_add(count)}
        if name==down{traffic.down=traffic.down.saturating_add(count)}
    }
    Ok(traffic)
}
fn latency_result(values:Vec<u64>, attempted:u8, reason:Option<String>)->LatencyResult {
    let successful=values.len() as u8;
    let average_ms=if successful==0 {None} else {
        let count=u128::from(successful);
        let sum: u128=values.iter().copied().map(u128::from).sum();
        Some(((sum+count/2)/count) as u64)
    };
    LatencyResult {
        average_ms,successful,attempted,samples_ms:values,
        reason:if average_ms.is_none(){Some(reason.unwrap_or_else(||"No successful response".into()))}else{None},
    }
}

async fn sample_latency(
    port:u16,samples:u8,progress:Option<tauri::ipc::Channel<LatencyResult>>,mode:ProbeMode,
)->Result<LatencyResult,String>{
    if !(1..=3).contains(&samples){return Err("Ping measurements must be 1, 2 or 3".into())}
    let mut values=Vec::with_capacity(samples.into());
    let mut reason=None;
    for attempt in 1..=samples{
        match probe_once(port,mode).await{
            Ok(ms)=>{
                values.push(ms);
                if values.len()==1 && attempt<samples {
                    if let Some(channel)=&progress {
                        let _=channel.send(latency_result(values.clone(),attempt,None));
                    }
                }
            }
            Err(e)=>{
                if reason.is_none()||!e.contains("timed out") { reason=Some(e); }
            }
        }
    }
    Ok(latency_result(values,samples,reason))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn extended_probe_accepts_a_late_primary_if_backup_fails() {
        let primary = async {
            sleep(Duration::from_millis(25)).await;
            Some(Probe { elapsed_ms: 8_000, ip: None })
        };
        let result = extended_probe_with(primary, || async { Err("Backup failed".into()) }, Duration::ZERO).await;
        assert_eq!(result.unwrap().elapsed_ms, 8_000);
    }

    #[tokio::test]
    async fn extended_probe_accepts_a_backup_while_primary_is_pending() {
        let result = extended_probe_with(
            std::future::pending(),
            || async { Ok(Probe { elapsed_ms: 8_000, ip: None }) },
            Duration::ZERO,
        ).await;
        assert_eq!(result.unwrap().elapsed_ms, 8_000);
    }
    #[test]
    fn latency_average_uses_successful_probes_and_keeps_attempt_count() {
        let result=latency_result(vec![203,300],3,None);
        assert_eq!((result.average_ms,result.successful,result.attempted),(Some(252),2,3));
        let failed=latency_result(Vec::new(),1,Some("timed out".into()));
        assert_eq!((failed.average_ms,failed.successful,failed.attempted),(None,0,1));
        assert_eq!(failed.reason.as_deref(),Some("timed out"));
    }
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

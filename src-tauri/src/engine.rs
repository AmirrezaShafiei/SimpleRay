//! Xray-core subprocess integration, local WinINet proxy lifecycle and HTTP real-delay.
//! The app does NOT claim success until an HTTPS 204 response travels through Xray.
//! The external Xray binary must be installed locally or explicitly provided via
//! SIMPLERAY_XRAY_PATH; no unverified binaries are downloaded or committed.
use serde::Serialize;
use serde_json::{json,Value};
use std::{fs,net::TcpListener,path::PathBuf,time::{Duration,Instant}};
use tauri::{AppHandle,Manager};
use tempfile::TempDir;
use tokio::{net::TcpStream,process::{Child,Command},sync::Mutex,time::{sleep,timeout}};
use crate::system_proxy::{self,ProxyBackup};

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
}
impl ConnectionStatus {
    fn off(error:Option<String>)->Self{Self{state:"disconnected".into(),server_id:None,system_proxy:false,download_bps:0.,upload_bps:0.,traffic_available:false,initial_latency_ms:None,error}}
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
struct EngineRuntime {active:Option<Active>,last_error:Option<String>}
#[derive(Default)]
pub struct EngineManager {runtime:Mutex<EngineRuntime>}

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
        let mut runtime=self.runtime.lock().await;
        if runtime.active.as_ref().is_some_and(|a|a.server_id==server_id){
            return self.snapshot_locked(&runtime);
        }
        let new_core=start_xray(app,outbound,true).await?;
        let initial_latency_ms=match probe_once(new_core.proxy_port).await {
            Ok(ms)=>ms,
            Err(error)=>{
                kill(new_core).await;
                return Err(format!("Connection verification failed: {error}"));
            }
        };
        let previous_port=runtime.active.as_ref().map(|a|a.core.proxy_port);
        let backup=if let Some(old_port)=previous_port{
            let mut snapshot=runtime.active.as_ref().ok_or("Existing session disappeared")?.backup.clone();
            if let Err(e)=system_proxy::switch(app,&mut snapshot,old_port,new_core.proxy_port){
                kill(new_core).await;return Err(e);
            }
            snapshot
        }else{
            match system_proxy::enable(app,new_core.proxy_port){
                Ok(backup)=>backup,
                Err(e)=>{kill(new_core).await;return Err(e)}
            }
        };
        if let Some(old)=runtime.active.take(){kill(old.core).await;}
        let server_id=server_id.clone();
        runtime.active=Some(Active{
            core:new_core,server_id,backup,last_poll:Instant::now(),
            download_bps:0.,upload_bps:0.,traffic_available:false,system_proxy:true,initial_latency_ms,
        });
        runtime.last_error=None;
        self.snapshot_locked(&runtime)
    }
    pub async fn disconnect(&self,app:&AppHandle)->Result<ConnectionStatus,String>{
        let mut runtime=self.runtime.lock().await;
        if let Some(active)=runtime.active.as_ref(){
            // Do not kill a working proxy if Windows refuses to restore settings:
            // otherwise clients would be redirected to a dead local port.
            system_proxy::restore(app,&active.backup,active.core.proxy_port)?;
        }
        if let Some(old)=runtime.active.take(){kill(old.core).await;}
        runtime.last_error=None;
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
    pub async fn ping_active(&self, server_id: &str) -> Result<u64, String> {
        let port={
            let runtime=self.runtime.lock().await;
            let active=runtime.active.as_ref().filter(|active| active.server_id==server_id)
                .ok_or("This configuration is no longer active")?;
            active.core.proxy_port
        };
        let result=probe_once(port).await;
        let runtime=self.runtime.lock().await;
        if !runtime.active.as_ref().is_some_and(|active| active.core.proxy_port==port
            && active.server_id==server_id) {
            return Err("The active connection changed during the probe".into());
        }
        result
    }
    fn snapshot_locked(&self,session:&EngineRuntime)->Result<ConnectionStatus,String>{
        if let Some(active)=&session.active{
            Ok(ConnectionStatus{state:"connected".into(),server_id:Some(active.server_id.clone()),
                system_proxy:active.system_proxy,download_bps:active.download_bps,upload_bps:active.upload_bps,
                traffic_available:active.traffic_available,initial_latency_ms:Some(active.initial_latency_ms),
                error:(!active.system_proxy).then(||"Windows System Proxy is off. Restore it to route Windows traffic.".into())})
        }else{Ok(ConnectionStatus::off(session.last_error.clone()))}
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
    if samples!=1 && samples!=3{return Err("Ping measurements must be 1 or 3".into())}
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

use std::time::Duration;
use tauri::{AppHandle,Manager,State};
use serde_json::Value;
mod system_proxy;
mod engine;
use engine::{EngineManager,ConnectionStatus,LatencyResult};
const MAX_SUBSCRIPTION_BYTES:usize=2_000_000;

#[tauri::command]
fn read_clipboard_text()->Result<String,String>{
    let mut clipboard=arboard::Clipboard::new().map_err(|_|"Clipboard is unavailable")?;
    clipboard.get_text().map_err(|_|"Clipboard contains no readable text".into())
}
#[tauri::command]
async fn fetch_subscription_text(url:String)->Result<String,String>{
    let parsed=reqwest::Url::parse(url.trim()).map_err(|_|"Invalid subscription URL")?;
    if !matches!(parsed.scheme(),"http"|"https")||parsed.host_str().is_none()
        || !parsed.username().is_empty()||parsed.password().is_some()||parsed.fragment().is_some(){
        return Err("Only HTTP(S) subscription URLs are supported".into());
    }
    let host=parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if matches!(host.as_str(),"localhost"|"127.0.0.1"|"::1"){
        return Err("Localhost subscriptions are not supported".into());
    }
    let client=reqwest::Client::builder().timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("SimpleRay/0.3")
        .build().map_err(|_|"Subscription HTTP client unavailable")?;
    let mut response=client.get(parsed).send().await.map_err(|_|"Unable to download subscription (network or certificate error)")?;
    if !response.status().is_success(){return Err(format!("Subscription server responded with HTTP {}",response.status().as_u16()))}
    if response.content_length().is_some_and(|n|n>MAX_SUBSCRIPTION_BYTES as u64){return Err("Subscription is too large".into())}
    let mut bytes=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(|_|"Subscription download was interrupted")?{
        if bytes.len().saturating_add(chunk.len())>MAX_SUBSCRIPTION_BYTES{return Err("Subscription is too large".into())}
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_|"Subscription is not valid UTF-8".into())
}
#[tauri::command]
async fn connect_server(app:AppHandle,manager:State<'_,EngineManager>,server_id:String,outbound:Value)->Result<ConnectionStatus,String>{
    manager.connect(&app,server_id,outbound).await
}
#[tauri::command]
async fn disconnect_server(app:AppHandle,manager:State<'_,EngineManager>)->Result<ConnectionStatus,String>{
    manager.disconnect(&app).await
}
#[tauri::command]
async fn connection_status(app:AppHandle,manager:State<'_,EngineManager>)->Result<ConnectionStatus,String>{
    manager.status(&app).await
}
#[tauri::command]
async fn measure_server_latency(app:AppHandle,outbound:Value,samples:u8)->Result<LatencyResult,String>{
    engine::ping_server(&app,outbound,samples).await
}
#[cfg_attr(mobile,tauri::mobile_entry_point)]
pub fn run(){
    tauri::Builder::default()
        .manage(EngineManager::default())
        .setup(|app|{
            // If a previous session crashed while System Proxy was enabled, restore its prior settings.
            // An unrecoverable record blocks proxy takeover instead of overwriting unknown user settings.
            if let Err(e)=system_proxy::recover(&app.handle().clone()){
                eprintln!("SimpleRay proxy recovery unavailable: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_clipboard_text,fetch_subscription_text,
            connect_server,disconnect_server,connection_status,measure_server_latency
        ])
        .build(tauri::generate_context!())
        .expect("failed to initialize SimpleRay")
        .run(|app,event|{
            if let tauri::RunEvent::Exit=event{
                let handle=app.clone();
                let manager=handle.state::<EngineManager>();
                tauri::async_runtime::block_on(manager.shutdown(&handle));
            }
        });
}

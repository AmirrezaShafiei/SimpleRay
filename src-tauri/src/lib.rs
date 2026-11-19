use std::time::Duration;
use tauri::{AppHandle,Manager,State};
use serde_json::Value;
mod system_proxy;
mod routing;
mod diagnostics;
mod network_events;

#[derive(Default)]
struct RoutingGuard(tokio::sync::Mutex<()>);
mod preferences;
mod tray;
mod engine;
mod switching;
mod phone_transfer;
use engine::{EngineManager,ConnectionStatus,LatencyResult};
use preferences::{DesktopPreferences,DesktopSettings};
use tray::ExitGuard;
use phone_transfer::{Invite, PhoneTransfer, Receipt};
const MAX_SUBSCRIPTION_BYTES:usize=2_000_000;

#[tauri::command]
fn read_clipboard_text()->Result<String,String>{
    let mut clipboard=arboard::Clipboard::new().map_err(|_|"Clipboard is unavailable")?;
    clipboard.get_text().map_err(|_|"Clipboard contains no readable text".into())
}
#[tauri::command]
fn phone_transfer_addresses() -> Result<Vec<String>, String> {
    phone_transfer::addresses()
}
#[tauri::command]
async fn start_phone_transfer(receiver: State<'_, PhoneTransfer>, address: String) -> Result<Invite, String> {
    receiver.start(address).await
}
#[tauri::command]
fn poll_phone_transfer(receiver: State<'_, PhoneTransfer>, id: String) -> Result<Receipt, String> {
    receiver.poll(&id)
}
#[tauri::command]
fn cancel_phone_transfer(receiver: State<'_, PhoneTransfer>, id: String) -> Result<(), String> {
    receiver.cancel(&id)
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
async fn connect_server(app:AppHandle,manager:State<'_,EngineManager>,server_id:String,outbound:Value,display_name:Option<String>)->Result<ConnectionStatus,String>{
    manager.connect(&app,server_id,outbound,display_name.unwrap_or_default()).await
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
async fn restore_system_proxy(app:AppHandle,manager:State<'_,EngineManager>)->Result<ConnectionStatus,String>{
    manager.repair_system_proxy(&app).await
}
#[tauri::command]
async fn ping_active_connection(app:AppHandle,manager:State<'_,EngineManager>,server_id:String)->Result<u64,String>{
    manager.ping_active(&app,&server_id,false).await
}
#[tauri::command]
async fn measure_server_latency(
    app:AppHandle, webview:tauri::Webview, manager:State<'_,EngineManager>,
    outbound:Value, samples:u8, on_first:Option<tauri::ipc::JavaScriptChannelId>,
)->Result<LatencyResult,String>{
    let progress=on_first.map(|channel|channel.channel_on(webview));
    manager.measure_candidate(&app,outbound,samples,progress).await
}
#[tauri::command]
async fn configure_server_switching(manager:State<'_,EngineManager>,mode:switching::SwitchMode,candidates:Vec<switching::Profile>)->Result<(),String>{
    manager.configure_switching(mode,candidates).await
}
#[tauri::command]
async fn accept_server_suggestion(app:AppHandle,manager:State<'_,EngineManager>,server_id:String)->Result<ConnectionStatus,String>{
    manager.accept_switch(&app,&server_id,None).await
}
#[tauri::command]
fn tray_panel_action(app:AppHandle,window:tauri::WebviewWindow,action:tray::PanelAction,server_id:Option<String>)->Result<(),String>{
    tray::panel_action(&app,&window,action,server_id)
}
#[tauri::command]
fn publish_tray_panel(app:AppHandle,window:tauri::WebviewWindow,snapshot:Value)->Result<(),String>{
    tray::publish_panel(&app,&window,&snapshot)
}
#[tauri::command]
async fn retry_tray_connection(app:AppHandle,manager:State<'_,EngineManager>,server_id:String)->Result<ConnectionStatus,String>{
    manager.retry(&app,&server_id).await
}
#[tauri::command]
fn dismiss_tray_suggestion(window:tauri::WebviewWindow)->Result<(),String>{
    tray::dismiss_suggestion(&window)
}
#[tauri::command]
async fn accept_tray_suggestion(
    app:AppHandle,window:tauri::WebviewWindow,server_id:String,generation:u64,revision:u64,
)->Result<(),String>{
    tray::accept_suggestion(&app,&window,&server_id,generation,revision).await
}
#[tauri::command]
async fn undo_server_switch(app:AppHandle,manager:State<'_,EngineManager>)->Result<ConnectionStatus,String>{
    manager.undo_switch(&app).await
}
#[tauri::command]
fn get_desktop_settings(settings:State<'_,DesktopSettings>)->DesktopPreferences{settings.get()}
#[tauri::command]
fn set_desktop_settings(app:AppHandle,settings:State<'_,DesktopSettings>,preferences:DesktopPreferences)->Result<DesktopPreferences,String>{
    settings.set(&app,preferences)
}
#[tauri::command]
fn get_autostart_enabled()->Result<bool,String>{preferences::startup_enabled()}
#[tauri::command]
fn set_autostart_enabled(enabled:bool)->Result<bool,String>{preferences::set_startup_enabled(enabled)}
#[tauri::command]
fn show_main_window(app:AppHandle)->Result<(),String>{
    let window=app.get_webview_window("main").ok_or("Main window unavailable")?;
    window.show().map_err(|_|"Cannot show SimpleRay".to_string())
}
#[tauri::command]
fn get_routing_settings(app:AppHandle)->Result<routing::Routing,String>{routing::load(&app)}
#[tauri::command]
async fn set_routing_settings(app:AppHandle,guard:State<'_,RoutingGuard>,settings:routing::Routing)->Result<bool,String>{
    let _operation=guard.0.lock().await;
    let result=routing::save(&app,settings).await;
    if result.is_err(){app.state::<diagnostics::Diagnostics>().record("Routing settings could not be applied.");}
    result
}
#[tauri::command]
async fn choose_routing_app()->Result<Option<String>,String>{routing::choose_executable().await}
#[tauri::command]
fn exit_ip_history(state:State<'_,diagnostics::Diagnostics>,server_id:String)->Vec<diagnostics::ExitEntry>{state.history(&server_id)}
#[tauri::command]
fn error_report(app:AppHandle,state:State<'_,diagnostics::Diagnostics>)->String{
    let mode=match routing::load(&app).map(|settings|settings.mode){
        Ok(routing::Mode::SystemProxy)=>"System Proxy",
        Ok(routing::Mode::Tun)=>"TUN",
        Err(_)=>"Unavailable",
    };
    state.report(mode)
}
#[tauri::command]
fn copy_error_report(text:String)->Result<(),String>{
    if text.len()>16_384 {return Err("Report is too large".into());}
    arboard::Clipboard::new().and_then(|mut clipboard|clipboard.set_text(text))
        .map_err(|_|"Unable to copy report to the clipboard".into())
}
#[tauri::command]
async fn rename_active_server(app:AppHandle,manager:State<'_,EngineManager>,server_id:String,display_name:String)->Result<(),String>{
    manager.rename_active(&app,&server_id,display_name).await;
    Ok(())
}
#[tauri::command]
async fn cancel_network_recovery(manager:State<'_,EngineManager>)->Result<(),String>{
    manager.cancel_recovery().await;
    Ok(())
}

#[cfg_attr(mobile,tauri::mobile_entry_point)]
pub fn run(){
    let builder = tauri::Builder::default();
    #[cfg(target_os="windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        if !args.iter().any(|arg| arg == "--minimized") {
            tray::show_main(app);
        }
    }));

    builder
        .manage(EngineManager::default())
        .manage(ExitGuard::default())
        .manage(PhoneTransfer::default())
        .manage(RoutingGuard::default())
        .manage(tray::ConnectionTray::default())
        .setup(|app|{
            if let Err(error)=preferences::initialize_startup(){
                eprintln!("Could not initialize Start with Windows: {error}");
            }
            // If a previous session crashed while System Proxy was enabled, restore its prior settings.
            // An unrecoverable record blocks proxy takeover instead of overwriting unknown user settings.
            if let Err(e)=system_proxy::recover(&app.handle().clone()){
                eprintln!("SimpleRay proxy recovery unavailable: {e}");
            }
            app.manage(DesktopSettings::new(app.handle()));
            app.manage(diagnostics::Diagnostics::new(app.handle()));
            tray::setup(app)?;
            network_events::start(app.handle());
            let handle=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle.state::<EngineManager>().monitor_core(&handle).await;
            });
            let handle=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle.state::<EngineManager>().monitor_latency(&handle).await;
            });
            let handle=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle.state::<EngineManager>().monitor_candidates(&handle).await;
            });
            let handle=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tray::monitor_suggestions(&handle).await;
            });
            if !std::env::args().any(|arg|arg=="--minimized") {
                tray::show_main(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_clipboard_text,fetch_subscription_text,
            phone_transfer_addresses,start_phone_transfer,poll_phone_transfer,cancel_phone_transfer,
            connect_server,disconnect_server,connection_status,restore_system_proxy,
            ping_active_connection,measure_server_latency,
            configure_server_switching,accept_server_suggestion,undo_server_switch,
            dismiss_tray_suggestion,accept_tray_suggestion,tray_panel_action,publish_tray_panel,retry_tray_connection,
            get_desktop_settings,set_desktop_settings,get_autostart_enabled,set_autostart_enabled,show_main_window,
            get_routing_settings,set_routing_settings,choose_routing_app,exit_ip_history,error_report,copy_error_report,rename_active_server,cancel_network_recovery
        ])
        .on_window_event(tray::handle_window_event)
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

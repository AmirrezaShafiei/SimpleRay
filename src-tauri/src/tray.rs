//! The webview stays mounted when the main window is hidden, so clipboard,
//! connection and subscription state are not destroyed by a close-to-tray action.
use std::{sync::atomic::{AtomicBool,Ordering},time::{Duration,Instant}};
use tauri::{AppHandle,Manager,PhysicalPosition,WebviewUrl,WebviewWindow,WebviewWindowBuilder,WindowEvent,menu::{Menu,MenuItem},tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState}};
use crate::{engine::EngineManager,preferences::DesktopSettings,switching::TraySuggestion};

#[derive(Default)]
pub struct ExitGuard(pub AtomicBool);

const PANEL_WINDOW: &str = "tray-panel";
const PANEL_SIZE: (f64, f64) = (356.0, 370.0);

const SUGGESTION_WINDOW:&str="tray-suggestion";
const SUGGESTION_SIZE:(f64,f64)=(358.0,146.0);
const SUGGESTION_GAP:Duration=Duration::from_secs(60);

pub fn show_main(app:&AppHandle) {
    hide_panel(app);
    if let Some(popup)=app.get_webview_window(SUGGESTION_WINDOW) {let _=popup.hide();}
    if let Some(window)=app.get_webview_window("main") {
        let _=window.show();
        let _=window.unminimize();
        let _=window.set_focus();
    }
}

fn request_toggle(app:&AppHandle) {
    if let Some(window)=app.get_webview_window("main") {
        let _=window.eval("window.dispatchEvent(new Event('simpleray:tray-toggle'))");
    }
}

pub fn request_exit(app:AppHandle) {
    let guard=app.state::<ExitGuard>();
    if guard.0.swap(true,Ordering::SeqCst){return;}
    tauri::async_runtime::spawn(async move {
        let manager=app.state::<EngineManager>();
        match manager.disconnect(&app).await {
            Ok(_)=>app.exit(0),
            Err(error)=>{
                // Keeping Xray alive is safer than exiting with OS System Proxy
                // still pointing to a non-existent localhost listener.
                eprintln!("SimpleRay could not cleanly restore System Proxy: {error}");
                show_main(&app);
                if let Some(window)=app.get_webview_window("main") {
                    let _=window.eval("window.dispatchEvent(new Event('simpleray:exit-blocked'))");
                }
                app.state::<ExitGuard>().0.store(false,Ordering::SeqCst);
            }
        }
    });
}

fn send_to_main(app: &AppHandle, name: &str, payload: &serde_json::Value) -> Result<(), String> {
    let main=app.get_webview_window("main").ok_or("Main window unavailable")?;
    dispatch(&main,name,payload)
}

fn dispatch(window: &WebviewWindow, event: &str, payload: &serde_json::Value) -> Result<(), String> {
    window.eval(format!("window.dispatchEvent(new CustomEvent('{event}',{{detail:{payload}}}))"))
        .map_err(|error| error.to_string())
}

fn hide_panel(app: &AppHandle) {
    if let Some(panel)=app.get_webview_window(PANEL_WINDOW) {
        if panel.is_visible().unwrap_or(false) {
            let _=panel.hide();
            let _=send_to_main(app,"simpleray:tray-panel-visible",&serde_json::json!(false));
        }
    }
}

fn open_panel(app: &AppHandle, point: PhysicalPosition<f64>) -> tauri::Result<()> {
    let Some(panel)=app.get_webview_window(PANEL_WINDOW) else { return Ok(()); };
    if panel.is_visible()? {
        hide_panel(app);
        return Ok(());
    }
    if let Some(monitor)=panel.monitor_from_point(point.x,point.y)?.or(panel.primary_monitor()?) {
        let area=monitor.work_area();
        let scale=monitor.scale_factor();
        let gap=(6.0*scale).round() as i32;
        let width=(PANEL_SIZE.0*scale).round() as i32;
        let height=(PANEL_SIZE.1*scale).round() as i32;
        let left=area.position.x;
        let top=area.position.y;
        let right=left+area.size.width as i32;
        let bottom=top+area.size.height as i32;
        let x=(point.x.round() as i32-width/2).clamp(left+gap,(right-width-gap).max(left+gap));
        let y=(point.y.round() as i32-height-gap).clamp(top+gap,(bottom-height-gap).max(top+gap));
        panel.set_position(PhysicalPosition::new(x,y))?;
    }
    if let Some(notice)=app.get_webview_window(SUGGESTION_WINDOW) { let _=notice.hide(); }
    panel.show()?;
    let _=panel.set_focus();
    let _=send_to_main(app,"simpleray:tray-panel-visible",&serde_json::json!(true));
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PanelAction { Refresh, Connect, Cancel, Disconnect, RestoreProxy, Retry, Switch, Open, Exit, Close }

pub fn panel_action(app:&AppHandle,window:&WebviewWindow,action:PanelAction,server_id:Option<String>)->Result<(),String>{
    if window.label()!=PANEL_WINDOW {return Err("Unknown tray panel".into());}
    if !window.is_visible().unwrap_or(false) {return Ok(());}
    match action {
        PanelAction::Open=>{show_main(app);Ok(())}
        PanelAction::Exit=>{hide_panel(app);request_exit(app.clone());Ok(())}
        PanelAction::Close=>{hide_panel(app);Ok(())}
        PanelAction::Refresh=>send_to_main(app,"simpleray:tray-panel-visible",&serde_json::json!(true)),
        action=>{
            let command=match action{
                PanelAction::Connect=>"connect",
                PanelAction::Cancel=>"cancel",
                PanelAction::Disconnect=>"disconnect",
                PanelAction::RestoreProxy=>"restoreProxy",
                PanelAction::Retry=>"retry",
                PanelAction::Switch=>"switch",
                _=>unreachable!(),
            };
            if server_id.as_ref().is_some_and(|id|id.len()>256) {return Err("Invalid server selection".into());}
            send_to_main(app,"simpleray:tray-panel-action",&serde_json::json!({ "action":command,"serverId":server_id }))
        }
    }
}

pub fn publish_panel(app:&AppHandle,window:&WebviewWindow,snapshot:&serde_json::Value)->Result<(),String>{
    if window.label()!="main" {return Err("Unknown tray panel data source".into());}
    if let Some(panel)=app.get_webview_window(PANEL_WINDOW).filter(|panel|panel.is_visible().unwrap_or(false)){
        dispatch(&panel,"simpleray:tray-panel-snapshot",snapshot)?;
    }
    Ok(())
}

pub fn setup(app:&tauri::App)->Result<(), Box<dyn std::error::Error>> {
    let panel=WebviewWindowBuilder::new(app,PANEL_WINDOW,WebviewUrl::App("tray-panel.html".into()))
        .title("SimpleRay tray panel")
        .inner_size(PANEL_SIZE.0,PANEL_SIZE.1)
        .visible(false).focused(false)
        .decorations(false).resizable(false).always_on_top(true).skip_taskbar(true)
        .build();
    let icon=app.default_window_icon().ok_or("No SimpleRay tray icon configured")?.clone();
    let mut builder=TrayIconBuilder::with_id("simpleray-tray")
        .icon(icon)
        .tooltip("SimpleRay")
        .on_tray_icon_event(|tray,event| {
            if let TrayIconEvent::Click {button,button_state:MouseButtonState::Up,position,..}=event {
                let app=tray.app_handle();
                match button {
                    MouseButton::Left=>show_main(app),
                    MouseButton::Right=>{
                        if let Err(error)=open_panel(app,position) {
                            eprintln!("SimpleRay could not open the tray panel: {error}");
                        }
                    }
                    _=>{}
                }
            }
        });
    if let Err(error)=panel {
        eprintln!("SimpleRay could not prepare the tray panel: {error}");
        let show=MenuItem::with_id(app,"show","Show SimpleRay",true,None::<&str>)?;
        let toggle=MenuItem::with_id(app,"toggle","Connect / Disconnect",true,None::<&str>)?;
        let quit=MenuItem::with_id(app,"quit","Exit SimpleRay",true,None::<&str>)?;
        let menu=Menu::with_items(app,&[&show,&toggle,&quit])?;
        builder=builder.menu(&menu).show_menu_on_left_click(false)
            .on_menu_event(|app,event|match event.id.as_ref() {
                "show"=>show_main(app),
                "toggle"=>request_toggle(app),
                "quit"=>request_exit(app.clone()),
                _=>{}
            });
    }
    builder.build(app)?;
    if let Err(error)=WebviewWindowBuilder::new(app,SUGGESTION_WINDOW,WebviewUrl::App("tray-suggestion.html".into()))
        .title("SimpleRay server suggestion")
        .inner_size(SUGGESTION_SIZE.0,SUGGESTION_SIZE.1)
        .visible(false).focused(false).focusable(false)
        .decorations(false).resizable(false).always_on_top(true).skip_taskbar(true)
        .build() {
        eprintln!("SimpleRay could not prepare the suggestion popup: {error}");
    }
    Ok(())
}

pub fn handle_window_event(window:&tauri::Window,event:&WindowEvent) {
    if window.label()==PANEL_WINDOW {
        match event {
            WindowEvent::CloseRequested{api,..}=>{api.prevent_close();hide_panel(window.app_handle());}
            WindowEvent::Focused(false)=>hide_panel(window.app_handle()),
            _=>{}
        }
        return;
    }
    if window.label()==SUGGESTION_WINDOW {
        if let WindowEvent::CloseRequested{api,..}=event {
            api.prevent_close();
            let _=window.hide();
        }
        return;
    }
    if window.label()!="main" {return}
    if let WindowEvent::CloseRequested{api,..}=event {
        api.prevent_close();
        let app=window.app_handle();
        if app.state::<DesktopSettings>().get().minimize_to_tray {
            let _=window.hide();
        } else {
            request_exit(app.clone());
        }
    }
}


fn position_suggestion(main:&WebviewWindow,popup:&WebviewWindow)->tauri::Result<()> {
    let Some(monitor)=main.primary_monitor()? else {return Ok(())};
    let area=monitor.work_area();
    let scale=monitor.scale_factor();
    let margin=(14.0*scale).round() as i32;
    let width=(SUGGESTION_SIZE.0*scale).round() as i32;
    let height=(SUGGESTION_SIZE.1*scale).round() as i32;
    popup.set_position(PhysicalPosition::new(
        area.position.x+(area.size.width as i32-width-margin).max(0),
        area.position.y+(area.size.height as i32-height-margin).max(0),
    ))
}

pub async fn monitor_suggestions(app:&AppHandle) {
    let (Some(main),Some(popup))=(app.get_webview_window("main"),app.get_webview_window(SUGGESTION_WINDOW)) else {
        return;
    };
    let mut last_notice:Option<(TraySuggestion,Instant)>=None;
    let mut ticks=tokio::time::interval(Duration::from_secs(1));
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        ticks.tick().await;
        if app.get_webview_window(PANEL_WINDOW).is_some_and(|panel|panel.is_visible().unwrap_or(false)){
            if popup.is_visible().unwrap_or(false){let _=popup.hide();}
            continue;
        }
        if main.is_visible().unwrap_or(true) && !main.is_minimized().unwrap_or(false) {
            if popup.is_visible().unwrap_or(false) {let _=popup.hide();}
            continue;
        }
        if popup.is_visible().unwrap_or(true) {continue;}
        let Some(offer)=app.state::<EngineManager>().tray_suggestion().await else {continue;};
        let now=Instant::now();
        if last_notice.as_ref().is_some_and(|(last,time)| {
            offer.same_offer(last) || now.duration_since(*time)<SUGGESTION_GAP
        }) {continue;}
        if position_suggestion(&main,&popup).is_err() {continue;}
        let Ok(payload)=serde_json::to_string(&offer) else {continue;};
        if popup.eval(format!("window.dispatchEvent(new CustomEvent('simpleray:suggestion',{{detail:{payload}}}))")).is_ok()
            && popup.show().is_ok() {
            last_notice=Some((offer,now));
        }
    }
}

pub fn dismiss_suggestion(window:&WebviewWindow)->Result<(),String> {
    if window.label()!=SUGGESTION_WINDOW {return Err("Unknown suggestion window".into());}
    window.hide().map_err(|_|"Could not close the suggestion".into())
}

pub async fn accept_suggestion(
    app:&AppHandle,window:&WebviewWindow,server_id:&str,generation:u64,revision:u64,
)->Result<(),String> {
    if window.label()!=SUGGESTION_WINDOW {return Err("Unknown suggestion window".into());}
    let result=app.state::<EngineManager>().accept_switch(app,server_id,Some((generation,revision))).await?;
    if let (Some(main),Some(id))=(app.get_webview_window("main"),result.server_id) {
        if let Ok(id)=serde_json::to_string(&id) {
            let _=main.eval(format!("window.dispatchEvent(new CustomEvent('simpleray:tray-switched',{{detail:{id}}}))"));
        }
    }
    Ok(())
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ConnectionColor { Blue, Green, Red }

#[derive(Default)]
pub struct ConnectionTray(std::sync::Mutex<Option<(ConnectionColor,String)>>);

pub fn connection_icon(app:&AppHandle,color:ConnectionColor,name:Option<&str>,latency:Option<u64>,outage:Option<u64>) {
    let name=name.map(|name|name.chars().filter(|ch|!ch.is_control()).take(38).collect::<String>());
    let mut tooltip="SimpleRay".to_string();
    if let Some(name)=name.filter(|name|!name.is_empty()){tooltip.push_str(" · ");tooltip.push_str(&name);}
    if let Some(ms)=latency{tooltip.push_str(&format!(" · {ms} ms"));}
    if let Some(seconds)=outage{
        let elapsed=if seconds<60 {format!("{seconds}s")} else if seconds<3600 {format!("{}m {}s",seconds/60,seconds%60)} else {format!("{}h {}m",seconds/3600,seconds/60%60)};
        tooltip.push_str(&format!(" · Down {elapsed}"));
    }
    let Some(tray)=app.tray_by_id("simpleray-tray") else{return};
    let state=app.state::<ConnectionTray>();
    let Ok(mut previous)=state.0.lock() else{return};
    if previous.as_ref().is_none_or(|(_,text)|*text!=tooltip) {
        let _=tray.set_tooltip(Some(&tooltip));
    }
    if previous.as_ref().is_none_or(|(old,_)|*old!=color){
        if let Some(original)=app.default_window_icon(){
            let icon=match color{
                ConnectionColor::Blue=>original.clone(),
                _=>{
                    let palette=if color==ConnectionColor::Green{[35u8,217,135]}else{[250u8,75,101]};
                    let mut pixels=original.rgba().to_vec();
                    for pixel in pixels.chunks_exact_mut(4) {
                        if pixel[3]==0 || pixel[2].saturating_sub(pixel[0])<28 {continue;}
                        let scale=f32::from(pixel[2])/255.0;
                        for (channel,level) in pixel.iter_mut().zip(palette){
                            *channel=(f32::from(level)*scale).round() as u8;
                        }
                    }
                    tauri::image::Image::new_owned(pixels,original.width(),original.height())
                }
            };
            let _=tray.set_icon(Some(icon.clone()));
            if let Some(window)=app.get_webview_window("main"){let _=window.set_icon(icon);}
        }
    }
    *previous=Some((color,tooltip));
}

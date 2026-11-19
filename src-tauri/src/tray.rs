//! The webview stays mounted when the main window is hidden, so clipboard,
//! connection and subscription state are not destroyed by a close-to-tray action.
use std::{sync::atomic::{AtomicBool,Ordering},time::{Duration,Instant}};
use tauri::{AppHandle,Manager,PhysicalPosition,WebviewUrl,WebviewWindow,WebviewWindowBuilder,WindowEvent,menu::{Menu,MenuItem},tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState}};
use crate::{engine::EngineManager,preferences::DesktopSettings,switching::TraySuggestion};

#[derive(Default)]
pub struct ExitGuard(pub AtomicBool);

const SUGGESTION_WINDOW:&str="tray-suggestion";
const SUGGESTION_SIZE:(f64,f64)=(358.0,146.0);
const SUGGESTION_GAP:Duration=Duration::from_secs(60);

pub fn show_main(app:&AppHandle) {
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

pub fn setup(app:&tauri::App)->Result<(), Box<dyn std::error::Error>> {
    let show=MenuItem::with_id(app,"show","Show SimpleRay",true,None::<&str>)?;
    let toggle=MenuItem::with_id(app,"toggle","Connect / Disconnect",true,None::<&str>)?;
    let quit=MenuItem::with_id(app,"quit","Exit SimpleRay",true,None::<&str>)?;
    let menu=Menu::with_items(app,&[&show,&toggle,&quit])?;
    let icon=app.default_window_icon().ok_or("No SimpleRay tray icon configured")?.clone();
    TrayIconBuilder::with_id("simpleray-tray")
        .icon(icon)
        .tooltip("SimpleRay")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app,event|match event.id.as_ref() {
            "show"=>show_main(app),
            "toggle"=>request_toggle(app),
            "quit"=>request_exit(app.clone()),
            _=>{}
        })
        .on_tray_icon_event(|tray,event| {
            if let TrayIconEvent::Click {button:MouseButton::Left,button_state:MouseButtonState::Up,..}=event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
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

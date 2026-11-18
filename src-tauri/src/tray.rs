//! The webview stays mounted when the main window is hidden, so clipboard,
//! connection and subscription state are not destroyed by a close-to-tray action.
use std::sync::atomic::{AtomicBool,Ordering};
use tauri::{AppHandle,Manager,WindowEvent,menu::{Menu,MenuItem},tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState}};
use crate::{engine::EngineManager,preferences::DesktopSettings};

#[derive(Default)]
pub struct ExitGuard(pub AtomicBool);

fn show_main(app:&AppHandle) {
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
    Ok(())
}

pub fn handle_window_event(window:&tauri::Window,event:&WindowEvent) {
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

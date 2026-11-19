//! System Tray + unobtrusive server quick switch. No hover popup.
use std::{sync::{atomic::{AtomicBool,Ordering},Mutex,OnceLock},time::{Duration,Instant}};
use tauri::{AppHandle,Manager,WindowEvent,PhysicalPosition,menu::{Menu,MenuItem},tray::{TrayIconBuilder,TrayIconEvent,MouseButton,MouseButtonState}};
use crate::{engine::EngineManager,preferences::DesktopSettings};

#[derive(Default)]
pub struct ExitGuard(pub AtomicBool);
pub fn show_main(app:&AppHandle){
    if let Some(quick)=app.get_webview_window("quick"){let _=quick.hide();}
    if let Some(main)=app.get_webview_window("main"){
        let _=main.show();let _=main.unminimize();let _=main.set_focus();
    }
}
fn main_is_visible(app:&AppHandle)->bool{
    app.get_webview_window("main").and_then(|w|w.is_visible().ok()).unwrap_or(true)
}
fn request_toggle(app:&AppHandle){
    if let Some(main)=app.get_webview_window("main"){let _=main.eval("window.dispatchEvent(new Event('simpleray:tray-toggle'))");}
}
pub fn show_quick(app:&AppHandle,anchor:Option<PhysicalPosition<f64>>){
    let Some(window)=app.get_webview_window("quick") else {return};
    if anchor.is_some()&&window.is_visible().unwrap_or(false){let _=window.hide();return;}
    let point=anchor.unwrap_or_else(||app.primary_monitor().ok().flatten().map_or(
        PhysicalPosition::new(0.,0.),|m|{
            let a=m.work_area();
            PhysicalPosition::new((a.position.x+a.size.width as i32-12) as f64,(a.position.y+a.size.height as i32-12) as f64)
        }));
    let monitor=app.available_monitors().unwrap_or_default().into_iter().find(|m|{
        let a=m.work_area();
        point.x>=a.position.x as f64&&point.x<=(a.position.x+a.size.width as i32) as f64&&
        point.y>=a.position.y as f64-55.&&point.y<=(a.position.y+a.size.height as i32+55) as f64
    }).or_else(||app.primary_monitor().ok().flatten());
    if let Some(m)=monitor{
        let area=m.work_area();let scale=m.scale_factor();
        let width=(366.*scale).round() as i32;let height=(470.*scale).round() as i32;
        let x=((point.x as i32)-width+24).clamp(area.position.x,(area.position.x+area.size.width as i32-width).max(area.position.x));
        let y=((point.y as i32)-height-12).clamp(area.position.y,(area.position.y+area.size.height as i32-height).max(area.position.y));
        let _=window.set_position(PhysicalPosition::new(x,y));
    }
    let _=window.show();let _=window.set_focus();
}
static LAST_SUGGESTION:OnceLock<Mutex<Option<(String,Instant)>>> = OnceLock::new();
pub fn maybe_show_suggestion(app:&AppHandle,server_id:&str){
    if main_is_visible(app){return;}
    let holder=LAST_SUGGESTION.get_or_init(||Mutex::new(None));
    let Ok(mut last)=holder.lock() else{return};
    let now=Instant::now();
    if last.as_ref().is_some_and(|(id,at)|id==server_id&&now.duration_since(*at)<Duration::from_secs(90)){return;}
    *last=Some((server_id.to_owned(),now));drop(last);
    show_quick(app,None);
    if let Some(window)=app.get_webview_window("quick"){
        let _=window.eval("window.dispatchEvent(new Event('simpleray:auto-suggest'))");
    }
}
pub fn request_exit(app:AppHandle){
    let guard=app.state::<ExitGuard>();
    if guard.0.swap(true,Ordering::SeqCst){return;}
    tauri::async_runtime::spawn(async move {
        let manager=app.state::<EngineManager>();
        match manager.disconnect(&app).await {
            Ok(_)=>app.exit(0),
            Err(error)=>{
                eprintln!("SimpleRay could not restore System Proxy: {error}");
                show_main(&app);
                if let Some(window)=app.get_webview_window("main"){let _=window.eval("window.dispatchEvent(new Event('simpleray:exit-blocked'))");}
                app.state::<ExitGuard>().0.store(false,Ordering::SeqCst);
            }
        }
    });
}
pub fn setup(app:&tauri::App)->Result<(),Box<dyn std::error::Error>>{
    let quick=MenuItem::with_id(app,"quick","Quick Switch",true,None::<&str>)?;
    let show=MenuItem::with_id(app,"show","Show SimpleRay",true,None::<&str>)?;
    let toggle=MenuItem::with_id(app,"toggle","Connect / Disconnect",true,None::<&str>)?;
    let quit=MenuItem::with_id(app,"quit","Exit SimpleRay",true,None::<&str>)?;
    let menu=Menu::with_items(app,&[&quick,&show,&toggle,&quit])?;
    let icon=app.default_window_icon().ok_or("No tray icon configured")?.clone();
    TrayIconBuilder::with_id("simpleray-tray").icon(icon).tooltip("SimpleRay")
        .menu(&menu).show_menu_on_left_click(false)
        .on_menu_event(|app,event|match event.id.as_ref(){
            "quick"=>show_quick(app,None),"show"=>show_main(app),
            "toggle"=>request_toggle(app),"quit"=>request_exit(app.clone()),_=>{}
        })
        .on_tray_icon_event(|tray,event|{
            if let TrayIconEvent::Click{button:MouseButton::Left,button_state:MouseButtonState::Up,position,..}=event {
                show_quick(tray.app_handle(),Some(position));
            }
        }).build(app)?;
    Ok(())
}
pub fn handle_window_event(window:&tauri::Window,event:&WindowEvent){
    if window.label()=="quick"{
        match event{
            WindowEvent::CloseRequested{api,..}=>{api.prevent_close();let _=window.hide();},
            WindowEvent::Focused(false)=>{let _=window.hide();},
            _=>{}
        }
        return;
    }
    if window.label()!="main"{return}
    if let WindowEvent::CloseRequested{api,..}=event{
        api.prevent_close();let app=window.app_handle();
        if app.state::<DesktopSettings>().get().minimize_to_tray{let _=window.hide();}
        else{request_exit(app.clone());}
    }
}

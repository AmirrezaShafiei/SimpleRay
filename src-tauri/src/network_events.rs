#[cfg(windows)]
pub fn start(app: &tauri::AppHandle) {
    use crate::engine::EngineManager;
    use std::ffi::c_void;
    use tauri::Manager;
    use tokio::sync::mpsc;

    #[repr(C)]
    struct PowerCallback {
        callback: unsafe extern "system" fn(*mut c_void, u32, *mut c_void) -> u32,
        context: *mut c_void,
    }

    #[link(name="iphlpapi")]
    extern "system" {
        fn NotifyIpInterfaceChange(
            family: u16,
            callback: unsafe extern "system" fn(*mut c_void, *mut c_void, i32),
            context: *mut c_void,
            initial: u8,
            handle: *mut *mut c_void,
        ) -> u32;
    }
    #[link(name="powrprof")]
    extern "system" {
        fn PowerRegisterSuspendResumeNotification(
            flags:u32, callback:*const PowerCallback, handle:*mut *mut c_void,
        ) -> u32;
    }

    unsafe extern "system" fn signal(context:*mut c_void) {
        let sender = &*context.cast::<mpsc::Sender<()>>();
        let _ = sender.try_send(());
    }
    unsafe extern "system" fn network_changed(context:*mut c_void, _interface:*mut c_void, _kind:i32) {
        signal(context);
    }
    unsafe extern "system" fn power_changed(context:*mut c_void, kind:u32, _details:*mut c_void)->u32 {
        if matches!(kind,0x07|0x12) {signal(context)}
        0
    }
    let (sender,mut receiver) = mpsc::channel::<()>(1);
    // Windows callbacks remain registered for the lifetime of the single app
    // process. The callback context must stay valid even during app shutdown.
    let context = Box::into_raw(Box::new(sender)).cast();
    let subscription=Box::into_raw(Box::new(PowerCallback{callback:power_changed,context}));
    let mut route_handle=std::ptr::null_mut();
    let mut power_handle=std::ptr::null_mut();
    let active=unsafe {
        let network=NotifyIpInterfaceChange(0,network_changed,context,0,&mut route_handle)==0;
        let power=PowerRegisterSuspendResumeNotification(2,subscription,&mut power_handle)==0;
        if !power {drop(Box::from_raw(subscription));}
        if !network&&!power {drop(Box::from_raw(context.cast::<mpsc::Sender<()>>()));}
        network||power
    };
    if !active {return;}
    let handle=app.clone();
    tauri::async_runtime::spawn(async move {
        while receiver.recv().await.is_some() {
            handle.state::<EngineManager>().recover_network(&handle).await;
            while receiver.try_recv().is_ok(){}
        }
    });
}

#[cfg(not(windows))]
pub fn start(_: &tauri::AppHandle) {}

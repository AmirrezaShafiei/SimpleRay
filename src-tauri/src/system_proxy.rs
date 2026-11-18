//! Scoped Windows user WinINet proxy manipulation and crash recovery.
//! This changes the current user's HTTP/HTTPS proxy, NOT the Windows TUN stack.
//! Never overwrite third-party changes made after SimpleRay connected.
use serde::{Deserialize,Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle,Manager};

#[derive(Clone,Debug,Serialize,Deserialize)]
pub struct ProxyBackup {
    pub original_enabled: Option<u32>,
    pub original_server: Option<String>,
    pub original_override: Option<String>,
    pub active_port: u16,
    #[serde(default)]
    pub previous_port: Option<u16>,
}
fn record_path(app:&AppHandle)->Result<PathBuf,String>{
    let dir=app.path().app_local_data_dir().map_err(|_|"Cannot access application data directory")?;
    fs::create_dir_all(&dir).map_err(|_|"Cannot create application data directory")?;
    Ok(dir.join("proxy-recovery.json"))
}
fn expected(port:u16)->String{format!("http=127.0.0.1:{port};https=127.0.0.1:{port}")}

#[cfg(target_os="windows")]
mod imp {
    use super::*;
    use winreg::{enums::{HKEY_CURRENT_USER,KEY_READ,KEY_SET_VALUE,KEY_QUERY_VALUE},RegKey};
    const INTERNET_SETTINGS:&str=r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    #[link(name="wininet")]
    extern "system" {
        fn InternetSetOptionW(handle:*mut core::ffi::c_void,option:u32,buffer:*mut core::ffi::c_void,length:u32)->i32;
    }
    fn notify_windows()->Result<(),String>{
        const SETTINGS_CHANGED:u32=39;
        const REFRESH:u32=37;
        unsafe {
            if InternetSetOptionW(std::ptr::null_mut(),SETTINGS_CHANGED,std::ptr::null_mut(),0)==0
            || InternetSetOptionW(std::ptr::null_mut(),REFRESH,std::ptr::null_mut(),0)==0 {
                return Err("Windows proxy notification failed".into());
            }
        }
        Ok(())
    }
    fn key()->Result<RegKey,String>{
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(INTERNET_SETTINGS,KEY_READ|KEY_QUERY_VALUE|KEY_SET_VALUE)
            .map_err(|_|"Cannot access Windows Internet Settings".to_string())
    }
    fn current_matches(k:&RegKey,port:u16)->bool{
        let enabled=k.get_value::<u32,_>("ProxyEnable").unwrap_or(0);
        let server=k.get_value::<String,_>("ProxyServer").unwrap_or_default();
        enabled==1&&server==expected(port)
    }
    pub fn enable(app:&AppHandle,port:u16)->Result<ProxyBackup,String>{
        // Snapshot must be durable BEFORE changing the registry: crash recovery.
        let k=key()?;
        let old=ProxyBackup{
            original_enabled:k.get_value::<u32,_>("ProxyEnable").ok(),
            original_server:k.get_value::<String,_>("ProxyServer").ok(),
            original_override:k.get_value::<String,_>("ProxyOverride").ok(),
            active_port:port,
            previous_port:None,
        };
        let path=record_path(app)?;
        if path.exists(){return Err("Unresolved previous proxy recovery record".into())}
        let serialized=serde_json::to_vec(&old).map_err(|_|"Could not serialize proxy recovery")?;
        fs::write(&path,serialized).map_err(|_|"Could not save Windows proxy recovery record")?;
        if let Err(_)=k.set_value("ProxyServer",&expected(port)).and_then(|_|k.set_value("ProxyEnable",&1u32)){
            // Registry may have been only partly modified; roll back immediately.
            let _=restore_values(&k,&old);
            let _=fs::remove_file(&path);
            return Err("Failed to enable Windows System Proxy".into());
        }
        if let Err(e)=notify_windows(){let _=restore(app,&old,port);return Err(e)}
        Ok(old)
    }
    pub fn switch(app:&AppHandle,backup:&mut ProxyBackup,old:u16,new_port:u16)->Result<(),String>{
        let k=key()?;
        if !current_matches(&k,old){return Err("System Proxy was changed externally; cannot switch automatically".into())}
        let path=record_path(app)?;
        let mut next=backup.clone();next.active_port=new_port;next.previous_port=Some(old);
        // During a crash window both endpoints should be recognized as ours.
        fs::write(&path,serde_json::to_vec(&next).map_err(|_|"Could not serialize recovery")?)
            .map_err(|_|"Could not update recovery record")?;
        if k.set_value("ProxyServer",&expected(new_port)).is_err(){
            let _=fs::write(&path,serde_json::to_vec(backup).unwrap_or_default());
            return Err("Windows proxy switch failed".into());
        }
        if let Err(e)=notify_windows(){
            let _=k.set_value("ProxyServer",&expected(old));let _=notify_windows();
            let _=fs::write(&path,serde_json::to_vec(backup).unwrap_or_default());
            return Err(e);
        }
        backup.active_port=new_port;
        backup.previous_port=None;
        // The bridge record supports a crash just before/after switching port.
        let _=fs::write(&path,serde_json::to_vec(backup).unwrap_or_default());
        Ok(())
    }
    fn restore_values(k:&RegKey,b:&ProxyBackup)->Result<(),String>{
        if let Some(v)=b.original_server.as_deref(){k.set_value("ProxyServer",&v).map_err(|_|"Could not restore ProxyServer")?}
        else {let _=k.delete_value("ProxyServer");}
        if let Some(v)=b.original_override.as_deref(){k.set_value("ProxyOverride",&v).map_err(|_|"Could not restore ProxyOverride")?}
        else {let _=k.delete_value("ProxyOverride");}
        if let Some(v)=b.original_enabled{k.set_value("ProxyEnable",&v).map_err(|_|"Could not restore ProxyEnable")?}
        else {let _=k.delete_value("ProxyEnable");}
        notify_windows()
    }
    pub fn restore(app:&AppHandle,b:&ProxyBackup,expected_port:u16)->Result<(),String>{
        let k=key()?;
        if current_matches(&k,expected_port)
            || b.previous_port.is_some_and(|old|current_matches(&k,old)) {
            restore_values(&k,b)?
        }
        // User/application changed proxy after we started: do not clobber it.
        let _=fs::remove_file(record_path(app)?);
        Ok(())
    }
    pub fn recover(app:&AppHandle)->Result<(),String>{
        let path=record_path(app)?;
        if !path.exists(){return Ok(())}
        let bytes=fs::read(&path).map_err(|_|"Unable to read previous proxy recovery file")?;
        let record:ProxyBackup=serde_json::from_slice(&bytes).map_err(|_|"Invalid proxy recovery file")?;
        restore(app,&record,record.active_port)
    }
}
#[cfg(not(target_os="windows"))]
mod imp {
    use super::*;
    pub fn enable(_app:&AppHandle,_port:u16)->Result<ProxyBackup,String>{Err("System Proxy integration requires Windows".into())}
    pub fn switch(_app:&AppHandle,_backup:&mut ProxyBackup,_old:u16,_new:u16)->Result<(),String>{Err("System Proxy integration requires Windows".into())}
    pub fn restore(_app:&AppHandle,_backup:&ProxyBackup,_expected_port:u16)->Result<(),String>{Ok(())}
    pub fn recover(_app:&AppHandle)->Result<(),String>{Ok(())}
}
pub use imp::{enable,switch,restore,recover};

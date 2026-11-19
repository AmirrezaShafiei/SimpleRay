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
    use std::io::{ErrorKind, Write};
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
    fn optional_value<T: winreg::types::FromRegValue>(key: &RegKey, name: &str) -> Result<Option<T>, String> {
        match key.get_value(name) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
            Err(_) => Err(format!("Could not read Windows {name}")),
        }
    }
    fn delete_value(key: &RegKey, name: &str) -> Result<(), String> {
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err(format!("Could not remove Windows {name}")),
        }
    }
    fn write_record(path: &std::path::Path, backup: &ProxyBackup, replace: bool) -> Result<(), String> {
        let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Proxy recovery directory unavailable")?)
            .map_err(|_| "Could not prepare Windows proxy recovery record")?;
        serde_json::to_writer(&mut file, backup).map_err(|_| "Could not save Windows proxy recovery record")?;
        file.flush().and_then(|_| file.as_file().sync_all())
            .map_err(|_| "Could not flush Windows proxy recovery record")?;
        let saved = if replace { file.persist(path) } else { file.persist_noclobber(path) };
        saved.map_err(|_| "Could not install Windows proxy recovery record".into()).map(|_| ())
    }
    fn remove_record(path: &std::path::Path) -> Result<(), String> {
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Could not remove Windows proxy recovery record".into()),
        }
    }
    pub fn is_active(port: u16) -> Result<bool, String> {
        let k = key()?;
        Ok(optional_value::<u32>(&k, "ProxyEnable")? == Some(1)
            && optional_value::<String>(&k, "ProxyServer")?.as_deref() == Some(&expected(port)))
    }
    pub fn enable(app:&AppHandle,port:u16)->Result<ProxyBackup,String>{
        // Snapshot must be durable BEFORE changing the registry: crash recovery.
        recover(app)?;
        let k=key()?;
        let old=ProxyBackup{
            original_enabled:optional_value(&k,"ProxyEnable")?,
            original_server:optional_value(&k,"ProxyServer")?,
            original_override:None,
            active_port:port,
            previous_port:None,
        };
        let path=record_path(app)?;
        write_record(&path, &old, false)?;
        if k.set_value("ProxyServer",&expected(port)).and_then(|_|k.set_value("ProxyEnable",&1u32)).is_err(){
            // Registry may have been only partly modified; roll back immediately.
            let _=restore(app,&old,port);
            return Err("Failed to enable Windows System Proxy".into());
        }
        if let Err(e)=notify_windows(){let _=restore(app,&old,port);return Err(e)}
        Ok(old)
    }
    pub fn switch(app:&AppHandle,backup:&mut ProxyBackup,old:u16,new_port:u16)->Result<(),String>{
        let k=key()?;
        if !is_active(old)?{return Err("System Proxy was changed externally; disconnect before switching".into())}
        let path=record_path(app)?;
        let mut next=backup.clone();next.active_port=new_port;next.previous_port=Some(old);
        // During a crash window both endpoints should be recognized as ours.
        write_record(&path, &next, true)?;
        if k.set_value("ProxyServer",&expected(new_port)).is_err(){
            return Err("Windows proxy switch failed".into());
        }
        if let Err(e)=notify_windows(){
            if k.set_value("ProxyServer",&expected(old)).is_ok() {
                let _=notify_windows();
                return Err(e);
            }
            // The registry now points to the new listener. Keep it alive.
        }
        *backup=next;
        Ok(())
    }
    fn restore_values(k:&RegKey,b:&ProxyBackup,enabled:Option<u32>)->Result<(),String>{
        // Leave a user-disabled proxy disabled. Restore the endpoint last so a partial
        // write can be retried while it still points to our listener.
        if enabled==Some(1) {
            if let Some(v)=b.original_enabled{k.set_value("ProxyEnable",&v).map_err(|_|"Could not restore ProxyEnable")?}
            else {delete_value(k,"ProxyEnable")?;}
        }
        if let Some(v)=b.original_server.as_deref(){k.set_value("ProxyServer",&v).map_err(|_|"Could not restore ProxyServer")?}
        else {delete_value(k,"ProxyServer")?;}
        Ok(())
    }
    pub fn restore(app:&AppHandle,b:&ProxyBackup,expected_port:u16)->Result<(),String>{
        let k=key()?;
        let server=optional_value::<String>(&k,"ProxyServer")?;
        let enabled=optional_value::<u32>(&k,"ProxyEnable")?;
        if server.as_deref()==Some(&expected(expected_port))
            || b.previous_port.is_some_and(|old|server.as_deref()==Some(&expected(old))) {
            restore_values(&k,b,enabled)?;
            notify_windows()?;
        } else if server==b.original_server && enabled==b.original_enabled {
            // The values may already have been restored before a failed notification.
            notify_windows()?;
        }
        // User/application changed proxy after we started: do not clobber it.
        remove_record(&record_path(app)?)
    }
    pub fn recover(app:&AppHandle)->Result<(),String>{
        let path=record_path(app)?;
        let bytes=match fs::read(&path) {
            Ok(bytes)=>bytes,
            Err(error) if error.kind()==ErrorKind::NotFound=>return Ok(()),
            Err(_)=>return Err("Unable to read previous proxy recovery file".into()),
        };
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
    pub fn is_active(_port:u16)->Result<bool,String>{Ok(false)}
}
pub use imp::{enable,switch,restore,recover,is_active};

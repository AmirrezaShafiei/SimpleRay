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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    original_connection: Option<ConnectionProxy>,
    pub active_port: u16,
    #[serde(default)]
    pub previous_port: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct ConnectionProxy {
    flags: u32,
    server: String,
    bypass: String,
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
    use std::{mem::size_of, ptr::{null, null_mut}};
    use windows_sys::Win32::{Foundation::GlobalFree, Networking::WinInet::{
        InternetQueryOptionW, InternetSetOptionW, INTERNET_OPTION_PER_CONNECTION_OPTION,
        INTERNET_OPTION_PROXY_SETTINGS_CHANGED, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
        INTERNET_PER_CONN_FLAGS, INTERNET_PER_CONN_OPTION_LISTW, INTERNET_PER_CONN_OPTIONW,
        INTERNET_PER_CONN_OPTIONW_0, INTERNET_PER_CONN_PROXY_BYPASS, INTERNET_PER_CONN_PROXY_SERVER,
        PROXY_TYPE_AUTO_DETECT, PROXY_TYPE_AUTO_PROXY_URL, PROXY_TYPE_DIRECT, PROXY_TYPE_PROXY,
    }};
    use winreg::{enums::{HKEY_CURRENT_USER,KEY_READ,KEY_SET_VALUE,KEY_QUERY_VALUE},RegKey};
    const INTERNET_SETTINGS:&str=r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    const MANUAL_FLAGS: u32 = PROXY_TYPE_DIRECT | PROXY_TYPE_PROXY;
    const LOCAL_BYPASS: &str = "<local>";

    fn notify_windows()->Result<(),String>{
        unsafe {
            InternetSetOptionW(null(), INTERNET_OPTION_PROXY_SETTINGS_CHANGED, null(), 0);
            let changed = InternetSetOptionW(null(), INTERNET_OPTION_SETTINGS_CHANGED, null(), 0);
            let refreshed = InternetSetOptionW(null(), INTERNET_OPTION_REFRESH, null(), 0);
            if changed == 0 || refreshed == 0 {
                return Err("Windows proxy notification failed".into());
            }
        }
        Ok(())
    }
    fn option_list(options: &mut [INTERNET_PER_CONN_OPTIONW]) -> INTERNET_PER_CONN_OPTION_LISTW {
        INTERNET_PER_CONN_OPTION_LISTW {
            dwSize: size_of::<INTERNET_PER_CONN_OPTION_LISTW>() as u32,
            pszConnection: null_mut(), // Default LAN connection for the current Windows user.
            dwOptionCount: options.len() as u32,
            dwOptionError: 0,
            pOptions: options.as_mut_ptr(),
        }
    }
    fn take_option_string(ptr: *mut u16) -> String {
        if ptr.is_null() { return String::new(); }
        // WinINet returns a null-terminated string owned by the caller.
        unsafe {
            let mut len = 0;
            while *ptr.add(len) != 0 { len += 1; }
            let value = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
            GlobalFree(ptr.cast());
            value
        }
    }
    fn current_connection() -> Result<ConnectionProxy, String> {
        let mut options = [INTERNET_PER_CONN_OPTIONW::default(); 3];
        options[0].dwOption = INTERNET_PER_CONN_FLAGS;
        options[1].dwOption = INTERNET_PER_CONN_PROXY_SERVER;
        options[2].dwOption = INTERNET_PER_CONN_PROXY_BYPASS;
        let mut list = option_list(&mut options);
        let mut size = list.dwSize;
        let ok = unsafe { InternetQueryOptionW(null(), INTERNET_OPTION_PER_CONNECTION_OPTION,
            (&mut list as *mut INTERNET_PER_CONN_OPTION_LISTW).cast(), &mut size) };
        let server = take_option_string(unsafe { options[1].Value.pszValue });
        let bypass = take_option_string(unsafe { options[2].Value.pszValue });
        if ok == 0 { return Err("Cannot read Windows System Proxy settings".into()); }
        Ok(ConnectionProxy { flags: unsafe { options[0].Value.dwValue }, server, bypass })
    }
    fn set_connection(proxy: &ConnectionProxy) -> Result<(), String> {
        let mut server: Vec<u16> = proxy.server.encode_utf16().chain([0]).collect();
        let mut bypass: Vec<u16> = proxy.bypass.encode_utf16().chain([0]).collect();
        let mut options = [
            INTERNET_PER_CONN_OPTIONW { dwOption: INTERNET_PER_CONN_FLAGS,
                Value: INTERNET_PER_CONN_OPTIONW_0 { dwValue: proxy.flags } },
            INTERNET_PER_CONN_OPTIONW { dwOption: INTERNET_PER_CONN_PROXY_SERVER,
                Value: INTERNET_PER_CONN_OPTIONW_0 { pszValue: server.as_mut_ptr() } },
            INTERNET_PER_CONN_OPTIONW { dwOption: INTERNET_PER_CONN_PROXY_BYPASS,
                Value: INTERNET_PER_CONN_OPTIONW_0 { pszValue: bypass.as_mut_ptr() } },
        ];
        let list = option_list(&mut options);
        let ok = unsafe { InternetSetOptionW(null(), INTERNET_OPTION_PER_CONNECTION_OPTION,
            (&list as *const INTERNET_PER_CONN_OPTION_LISTW).cast(), list.dwSize) };
        if ok == 0 { return Err("Windows refused to change System Proxy".into()); }
        notify_windows()
    }
    fn listener_matches(server: &str, port: u16) -> bool {
        let endpoint = format!("127.0.0.1:{port}");
        if server.trim() == endpoint { return true; }
        let routes = server.split(';').filter_map(|item| item.split_once('='));
        let mut http = false;
        let mut https = false;
        for (scheme, address) in routes {
            if scheme.trim().eq_ignore_ascii_case("http") {
                http = address.trim() == endpoint;
            } else if scheme.trim().eq_ignore_ascii_case("https") {
                https = address.trim() == endpoint;
            }
        }
        http && https
    }
    fn app_connection(port: u16) -> ConnectionProxy {
        ConnectionProxy { flags: MANUAL_FLAGS, server: expected(port), bypass: LOCAL_BYPASS.into() }
    }
    fn apply_listener(port: u16) -> Result<(), String> {
        set_connection(&app_connection(port))?;
        if !is_active(port)? { return Err("Windows did not apply SimpleRay's System Proxy settings".into()); }
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
        let current = current_connection()?;
        Ok(current.flags & (PROXY_TYPE_PROXY | PROXY_TYPE_AUTO_DETECT | PROXY_TYPE_AUTO_PROXY_URL)
            == PROXY_TYPE_PROXY && listener_matches(&current.server, port)
            && current.bypass.trim().eq_ignore_ascii_case(LOCAL_BYPASS))
    }
    pub fn enable(app:&AppHandle,port:u16)->Result<ProxyBackup,String>{
        // Snapshot must be durable BEFORE changing the registry: crash recovery.
        recover(app)?;
        let old=ProxyBackup{
            original_enabled:None,
            original_server:None,
            original_connection:Some(current_connection()?),
            active_port:port,
            previous_port:None,
        };
        let path=record_path(app)?;
        write_record(&path, &old, false)?;
        if let Err(error)=apply_listener(port) {
            let _=restore(app,&old,port);
            return Err(error);
        }
        Ok(old)
    }
    pub fn switch(app:&AppHandle,backup:&mut ProxyBackup,old:u16,new_port:u16)->Result<(),String>{
        if !is_active(old)?{return Err("Windows System Proxy is off. Restore it before switching.".into())}
        let path=record_path(app)?;
        let mut next=backup.clone();next.active_port=new_port;next.previous_port=Some(old);
        // During a crash window both endpoints should be recognized as ours.
        write_record(&path, &next, true)?;
        if let Err(error)=apply_listener(new_port) {
            if apply_listener(old).is_ok() || !matches!(is_active(new_port), Ok(true)) {
                return Err(error);
            }
            // If Windows kept the new listener, keep its process alive as well.
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
        if let Some(original) = &b.original_connection {
            let current = current_connection()?;
            if listener_matches(&current.server, expected_port)
                || b.previous_port.is_some_and(|old|listener_matches(&current.server, old)) {
                let mut restored = original.clone();
                if current.flags != MANUAL_FLAGS { restored.flags = current.flags; }
                if !current.bypass.trim().eq_ignore_ascii_case(LOCAL_BYPASS) { restored.bypass = current.bypass; }
                set_connection(&restored)?;
            } else if current == *original {
                notify_windows()?;
            }
            return remove_record(&record_path(app)?);
        }
        // Upgrade recovery from releases that stored only the legacy registry values.
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

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn matches_both_wininet_routes() {
            assert!(listener_matches("https=127.0.0.1:54321;HTTP=127.0.0.1:54321", 54321));
            assert!(listener_matches("127.0.0.1:54321", 54321));
            assert!(!listener_matches("http=127.0.0.1:54321;https=127.0.0.1:99", 54321));
        }

        #[test]
        #[ignore = "changes the Windows user's proxy temporarily; run in an isolated runner"]
        fn wininet_system_proxy_round_trip() {
            let original = current_connection().expect("read initial Windows proxy settings");
            let result = apply_listener(54321).and_then(|_| is_active(54321));
            set_connection(&original).expect("restore initial Windows proxy settings");
            assert_eq!(current_connection().unwrap(), original);
            assert_eq!(result, Ok(true));
        }
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

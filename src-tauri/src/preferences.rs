//! User-scoped desktop preferences and Windows auto-start (no administrator privileges).
//! Keeps the shell's close-to-tray behavior available while the webview is hidden.
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf, sync::RwLock};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DesktopPreferences {
    pub minimize_to_tray: bool,
    pub auto_connect: bool,
}
impl Default for DesktopPreferences {
    fn default() -> Self { Self { minimize_to_tray: true, auto_connect: false } }
}

#[derive(Default)]
pub struct DesktopSettings { current: RwLock<DesktopPreferences> }
impl DesktopSettings {
    pub fn new(app: &AppHandle) -> Self {
        let current = settings_path(app).ok().and_then(|p|fs::read(p).ok())
            .and_then(|bytes|serde_json::from_slice::<DesktopPreferences>(&bytes).ok()).unwrap_or_default();
        Self { current: RwLock::new(current) }
    }
    pub fn get(&self) -> DesktopPreferences {
        self.current.read().map(|p|p.clone()).unwrap_or_default()
    }
    pub fn set(&self, app: &AppHandle, prefs: DesktopPreferences) -> Result<DesktopPreferences,String> {
        let p=settings_path(app)?;
        let mut current=self.current.write().map_err(|_|"Settings lock unavailable")?;
        let bytes=serde_json::to_vec(&prefs).map_err(|_|"Cannot encode preferences")?;
        let mut tmp=tempfile::NamedTempFile::new_in(p.parent().ok_or("Settings directory unavailable")?)
            .map_err(|_|"Cannot prepare desktop settings")?;
        tmp.write_all(&bytes).and_then(|_|tmp.as_file().sync_all())
            .map_err(|_|"Cannot save desktop settings")?;
        tmp.persist(&p).map_err(|_|"Cannot finish saving desktop settings")?;
        *current=prefs.clone();
        Ok(prefs)
    }
}
fn settings_path(app:&AppHandle)->Result<PathBuf,String>{
    let dir=app.path().app_local_data_dir().map_err(|_|"App data unavailable")?;
    fs::create_dir_all(&dir).map_err(|_|"Cannot create settings folder")?;
    Ok(dir.join("desktop-preferences.json"))
}

#[cfg(target_os="windows")]
mod windows_startup {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    const REG_PATH:&str=r"Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE:&str="SimpleRay";
    const PREFERENCES_KEY:&str=r"Software\SimpleRay";
    const STARTUP_PREFERENCE:&str="StartWithWindows";

    fn run_key()->Result<RegKey,String>{
        RegKey::predef(HKEY_CURRENT_USER).create_subkey(REG_PATH).map(|(key,_)|key)
            .map_err(|_|"Cannot access user startup settings".into())
    }
    fn preference_key()->Result<RegKey,String>{
        RegKey::predef(HKEY_CURRENT_USER).create_subkey(PREFERENCES_KEY).map(|(key,_)|key)
            .map_err(|_|"Cannot access SimpleRay startup preferences".into())
    }
    fn startup_command()->Result<String,String>{
        let path=std::env::current_exe().map_err(|_|"Cannot find application executable")?;
        let name=path.file_name().and_then(|n|n.to_str()).unwrap_or("");
        if !name.eq_ignore_ascii_case("simpleray.exe") {
            return Err("Startup is only available from the installed SimpleRay.exe".into())
        }
        Ok(format!("\"{}\" --minimized",path.display()))
    }
    fn read_entry(key:&RegKey)->Result<Option<String>,String>{
        match key.get_value(VALUE){
            Ok(value)=>Ok(Some(value)),
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>Ok(None),
            Err(_)=>Err("Cannot read the SimpleRay startup entry".into()),
        }
    }
    fn sync_entry(key:&RegKey,entry:&str,current:Option<&str>,enabled:bool)->Result<(),String>{
        if enabled && current.is_none(){
            key.set_value(VALUE,&entry).map_err(|_|"Failed to enable Start with Windows")?;
        }else if !enabled && current==Some(entry){
            key.delete_value(VALUE).map_err(|_|"Failed to disable Start with Windows")?;
        }
        Ok(())
    }
    pub fn initialize()->Result<(),String>{
        let entry=startup_command()?;
        let prefs=preference_key()?;
        let enabled=match prefs.get_value::<u32,_>(STARTUP_PREFERENCE){
            Ok(value)=>value!=0,
            Err(error) if error.kind()==std::io::ErrorKind::NotFound=>true,
            Err(_)=>return Err("Cannot read the Start with Windows preference".into()),
        };
        let key=run_key()?;
        let current=read_entry(&key)?;
        sync_entry(&key,&entry,current.as_deref(),enabled)
    }
    pub fn is_enabled()->Result<bool,String>{
        let key=run_key()?;
        Ok(read_entry(&key)?.is_some_and(|current|startup_command().is_ok_and(|entry|current==entry)))
    }
    pub fn set_enabled(enabled:bool)->Result<bool,String>{
        let entry=startup_command()?;
        let key=run_key()?;
        let current=read_entry(&key)?;
        if current.as_deref().is_some_and(|value|value!=entry.as_str()){
            return Err("Another SimpleRay startup entry already exists; not overwriting it".into());
        }
        preference_key()?.set_value(STARTUP_PREFERENCE,&u32::from(enabled))
            .map_err(|_|"Cannot save the Start with Windows preference")?;
        sync_entry(&key,&entry,current.as_deref(),enabled)?;
        Ok(enabled)
    }
}
#[cfg(not(target_os="windows"))]
mod windows_startup {
    pub fn initialize()->Result<(),String>{Ok(())}
    pub fn is_enabled()->Result<bool,String>{Ok(false)}
    pub fn set_enabled(_enabled:bool)->Result<bool,String>{Err("Start with Windows is available only on Windows".into())}
}
pub use windows_startup::{initialize as initialize_startup,is_enabled as startup_enabled,set_enabled as set_startup_enabled};

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn desktop_preferences_safe_defaults() {
        let defaults=DesktopPreferences::default();
        assert!(defaults.minimize_to_tray);
        assert!(!defaults.auto_connect);
    }
}

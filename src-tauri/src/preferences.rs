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
    fn run_key()->Result<RegKey,String>{
        RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
            REG_PATH,winreg::enums::KEY_READ|winreg::enums::KEY_QUERY_VALUE|winreg::enums::KEY_SET_VALUE
        ).map_err(|_|"Cannot access user startup settings".into())
    }
    fn startup_command()->Result<String,String>{
        let path=std::env::current_exe().map_err(|_|"Cannot find app executable")?;
        // Do not register a debug executable or a spoofed location as the login app.
        let name=path.file_name().and_then(|n|n.to_str()).unwrap_or("");
        if !name.eq_ignore_ascii_case("simpleray.exe") {
            return Err("Startup is only available from the installed SimpleRay.exe".into())
        }
        Ok(format!("\"{}\" --minimized",path.display()))
    }
    pub fn is_enabled()->Result<bool,String>{
        let k=run_key()?;
        let existing: String=match k.get_value(VALUE){Ok(v)=>v,Err(_)=>return Ok(false)};
        Ok(startup_command().is_ok_and(|expected|existing==expected))
    }
    pub fn set_enabled(enabled:bool)->Result<bool,String>{
        let k=run_key()?;
        if enabled {
            let entry=startup_command()?;
            if let Ok(current)=k.get_value::<String,_>(VALUE) {
                if current!=entry {return Err("Another SimpleRay startup entry already exists; not overwriting it".into());}
            }
            k.set_value(VALUE,&entry).map_err(|_|"Failed to enable Start with Windows")?;
        }else {
            if let Ok(current)=k.get_value::<String,_>(VALUE) {
                let ours=startup_command()?;
                if current!=ours {return Err("Startup entry was modified externally; refusing to delete it".into());}
                k.delete_value(VALUE).map_err(|_|"Failed to disable Start with Windows")?;
            }
        }
        is_enabled()
    }
}
#[cfg(not(target_os="windows"))]
mod windows_startup {
    pub fn is_enabled()->Result<bool,String>{Ok(false)}
    pub fn set_enabled(_enabled:bool)->Result<bool,String>{Err("Start with Windows is available only on Windows".into())}
}
pub use windows_startup::{is_enabled as startup_enabled,set_enabled as set_startup_enabled};

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn desktop_preferences_safe_defaults() {
        let defaults=DesktopPreferences::default();
        assert!(defaults.minimize_to_tray);
        assert!(!defaults.auto_connect);
    }
}

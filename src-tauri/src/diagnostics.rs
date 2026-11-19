use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, VecDeque}, fs, io::Write, net::IpAddr, sync::Mutex, time::{SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Manager};

fn timestamp() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitEntry {
    ip: IpAddr,
    observed_at_ms: u64,
}

#[derive(Default)]
pub struct Diagnostics {
    ips: Mutex<HashMap<String, Vec<ExitEntry>>>,
    events: Mutex<VecDeque<(u64, &'static str)>>,
}

impl Diagnostics {
    fn file(app: &AppHandle) -> Option<std::path::PathBuf> {
        Some(app.path().app_local_data_dir().ok()?.join("exit-ip-history.json"))
    }
    pub fn new(app: &AppHandle) -> Self {
        let ips = Self::file(app).and_then(|path| fs::read(path).ok())
            .filter(|data| data.len() < 8 * 1024 * 1024)
            .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        Self { ips: Mutex::new(ips), events: Mutex::default() }
    }
    pub fn observation(&self, app:&AppHandle, id:&str, ip:IpAddr) {
        let Ok(mut entries) = self.ips.lock() else { return };
        if entries.get(id).and_then(|row|row.last()).is_some_and(|entry|entry.ip==ip) { return; }
        if entries.len()>=512 && !entries.contains_key(id) {
            let oldest=entries.iter().min_by_key(|(_,row)|row.last().map(|entry|entry.observed_at_ms)).map(|(id,_)|id.clone());
            if let Some(oldest)=oldest { entries.remove(&oldest); }
        }
        let row=entries.entry(id.to_string()).or_default();
        row.push(ExitEntry{ip,observed_at_ms:timestamp()});
        if row.len()>128 { row.remove(0); }
        let saved=(||{
            let path=Self::file(app)?;
            fs::create_dir_all(path.parent()?).ok()?;
            let mut temporary=tempfile::NamedTempFile::new_in(path.parent()?).ok()?;
            serde_json::to_writer(&mut temporary,&*entries).ok()?;
            temporary.flush().ok()?;
            temporary.persist(path).ok()?;
            Some(())
        })();
        if saved.is_none() { self.record("Exit IP history could not be saved."); }
    }
    pub fn history(&self,id:&str)->Vec<ExitEntry> {
        self.ips.lock().ok().and_then(|entries|entries.get(id).cloned()).unwrap_or_default()
    }
    // Only fixed product messages enter the shareable report. Network errors and
    // subprocess output can contain credentials or subscription URLs.
    pub fn record(&self, message:&'static str) {
        let Ok(mut events)=self.events.lock() else { return };
        if events.len()>=30 { events.pop_front(); }
        events.push_back((timestamp(),message));
    }
    pub fn report(&self, mode:&str)->String {
        let mut report=format!("SimpleRay {}\nPlatform: {} ({})\nConnection mode: {mode}\n\nRecent errors (Unix milliseconds in UTC)\n",env!("CARGO_PKG_VERSION"),std::env::consts::OS,std::env::consts::ARCH);
        if let Ok(entries)=self.events.lock() {
            if entries.is_empty() { report.push_str("No errors recorded in this session.\n"); }
            for (date,event) in entries.iter() { report.push_str(&format!("{date}  {event}\n")); }
        }
        report
    }
}

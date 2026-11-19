use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, io::Write, path::{Path, PathBuf}};
use tauri::{AppHandle, Manager};

pub const TUN_NAME: &str = "SimpleRayTUN";
const TUN_V4: &str = "198.19.231.1";
const TUN_V6: &str = "fd65:89a4:5751::1";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    #[default]
    SystemProxy,
    Tun,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Route { Direct, Proxy }
impl Route {
    fn tag(self) -> &'static str {
        match self { Self::Direct => "direct", Self::Proxy => "proxy" }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct AppRule {
    pub path: String,
    pub route: Route,
    pub locked: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct SiteRule { pub domain: String, pub route: Route }

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Routing {
    pub mode: Mode,
    pub apps: Vec<AppRule>,
    pub sites: Vec<SiteRule>,
}

fn data_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_local_data_dir().map_err(|_| "Settings unavailable")?;
    fs::create_dir_all(&directory).map_err(|_| "Cannot create settings folder")?;
    Ok(directory.join("routing.json"))
}
pub fn load(app: &AppHandle) -> Result<Routing, String> {
    match fs::read(data_path(app)?) {
        Ok(data) => serde_json::from_slice(&data).map_err(|_| "Saved routing settings could not be read".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Routing::default()),
        Err(_) => Err("Cannot read routing settings".into()),
    }
}

fn normalized_domain(value: &str) -> Result<String, String> {
    let value = value.trim().trim_end_matches('.');
    if value.is_empty() || value.len() > 253 || value.chars().any(|c| "/\\@:#?*%".contains(c) || c.is_whitespace()) {
        return Err("Enter a domain such as example.com".into());
    }
    let url=reqwest::Url::parse(&format!("https://{value}/"))
        .map_err(|_| "Enter a valid domain name")?;
    let domain=url.host_str().filter(|host|host.parse::<std::net::IpAddr>().is_err())
        .ok_or("Enter a domain name, without an IP address or URL")?.to_string();
    if !domain.contains('.') || domain.split('.').any(|label| {
        label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
            || !label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    }) {
        return Err("Enter a valid domain such as example.com".into());
    }
    Ok(domain)
}

pub fn validate(settings: &mut Routing) -> Result<(), String> {
    if settings.apps.len() > 50 || settings.sites.len() > 200 {
        return Err("Too many routing rules (50 apps or 200 websites)".into());
    }
    let mut paths = HashSet::new();
    for item in &mut settings.apps {
        let path = Path::new(item.path.trim());
        if item.path.len() > 1024 || !path.is_absolute()
            || !path.extension().and_then(|ext| ext.to_str()).is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        {
            return Err("Choose a Windows executable (.exe) with its full path".into());
        }
        let resolved = path.canonicalize().map_err(|_| "An executable could not be found")?;
        let text = resolved.to_str().ok_or("Executable path is not valid text")?;
        item.path = text.strip_prefix(r"\\?\").unwrap_or(text).to_string();
        let executable = Path::new(&item.path).file_name().and_then(|part| part.to_str()).unwrap_or_default();
        if ["simpleray.exe","xray.exe"].iter().any(|name| executable.eq_ignore_ascii_case(name)) {
            return Err("SimpleRay and its core manage their own connection".into());
        }
        if !paths.insert(item.path.to_ascii_lowercase()) {
            return Err("Only one rule is allowed for each executable".into());
        }
        if item.locked && (settings.mode != Mode::Tun || item.route != Route::Proxy) {
            return Err("Tunnel lock requires TUN and Through tunnel. Turn off the lock before switching modes.".into());
        }
    }
    let mut domains = HashSet::new();
    for item in &mut settings.sites {
        item.domain = normalized_domain(&item.domain)?;
        if !domains.insert(item.domain.clone()) {
            return Err("Only one rule is allowed for each domain".into());
        }
    }
    settings.sites.sort_by_key(|rule| std::cmp::Reverse(rule.domain.len()));
    Ok(())
}

pub fn config(base: &mut Value, settings: &Routing, health_port: u16) {
    let inbounds = base["inbounds"].as_array_mut().expect("Xray config includes an inbound list");
    inbounds.push(json!({"tag":"health-in","listen":"127.0.0.1","port":health_port,"protocol":"http"}));
    let mut rules = base["routing"]["rules"].as_array().cloned().unwrap_or_default();
    rules.push(json!({"type":"field","inboundTag":["health-in"],"outboundTag":"proxy"}));
    if settings.mode == Mode::Tun {
        base["inbounds"].as_array_mut().unwrap().push(json!({
            "tag":"tun-in","protocol":"tun",
            "settings":{
                "name":TUN_NAME,"desc":"SimpleRay",
                "gateway":[format!("{TUN_V4}/30"),format!("{TUN_V6}/64")],
                "dns":["1.1.1.1","1.0.0.1"],
                "autoSystemRoutingTable":["0.0.0.0/0","::/0"],
                "autoOutboundsInterface":"auto","autoSystemWfpBlockLeak":["dns","misconfigtun"]
            },
            "sniffing":{"enabled":true,"destOverride":["http","tls","quic"],"routeOnly":true}
        }));
        rules.push(json!({"type":"field","inboundTag":["tun-in"],"process":["xray/","self/"],"outboundTag":"direct"}));
        for item in &settings.apps {
            rules.push(json!({"type":"field","inboundTag":["tun-in"],"process":[item.path.replace('\\',"/")],"outboundTag":item.route.tag()}));
        }
    }
    for item in &settings.sites {
        rules.push(json!({"type":"field","domain":[format!("domain:{}",item.domain)],"outboundTag":item.route.tag()}));
    }
    base["outbounds"].as_array_mut().unwrap().push(json!({"tag":"direct","protocol":"freedom"}));
    base["routing"]=json!({"rules":rules});
}

pub async fn save(app: &AppHandle, mut settings: Routing) -> Result<bool, String> {
    validate(&mut settings)?;
    let previous = load(app)?;
    if settings == previous { return Ok(false); }
    let path = data_path(app)?;
    let bytes=serde_json::to_vec(&settings).map_err(|_|"Cannot encode routing settings")?;
    let mut temporary=tempfile::NamedTempFile::new_in(path.parent().ok_or("Routing directory unavailable")?)
        .map_err(|_|"Cannot prepare routing settings")?;
    temporary.write_all(&bytes).and_then(|_|temporary.as_file().sync_all()).map_err(|_|"Cannot save routing settings")?;
    apply_locks(&previous, &settings).await?;
    if temporary.persist(path).is_err() {
        let _ = apply_locks(&settings, &previous).await;
        return Err("Cannot finish saving routing settings".into());
    }
    Ok(true)
}

#[cfg(windows)]
fn address_ranges() -> Vec<String> {
    let v4 = u32::from(TUN_V4.parse::<std::net::Ipv4Addr>().unwrap());
    let v6 = u128::from(TUN_V6.parse::<std::net::Ipv6Addr>().unwrap());
    [
        format!("0.0.0.0-{}",std::net::Ipv4Addr::from(v4-1)),
        format!("{}-255.255.255.255",std::net::Ipv4Addr::from(v4+1)),
        format!("::-{}",std::net::Ipv6Addr::from(v6-1)),
        format!("{}-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",std::net::Ipv6Addr::from(v6+1)),
    ].into()
}

#[cfg(windows)]
async fn apply_locks(previous: &Routing, next: &Routing) -> Result<(), String> {
    let locks = |settings: &Routing| settings.apps.iter().filter(|item|item.locked)
        .map(|item|item.path.clone()).collect::<std::collections::BTreeSet<_>>();
    let old = locks(previous);
    let desired = locks(next);
    if old == desired { return Ok(()); }
    let rule = |path: &String| {
        let hash = path.bytes().map(|byte| byte.to_ascii_lowercase()).fold(14695981039346656037u64,
            |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(1099511628211));
        json!({"name":format!("SimpleRay-TunnelLock-{hash:016x}"),"path":path})
    };
    let to_add: Vec<_> = desired.difference(&old).map(rule).collect();
    let to_remove: Vec<_> = old.difference(&desired).map(rule).collect();
    let payload = json!({"add":to_add,"remove":to_remove,"addresses":address_ranges()});
    let script = r#"
$ErrorActionPreference = 'Stop'
$settings = $env:SIMPLERAY_FIREWALL_CHANGE | ConvertFrom-Json
$added = @()
$removed = @()
function Add-Protection($entry) {
  New-NetFirewallRule -Name $entry.name -DisplayName 'SimpleRay tunnel lock' -Group 'SimpleRay tunnel lock' -Direction Outbound -Program $entry.path -Action Block -Profile Any -LocalAddress @($settings.addresses | ForEach-Object { [string]$_ }) | Out-Null
}
try {
  if ($settings.add -and (Get-NetFirewallProfile -PolicyStore ActiveStore | Where-Object { $_.Enabled -ne 'True' })) {
    throw 'Windows Firewall profile disabled'
  }
  foreach ($entry in $settings.add) {
    if (-not (Get-NetFirewallRule -Name $entry.name -PolicyStore PersistentStore -ErrorAction SilentlyContinue)) {
      Add-Protection $entry
      $added += $entry
    }
    if (-not (Get-NetFirewallRule -Name $entry.name -PolicyStore ActiveStore -ErrorAction SilentlyContinue)) {
      throw 'Windows policy did not activate the rule'
    }
  }
  foreach ($entry in $settings.remove) {
    if (Get-NetFirewallRule -Name $entry.name -PolicyStore PersistentStore -ErrorAction SilentlyContinue) {
      Remove-NetFirewallRule -Name $entry.name -PolicyStore PersistentStore
      $removed += $entry
    }
  }
} catch {
  foreach ($entry in $removed) { try { Add-Protection $entry } catch {} }
  foreach ($entry in $added) { Remove-NetFirewallRule -Name $entry.name -PolicyStore PersistentStore -ErrorAction SilentlyContinue }
  exit 1
}
"#;
    let powershell=PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows system directory unavailable")?)
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut command=tokio::process::Command::new(powershell);
    command.creation_flags(0x0800_0000).kill_on_drop(true)
        .args(["-NoProfile","-NonInteractive","-Command",script])
        .env("SIMPLERAY_FIREWALL_CHANGE",payload.to_string())
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    if command.status().await.is_ok_and(|status|status.success()) { Ok(()) }
    else { Err("Tunnel lock requires administrator rights and active Windows Firewall profiles".into()) }
}
#[cfg(not(windows))]
async fn apply_locks(_: &Routing, next: &Routing) -> Result<(), String> {
    if next.apps.iter().any(|item| item.locked) { Err("Tunnel lock requires Windows".into()) } else { Ok(()) }
}

#[cfg(windows)]
pub async fn choose_executable() -> Result<Option<String>, String> {
    let powershell=PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows system directory unavailable")?)
        .join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let output=tokio::process::Command::new(powershell).creation_flags(0x0800_0000).kill_on_drop(true)
        .args(["-NoProfile","-STA","-Command",
            "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object Windows.Forms.OpenFileDialog; $dialog.Filter='Windows applications (*.exe)|*.exe'; if($dialog.ShowDialog() -eq 'OK'){[Console]::WriteLine($dialog.FileName)}"])
        .output().await.map_err(|_|"Cannot open application picker")?;
    if !output.status.success() { return Err("Application picker failed".into()); }
    let path = String::from_utf8(output.stdout).map_err(|_|"Cannot read picked executable")?;
    Ok((!path.trim().is_empty()).then(||path.trim().to_string()))
}
#[cfg(not(windows))]
pub async fn choose_executable() -> Result<Option<String>, String> {
    Err("Application picker requires Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_request_has_a_pinned_proxy_route_even_when_the_site_is_direct() {
        let mut base=json!({"inbounds":[],"outbounds":[],"routing":{"rules":[
            {"inboundTag":["api-in"],"outboundTag":"api"}
        ]}});
        config(&mut base,&Routing{sites:vec![SiteRule{domain:"example.com".into(),route:Route::Direct}],..Routing::default()},20000);
        assert_eq!(base["routing"]["rules"][0]["outboundTag"],"api");
        assert_eq!(base["routing"]["rules"][1]["outboundTag"],"proxy");
        assert_eq!(base["routing"]["rules"][2]["outboundTag"],"direct");
        assert_eq!(base["inbounds"][0]["listen"],"127.0.0.1");
    }
    #[test]
    fn normalizes_domain_and_rejects_urls_ips_and_wildcards() {
        assert_eq!(normalized_domain("Example.COM.").unwrap(),"example.com");
        for invalid in ["127.0.0.1","https://example.org","*.example.org","-site.net"] {
            assert!(normalized_domain(invalid).is_err(),"{invalid}");
        }
    }
}

#[cfg(all(test,windows))]
#[test]
#[ignore = "requires the staged Xray and Wintun runtime and an elevated Windows runner"]
fn windows_tun_adapter_smoke() {
    use std::os::windows::process::CommandExt;
    use std::process::{Command,Stdio};
    use std::time::{Duration,Instant};
    let runtime=Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let dir=tempfile::tempdir().expect("TUN smoke temp directory");
    let config_path=dir.path().join("tun-smoke.json");
    let mut value=json!({"log":{"loglevel":"warning"},"inbounds":[],"outbounds":[
        {"tag":"proxy","protocol":"freedom"}
    ]});
    let port=std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    config(&mut value,&Routing{mode:Mode::Tun,..Routing::default()},port);
    let tun=&mut value["inbounds"][1]["settings"];
    tun["name"]=json!("SimpleRayQATUN");
    tun["gateway"]=json!(["198.19.240.1/30"]);
    tun["dns"]=json!([]);
    tun["autoSystemRoutingTable"]=json!(["198.19.240.0/30"]);
    tun["autoSystemWfpBlockLeak"]=json!([]);
    fs::write(&config_path,serde_json::to_vec(&value).unwrap()).unwrap();
    let mut child=Command::new(runtime.join("xray.exe"))
        .creation_flags(0x0800_0000)
        .args(["run","-config"]).arg(&config_path)
        .env("XRAY_LOCATION_ASSET",&runtime)
        .stdin(Stdio::null()).stdout(Stdio::inherit()).stderr(Stdio::inherit())
        .spawn().expect("start official Xray TUN smoke");
    let deadline=Instant::now()+Duration::from_secs(12);
    let test_ip:std::net::IpAddr="198.19.240.1".parse().unwrap();
    let started=loop {
        let adapter_ready=if_addrs::get_if_addrs().is_ok_and(|addresses|addresses.iter().any(|entry|entry.ip()==test_ip));
        if adapter_ready && std::net::TcpStream::connect(("127.0.0.1",port)).is_ok() {break true}
        if Instant::now()>=deadline || !matches!(child.try_wait(),Ok(None)) {break false}
        std::thread::sleep(Duration::from_millis(100));
    };
    let _=child.kill();
    let _=child.wait();
    assert!(started,"Xray did not expose a healthy TUN adapter on Windows");
}

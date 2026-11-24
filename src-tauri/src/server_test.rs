use serde::Serialize;
use std::time::Duration;
use tokio::{
    sync::watch,
    time::{timeout_at, Instant},
};

pub const CANCELLED: &str = "Test cancelled";
pub const DOWNLOAD_BYTES: u64 = 3_000_000;
const MIN_SAMPLE_BYTES: u64 = 128 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Default)]
pub struct ManualTest {
    id: u32,
    cancel: Option<watch::Sender<bool>>,
    speed: bool,
}

impl ManualTest {
    pub fn begin(&mut self, speed: bool) -> Result<u32, String> {
        if self.cancel.is_some() {
            return Err("A server test is already running".into());
        }
        self.id = self.id.wrapping_add(1);
        self.cancel = Some(watch::channel(false).0);
        self.speed = speed;
        Ok(self.id)
    }

    pub fn speed_running(&self) -> bool {
        self.speed && self.cancel.is_some()
    }

    pub fn subscribe(&self, id: u32) -> Result<watch::Receiver<bool>, String> {
        self.cancel
            .as_ref()
            .filter(|_| self.id == id)
            .map(watch::Sender::subscribe)
            .ok_or_else(|| CANCELLED.into())
    }

    pub fn cancel(&self, id: u32) {
        if let Some(sender) = self.cancel.as_ref().filter(|_| self.id == id) {
            sender.send_replace(true);
        }
    }

    pub fn finish(&mut self, id: u32) {
        if self.id == id {
            self.cancel = None;
        }
    }
}

pub async fn wait_until_cancelled(cancel: &mut watch::Receiver<bool>) {
    // Dropping the sender also cancels an outstanding request.
    let _ = cancel.wait_for(|requested| *requested).await;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    mbps: f64,
    downloaded_bytes: u64,
    complete: bool,
}

fn download_rate(bytes: u64, elapsed: Duration) -> Option<f64> {
    (bytes >= MIN_SAMPLE_BYTES && !elapsed.is_zero())
        .then(|| bytes as f64 * 8.0 / elapsed.as_secs_f64() / 1_000_000.0)
}

pub async fn measure_download(port: u16) -> Result<DownloadResult, String> {
    let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
        .map_err(|_| "Cannot configure the download test proxy")?;
    let client = reqwest::Client::builder()
        .proxy(proxy)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Cannot create the download test client")?;
    let deadline = Instant::now() + DOWNLOAD_TIMEOUT;
    let mut response = timeout_at(
        deadline,
        client.get(format!("https://speed.cloudflare.com/__down?bytes={DOWNLOAD_BYTES}"))
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send(),
    )
    .await
    .map_err(|_| "Download timed out")?
    .map_err(|_| "Cannot reach the test server through this connection")?;
    let content_type = response.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok());
    if response.status() != reqwest::StatusCode::OK
        || content_type != Some("application/octet-stream")
        || response.content_length().is_some_and(|length| length != DOWNLOAD_BYTES)
    {
        return Err("Unexpected download test response".into());
    }

    let mut downloaded = 0;
    let mut first_chunk = 0;
    let mut first_at = None;
    let mut last_at = None;
    while downloaded < DOWNLOAD_BYTES {
        let chunk = match timeout_at(deadline, response.chunk()).await {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => return Err("Download ended before the expected size".into()),
            Ok(Err(_)) => return Err("Download interrupted".into()),
            Err(_) => break,
        };
        if chunk.is_empty() {
            continue;
        }
        let received_at = Instant::now();
        let length = (chunk.len() as u64).min(DOWNLOAD_BYTES - downloaded);
        if first_at.is_none() {
            first_at = Some(received_at);
            first_chunk = length;
        }
        last_at = Some(received_at);
        downloaded += length;
    }

    let complete = downloaded == DOWNLOAD_BYTES;
    let mbps = first_at.zip(last_at)
        .and_then(|(first, last)| {
            let end = if complete { last } else { deadline };
            download_rate(downloaded - first_chunk, end - first)
        })
        .ok_or("Insufficient download sample")?;
    Ok(DownloadResult {
        mbps,
        downloaded_bytes: downloaded,
        complete,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_rate_requires_enough_timed_data() {
        assert_eq!(download_rate(1_000_000, Duration::from_millis(500)), Some(16.0));
        assert_eq!(download_rate(4_000, Duration::from_millis(500)), None);
        assert_eq!(download_rate(1_000_000, Duration::ZERO), None);
    }

    #[test]
    fn cancellation_survives_until_native_probes_subscribe() {
        let mut test = ManualTest::default();
        let first = test.begin(true).unwrap();
        assert!(test.speed_running());
        assert!(test.begin(false).is_err());
        test.cancel(first);
        assert!(*test.subscribe(first).unwrap().borrow());
        test.finish(first);
        let second = test.begin(false).unwrap();
        assert!(!test.speed_running());
        test.cancel(first);
        assert!(!*test.subscribe(second).unwrap().borrow());
        assert!(test.subscribe(first).is_err());
    }
}

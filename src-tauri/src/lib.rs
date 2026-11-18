use std::time::Duration;

const MAX_SUBSCRIPTION_BYTES: usize = 2_000_000;

/// Native clipboard access. The browser preview uses navigator.clipboard instead.
#[tauri::command]
fn read_clipboard_text() -> Result<String, String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|_| "Clipboard is unavailable".to_string())?;
    clipboard
        .get_text()
        .map_err(|_| "Clipboard contains no readable text".to_string())
}

/// Fetches a user-entered subscription URL without WebView CORS restrictions.
/// Secrets in the URL and response are never placed in error messages/logs.
#[tauri::command]
async fn fetch_subscription_text(url: String) -> Result<String, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|_| "Invalid subscription URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Only HTTP(S) subscription URLs are supported".to_string());
    }
    let host = parsed.host_str().unwrap_or_default().to_ascii_lowercase();
    if matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Err("Localhost subscriptions are not supported".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(3))
        .user_agent("SimpleRay/0.1")
        .build()
        .map_err(|_| "Subscription HTTP client unavailable".to_string())?;
    let mut response = client.get(parsed).send().await
        .map_err(|_| "Unable to download subscription (network or certificate error)".to_string())?;
    if !response.status().is_success() {
        return Err(format!("Subscription server responded with HTTP {}", response.status().as_u16()));
    }
    if response.content_length().is_some_and(|n| n > MAX_SUBSCRIPTION_BYTES as u64) {
        return Err("Subscription is too large".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await
        .map_err(|_| "Subscription download was interrupted".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_SUBSCRIPTION_BYTES {
            return Err("Subscription is too large".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Subscription is not valid UTF-8".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![read_clipboard_text, fetch_subscription_text])
        .run(tauri::generate_context!())
        .expect("failed to start SimpleRay");
}

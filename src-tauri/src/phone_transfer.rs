//! A one-use, opt-in configuration inbox on a selected private IPv4 interface.
use http_body_util::{BodyExt, Full, Limited};
use hyper::{
    body::{Bytes, Incoming},
    header, server::conn::http1, service::service_fn,
    Method, Request, Response, StatusCode,
};
use hyper_util::rt::TokioIo;
use serde::Serialize;
use std::{
    convert::Infallible,
    net::{IpAddr, Ipv4Addr, SocketAddrV4, UdpSocket},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{net::TcpListener, task::{JoinHandle, JoinSet}, time::{sleep_until, timeout}};

const LIFETIME: Duration = Duration::from_secs(180);
const MAX_LINK_BYTES: usize = 65_536;
const MAX_CLIENTS: usize = 8;
const FORM: &str = include_str!("phone_transfer_form.html");

#[derive(Default)]
pub struct PhoneTransfer(Mutex<Option<Session>>);

struct Session {
    id: String,
    until: Instant,
    data: Arc<Mutex<Mailbox>>,
    server: JoinHandle<()>,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.server.abort();
    }
}

enum Mailbox {
    Waiting,
    Received(String),
    Delivered,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    id: String,
    url: String,
    expires_in: u64,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum Receipt {
    Waiting,
    Received { link: String },
    Expired,
}

fn private_address(ip: Ipv4Addr) -> bool {
    ip.is_private() || ip.is_link_local()
}

pub fn addresses() -> Result<Vec<String>, String> {
    let mut ips: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .map_err(|_| "Unable to read local network addresses")?
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if private_address(ip) => Some(ip),
            _ => None,
        })
        .collect();
    // A UDP route lookup selects the active adapter; it sends no packet.
    let preferred = UdpSocket::bind("0.0.0.0:0").ok().and_then(|socket| {
        socket.connect("1.1.1.1:53").ok()?;
        socket.local_addr().ok().map(|address| address.ip())
    });
    ips.sort_by_key(|ip| (preferred != Some(IpAddr::V4(*ip)), *ip));
    ips.dedup();
    Ok(ips.into_iter().map(|ip| ip.to_string()).collect())
}

impl PhoneTransfer {
    pub async fn start(&self, address: String) -> Result<Invite, String> {
        let ip: Ipv4Addr = address.parse().map_err(|_| "Invalid local address")?;
        if !addresses()?.contains(&address) {
            return Err("Choose a private address assigned to this computer".into());
        }

        self.start_on(ip).await
    }

    async fn start_on(&self, ip: Ipv4Addr) -> Result<Invite, String> {
        let listener = TcpListener::bind(SocketAddrV4::new(ip, 0)).await
            .map_err(|_| "Unable to open the local receiver on this network")?;
        let authority = listener.local_addr()
            .map_err(|_| "Unable to read the local receiver address")?.to_string();
        let mut token = [0u8; 32];
        getrandom::fill(&mut token).map_err(|_| "Unable to create a private transfer code")?;
        let hex = |bytes: &[u8]| -> String { bytes.iter().map(|byte| format!("{byte:02x}")).collect() };
        let id = hex(&token[..16]);
        let form_token = hex(&token[16..]);
        let path = format!("/receive/{id}");
        let url = format!("http://{authority}{path}");
        let until = Instant::now() + LIFETIME;
        let data = Arc::new(Mutex::new(Mailbox::Waiting));
        let server = tokio::spawn(serve(listener, path, authority, form_token, until, data.clone()));
        let session = Session { id: id.clone(), until, data, server };
        *self.0.lock().map_err(|_| "Phone receiver unavailable")? = Some(session);
        Ok(Invite { id, url, expires_in: LIFETIME.as_secs() })
    }

    pub fn poll(&self, id: &str) -> Result<Receipt, String> {
        let mut session = self.0.lock().map_err(|_| "Phone receiver unavailable")?;
        let Some(active) = session.as_ref().filter(|session| session.id == id) else {
            return Ok(Receipt::Expired);
        };
        if Instant::now() >= active.until {
            *session = None;
            return Ok(Receipt::Expired);
        }

        let mut data = active.data.lock().map_err(|_| "Phone receiver unavailable")?;
        Ok(match &*data {
            Mailbox::Waiting => Receipt::Waiting,
            Mailbox::Delivered => Receipt::Expired,
            Mailbox::Received(_) => match std::mem::replace(&mut *data, Mailbox::Delivered) {
                Mailbox::Received(link) => Receipt::Received { link },
                _ => unreachable!("mailbox remained locked"),
            },
        })
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let mut session = self.0.lock().map_err(|_| "Phone receiver unavailable")?;
        if session.as_ref().is_some_and(|active| active.id == id) {
            *session = None;
        }
        Ok(())
    }
}

async fn serve(
    listener: TcpListener,
    path: String,
    authority: String,
    form_token: String,
    until: Instant,
    data: Arc<Mutex<Mailbox>>,
) {
    let mut clients = JoinSet::new();
    let loopback = listener.local_addr().is_ok_and(|address| address.ip().is_loopback());
    let expires = sleep_until(until.into());
    tokio::pin!(expires);
    loop {
        tokio::select! {
            _ = &mut expires => break,
            _ = clients.join_next(), if !clients.is_empty() => {},
            connection = listener.accept(), if clients.len() < MAX_CLIENTS => {
                let Ok((socket, peer)) = connection else { break };
                if !matches!(peer.ip(), IpAddr::V4(ip) if private_address(ip) || (loopback && ip.is_loopback())) {
                    continue;
                }
                let path = path.clone();
                let authority = authority.clone();
                let form_token = form_token.clone();
                let data = data.clone();
                clients.spawn(async move {
                    let handler = service_fn(|request| handle(request, &path, &authority, &form_token, &data));
                    let connection = http1::Builder::new()
                        .keep_alive(false)
                        .serve_connection(TokioIo::new(socket), handler);
                    let _ = timeout(Duration::from_secs(8), connection).await;
                });
            }
        }
    }
}

type Reply = Response<Full<Bytes>>;

async fn handle(
    request: Request<Incoming>, path: &str, authority: &str, form_token: &str, mailbox: &Mutex<Mailbox>,
) -> Result<Reply, Infallible> {
    if request.uri().path_and_query().map(|value| value.as_str()) != Some(path)
        || request.headers().get(header::HOST).and_then(|value| value.to_str().ok()) != Some(authority)
    {
        return Ok(message(StatusCode::NOT_FOUND, "Transfer link unavailable", "Scan the QR code in SimpleRay."));
    }
    if request.method() == Method::GET {
        let ready = mailbox.lock().is_ok_and(|value| matches!(*value, Mailbox::Waiting));
        if !ready { return Ok(used()); }
        let mut form = page(StatusCode::OK, FORM.replace("__FORM_TOKEN__", form_token));
        // HTML form POSTs can replace Origin with "null" under no-referrer.
        // Keep the referrer local to this page and preserve the real Origin.
        form.headers_mut().insert(header::REFERRER_POLICY, header::HeaderValue::from_static("same-origin"));
        return Ok(form);
    }
    if request.method() != Method::POST {
        return Ok(message(StatusCode::METHOD_NOT_ALLOWED, "Method unavailable", "Open the transfer link in your browser."));
    }
    let expected_origin = format!("http://{authority}");
    if request.headers().get(header::ORIGIN).is_some_and(|value| {
        value != "null" && value.as_bytes() != expected_origin.as_bytes()
    }) || request.headers().get("sec-fetch-site").is_some_and(|value| value == "cross-site" || value == "same-site") {
        return Ok(rejected_form());
    }
    let form_encoded = request.headers().get(header::CONTENT_TYPE).and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("application/x-www-form-urlencoded"));
    if !form_encoded {
        return Ok(message(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Open the SimpleRay form", "Scan a new QR code and send from the form that opens."));
    }

    let Ok(body) = Limited::new(request.into_body(), MAX_LINK_BYTES * 3 + 64).collect().await else {
        return Ok(message(StatusCode::PAYLOAD_TOO_LARGE, "Configuration is too long", "Send one subscription URL, share link, or WireGuard profile."));
    };
    let bytes = body.to_bytes();
    let Ok(form) = std::str::from_utf8(&bytes) else { return Ok(invalid_link()) };
    let mut link = None;
    let mut valid_form = false;
    for (key, value) in form_urlencoded::parse(form.as_bytes()) {
        match key.as_ref() {
            "link" => link = Some(value),
            "form_token" => valid_form = value == form_token,
            _ => {}
        }
    }
    if !valid_form { return Ok(rejected_form()); }
    let Some(link) = link.as_deref().map(str::trim).filter(|link| {
        !link.is_empty() && link.len() <= MAX_LINK_BYTES
    }) else { return Ok(invalid_link()) };
    // The desktop import parser validates the shared format and its fields.
    let Ok(mut inbox) = mailbox.lock() else {
        return Ok(message(StatusCode::SERVICE_UNAVAILABLE, "Receiver unavailable", "Create a new transfer code in SimpleRay."));
    };
    if !matches!(*inbox, Mailbox::Waiting) {
        return Ok(used());
    }
    *inbox = Mailbox::Received(link.to_owned());
    Ok(message(StatusCode::OK, "Sent to SimpleRay", "Check SimpleRay on your computer to finish importing."))
}

fn rejected_form() -> Reply {
    message(StatusCode::FORBIDDEN, "Transfer rejected", "Open a new QR code from SimpleRay and send from the page it opens.")
}

fn invalid_link() -> Reply {
    message(StatusCode::BAD_REQUEST, "No configuration received", "Go back and paste one subscription URL, share link, or WireGuard profile.")
}

fn used() -> Reply {
    message(StatusCode::GONE, "This transfer code has been used", "Create a new code in SimpleRay to send another link or configuration.")
}

fn message(status: StatusCode, title: &str, detail: &str) -> Reply {
    // Both strings are fixed UI copy. Never reflect submitted configuration data.
    page(status, format!(r#"<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SimpleRay</title><main style="font:16px system-ui;margin:12vh auto;max-width:28rem;padding:1.5rem"><h1>{title}</h1><p>{detail}</p></main></html>"#))
}

fn page(status: StatusCode, body: String) -> Reply {
    let mut response = Response::new(Full::new(Bytes::from(body)));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, header::HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, header::HeaderValue::from_static("no-store"));
    headers.insert(header::REFERRER_POLICY, header::HeaderValue::from_static("no-referrer"));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, header::HeaderValue::from_static("nosniff"));
    headers.insert(header::CONTENT_SECURITY_POLICY, header::HeaderValue::from_static(
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    ));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn receiver_accepts_one_local_form_and_delivers_it_once() {
        let receiver = PhoneTransfer::default();
        let invite = receiver.start_on(Ipv4Addr::LOCALHOST).await.unwrap();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let get = client.get(&invite.url).send().await.unwrap();
        assert_eq!(get.status(), StatusCode::OK);
        assert_eq!(get.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(get.headers()[header::REFERRER_POLICY], "same-origin");
        let form = get.text().await.unwrap();
        assert!(form.contains("name=\"link\""));
        let token = form.split_once("name=\"form_token\" value=\"").unwrap().1.split('"').next().unwrap();
        assert_eq!(token.len(), 32);
        assert_ne!(token, invite.id);
        assert!(matches!(receiver.poll(&invite.id).unwrap(), Receipt::Waiting));

        let link = "vless://dummy@example.test:443#Example";
        let local_origin = invite.url.split("/receive/").next().unwrap();
        let send = || client.post(&invite.url).form(&[("link", link), ("form_token", token)]);
        let rejected = send().header(header::ORIGIN, "https://other.example").send().await.unwrap();
        assert_eq!(rejected.status(), StatusCode::FORBIDDEN);
        let cross_site = send().header(header::ORIGIN, "null").header("sec-fetch-site", "cross-site").send().await.unwrap();
        assert_eq!(cross_site.status(), StatusCode::FORBIDDEN);
        let missing_token = client.post(&invite.url).header(header::ORIGIN, "null").form(&[("link", link)]).send().await.unwrap();
        assert_eq!(missing_token.status(), StatusCode::FORBIDDEN);
        let (one, two) = tokio::join!(
            send().header(header::ORIGIN, "null").send(),
            send().header(header::ORIGIN, local_origin).send()
        );
        let mut statuses = [one.unwrap().status(), two.unwrap().status()];
        statuses.sort();
        assert_eq!(statuses, [StatusCode::OK, StatusCode::GONE]);
        match receiver.poll(&invite.id).unwrap() {
            Receipt::Received { link: received } => assert_eq!(link, received),
            _ => panic!("expected the posted configuration"),
        }
        assert!(matches!(receiver.poll(&invite.id).unwrap(), Receipt::Expired));
        receiver.cancel(&invite.id).unwrap();
    }

    #[tokio::test]
    async fn expired_or_replaced_invites_cannot_be_consumed() {
        let receiver = PhoneTransfer::default();
        let old = receiver.start_on(Ipv4Addr::LOCALHOST).await.unwrap();
        let invite = receiver.start_on(Ipv4Addr::LOCALHOST).await.unwrap();
        receiver.cancel(&old.id).unwrap();
        assert!(matches!(receiver.poll(&old.id).unwrap(), Receipt::Expired));
        assert!(matches!(receiver.poll(&invite.id).unwrap(), Receipt::Waiting));
        receiver.0.lock().unwrap().as_mut().unwrap().until = Instant::now();
        assert!(matches!(receiver.poll(&invite.id).unwrap(), Receipt::Expired));
    }
}

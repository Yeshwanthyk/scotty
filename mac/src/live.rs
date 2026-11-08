//! A live socket on its own thread: `/api/sessions/live` for the list, `/api/sessions/{id}/live`
//! for one session. The thread connects, reconnects with the web's backoff (1s doubling to 30s),
//! decodes every frame, and hands typed frames to the UI thread, waking it once per batch.
//!
//! Scotty pushes only on change and the web sends no pings, so neither does this. A close with
//! code 1000 is the server's last word: the thread reports `Closed` and ends. Dropping the
//! `Live` handle ends the thread too.

use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::thread;
use std::time::Duration;

use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Link {
    Connecting,
    Open,
    /// Down and retrying; why, for a tooltip.
    Retrying(String),
    /// The server closed it for good (code 1000).
    Closed,
    /// No token, or Access refused it: the thread ends, and the window asks the owner to sign in.
    SignIn,
}

pub enum Inbound<F> {
    Link(Link),
    Frame(F),
}

/// A running socket. Drop it to stop the thread.
pub struct Live<F> {
    pub inbound: Receiver<Inbound<F>>,
    _stop: Sender<()>,
}

pub fn start<F: Send + 'static>(base: &str, path: &str, decode: fn(&str) -> Option<F>, wake: impl Fn() + Send + 'static) -> Live<F> {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let (in_tx, in_rx) = mpsc::channel::<Inbound<F>>();
    let url = format!("{}{}", base.trim_end_matches('/').replacen("http", "ws", 1), path);
    let base = base.to_string();
    thread::Builder::new().name("scotty-live".into()).spawn(move || run(&base, &url, decode, &stop_rx, &in_tx, &wake)).expect("spawn a socket thread");
    Live { inbound: in_rx, _stop: stop_tx }
}

const READ_SLICE: Duration = Duration::from_millis(50);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);

fn run<F>(base: &str, url: &str, decode: fn(&str) -> Option<F>, stop: &Receiver<()>, out: &Sender<Inbound<F>>, wake: &impl Fn()) {
    let send = |m: Inbound<F>| -> bool {
        let ok = out.send(m).is_ok();
        if ok {
            wake();
        }
        ok
    };
    let stopped = || matches!(stop.try_recv(), Err(TryRecvError::Disconnected));
    let mut backoff = BACKOFF_MIN;
    loop {
        if stopped() {
            return;
        }
        let token = crate::signin::token(base).map_err(|no| match no {
            crate::signin::NoToken::SignIn => Refused::SignIn,
            crate::signin::NoToken::Bad(why) => Refused::Other(why),
        });
        let why = match token.and_then(|t| connect(base, url, &t)) {
            Ok(mut socket) => {
                backoff = BACKOFF_MIN;
                if !send(Inbound::Link(Link::Open)) {
                    return;
                }
                match serve(&mut socket, decode, &stopped, &send) {
                    End::Quit => {
                        let _ = socket.close(None);
                        return;
                    }
                    End::Final => {
                        send(Inbound::Link(Link::Closed));
                        return;
                    }
                    End::Lost(why) => why,
                }
            }
            Err(Refused::SignIn) => {
                send(Inbound::Link(Link::SignIn));
                return;
            }
            Err(Refused::Other(why)) => why,
        };
        if !send(Inbound::Link(Link::Retrying(why))) {
            return;
        }
        // Sleep in slices, so a dropped handle ends the thread promptly.
        let until = std::time::Instant::now() + backoff;
        while std::time::Instant::now() < until {
            if stopped() {
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

enum Refused {
    SignIn,
    Other(String),
}

/// No `Origin` header: the Worker refuses a foreign one on live sockets.
fn connect(base: &str, url: &str, token: &str) -> Result<Socket, Refused> {
    let other = |e: String| Refused::Other(e);
    let mut request = url.into_client_request().map_err(|e| other(e.to_string()))?;
    let headers = request.headers_mut();
    if !token.is_empty() {
        headers.insert("Cookie", HeaderValue::from_str(&format!("CF_Authorization={token}")).map_err(|e| other(e.to_string()))?);
        headers.insert("cf-access-token", HeaderValue::from_str(token).map_err(|e| other(e.to_string()))?);
    }
    let (socket, _) = tungstenite::connect(request).map_err(|e| match e {
        tungstenite::Error::Http(response) => {
            let code = response.status().as_u16();
            if matches!(code, 302 | 401 | 403) {
                crate::signin::refused(base, token);
                Refused::SignIn
            } else {
                Refused::Other(format!("Scotty answered {code}"))
            }
        }
        e => Refused::Other(e.to_string()),
    })?;
    let tcp = match socket.get_ref() {
        MaybeTlsStream::Plain(tcp) => tcp,
        MaybeTlsStream::Rustls(tls) => tls.get_ref(),
        _ => return Err(other("unexpected stream".into())),
    };
    tcp.set_nodelay(true).map_err(|e| other(e.to_string()))?;
    tcp.set_read_timeout(Some(READ_SLICE)).map_err(|e| other(e.to_string()))?;
    Ok(socket)
}

enum End {
    Quit,
    Final,
    Lost(String),
}

fn serve<F>(socket: &mut Socket, decode: fn(&str) -> Option<F>, stopped: &impl Fn() -> bool, send: &impl Fn(Inbound<F>) -> bool) -> End {
    loop {
        if stopped() {
            return End::Quit;
        }
        match socket.read() {
            Ok(Message::Text(text)) => {
                if let Some(frame) = decode(&text) {
                    if !send(Inbound::Frame(frame)) {
                        return End::Quit;
                    }
                }
            }
            Ok(Message::Close(frame)) => {
                return match frame {
                    Some(f) if f.code == CloseCode::Normal => End::Final,
                    Some(f) => End::Lost(format!("closed ({})", u16::from(f.code))),
                    None => End::Lost("closed".into()),
                };
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(e) => return End::Lost(e.to_string()),
        }
    }
}

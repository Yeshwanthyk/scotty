//! Signing in to a Scotty behind Cloudflare Access, from the app, as `cloudflared access login` does
//! (cloudflared's `token/token.go`, `token/transfer.go`, `token/jwks.go`), so nobody installs cloudflared.
//!
//! 1. **Which Access app guards this Scotty.** A `HEAD` with `cf-access-metadata-request: true` makes
//!    Cloudflare's edge answer with a signed JWT naming the app's AUD and the team's auth domain. Its
//!    signature is checked against the team's keys, and its hostname against the address asked for,
//!    so a look-alike server can't send the sign-in elsewhere.
//! 2. **The browser signs in.** The app makes a throwaway key pair and opens
//!    `<scotty>/cdn-cgi/access/cli?token=<public key>&aud=…`: the owner's own Access login page.
//! 3. **The token comes back sealed.** Meanwhile the app long-polls
//!    `login.cloudflareaccess.org/transfer/<public key>`; once the owner signs in, it answers with
//!    `{app_token, org_token}` sealed to that key (NaCl box), which only this process can open.
//! 4. **The Keychain keeps it**, under the Scotty's address. The Worker checks it on every request, so the
//!    app reads the expiry only to know when to ask again.
//!
//! Scotty sits behind its owner's own Access, so this works for any deployment; the
//! address is the only thing the app asks for.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use crypto_box::aead::{Aead, OsRng};
use crypto_box::{PublicKey, SalsaBox, SecretKey};
use serde::Deserialize;

const KEYCHAIN_SERVICE: &str = "scotty-mac";
const ACCESS_DOMAIN_SUFFIX: &str = ".cloudflareaccess.com";
const TRANSFER: &str = "https://login.cloudflareaccess.org/transfer/";
/// A sign-in left open in the browser gives up after about ten minutes, as cloudflared does. Short
/// polls, so Cancel ends the wait within seconds.
const POLLS: usize = 60;
const POLL_TIMEOUT: Duration = Duration::from_secs(10);
/// Ask again a minute before the token runs out, not after the socket is refused.
const EXPIRY_MARGIN: u64 = 60;

/// Why a request has no token to send.
#[derive(Debug, PartialEq, Eq)]
pub enum NoToken {
    /// Nothing saved, or it ran out: the owner signs in from the app's sign-in screen.
    SignIn,
    /// The address can't carry a sign-in (not https), or the Keychain refused to hand over the saved one.
    Bad(String),
}

/// The token to send to `base`: none for a Scotty on this Mac, else the saved one while it is good.
/// Never opens the browser; `sign_in` does, when the owner asks.
pub fn token(base: &str) -> Result<String, NoToken> {
    if loopback(base) {
        // A Worker on this Mac (`wrangler dev`, the UI's seed server) has no Access in front of it.
        return Ok(String::new());
    }
    let origin = origin(base).map_err(NoToken::Bad)?;
    let mut saved = held();
    let token = match saved.get(&origin) {
        Some(t) => Some(t.clone()),
        None => keychain::get(&origin).map_err(|code| NoToken::Bad(format!("macOS Keychain didn't let Scotty read its sign-in (error {code}). Allow it when macOS asks, or sign in again.")))?,
    };
    let Some(token) = token else { return Err(NoToken::SignIn) };
    saved.insert(origin, token.clone());
    if expired(&token) { Err(NoToken::SignIn) } else { Ok(token) }
}

/// The saved tokens this run has read, by origin. macOS asks before a rebuilt app reads a token an
/// earlier build saved, so the app reads each one once rather than on every request's thread. The
/// lock also keeps a refusal's read-then-delete and a sign-in's save from interleaving.
static KEYCHAIN: std::sync::Mutex<std::collections::BTreeMap<String, String>> = std::sync::Mutex::new(std::collections::BTreeMap::new());

fn held() -> std::sync::MutexGuard<'static, std::collections::BTreeMap<String, String>> {
    KEYCHAIN.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Scotty refused `sent` (Access answered 401, 403 or a redirect): drop it, so the next request
/// asks for a sign-in rather than sending it again. A token saved since `sent` went out (a sign-in
/// that landed while this request was on the wire) stays.
pub fn refused(base: &str, sent: &str) {
    let Ok(origin) = origin(base) else { return };
    let mut saved = held();
    if saved.get(&origin).map(String::as_str) == Some(sent) {
        saved.remove(&origin);
        keychain::delete(&origin);
    }
}

/// The browser sign-in, steps 1 to 4. `opened` gets the sign-in page's address once the browser
/// shows it, so the app can offer to open it again; `cancelled` ends the wait between long polls.
/// Blocks until the owner finishes, gives up, or cancels: run it off the UI thread.
pub fn sign_in(base: &str, opened: impl FnOnce(String), cancelled: impl Fn() -> bool) -> Result<(), String> {
    let origin = origin(base)?;
    let app = app_info(&origin)?;
    let token = transfer(&origin, &app.aud, opened, cancelled)?;
    let mut saved = held();
    keychain::set(&origin, &token);
    saved.insert(origin, token);
    Ok(())
}

/// Forget the saved token for `base` (sign out).
pub fn forget(base: &str) {
    if let Ok(origin) = origin(base) {
        held().remove(&origin);
        keychain::delete(&origin);
    }
}

/// `https://host` with no path, lower-case: the Keychain account and the Access app's address.
fn origin(base: &str) -> Result<String, String> {
    let base = base.trim().trim_end_matches('/');
    let (scheme, rest) = base.split_once("://").ok_or_else(|| format!("{base} isn't an address (https://…)"))?;
    if scheme != "https" {
        return Err(format!("{base}: a deployed Scotty answers on https"));
    }
    let host = rest.split('/').next().unwrap_or_default().to_ascii_lowercase();
    if host.is_empty() {
        return Err(format!("{base} has no host"));
    }
    Ok(format!("https://{host}"))
}

/// `http://127.0.0.1:…`, `http://localhost:…` or `http://[::1]:…`: a Worker on this Mac.
fn loopback(base: &str) -> bool {
    let Some(rest) = base.trim().strip_prefix("http://") else { return false };
    let authority = rest.split('/').next().unwrap_or_default();
    let host = match authority.strip_prefix('[') {
        Some(v6) => v6.split(']').next().unwrap_or_default(),
        None => authority.split(':').next().unwrap_or_default(),
    };
    matches!(host.to_ascii_lowercase().as_str(), "127.0.0.1" | "localhost" | "::1")
}

fn host_of(origin: &str) -> &str {
    origin.trim_start_matches("https://")
}

/// The metadata JWT's claims (cloudflared `metadataClaims`).
#[derive(Debug, Deserialize)]
struct AppInfo {
    #[serde(rename = "type")]
    kind: String,
    hostname: String,
    auth_domain: String,
    aud: String,
    iat: u64,
}

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0)
        .timeout_connect(Duration::from_secs(7))
        .user_agent(concat!("scotty-mac/", env!("CARGO_PKG_VERSION")))
        .build()
}

/// Step 1: which Access app guards `origin`, checked against the team's keys.
fn app_info(origin: &str) -> Result<AppInfo, String> {
    let response = match agent()
        .head(origin)
        .set("cf-access-metadata-request", "true")
        .timeout(Duration::from_secs(7))
        .call()
    {
        Ok(response) => response,
        Err(ureq::Error::Status(_, response)) => response,
        Err(e) => return Err(format!("couldn't reach {origin}: {e}")),
    };
    let jwt = response
        .header("cf-access-metadata")
        .ok_or_else(|| format!("{origin} isn't behind Cloudflare Access"))?
        .to_string();

    // The unverified claims name the team, whose keys then check the signature.
    let unverified: AppInfo = claims(&jwt).ok_or("Access sent an unreadable app description")?;
    let team = unverified.auth_domain.to_ascii_lowercase();
    if !team.ends_with(ACCESS_DOMAIN_SUFFIX) || team.contains('/') {
        return Err(format!("Access named an unexpected sign-in domain ({team})"));
    }
    let info = verify(&jwt, &team)?;

    let now = now();
    if !info.hostname.eq_ignore_ascii_case(host_of(origin)) {
        return Err(format!("Access described {} when asked about {}", info.hostname, host_of(origin)));
    }
    if info.kind != "match" || info.aud.is_empty() {
        return Err("Access found no app for this address".into());
    }
    if info.iat + 24 * 3600 < now || info.iat > now + 300 {
        return Err("Access's app description is out of date; check this computer's clock".into());
    }
    Ok(info)
}

#[derive(Deserialize)]
struct Certs {
    keys: Vec<Jwk>,
}

#[derive(Deserialize)]
struct Jwk {
    kid: String,
    n: String,
    e: String,
}

fn verify(jwt: &str, team: &str) -> Result<AppInfo, String> {
    use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header};
    let kid = decode_header(jwt).ok().and_then(|h| h.kid).ok_or("Access's app description isn't signed")?;
    let certs = agent()
        .get(&format!("https://{team}/cdn-cgi/access/certs"))
        .timeout(Duration::from_secs(7))
        .call()
        .map_err(|e| format!("couldn't fetch {team}'s keys: {e}"))?
        .into_string()
        .map_err(|e| format!("couldn't fetch {team}'s keys: {e}"))?;
    let certs: Certs = serde_json::from_str(&certs).map_err(|e| format!("{team}'s keys didn't parse: {e}"))?;
    let key = certs.keys.iter().find(|k| k.kid == kid).ok_or("Access signed with a key its team doesn't list")?;
    let key = DecodingKey::from_rsa_components(&key.n, &key.e).map_err(|e| e.to_string())?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.required_spec_claims.clear();
    validation.validate_exp = false;
    validation.validate_aud = false;
    decode::<AppInfo>(jwt, &key, &validation)
        .map(|data| data.claims)
        .map_err(|e| format!("Access's app description failed its signature check: {e}"))
}

#[derive(Deserialize)]
struct Transferred {
    app_token: String,
}

/// Steps 2 and 3: the browser signs in; the token comes back sealed to a key only this process has.
fn transfer(origin: &str, aud: &str, opened: impl FnOnce(String), cancelled: impl Fn() -> bool) -> Result<String, String> {
    let secret = SecretKey::generate(&mut OsRng);
    let public = URL_SAFE.encode(secret.public_key().as_bytes());

    // cloudflared's buildRequestURL: the token and aud ride on both the redirect and the cli URL.
    let redirect = format!("{origin}/?aud={}&token={}", enc(aud), enc(&public));
    let url = format!(
        "{origin}/cdn-cgi/access/cli?aud={}&edge_token_transfer=true&redirect_url={}&send_org_token=true&token={}",
        enc(aud),
        enc(&redirect),
        enc(&public)
    );
    std::process::Command::new("open").arg(&url).status().map_err(|e| format!("couldn't open the browser: {e}"))?;
    opened(url);

    let poll = format!("{TRANSFER}{public}");
    for _ in 0..POLLS {
        if cancelled() {
            return Err("cancelled".into());
        }
        match agent().get(&poll).timeout(POLL_TIMEOUT).call() {
            Ok(response) if response.status() == 200 => {
                let sender = response.header("service-public-key").ok_or("the sign-in came back without its key")?.to_string();
                let body = response.into_string().map_err(|e| e.to_string())?;
                let sealed = STANDARD.decode(body.trim()).map_err(|_| "the sign-in came back unreadable")?;
                let opened = open(&sealed, &sender, &secret)?;
                let tokens: Transferred = serde_json::from_slice(&opened).map_err(|_| "the sign-in came back unreadable")?;
                return Ok(tokens.app_token);
            }
            // Not signed in yet: the endpoint answers once the browser finishes.
            Ok(_) | Err(ureq::Error::Status(400..=499, _)) => {}
            Err(ureq::Error::Status(code, _)) => return Err(format!("Cloudflare's sign-in service answered {code}")),
            Err(ureq::Error::Transport(e)) if e.kind() == ureq::ErrorKind::Io => {} // the long poll timed out
            Err(e) => return Err(format!("Cloudflare's sign-in service: {e}")),
        }
    }
    Err("the browser sign-in didn't finish".into())
}

/// NaCl box: a 24-byte nonce, then the sealed bytes.
fn open(sealed: &[u8], sender: &str, secret: &SecretKey) -> Result<Vec<u8>, String> {
    if sealed.len() < 24 {
        return Err("the sign-in came back too short".into());
    }
    let sender = URL_SAFE.decode(sender).ok().and_then(|b| <[u8; 32]>::try_from(b).ok()).ok_or("the sign-in's key is malformed")?;
    let (nonce, body) = sealed.split_at(24);
    SalsaBox::new(&PublicKey::from(sender), secret)
        .decrypt(nonce.into(), body)
        .map_err(|_| "the sign-in didn't open with this app's key".to_string())
}

fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A JWT's claims, unverified: for the expiry and to find the signer.
fn claims<T: for<'de> Deserialize<'de>>(jwt: &str) -> Option<T> {
    let payload = jwt.split('.').nth(1)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?).ok()
}

fn expired(jwt: &str) -> bool {
    #[derive(Deserialize)]
    struct Exp {
        exp: u64,
    }
    claims::<Exp>(jwt).is_none_or(|c| c.exp <= now() + EXPIRY_MARGIN)
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The login Keychain, one generic password per Scotty address.
mod keychain {
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    use super::KEYCHAIN_SERVICE;

    /// The saved token, `None` when nothing is saved, or the Keychain's error code when it refused.
    pub fn get(origin: &str) -> Result<Option<String>, i32> {
        const NOT_FOUND: i32 = -25300;
        match get_generic_password(KEYCHAIN_SERVICE, origin) {
            Ok(b) => Ok(String::from_utf8(b).ok()),
            Err(e) if e.code() == NOT_FOUND => Ok(None),
            Err(e) => Err(e.code()),
        }
    }

    pub fn set(origin: &str, token: &str) {
        let _ = set_generic_password(KEYCHAIN_SERVICE, origin, token.as_bytes());
    }

    pub fn delete(origin: &str) {
        let _ = delete_generic_password(KEYCHAIN_SERVICE, origin);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_becomes_its_origin() {
        assert_eq!(origin("https://Scotty.Example.workers.dev/chat/3").unwrap(), "https://scotty.example.workers.dev");
        assert!(origin("http://scotty.example.com").is_err());
        assert!(origin("scotty.example.com").is_err());
    }

    #[test]
    fn only_this_mac_skips_access() {
        assert!(loopback("http://127.0.0.1:8787"));
        assert!(loopback("http://localhost:4173/s/abc"));
        assert!(loopback("http://[::1]:8787"));
        assert!(!loopback("https://127.0.0.1:8787"));
        assert!(!loopback("http://127.0.0.1.example.com"));
        assert!(!loopback("http://scotty.example.com"));
    }

    #[test]
    fn a_sealed_token_opens_with_this_apps_key_only() {
        let app = SecretKey::generate(&mut OsRng);
        let service = SecretKey::generate(&mut OsRng);
        let nonce = [7u8; 24];
        let sealed = SalsaBox::new(&app.public_key(), &service).encrypt((&nonce).into(), &b"{\"app_token\":\"a.b.c\"}"[..]).unwrap();
        let wire = [nonce.as_slice(), &sealed].concat();
        let sender = URL_SAFE.encode(service.public_key().as_bytes());

        let opened = open(&wire, &sender, &app).unwrap();
        assert_eq!(serde_json::from_slice::<Transferred>(&opened).unwrap().app_token, "a.b.c");
        assert!(open(&wire, &sender, &SecretKey::generate(&mut OsRng)).is_err());
    }

    #[test]
    fn a_token_near_its_expiry_counts_as_expired() {
        let jwt = |exp: u64| format!("h.{}.s", URL_SAFE_NO_PAD.encode(format!("{{\"exp\":{exp}}}")));
        assert!(!expired(&jwt(now() + 3600)));
        assert!(expired(&jwt(now() + 10)));
        assert!(expired("not-a-jwt"));
    }
}

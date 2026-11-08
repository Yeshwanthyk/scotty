//! The Scottys this app has opened, by the address the user typed. Nothing names one in code.
//! The list lives in `~/Library/Application Support/scotty-mac/servers.json`: addresses only.
//! Tokens live in the Keychain (`signin.rs`).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Server {
    /// The address's host, as the list shows it.
    pub name: String,
    /// `https://host`, or `http://127.0.0.1:port` for a local Worker.
    pub url: String,
}

#[derive(Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default)]
    servers: Vec<Server>,
    #[serde(default)]
    last: Option<String>,
    /// Turns seen per session, by server and session id (the web keeps this in localStorage).
    #[serde(default)]
    seen: std::collections::HashMap<String, std::collections::HashMap<String, u64>>,
}

pub fn known() -> Vec<Server> {
    load().servers
}

/// The one opened last, to open again at launch.
pub fn last() -> Option<Server> {
    let saved = load();
    let url = saved.last?;
    Some(
        saved
            .servers
            .into_iter()
            .find(|k| same(&k.url, &url))
            .unwrap_or_else(|| Server {
                name: name_of(&url),
                url,
            }),
    )
}

pub fn opened(server: &Server) {
    let mut saved = load();
    if !saved.servers.iter().any(|k| same(&k.url, &server.url)) {
        saved.servers.push(server.clone());
    }
    saved.last = Some(server.url.clone());
    store(&saved);
}

/// Stop opening it at launch; signing out leaves it in the list.
pub fn forget_last() {
    let mut saved = load();
    saved.last = None;
    store(&saved);
}

pub fn seen(url: &str) -> std::collections::HashMap<String, u64> {
    load().seen.remove(url).unwrap_or_default()
}

pub fn mark_seen(url: &str, id: &str, turns: u64) {
    let mut saved = load();
    let map = saved.seen.entry(url.to_string()).or_default();
    if map.get(id) == Some(&turns) {
        return;
    }
    map.insert(id.to_string(), turns);
    store(&saved);
}

/// A typed address: `scotty.example.com` or `https://…/s/abc` → `https://host`.
pub fn parse(typed: &str) -> Option<Server> {
    let typed = typed.trim().trim_end_matches('/');
    if typed.is_empty() || typed.contains(char::is_whitespace) {
        return None;
    }
    let with_scheme = if typed.contains("://") {
        typed.to_string()
    } else {
        format!("https://{typed}")
    };
    let (scheme, rest) = with_scheme.split_once("://")?;
    let host = rest.split('/').next()?.to_ascii_lowercase();
    if !matches!(scheme, "https" | "http") || !host.contains(['.', ':']) {
        return None;
    }
    let url = format!("{scheme}://{host}");
    Some(Server {
        name: name_of(&url),
        url,
    })
}

fn name_of(url: &str) -> String {
    url.split("://").nth(1).unwrap_or(url).to_string()
}

fn same(a: &str, b: &str) -> bool {
    a.trim_end_matches('/')
        .eq_ignore_ascii_case(b.trim_end_matches('/'))
}

fn saved_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Application Support/scotty-mac/servers.json"))
}

fn load() -> Saved {
    if std::env::var_os("APP_OFFLINE").is_some() {
        return Saved::default();
    }
    saved_path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn store(saved: &Saved) {
    if std::env::var_os("APP_OFFLINE").is_some() {
        return;
    }
    let Some(path) = saved_path() else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_vec_pretty(saved) {
        let _ = std::fs::write(path, json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_typed_address_becomes_a_server() {
        assert_eq!(
            parse("scotty.example.com").unwrap().url,
            "https://scotty.example.com"
        );
        assert_eq!(
            parse("https://Scotty.Example.com/s/abc").unwrap().name,
            "scotty.example.com"
        );
        assert_eq!(
            parse("http://127.0.0.1:8787").unwrap().url,
            "http://127.0.0.1:8787"
        );
        assert!(parse("not an address").is_none());
        assert!(parse("ftp://x.y").is_none());
    }
}

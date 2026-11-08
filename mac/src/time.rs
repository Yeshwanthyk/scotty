//! Times as the web writes them (`ui/src/data/status.ts`): `ago`, `until`, `duration` and the
//! sidebar's groups. The API sends ISO 8601 strings; `parse` reads them as UTC milliseconds.

/// `2026-11-07T09:30:00.000Z` (or with an offset) → milliseconds since the epoch.
pub fn parse(iso: &str) -> Option<f64> {
    let b = iso.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> { iso.get(from..from + len)?.parse().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (h, mi, s) = if b.len() >= 19 { (num(11, 2)?, num(14, 2)?, num(17, 2)?) } else { (0, 0, 0) };
    let mut i = 19;
    let mut frac = 0.0;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        frac = format!("0.{}", &iso[start..i]).parse().unwrap_or(0.0);
    }
    let offset = match b.get(i) {
        Some(b'+' | b'-') => {
            let sign = if b[i] == b'-' { -1 } else { 1 };
            sign * (num(i + 1, 2)? * 60 + num(i + 4, 2).unwrap_or(0))
        }
        _ => 0,
    };
    let days = days_from_civil(y, mo, d);
    let secs = days * 86_400 + h * 3600 + mi * 60 + s - offset * 60;
    Some((secs as f64 + frac) * 1000.0)
}

/// Howard Hinnant's days_from_civil.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The local calendar: (days since the epoch in local time, month 0–11, day of month, seconds
/// east of UTC).
fn local(ms: f64) -> (i64, i32, i32, i64) {
    let secs = (ms / 1000.0).floor() as libc::time_t;
    // SAFETY: localtime_r writes into the `tm` we own and reads only `secs`.
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe { libc::localtime_r(&secs, &mut tm) };
    let day = (secs as i64 + tm.tm_gmtoff).div_euclid(86_400);
    (day, tm.tm_mon, tm.tm_mday, tm.tm_gmtoff)
}

const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/// Days since the epoch on the local calendar.
pub fn day(ms: f64) -> i64 {
    local(ms).0
}

pub fn now_ms() -> f64 {
    std::time::UNIX_EPOCH.elapsed().map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// "now", "5m", "3h", "2d", then "Nov 7".
pub fn ago(iso: &str, now: f64) -> String {
    let Some(at) = parse(iso) else { return String::new() };
    let seconds = ((now - at) / 1000.0).round().max(0.0);
    if seconds < 45.0 {
        return "now".into();
    }
    let minutes = (seconds / 60.0).round();
    if minutes < 60.0 {
        return format!("{minutes}m");
    }
    let hours = (minutes / 60.0).round();
    if hours < 24.0 {
        return format!("{hours}h");
    }
    let days = (hours / 24.0).round();
    if days < 7.0 {
        return format!("{days}d");
    }
    let (_, mon, mday, _) = local(at);
    format!("{} {mday}", MONTHS[mon as usize])
}

/// "42s", "3m 5s", "1h 20m".
pub fn duration(ms: f64) -> String {
    let seconds = (ms / 1000.0).round().max(0.0) as i64;
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    if minutes < 60 {
        return format!("{minutes}m {}s", seconds % 60);
    }
    format!("{}h {}m", minutes / 60, minutes % 60)
}

pub const GROUPS: [&str; 3] = ["Today", "This week", "Older"];

/// Today (since local midnight), This week (since midnight six days ago), Older.
pub fn group_of(iso: &str, now: f64) -> usize {
    let Some(at) = parse(iso) else { return 2 };
    let (today, _, _, _) = local(now);
    let (day, _, _, _) = local(at);
    match today - day {
        ..=0 => 0,
        1..=6 => 1,
        _ => 2,
    }
}

/// An ISO string for `ms`, for offline scenes.
pub fn iso(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_read_as_the_web_writes_them() {
        assert_eq!(parse("1970-01-01T00:00:01.500Z"), Some(1500.0));
        assert_eq!(parse("2026-11-07T10:00:00+01:00"), parse("2026-11-07T09:00:00Z"));
        let now = parse("2026-11-07T12:00:00Z").unwrap();
        assert_eq!(iso(now), "2026-11-07T12:00:00.000Z");
        assert_eq!(ago("2026-11-07T11:59:30Z", now), "now");
        assert_eq!(ago("2026-11-07T11:55:00Z", now), "5m");
        assert_eq!(ago("2026-11-07T09:00:00Z", now), "3h");
        assert_eq!(duration(42_000.0), "42s");
        assert_eq!(duration(185_000.0), "3m 5s");
    }
}

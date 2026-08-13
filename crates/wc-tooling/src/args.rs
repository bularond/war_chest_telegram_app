//! `--name value` and `--flag`, the way every command here is invoked.

use wc_core::types::DraftMode;
use wc_core::units::{SetMask, UnitSet};

pub fn arg(name: &str, fallback: &str) -> String {
    let flag = format!("--{name}");
    let argv: Vec<String> = std::env::args().collect();
    match argv.iter().position(|a| *a == flag) {
        Some(i) => argv.get(i + 1).cloned().unwrap_or_else(|| fallback.to_string()),
        None => fallback.to_string(),
    }
}

pub fn flag(name: &str) -> bool {
    let flag = format!("--{name}");
    std::env::args().any(|a| a == flag)
}

pub fn num<T: std::str::FromStr>(name: &str, fallback: T) -> T
where
    T::Err: std::fmt::Display,
{
    let raw = arg(name, "");
    if raw.is_empty() {
        return fallback;
    }
    match raw.parse() {
        Ok(v) => v,
        Err(e) => {
            eprintln!("--{name} {raw}: {e}");
            std::process::exit(1);
        }
    }
}

/// `--sets nobility,siege`. The base game is always in.
pub fn sets(name: &str) -> SetMask {
    let raw = arg(name, "");
    let mut mask = SetMask::base();
    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        match UnitSet::from_key(part) {
            Some(set) => mask = mask.with(set),
            None => {
                eprintln!("unknown set \"{part}\"; known: base, nobility, siege, nightfall");
                std::process::exit(1);
            }
        }
    }
    mask
}

pub fn draft_mode(name: &str, fallback: &str) -> DraftMode {
    let raw = arg(name, fallback);
    match DraftMode::from_key(&raw) {
        Some(mode) => mode,
        None => {
            eprintln!("unknown draft mode \"{raw}\"; known: random, draft, ban");
            std::process::exit(1);
        }
    }
}

pub fn die(message: impl std::fmt::Display) -> ! {
    eprintln!("{message}");
    std::process::exit(1)
}

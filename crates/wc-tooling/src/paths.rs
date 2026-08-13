//! Where a path on the command line is measured from.
//!
//! `npm run sprt -- --a weights/base.json` starts the binary from wherever npm
//! put it, not from where the command was typed — so a relative path opened one
//! directory too deep. npm exports the directory the user was standing in as
//! `INIT_CWD`; when it is absent the process's own directory is right.

use std::path::{Path, PathBuf};

pub fn base() -> PathBuf {
    match std::env::var_os("INIT_CWD") {
        Some(dir) => PathBuf::from(dir),
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    }
}

pub fn resolve(path: &str) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        base().join(p)
    }
}

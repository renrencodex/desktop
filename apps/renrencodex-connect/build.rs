use std::{env, fs, path::PathBuf};

fn main() {
    let package_json = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest directory"))
        .join("../desktop/package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());

    let document: serde_json::Value =
        serde_json::from_slice(&fs::read(&package_json).expect("read apps/desktop/package.json"))
            .expect("parse apps/desktop/package.json");
    let version = document["version"]
        .as_str()
        .filter(|value| {
            let parts = value.split('.').collect::<Vec<_>>();
            parts.len() == 3
                && parts
                    .iter()
                    .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
        })
        .expect("Desktop version must be stable SemVer");
    println!("cargo:rustc-env=RENRENCODEX_CONNECT_VERSION={version}");
}

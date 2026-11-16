fn main() {
    println!("cargo:rerun-if-env-changed=TAURI_SIGNING_PRIVATE_KEY");
    println!("cargo:rerun-if-env-changed=RENRENCODEX_UPDATER_PUBLIC_KEY");
    let signing_key_is_set =
        std::env::var("TAURI_SIGNING_PRIVATE_KEY").is_ok_and(|value| !value.trim().is_empty());
    let public_key_is_set =
        std::env::var("RENRENCODEX_UPDATER_PUBLIC_KEY").is_ok_and(|value| !value.trim().is_empty());
    if signing_key_is_set && !public_key_is_set {
        panic!("RENRENCODEX_UPDATER_PUBLIC_KEY must be set when building signed updater artifacts");
    }
    tauri_build::build()
}

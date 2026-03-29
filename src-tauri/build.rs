fn main() {
    // Embed the UAC manifest only in release builds.
    // In dev/debug builds, Tauri's hot-reload conflicts with requireAdministrator
    // and causes a STATUS_ENTRYPOINT_NOT_FOUND crash, so we skip it there.
    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile == "release" {
        tauri_build::try_build(
            tauri_build::Attributes::new().windows_attributes(
                tauri_build::WindowsAttributes::new()
                    .app_manifest(include_str!("app.manifest")),
            ),
        )
        .expect("failed to run tauri-build");
    } else {
        tauri_build::build();
    }
}

use std::path::PathBuf;

/*
 * `pnpm tauri dev` and the E2E binary are bare executables in `target/debug/`
 * with no `.app` around them, so macOS finds no bundle name and falls back to the
 * executable's file name — `anyscp`, the Cargo package name — for the Dock
 * tooltip and the app menu. A dev instance therefore shows up as a different
 * application than the `OmniSSH-dev` window title and About card (see the
 * `window_title` in lib.rs).
 *
 * macOS also accepts a regular directory as a flat bundle: an executable whose
 * directory holds an Info.plist naming it in `CFBundleExecutable` is registered
 * under that plist's `CFBundleName`/`CFBundleDisplayName`. Writing such a plist
 * beside the freshly linked binary renames dev builds without touching anything
 * outside `target/`. An embedded `__TEXT,__info_plist` section does not achieve
 * this — it is ignored for a non-bundled executable.
 *
 * Release builds are skipped: the Tauri bundler gives the `.app` its own
 * Info.plist. `CFBundleIdentifier` is left out on purpose so dev builds stay
 * unnamed with LaunchServices exactly as they are today, leaving keychain and
 * permission identities untouched.
 */
fn name_macos_debug_binary() {
    /* Read the target from the environment rather than `cfg!` so a cross-build is
     * judged by the platform the binary is generated for, not the host. */
    let is_macos_target = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos");
    let is_debug_profile = std::env::var("PROFILE").as_deref() == Ok("debug");
    if !(is_macos_target && is_debug_profile) {
        return;
    }

    let out_dir =
        PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR set for build scripts"));
    /* OUT_DIR is `<target>/<profile>/build/<crate>-<hash>/out`, so three
     * ancestors up is the directory the linked binary is written to. */
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return;
    };

    /* CFBundleExecutable has to name the binary for macOS to pair the plist with
     * it; the name is the package name because there is no custom `[[bin]]`. */
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>OmniSSH-dev</string>
	<key>CFBundleDisplayName</key>
	<string>OmniSSH-dev</string>
	<key>CFBundleExecutable</key>
	<string>{}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
</dict>
</plist>
"#,
        env!("CARGO_PKG_NAME")
    );

    /* Cosmetic only: an unwritable target directory is worth a warning, not a
     * build failure. */
    if let Err(e) = std::fs::write(profile_dir.join("Info.plist"), plist) {
        println!("cargo:warning=could not write the macOS dev Info.plist: {e}");
    }
}

fn main() {
    name_macos_debug_binary();
    tauri_build::build()
}

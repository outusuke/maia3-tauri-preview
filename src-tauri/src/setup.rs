use serde::Serialize;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Without this, every child process flashes a console window on Windows release builds.
pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        self
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    /// Legacy PyTorch backend: the `maia3` pip package is on PATH.
    pub engine_ready: bool,
    pub onnx_runtime_ready: bool,
    pub onnx_models_ready: Vec<String>,
    /// Exported .onnx file size in bytes, keyed by model, for the models in `onnx_models_ready`.
    pub onnx_model_bytes: std::collections::HashMap<String, u64>,
    pub stockfish_ready: bool,
    /// "stockfish" if found on PATH, otherwise the full path to the app's downloaded copy.
    pub stockfish_path: Option<String>,
    /// True only when `stockfish_path` is this app's own downloaded copy, not a system install — the only case "Remove" applies to.
    pub stockfish_is_downloaded: bool,
    pub stockfish_bytes: Option<u64>,
    /// Host programs like a system Stockfish aren't visible in Flatpak; the UI uses this to push the built-in download.
    pub flatpak: bool,
}

/// The three console scripts install together, so finding any one means ready.
const MAIA_CANDIDATES: &[&str] = &["maia3-5m", "maia3-23m", "maia3-79m"];

/// Hand-rolled to avoid pulling in the `which` crate.
fn on_path(name: &str) -> bool {
    find_on_path(name).is_some()
}

fn any_on_path(names: &[&str]) -> bool {
    names.iter().any(|n| on_path(n))
}

fn exe_file_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let exe = exe_file_name(name);
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(&exe))
        .find(|p| is_executable_file(p))
}

/// A GUI-launched app inherits a minimal PATH, missing e.g. /usr/games (Debian) and /opt/homebrew/bin.
fn well_known_bin_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from);

    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(p) = std::env::var_os(var) {
                dirs.push(PathBuf::from(p).join("Stockfish"));
            }
        }
        if let Some(p) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(p).join("Microsoft").join("WinGet").join("Links"));
        }
        if let Some(h) = &home {
            dirs.push(h.join("scoop").join("shims"));
        }
        dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
        dirs.push(PathBuf::from(r"C:\Stockfish"));
    } else {
        for d in [
            "/usr/games",
            "/usr/local/games",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/opt/homebrew/bin",
            "/opt/local/bin",
            "/snap/bin",
            "/home/linuxbrew/.linuxbrew/bin",
            "/run/current-system/sw/bin",
            "/nix/var/nix/profiles/default/bin",
        ] {
            dirs.push(PathBuf::from(d));
        }
        if let Some(h) = &home {
            for d in [".local/bin", "bin", ".cargo/bin", ".nix-profile/bin"] {
                dirs.push(h.join(d));
            }
        }
    }
    dirs
}

fn find_executable(name: &str) -> Option<PathBuf> {
    if let Some(p) = find_on_path(name) {
        return Some(p);
    }
    let exe = exe_file_name(name);
    well_known_bin_dirs()
        .into_iter()
        .map(|d| d.join(&exe))
        .find(|p| is_executable_file(p))
}

/// Host paths like /usr/games aren't visible inside a Flatpak, whatever PATH says.
fn is_flatpak() -> bool {
    Path::new("/.flatpak-info").exists()
}

/// Last resort: the login shell picks up PATH additions from ~/.profile; short timeout so a slow shell can't hang the UI.
#[cfg(unix)]
fn probe_login_shell(name: &str) -> Option<PathBuf> {
    if is_flatpak() {
        return None; // the sandbox's shell knows nothing about the host
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut child = Command::new(shell)
        .args(["-l", "-c", &format!("command -v {name}")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    // Take the last non-empty line: rc files sometimes print a banner first.
    let line = out.lines().rev().find(|l| !l.trim().is_empty())?.trim();
    let p = PathBuf::from(line);
    is_executable_file(&p).then_some(p)
}

#[cfg(not(unix))]
fn probe_login_shell(_name: &str) -> Option<PathBuf> {
    None
}

fn stockfish_exe_name() -> &'static str {
    if cfg!(windows) {
        "stockfish.exe"
    } else {
        "stockfish"
    }
}

/// Lives in the app's own data dir, so no sudo or package manager is needed.
fn stockfish_install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("couldn't resolve app data dir: {e}"))?
        .join("bin");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Removes only this app's own downloaded copy. A system Stockfish on PATH is left alone — there's nothing here to remove.
#[tauri::command]
pub fn remove_stockfish(app: AppHandle) -> Result<(), String> {
    if let Some(path) = downloaded_stockfish_path(&app) {
        std::fs::remove_file(&path).map_err(|e| format!("could not remove {}: {e}", path.display()))?;
    }
    Ok(())
}

fn downloaded_stockfish_path(app: &AppHandle) -> Option<PathBuf> {
    let path = stockfish_install_dir(app).ok()?.join(stockfish_exe_name());
    path.is_file().then_some(path)
}

/// Order: STOCKFISH_PATH env var, PATH plus well-known dirs, the app's downloaded copy, then the login shell. Always a full path.
pub fn resolve_stockfish(app: &AppHandle) -> Option<String> {
    if let Some(p) = std::env::var_os("STOCKFISH_PATH").map(PathBuf::from) {
        if is_executable_file(&p) {
            return Some(p.to_string_lossy().to_string());
        }
    }
    if let Some(p) = find_executable("stockfish") {
        return Some(p.to_string_lossy().to_string());
    }
    if let Some(p) = downloaded_stockfish_path(app) {
        return Some(p.to_string_lossy().to_string());
    }
    probe_login_shell("stockfish").map(|p| p.to_string_lossy().to_string())
}

/// Lets the frontend tell "not installed" from "found but failed to launch".
pub const STOCKFISH_NOT_FOUND_PREFIX: &str = "not-found:";

pub fn stockfish_not_found_message() -> String {
    if is_flatpak() {
        format!(
            "{STOCKFISH_NOT_FOUND_PREFIX} this app is running inside a Flatpak sandbox, which \
             can't see Stockfish installed on the host system. Use the setup screen's \
             \"Install Stockfish\" option to download a copy the app can use."
        )
    } else {
        format!(
            "{STOCKFISH_NOT_FOUND_PREFIX} Stockfish wasn't found on PATH or in the usual \
             install locations (/usr/games, /usr/local/bin, Homebrew, ...). If it lives \
             somewhere unusual, start the app with STOCKFISH_PATH=/full/path/to/stockfish."
        )
    }
}

// async so resolving (filesystem, login shell) doesn't stall the UI thread.
#[tauri::command(async)]
pub fn setup_status(app: AppHandle) -> SetupStatus {
    let stockfish_path = resolve_stockfish(&app);
    let downloaded_stockfish = downloaded_stockfish_path(&app);
    let stockfish_is_downloaded = matches!((&stockfish_path, &downloaded_stockfish),
        (Some(p), Some(d)) if *p == d.to_string_lossy());
    let stockfish_bytes = downloaded_stockfish.filter(|_| stockfish_is_downloaded)
        .and_then(|p| p.metadata().ok())
        .map(|m| m.len());
    let onnx_models_ready = onnx_exported_models(&app);
    let onnx_model_bytes = onnx_models_ready
        .iter()
        .filter_map(|m| {
            let bytes = onnx_model_path(&app, m).ok()?.metadata().ok()?.len();
            Some((m.clone(), bytes))
        })
        .collect();
    SetupStatus {
        engine_ready: any_on_path(MAIA_CANDIDATES),
        onnx_runtime_ready: onnx_venv_works(&app),
        onnx_models_ready,
        onnx_model_bytes,
        stockfish_ready: stockfish_path.is_some(),
        stockfish_path,
        stockfish_is_downloaded,
        stockfish_bytes,
        flatpak: is_flatpak(),
    }
}

fn emit_log(app: &AppHandle, line: impl AsRef<str>) {
    let _ = app.emit("setup-log", line.as_ref());
}

// Steps have very uneven cost, so each gets a weight; ones we can't measure report `fraction: None` instead of a made-up number.

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProgressEvent {
    /// "maia" or "stockfish"
    task: String,
    steps: Vec<String>,
    weights: Vec<f32>,
    /// Equals steps.len() once finished.
    index: usize,
    fraction: Option<f32>,
    /// Percent (0..=100) for the whole task; `fraction` is 0..=1 within the step.
    overall: f32,
    /// "running" | "done" | "failed"
    state: &'static str,
    detail: Option<String>,
}

#[derive(Clone)]
struct Progress {
    app: AppHandle,
    task: &'static str,
    steps: Vec<String>,
    weights: Vec<f32>,
    index: usize,
}

impl Progress {
    fn new(app: &AppHandle, task: &'static str, plan: &[(&str, f32)]) -> Self {
        let p = Progress {
            app: app.clone(),
            task,
            steps: plan.iter().map(|(s, _)| s.to_string()).collect(),
            weights: plan.iter().map(|(_, w)| *w).collect(),
            index: 0,
        };
        p.emit("running", None, None);
        p
    }

    fn overall(&self, fraction: Option<f32>) -> f32 {
        let total: f32 = self.weights.iter().sum();
        if total <= 0.0 {
            return 0.0;
        }
        let done: f32 = self.weights.iter().take(self.index).sum();
        let within = self
            .weights
            .get(self.index)
            .map(|w| w * fraction.unwrap_or(0.0).clamp(0.0, 1.0))
            .unwrap_or(0.0);
        ((done + within) / total * 100.0).min(100.0)
    }

    fn emit(&self, state: &'static str, fraction: Option<f32>, detail: Option<String>) {
        let _ = self.app.emit(
            "setup-progress",
            ProgressEvent {
                task: self.task.to_string(),
                steps: self.steps.clone(),
                weights: self.weights.clone(),
                index: self.index,
                fraction,
                overall: if state == "done" { 100.0 } else { self.overall(fraction) },
                state,
                detail,
            },
        );
    }

    fn update(&self, fraction: Option<f32>, detail: Option<String>) {
        self.emit("running", fraction, detail);
    }

    fn advance(&mut self) {
        self.index = (self.index + 1).min(self.steps.len());
        self.emit("running", None, None);
    }

    fn finish(&mut self) {
        self.index = self.steps.len();
        self.emit("done", None, None);
    }

    fn fail(&self, message: &str) {
        self.emit("failed", None, Some(message.to_string()));
    }
}

/// Reads the trailing "NN%" of tqdm-style lines like `model.safetensors:  45%|####  |`.
fn parse_percent(line: &str) -> Option<f32> {
    let idx = line.rfind('%')?;
    let digits: String = line[..idx]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let v: f32 = digits.parse().ok()?;
    (0.0..=100.0).contains(&v).then_some(v)
}

type PercentSink = Arc<dyn Fn(f32) + Send + Sync>;

/// Splits on \r too because pip/tqdm redraw bars in place; stdout and stderr get separate threads so neither pipe can block the child.
fn pump_output<R: Read + Send + 'static>(
    app: AppHandle,
    mut reader: R,
    percent_sink: Option<PercentSink>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut line: Vec<u8> = Vec::new();
        let mut last_pct_emit = Instant::now() - Duration::from_secs(1);
        let mut last_logged_bucket: i32 = -1;

        let mut flush = |line: &mut Vec<u8>, from_cr: bool| {
            if line.is_empty() {
                return;
            }
            let text = String::from_utf8_lossy(line).trim_end().to_string();
            line.clear();
            if text.is_empty() {
                return;
            }
            if from_cr {
                // Progress-bar repaint: feed the bar, but log only once per 10%.
                if let Some(pct) = parse_percent(&text) {
                    if let Some(sink) = &percent_sink {
                        if last_pct_emit.elapsed() >= Duration::from_millis(150) {
                            sink(pct / 100.0);
                            last_pct_emit = Instant::now();
                        }
                    }
                    let bucket = (pct / 10.0) as i32;
                    if bucket != last_logged_bucket {
                        last_logged_bucket = bucket;
                        emit_log(&app, text);
                    }
                    return;
                }
            }
            emit_log(&app, text);
        };

        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    for &b in &buf[..n] {
                        match b {
                            b'\n' => flush(&mut line, false),
                            b'\r' => flush(&mut line, true),
                            _ => {
                                line.push(b);
                                // Cap runaway lines from a process that never prints a newline.
                                if line.len() >= 4096 {
                                    flush(&mut line, false);
                                }
                            }
                        }
                    }
                }
            }
        }
        flush(&mut line, false);
    })
}

fn run_and_stream_with(
    app: &AppHandle,
    program: &str,
    args: &[&str],
    percent_sink: Option<PercentSink>,
) -> bool {
    emit_log(app, format!("$ {program} {}", args.join(" ")));

    let mut child = match Command::new(program)
        .args(args)
        .no_window()
        // Python block-buffers piped stdout, so output would otherwise arrive in one lump at the end.
        .env("PYTHONUNBUFFERED", "1")
        // Windows Python defaults to the ANSI code page, which chokes on pip's and tqdm's output.
        .env("PYTHONUTF8", "1")
        .env("PIP_DISABLE_PIP_VERSION_CHECK", "1")
        .env("PIP_PROGRESS_BAR", "off")
        // Every venv is throwaway or built once, so pip's cache would just sit there (~300 MB of torch wheels).
        .env("PIP_NO_CACHE_DIR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            emit_log(app, format!("!! could not run '{program}': {e}"));
            return false;
        }
    };

    let mut pumps = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        pumps.push(pump_output(app.clone(), stdout, percent_sink.clone()));
    }
    if let Some(stderr) = child.stderr.take() {
        pumps.push(pump_output(app.clone(), stderr, percent_sink));
    }

    let result = child.wait();
    for p in pumps {
        let _ = p.join();
    }

    match result {
        Ok(status) => status.success(),
        Err(e) => {
            emit_log(app, format!("!! {program} exited abnormally: {e}"));
            false
        }
    }
}

fn run_and_stream(app: &AppHandle, program: &str, args: &[&str]) -> bool {
    run_and_stream_with(app, program, args, None)
}

const STOCKFISH_RELEASE_BASE: &str =
    "https://github.com/official-stockfish/Stockfish/releases/latest/download";

/// Stockfish 19+ ships one universal .tar.gz per platform (the old per-CPU names 404). Empty = no known prebuilt, e.g. Windows.
fn stockfish_candidates() -> Vec<&'static str> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    let mut candidates = Vec::new();

    if os == "linux" && arch == "x86_64" {
        candidates.push("stockfish-linux-x86-64-universal");
    } else if os == "linux" && arch == "aarch64" {
        candidates.push("stockfish-linux-arm64-universal");
    } else if os == "linux" && arch == "riscv64" {
        candidates.push("stockfish-linux-riscv64-universal");
    } else if os == "macos" {
        // One universal build now covers both Apple Silicon and Intel Macs.
        candidates.push("stockfish-macos-universal");
    }

    candidates
}

fn download_stockfish(app: &AppHandle, progress: &mut Progress) -> Result<(), String> {
    let candidates = stockfish_candidates();
    if candidates.is_empty() {
        if cfg!(windows) {
            return Err("Stockfish isn't downloaded automatically on Windows - install it from stockfishchess.org, then add it to PATH or set STOCKFISH_PATH and restart the app".into());
        }
        return Err(format!(
            "no prebuilt Stockfish available for {}/{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ));
    }

    let install_dir = stockfish_install_dir(app)?;
    let client = reqwest::blocking::Client::builder()
        .user_agent("maia-chess-setup")
        // Generous whole-request budget: the archive is tens of MB and the connection may be slow.
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;

    for name in candidates {
        emit_log(app, format!("    Trying {name} ..."));
        // sf_19+ assets are .tar.gz; older ones were plain .tar.
        let url = format!("{STOCKFISH_RELEASE_BASE}/{name}.tar.gz");

        let mut resp = match client.get(&url).send() {
            Ok(r) if r.status().is_success() => r,
            Ok(r) => {
                emit_log(app, format!("    {name}: HTTP {}", r.status()));
                continue;
            }
            Err(e) => {
                emit_log(app, format!("    {name}: {e}"));
                continue;
            }
        };

        let total = resp.content_length();
        let mut bytes: Vec<u8> = Vec::with_capacity(total.unwrap_or(40_000_000) as usize);
        let mut chunk = [0u8; 64 * 1024];
        let mut last_reported: i32 = -1;
        let mut ok = true;
        loop {
            match resp.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    bytes.extend_from_slice(&chunk[..n]);
                    let mb = bytes.len() as f32 / 1_048_576.0;
                    match total {
                        Some(t) if t > 0 => {
                            let frac = bytes.len() as f32 / t as f32;
                            let pct = (frac * 100.0) as i32;
                            if pct != last_reported {
                                last_reported = pct;
                                progress.update(
                                    Some(frac),
                                    Some(format!("{mb:.1} / {:.1} MB", t as f32 / 1_048_576.0)),
                                );
                            }
                        }
                        _ => {
                            // Unknown size: report whole MB so far, no fraction.
                            let mb_i = mb as i32;
                            if mb_i != last_reported {
                                last_reported = mb_i;
                                progress.update(None, Some(format!("{mb:.1} MB downloaded")));
                            }
                        }
                    }
                }
                Err(e) => {
                    emit_log(app, format!("    {name}: download failed: {e}"));
                    ok = false;
                    break;
                }
            }
        }
        if !ok {
            continue;
        }
        emit_log(
            app,
            format!("    Downloaded {:.1} MB", bytes.len() as f32 / 1_048_576.0),
        );

        progress.advance();
        let gz = flate2::read::GzDecoder::new(Cursor::new(&bytes[..]));
        let mut archive = tar::Archive::new(gz);
        let entries = match archive.entries() {
            Ok(e) => e,
            Err(e) => {
                emit_log(app, format!("    {name}: not a valid tar.gz: {e}"));
                continue;
            }
        };

        // Match the archive-derived name or plain "stockfish", not a "stockfish-" prefix, which would hit docs like Stockfish-FAQ.md first.
        let mut extracted = false;
        for entry in entries.flatten() {
            let mut entry = entry;
            if entry.header().entry_type().is_dir() {
                continue;
            }
            let Ok(path_in_tar) = entry.path().map(|p| p.to_string_lossy().to_string()) else {
                continue;
            };
            let file_name = Path::new(&path_in_tar)
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default();
            let file_name_lower = file_name.to_lowercase();
            let stem_lower = file_name_lower.strip_suffix(".exe").unwrap_or(&file_name_lower);
            if stem_lower != "stockfish" && stem_lower != name.to_lowercase() {
                continue;
            }
            let dest = install_dir.join(stockfish_exe_name());
            let mut out = std::fs::File::create(&dest).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut out).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
                    .map_err(|e| e.to_string())?;
            }
            extracted = true;
            break;
        }

        if extracted {
            emit_log(app, format!("    Got it: {name}"));
            return Ok(());
        }
        emit_log(app, format!("    {name}: archive didn't contain the expected binary"));
        // Back to the "download" step's slot if there's another candidate.
        progress.index = 1;
    }

    Err("couldn't auto-download a Stockfish build for this machine".into())
}

fn stockfish_manual_install_hint() -> &'static str {
    "Install it yourself with your package manager \
     (e.g. `apt install stockfish`, `brew install stockfish`, \
     `winget install Stockfish`) or grab a build from \
     https://stockfishchess.org/download/."
}

fn install_stockfish_impl(app: &AppHandle) -> Result<(), String> {
    let mut progress = Progress::new(
        app,
        "stockfish",
        &[("Checking for an existing Stockfish", 5.0), ("Downloading Stockfish", 85.0), ("Unpacking", 10.0)],
    );

    if let Some(path) = resolve_stockfish(app) {
        emit_log(app, format!("Stockfish: already available at {path}"));
        progress.finish();
        return Ok(());
    }
    if is_flatpak() {
        emit_log(
            app,
            "Running in a Flatpak sandbox: host-installed Stockfish isn't visible here, \
             so a private copy is downloaded instead.",
        );
    }

    progress.advance();
    emit_log(app, "Stockfish not found - downloading a prebuilt binary...");
    match download_stockfish(app, &mut progress) {
        Ok(()) => {
            emit_log(app, "Stockfish: downloaded and ready.");
            progress.finish();
            Ok(())
        }
        Err(e) => {
            let msg = format!("{e}. {}", stockfish_manual_install_hint());
            emit_log(app, format!("!! {msg}"));
            progress.fail(&msg);
            Err(msg)
        }
    }
}

/// Independent of the legacy `run_setup`; called when the user opts into Stockfish on the first-launch screen.
#[tauri::command]
pub async fn install_stockfish(app: AppHandle) -> Result<(), String> {
    // Blocking download: keep it off the UI thread and the async workers.
    tauri::async_runtime::spawn_blocking(move || install_stockfish_impl(&app))
        .await
        .map_err(|e| format!("Stockfish install task failed: {e}"))?
}

/// Legacy: pulls in the full PyTorch runtime. Kept only for the old "pytorch" backend path in main.rs.
#[tauri::command]
pub async fn run_setup(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_setup_blocking(app))
        .await
        .map_err(|e| format!("setup task failed: {e}"))?
}

fn run_setup_blocking(app: AppHandle) -> Result<(), String> {
    let status = setup_status(app.clone());

    if status.engine_ready {
        emit_log(&app, "Maia-3 engine: already on PATH, skipping install.");
    } else {
        emit_log(&app, "Maia-3 engine not found - installing via pip...");
        let pip = if on_path("pip3") { "pip3" } else { "pip" };
        let ok = run_and_stream(&app, pip, &["install", "--user", "maia3"]);
        if !ok {
            emit_log(
                &app,
                "!! pip install failed. Make sure Python 3 + pip are installed, \
                 then run `pip install maia3` yourself (see the Maia-3 README).",
            );
        }
    }

    if status.stockfish_ready {
        emit_log(&app, "Stockfish: already available.");
    } else {
        let _ = install_stockfish_impl(&app);
    }

    Ok(())
}

// ONNX backend: a throwaway torch venv exports the checkpoint once; a small onnxruntime venv then runs it via the bundled UCI script.

/// Same base folder as `stockfish_install_dir`, so nothing lands outside the app's own data.
fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("couldn't resolve app data dir: {e}"))
}

fn onnx_runtime_venv_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("onnx-runtime-venv"))
}

fn onnx_export_venv_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("onnx-export-venv-tmp"))
}

fn onnx_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("onnx-models"))
}

fn venv_python(venv_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        venv_dir.join("Scripts").join("python.exe")
    } else {
        venv_dir.join("bin").join("python3")
    }
}

fn venv_pip(venv_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        venv_dir.join("Scripts").join("pip.exe")
    } else {
        venv_dir.join("bin").join("pip3")
    }
}

/// The runtime venv's python, not a system one, so PATH can't affect it.
pub fn onnx_venv_python(app: &AppHandle) -> PathBuf {
    onnx_runtime_venv_dir(app)
        .map(|d| venv_python(&d))
        .unwrap_or_default()
}

fn onnx_model_path(app: &AppHandle, model: &str) -> Result<PathBuf, String> {
    Ok(onnx_models_dir(app)?.join(format!("{model}.onnx")))
}

/// Deletes an exported model's .onnx file, freeing its disk space. A no-op (not an error) if it was never exported.
#[tauri::command]
pub fn remove_onnx_model(app: AppHandle, model: String) -> Result<(), String> {
    let path = onnx_model_path(&app, &model)?;
    if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| format!("could not remove {}: {e}", path.display()))?;
    }
    Ok(())
}

fn onnx_exported_models(app: &AppHandle) -> Vec<String> {
    let Ok(dir) = onnx_models_dir(app) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) == Some("onnx") {
                path.file_stem().map(|s| s.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Tauri's resolver, because the layout differs across dev, .deb and AppImage; MAIA3_RESOURCES_DIR overrides it for `tauri dev`.
fn resolve_resource(app: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("MAIA3_RESOURCES_DIR") {
        return Ok(PathBuf::from(dir).join(file_name));
    }
    app.path()
        .resolve(
            format!("resources/{file_name}"),
            tauri::path::BaseDirectory::Resource,
        )
        .map(strip_verbatim_prefix)
        .map_err(|e| format!("couldn't resolve resource dir: {e}"))
}

/// Tauri can hand back `\\?\C:\...` paths on Windows, which Python and pip don't always accept.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path,
    }
}

fn onnx_export_script(app: &AppHandle) -> Result<PathBuf, String> {
    resolve_resource(app, "export_maia3_onnx.py")
}

fn onnx_uci_script(app: &AppHandle) -> Result<PathBuf, String> {
    resolve_resource(app, "maia3_onnx_uci.py")
}

// a venv built under another runtime's python (e.g. after a Flatpak runtime bump) keeps its python3 but loses its site-packages
fn onnx_venv_works(app: &AppHandle) -> bool {
    let python = onnx_venv_python(app);
    python.is_file()
        && Command::new(&python)
            .args([
                "-c",
                "import importlib.util as u,sys; sys.exit(0 if all(u.find_spec(m) for m in ('chess','numpy','onnxruntime')) else 1)",
            ])
            .no_window()
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
}

pub fn onnx_engine_command(
    app: &AppHandle,
    model: &str,
    mut extra_args: Vec<String>,
) -> Result<(String, Vec<String>), String> {
    let python = onnx_venv_python(app);
    if !onnx_venv_works(app) {
        return Err(
            "the ONNX Runtime environment isn't set up yet - run ONNX setup first".into(),
        );
    }
    let onnx_path = onnx_model_path(app, model)?;
    if !onnx_path.is_file() {
        return Err(format!(
            "{model} hasn't been exported to ONNX yet - run ONNX setup for this model first"
        ));
    }
    let script = onnx_uci_script(app)?;
    if !script.is_file() {
        return Err(format!(
            "missing bundled resource: {}",
            script.to_string_lossy()
        ));
    }

    let mut args = vec![
        script.to_string_lossy().to_string(),
        "--onnx".to_string(),
        onnx_path.to_string_lossy().to_string(),
        "--history".to_string(),
        "8".to_string(),
        "--use-uci-history".to_string(),
    ];
    args.append(&mut extra_args);
    Ok((python.to_string_lossy().to_string(), args))
}

/// A GUI-launched app's PATH is often minimal, so check the usual install dirs too.
fn find_python() -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["py", "python", "python3"]
    } else {
        &["python3", "python"]
    };
    names
        .iter()
        .filter_map(|n| find_executable(n))
        .find(|p| !cfg!(windows) || python_can_make_venvs(p))
}

/// Windows ships a Microsoft Store stub named python.exe that exits with an error when given arguments, so a PATH hit alone proves nothing.
fn python_can_make_venvs(python: &Path) -> bool {
    Command::new(python)
        .args(["-c", "import venv"])
        .no_window()
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn pip_install(
    app: &AppHandle,
    pip: &Path,
    extra: &[&str],
    sink: Option<PercentSink>,
) -> bool {
    let mut args: Vec<String> = vec!["install".into()];
    args.extend(extra.iter().map(|s| s.to_string()));
    let program = pip.to_string_lossy().to_string();
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_and_stream_with(app, &program, &arg_refs, sink)
}

/// Safe to re-run for another model size: the runtime venv is reused and finished exports are skipped.
fn run_onnx_setup_impl(app: &AppHandle, model: &str, progress: &mut Progress) -> Result<(), String> {
    let models_dir = onnx_models_dir(app)?;
    std::fs::create_dir_all(&models_dir).map_err(|e| e.to_string())?;
    let onnx_path = onnx_model_path(app, model)?;
    let runtime_venv = onnx_runtime_venv_dir(app)?;

    if onnx_path.is_file() {
        emit_log(app, format!("ONNX model {model}: already exported, skipping."));
    } else {
        let export_script = onnx_export_script(app)?;
        if !export_script.is_file() {
            return Err(format!(
                "missing bundled resource: {} (this build wasn't packaged with \
                 src-tauri/resources/ - see tauri.conf.json bundle.resources)",
                export_script.to_string_lossy()
            ));
        }

        emit_log(
            app,
            format!("==> Exporting {model} to ONNX (temporary venv, needs torch once)..."),
        );
        let export_venv = onnx_export_venv_dir(app)?;
        // Always rebuilt: a half-built venv from an interrupted run causes more pip errors than it saves time.
        let _ = std::fs::remove_dir_all(&export_venv);

        let python3 = find_python()
            .ok_or("Python 3 wasn't found - install python3 (with the venv module) and try again")?;
        let python3_str = python3.to_string_lossy().to_string();
        let export_venv_str = export_venv.to_string_lossy().to_string();
        if !run_and_stream(app, &python3_str, &["-m", "venv", &export_venv_str]) {
            return Err(
                "could not create the temporary export venv (is the python3-venv package installed?)"
                    .into(),
            );
        }
        progress.advance();

        let pip = venv_pip(&export_venv);
        // CPU-only wheel is far smaller than the default CUDA build; fall back to the default index if unreachable.
        if !(pip_install(app, &pip, &["torch", "--index-url", "https://download.pytorch.org/whl/cpu"], None)
            || pip_install(app, &pip, &["torch"], None))
        {
            return Err("failed to install torch into the export venv".into());
        }
        progress.advance();

        if !pip_install(
            app,
            &pip,
            &[
                "--no-deps",
                // Tarball URL instead of git+https: pip needs a git binary for that, which the Flatpak sandbox doesn't have.
                "https://github.com/CSSLab/maia3/archive/refs/heads/main.tar.gz",
            ],
            None,
        ) {
            return Err("failed to install the maia3 package into the export venv".into());
        }
        progress.advance();

        if !pip_install(
            app,
            &pip,
            &["numpy", "python-chess", "huggingface_hub", "safetensors", "onnx", "onnxruntime"],
            None,
        ) {
            return Err("failed to install export dependencies into the export venv".into());
        }
        progress.advance();

        // The export downloads the checkpoint from Hugging Face; its tqdm "NN%" output drives the step's bar.
        let venv_python_bin = venv_python(&export_venv);
        emit_log(app, format!("    Downloading + exporting {model} checkpoint..."));
        let sink: PercentSink = {
            let p = progress.clone();
            Arc::new(move |f| p.update(Some(f), Some("downloading checkpoint".to_string())))
        };
        let venv_python_str = venv_python_bin.to_string_lossy().to_string();
        let export_script_str = export_script.to_string_lossy().to_string();
        let onnx_path_str = onnx_path.to_string_lossy().to_string();
        let ok = run_and_stream_with(
            app,
            &venv_python_str,
            &[
                &export_script_str,
                "--model",
                model,
                "--output",
                &onnx_path_str,
                "--validate",
            ],
            Some(sink),
        );
        if !ok {
            return Err(format!("export_maia3_onnx.py failed for {model}"));
        }
        emit_log(app, format!("ONNX model {model}: exported to {}", onnx_path.display()));
        progress.advance();

        // The throwaway venv (and its torch install) is only needed for the export.
        let _ = std::fs::remove_dir_all(&export_venv);
        prune_hf_cache(app);
    }

    if onnx_venv_works(app) {
        emit_log(app, "ONNX runtime venv: already set up, skipping.");
    } else {
        emit_log(app, "==> Setting up the ONNX Runtime venv (no torch here)...");
        let _ = std::fs::remove_dir_all(&runtime_venv);
        let python3 = find_python()
            .ok_or("Python 3 wasn't found - install python3 (with the venv module) and try again")?;
        let python3_str = python3.to_string_lossy().to_string();
        let runtime_venv_str = runtime_venv.to_string_lossy().to_string();
        if !run_and_stream(app, &python3_str, &["-m", "venv", &runtime_venv_str]) {
            return Err(
                "could not create the ONNX runtime venv (is the python3-venv package installed?)"
                    .into(),
            );
        }
        progress.advance();

        let pip = venv_pip(&runtime_venv);
        if !pip_install(app, &pip, &["numpy", "python-chess", "onnxruntime"], None) {
            let _ = std::fs::remove_dir_all(&runtime_venv);
            return Err("failed to install onnxruntime into the runtime venv".into());
        }
        progress.advance();
        emit_log(app, "ONNX runtime venv: ready.");
    }

    Ok(())
}

/// Only steps that will actually run are laid out, so skipped ones don't show up as phantom steps.
pub fn run_onnx_setup(app: &AppHandle, model: &str) -> Result<(), String> {
    let need_export = onnx_model_path(app, model).map(|p| !p.is_file()).unwrap_or(true);
    let need_runtime = !onnx_venv_works(app);

    let mut plan: Vec<(String, f32)> = Vec::new();
    if need_export {
        plan.push(("Create temporary Python environment".into(), 3.0));
        plan.push(("Install PyTorch (temporary, largest download)".into(), 40.0));
        plan.push(("Install the Maia-3 package".into(), 6.0));
        plan.push(("Install export tools".into(), 12.0));
        plan.push((format!("Download and convert {model}"), 25.0));
    }
    if need_runtime {
        plan.push(("Create ONNX Runtime environment".into(), 2.0));
        plan.push(("Install ONNX Runtime".into(), 8.0));
    }

    if plan.is_empty() {
        let mut p = Progress::new(app, "maia", &[("Maia-3 is already set up", 1.0)]);
        emit_log(app, format!("Maia-3 ({model}): already set up."));
        p.finish();
        return Ok(());
    }

    let plan_refs: Vec<(&str, f32)> = plan.iter().map(|(s, w)| (s.as_str(), *w)).collect();
    let mut progress = Progress::new(app, "maia", &plan_refs);
    let result = run_onnx_setup_impl(app, model, &mut progress);
    // Success or failure, don't leave pip's download cache behind.
    purge_private_pip_cache(app);
    match result {
        Ok(()) => {
            progress.finish();
            Ok(())
        }
        Err(e) => {
            progress.fail(&e);
            Err(e)
        }
    }
}

/// Flatpak keeps the HF cache under the app's own XDG_CACHE_HOME, which an $HOME-only check misses.
fn hf_hub_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    };
    if let Some(p) = std::env::var_os("HF_HUB_CACHE") {
        push(PathBuf::from(p));
    }
    if let Some(p) = std::env::var_os("HF_HOME") {
        push(PathBuf::from(p).join("hub"));
    }
    if let Some(p) = std::env::var_os("XDG_CACHE_HOME") {
        push(PathBuf::from(p).join("huggingface").join("hub"));
    }
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        push(PathBuf::from(home).join(".cache").join("huggingface").join("hub"));
    }
    dirs
}

/// Clears the whole cache rather than one entry: nothing else here reads it, and the export's repo id is the `maia3` package's own choice, not ours to match against.
fn prune_hf_cache(app: &AppHandle) {
    let mut cleared = false;
    for hub_dir in hf_hub_dirs() {
        let Ok(entries) = std::fs::read_dir(&hub_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let removed = if path.is_dir() {
                std::fs::remove_dir_all(&path).is_ok()
            } else {
                std::fs::remove_file(&path).is_ok()
            };
            cleared |= removed;
        }
    }
    if cleared {
        emit_log(app, "    Cleared the downloaded checkpoint cache (already exported)".to_string());
    }
}

/// Flatpak's XDG_CACHE_HOME is private to the app; elsewhere it's the user's own ~/.cache/pip, so leave it alone.
fn purge_private_pip_cache(app: &AppHandle) {
    if !is_flatpak() {
        return;
    }
    let Some(cache_home) = std::env::var_os("XDG_CACHE_HOME") else {
        return;
    };
    let pip_cache = PathBuf::from(cache_home).join("pip");
    if pip_cache.is_dir() {
        emit_log(app, "    Clearing pip's download cache (not needed after setup)");
        let _ = std::fs::remove_dir_all(pip_cache);
    }
}

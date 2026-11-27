//! Thin Python sidecar manager (Demucs CUDA stems, yt-dlp, Gemini AI, Rubber Band clip prep).

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

pub struct SidecarManager {
    child: Mutex<Option<Child>>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    pub fn ensure_started(&self) {
        if is_backend_listening() {
            return;
        }
        let Some((python_exe, backend_dir)) = resolve_backend_paths() else {
            eprintln!("[musak-sidecar] Could not locate backend/.venv Python executable.");
            return;
        };

        let mut cmd = Command::new(&python_exe);
        cmd.args([
            "-m",
            "uvicorn",
            "musak.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8765",
        ])
        .current_dir(&backend_dir)
        .env("PYTHONPATH", &backend_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        if let Ok(child) = cmd.spawn() {
            *self.child.lock().unwrap() = Some(child);
        }
    }

    pub fn shutdown(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

impl Drop for SidecarManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn is_backend_listening() -> bool {
    TcpStream::connect_timeout(
        &"127.0.0.1:8765".parse().unwrap(),
        Duration::from_millis(120),
    )
    .is_ok()
}

fn resolve_backend_paths() -> Option<(PathBuf, PathBuf)> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.clone());
        if let Some(p) = cwd.parent() {
            candidates.push(p.to_path_buf());
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        for ancestor in exe.ancestors().take(6) {
            candidates.push(ancestor.to_path_buf());
        }
    }

    for root in candidates {
        let backend_dir = root.join("backend");
        let py_win = backend_dir.join(".venv").join("Scripts").join("python.exe");
        if py_win.is_file() {
            return Some((py_win, backend_dir));
        }
        let py_unix = backend_dir.join(".venv").join("bin").join("python");
        if py_unix.is_file() {
            return Some((py_unix, backend_dir));
        }
    }
    None
}

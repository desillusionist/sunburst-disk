//! Quick Look via the native Swift `QLPreviewView` helper.
//!
//! Electron spawned `electron/quicklook-preview` as a child process, read JSON
//! key events from its stdout, and forwarded them to the renderer as
//! `quick-look-key`. We keep that model: the helper is bundled as a Tauri
//! resource and located through a candidate search (dev + packaged layouts).

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QuickLookResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persistent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Active {
    id: u64,
    item_path: String,
    child: Arc<Mutex<Child>>,
}

static QUICK_LOOK: Mutex<Option<Active>> = Mutex::new(None);
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Locate the `quicklook-preview` helper in packaged and dev layouts.
pub(crate) fn helper_path(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        // Tauri rewrites `../` in resource paths to `_up_/`.
        candidates.push(dir.join("_up_").join("electron").join("quicklook-preview"));
        candidates.push(dir.join("electron").join("quicklook-preview"));
        candidates.push(dir.join("quicklook-preview"));
        candidates.push(dir.join("resources").join("quicklook-preview"));
    }
    // Dev fallback: the in-tree helper built by `npm run build:quicklook`.
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("electron")
            .join("quicklook-preview"),
    );
    candidates.into_iter().find(|path| path.exists())
}

fn terminate(child: &Arc<Mutex<Child>>) {
    if let Ok(guard) = child.lock() {
        let pid = guard.id() as i32;
        // Match Electron's SIGTERM-then-exit behaviour.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
}

/// `closeQuickLook`.
pub(crate) fn close() -> QuickLookResponse {
    let taken = QUICK_LOOK.lock().ok().and_then(|mut slot| slot.take());
    if let Some(active) = taken {
        terminate(&active.child);
    }
    QuickLookResponse {
        ok: true,
        closed: Some(true),
        ..Default::default()
    }
}

/// `quickLookPath`. Blocks ~350 ms while confirming the helper started.
pub(crate) fn start(app: &AppHandle, item_path: &str) -> QuickLookResponse {
    // Requesting the same item again closes the current preview.
    let same_item = QUICK_LOOK
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|active| active.item_path.clone()))
        .map(|path| path == item_path)
        .unwrap_or(false);
    if same_item {
        return close();
    }

    // Replace any existing preview.
    if let Some(previous) = QUICK_LOOK.lock().ok().and_then(|mut slot| slot.take()) {
        terminate(&previous.child);
    }

    let Some(helper) = helper_path(app) else {
        return QuickLookResponse {
            ok: false,
            error: Some("Native Quick Look helper is not built.".to_string()),
            ..Default::default()
        };
    };

    let mut child = match Command::new(&helper)
        .arg(item_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return QuickLookResponse {
                ok: false,
                error: Some(error.to_string()),
                ..Default::default()
            }
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    let id = SEQUENCE.fetch_add(1, Ordering::Relaxed) + 1;

    if let Ok(mut slot) = QUICK_LOOK.lock() {
        *slot = Some(Active {
            id,
            item_path: item_path.to_string(),
            child: child.clone(),
        });
    }

    if let Some(pipe) = stdout {
        let emit_app = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(pipe);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    if payload.get("key").is_some() {
                        let _ = emit_app.emit("quick-look-key", payload);
                    }
                }
            }
        });
    }

    if let Some(pipe) = stderr {
        let buffer = stderr_buffer.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut text = String::new();
            let _ = reader.read_to_string(&mut text);
            if let Ok(mut guard) = buffer.lock() {
                *guard = text;
            }
        });
    }

    // Waiter: when the helper exits on its own (user closed the panel), clear
    // the slot and notify the renderer that Quick Look closed.
    {
        let wait_app = app.clone();
        let wait_child = child.clone();
        let wait_path = item_path.to_string();
        std::thread::spawn(move || loop {
            let mut exited = false;
            if let Ok(mut guard) = wait_child.lock() {
                match guard.try_wait() {
                    Ok(Some(_)) => exited = true,
                    Ok(None) => {}
                    Err(_) => exited = true,
                }
            }
            if exited {
                let is_current = QUICK_LOOK
                    .lock()
                    .ok()
                    .and_then(|slot| slot.as_ref().map(|active| active.id == id))
                    .unwrap_or(false);
                if is_current {
                    if let Ok(mut slot) = QUICK_LOOK.lock() {
                        *slot = None;
                    }
                    let _ = wait_app.emit(
                        "quick-look-key",
                        json!({ "key": "closed", "path": wait_path }),
                    );
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(120));
        });
    }

    // Confirm startup like Electron's 350 ms spawn settle.
    std::thread::sleep(Duration::from_millis(350));
    let (running, success) = match child.lock() {
        Ok(mut guard) => match guard.try_wait() {
            Ok(None) => (true, true),
            Ok(Some(status)) => (false, status.success()),
            Err(_) => (false, false),
        },
        Err(_) => (false, false),
    };

    if running {
        QuickLookResponse {
            ok: true,
            persistent: Some(true),
            ..Default::default()
        }
    } else if success {
        QuickLookResponse {
            ok: true,
            ..Default::default()
        }
    } else {
        let stderr_text = stderr_buffer
            .lock()
            .map(|text| text.trim().to_string())
            .unwrap_or_default();
        QuickLookResponse {
            ok: false,
            error: Some(if stderr_text.is_empty() {
                "Quick Look helper stopped.".to_string()
            } else {
                stderr_text
            }),
            ..Default::default()
        }
    }
}

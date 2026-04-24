# Splash Screen Diagnostics

## Current behaviour (as of 2026-04-12)

App starts: blank black → blank white → homepage. No splash spinner visible at any point.
Setup() DOES complete (`[wsl_check] ok` in console). Main window works correctly end-to-end.

---

## What is in place

### `public/splashscreen.html`
Self-contained HTML. Verified correct via iframe preview — peach spinner, wordmark, status text, progress bar all render. No external deps.

### `src-tauri/tauri.conf.json`
```json
"withGlobalTauri": true,
"windows": [
  { "title": "RushCut", "width": 1280, "height": 800 }
]
```
- Single main window, always visible
- `withGlobalTauri: true` injects `window.__TAURI__` for event listening

### `src-tauri/src/lib.rs` — `create_splash_window()`
```rust
fn create_splash_window(app: &tauri::App) {
    let url = if tauri::is_dev() {
        WebviewUrl::External(
            url::Url::parse("http://localhost:1420/splashscreen.html").unwrap()
        )
    } else {
        WebviewUrl::App("splashscreen.html".into())
    };

    let _ = WebviewWindowBuilder::new(app, "splashscreen", url)
        .title("")
        .inner_size(480.0, 280.0)
        .decorations(false)
        .center()
        .resizable(false)
        .always_on_top(true)
        .build();
}
```

### `src-tauri/src/lib.rs` — `setup()` sequence
```rust
.setup(|app| {
    create_splash_window(app);          // 1. create splash
    app.emit("splash-step", "db").ok(); // 2. emit progress
    db::init(app.handle())?;
    app.emit("splash-step", "wsl").ok();
    // wsl --status check...
    app.emit("splash-step", "done").ok();
    std::thread::sleep(Duration::from_millis(300));
    close_splash(app);                  // 3. close splash
    Ok(())
})
```

### `wdio.conf.ts` — before hook
Window-switching guard added so E2E attaches to the correct window handle after splash closes.
E2E fast suite: **7/7 PASS** with these changes.

---

## What we know is NOT the problem

- Compilation: binary compiles clean, `[wsl_check] ok` confirms setup() runs
- Main window: loads and shows the app correctly
- E2E: all 7 tests pass
- HTML design: verified correct at all 4 stages via iframe preview
- Vite cache: cleared (`node_modules/.vite` deleted)

---

## Suspected root causes (in priority order)

### 1. Setup() completes before WebView2 renders (MOST LIKELY)
DB already exists → `db::init` is ~50ms. WSL check is ~200ms.
Total setup() time: ~300ms. Plus 300ms sleep = ~600ms.
WebView2 takes ~500–1000ms to load and render an HTTP page in dev.
**Result:** splash window appears, WebView2 starts loading, but `close_splash()` fires before the first paint.

**Diagnostic:** Add `std::thread::sleep(Duration::from_secs(5))` before `close_splash()`. If the spinner now appears, this is confirmed.

### 2. `tauri::is_dev()` returns false
If `is_dev()` is false, `WebviewUrl::App("splashscreen.html")` is used. In dev mode, `frontendDist: "../dist"` doesn't exist → blank window.

**Diagnostic:** Add `eprintln!("[splash] is_dev={}", tauri::is_dev());` before `create_splash_window(app)`. Check console output.

### 3. `always_on_top` not working or window hidden behind main
The 480×280 undecorated splash might appear behind the 1280×800 main window on certain Windows 11 setups, or off-screen on a multi-monitor configuration.

**Diagnostic:** Temporarily set the splash to a larger size (e.g. 800×600) with `decorations(true)` to make it findable.

### 4. `withGlobalTauri` not injecting into the splash window
If `window.__TAURI__` is undefined in the splash, the event listener silently fails. The spinner itself is pure CSS and would still show — but status text would stay "Starting...". This is LOW priority since the spinner uses only CSS.

**Diagnostic:** Check if spinner arc is visible. If "Starting..." text shows but no step updates → this is the cause.

---

## Next steps to try (in order)

### Step A — Confirm timing is the issue
In `lib.rs` setup(), change the sleep before `close_splash()`:
```rust
std::thread::sleep(std::time::Duration::from_secs(5)); // was 300ms
```
Run `pnpm dev`. If a spinner now appears for ~5 seconds before the app loads → timing confirmed.

### Step B — If timing confirmed: pre-warm the WebView2
Move the `create_splash_window(app)` call to BEFORE any blocking work, but add a short sleep AFTER creating it to let WebView2 start loading before setup() proceeds:
```rust
create_splash_window(app);
std::thread::sleep(std::time::Duration::from_millis(800)); // let WebView2 load
app.emit("splash-step", "db").ok();
// ... rest of setup
```

### Step C — If timing not confirmed: verify is_dev()
Add console log: `eprintln!("[splash] is_dev={}", tauri::is_dev());`
If false → switch to hardcoded URL with a build-time guard or use `TAURI_ENV_*` env var.

### Step D — Alternative: React-side loading overlay
Skip the second Tauri window entirely. Add an inline loading overlay to `index.html` that shows until Tauri emits `app-ready`. Pros: no second window, no timing race. Cons: black screen during Rust setup() (same as before, but shorter).

```html
<!-- index.html, inside <body> before <div id="root"> -->
<div id="rc-splash" style="position:fixed;inset:0;background:#0a0a0a;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:9999;font-family:system-ui">
  <div style="font-size:32px;font-weight:700;color:#FF8A65">RushCut</div>
  <div style="margin-top:24px;width:40px;height:40px;border-radius:50%;border:3px solid rgba(255,138,101,0.15);border-top-color:#FF8A65;animation:spin 0.9s linear infinite"></div>
  <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
</div>
```

Then in `main.tsx`:
```typescript
// Remove splash once React mounts
document.getElementById('rc-splash')?.remove();
```

This guarantees the spinner is visible as soon as Vite serves the HTML — no WebView2 race.

### Step E — Hybrid approach
Use both: the `index.html` inline overlay (removes when React mounts) AND the Tauri event from Rust (`app-ready`) to signal when backend is ready. Remove overlay only on `app-ready`, not on React mount. This covers both the "React loading" latency and the "Rust setup()" latency.

---

## Files changed in this session

| File | Change |
|------|--------|
| `public/splashscreen.html` | NEW — splash HTML |
| `src-tauri/tauri.conf.json` | `withGlobalTauri: true` added |
| `src-tauri/Cargo.toml` | `url = "2"` dependency added |
| `src-tauri/src/lib.rs` | `create_splash_window()`, `close_splash()`, Manager import, setup() wiring |
| `wdio.conf.ts` | `before` hook — window handle switching for E2E |

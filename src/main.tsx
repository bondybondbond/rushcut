import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import "./globals.css";
import { hydrateRenderPrefs } from "@/utils/renderStore";

// Remove #rc-splash when Rust emits app-ready (db init done).
// 500ms fallback covers the case where app-ready fires before React's listen() registers
// (async WSL in Batch A4 means app-ready fires ~50ms after binary starts).
const removeOverlay = () => document.getElementById("rc-splash")?.remove();
listen("app-ready", removeOverlay);
setTimeout(removeOverlay, 500);

// #188: render prefs (cards, transitions, music, resolution) are now SQLite-backed.
// Hydrate the synchronous read cache from the DB BEFORE the first render, so every
// component's `useState(() => readPlacedCards(...))` / `getRenderPref(...)` sees real
// data on mount. hydrateRenderPrefs() never throws; the splash covers this window.
hydrateRenderPrefs().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
});

import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import "./globals.css";

// Remove #rc-splash when Rust emits app-ready (db init done).
// 500ms fallback covers the case where app-ready fires before React's listen() registers
// (async WSL in Batch A4 means app-ready fires ~50ms after binary starts).
const removeOverlay = () => document.getElementById("rc-splash")?.remove();
listen("app-ready", removeOverlay);
setTimeout(removeOverlay, 500);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

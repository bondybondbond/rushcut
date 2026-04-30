import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import App from "./App";
import "./globals.css";

// Step E splash fix (Batch A): remove the inline overlay once Rust emits app-ready
// (db init + WSL check complete). Fallback removes after 5s in case event never fires.
listen("app-ready", () => {
  document.getElementById("rc-splash")?.remove();
});
setTimeout(() => document.getElementById("rc-splash")?.remove(), 5000);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

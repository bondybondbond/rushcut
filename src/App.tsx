import { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";

export default function App() {
  useEffect(() => {
    const unlisten = listen("wsl-check-failed", () => {
      alert(
        "WSL2 is required.\nOpen PowerShell as Administrator and run: wsl --install"
      );
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return (
    <Routes>
      <Route path="/" element={<div>RushCut — Batch 8 scaffold</div>} />
    </Routes>
  );
}

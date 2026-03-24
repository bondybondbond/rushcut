import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import Upload from "@/pages/Upload";
import Editor from "@/pages/Editor";
import Output from "@/pages/Output";

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
      <Route path="/" element={<Navigate to="/upload" replace />} />
      <Route path="/upload" element={<Upload />} />
      <Route path="/editor/:projectId" element={<Editor />} />
      <Route path="/output/:jobId" element={<Output />} />
    </Routes>
  );
}

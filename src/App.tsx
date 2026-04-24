import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import Upload from "@/pages/Upload";
import Editor from "@/pages/Editor";
import Output from "@/pages/Output";
import Library from "@/pages/Library";
import Review from "@/pages/Review";
import Trimmer from "@/pages/Trimmer";
import { AppShell } from "@/components/AppShell";

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
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/upload" replace />} />
        <Route path="/upload" element={<Upload />} />
        <Route path="/library" element={<Library />} />
        <Route path="/trimmer/:projectId" element={<Trimmer />} />
        <Route path="/review/:projectId" element={<Review />} />
        <Route path="/editor/:projectId" element={<Editor />} />
        <Route path="/output/:jobId" element={<Output />} />
      </Routes>
    </AppShell>
  );
}

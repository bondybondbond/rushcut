import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import Upload from "@/pages/Upload";
import Library from "@/pages/Library";
import Review from "@/pages/Review";
import Trimmer from "@/pages/Trimmer";
import Transitions from "@/pages/Transitions";
import Sound from "@/pages/Sound";
import Render from "@/pages/Render";
import { AppShell } from "@/components/AppShell";

export default function App() {
  useEffect(() => {
    // Close the native Win32 splash (Batch A4) — fires when React has actually mounted.
    invoke("confirm_app_loaded").catch(() => {});
  }, []);

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
        <Route path="/transitions/:projectId" element={<Transitions />} />
        <Route path="/sound/:projectId" element={<Sound />} />
        <Route path="/review/:projectId" element={<Review />} />
        <Route path="/render/:projectId" element={<Render />} />
      </Routes>
    </AppShell>
  );
}

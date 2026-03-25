import { useState, DragEvent } from "react";

interface UploadZoneProps {
  onFolderPath: (path: string) => void;
  disabled?: boolean;
}

export function UploadZone({ onFolderPath, disabled = false }: UploadZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [manualPath, setManualPath] = useState("");

  function onDragOver(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setIsDragOver(true);
  }
  function onDragLeave() { setIsDragOver(false); }
  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setIsDragOver(false);
    // Drag-drop of a folder gives us a DataTransferItemList
    const items = Array.from(e.dataTransfer.items);
    const folderEntry = items.find((item) => {
      const entry = item.webkitGetAsEntry?.();
      return entry?.isDirectory;
    });
    if (folderEntry) {
      const entry = folderEntry.webkitGetAsEntry?.();
      if (entry?.fullPath) onFolderPath(entry.fullPath);
    }
  }

  function handleManualSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = manualPath.trim();
    if (trimmed) onFolderPath(trimmed);
  }

  return (
    <div className="space-y-4">
      <div
        className={`block border-2 border-dashed rounded-lg p-10 text-center transition-all duration-200 ${
          isDragOver ? "border-[#FF8A65]/60 bg-[#FF8A65]/5" : "border-[#C9A96E]/50"
        } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-default"}`}
        onDragOver={disabled ? undefined : onDragOver}
        onDragLeave={disabled ? undefined : onDragLeave}
        onDrop={disabled ? undefined : onDrop}
      >
        <p className="text-[#e5e5e5] text-base">Drop a folder here, or use the button above</p>
        <p className="text-[#e5e5e5] text-sm mt-2 opacity-60">
          MP4 · MOV · MKV
        </p>
      </div>

      {/* Manual path fallback */}
      <form onSubmit={handleManualSubmit} className="flex gap-2">
        <input
          type="text"
          value={manualPath}
          onChange={(e) => setManualPath(e.target.value)}
          placeholder="Paste a folder path..."
          disabled={disabled}
          className="flex-1 bg-[#111111] border border-white/10 rounded-md px-3 py-2 text-[#e5e5e5] text-sm placeholder:text-[#555555] focus:outline-none focus:border-[#C9A96E]/50 disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={disabled || !manualPath.trim()}
          className="px-4 py-2 bg-white/10 text-[#e5e5e5] text-sm rounded-md hover:bg-white/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Scan
        </button>
      </form>
    </div>
  );
}

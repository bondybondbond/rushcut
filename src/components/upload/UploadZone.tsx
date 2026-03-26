import { useState, DragEvent } from "react";

interface UploadZoneProps {
  onFolderPath: (path: string) => void;
  disabled?: boolean;
}

export function UploadZone({ onFolderPath, disabled = false }: UploadZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);

  function onDragOver(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setIsDragOver(true);
  }
  function onDragLeave() { setIsDragOver(false); }
  function onDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setIsDragOver(false);
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

  return (
    <div
      className={`block border-2 border-dashed rounded-lg p-10 text-center transition-all duration-200 ${
        isDragOver ? "border-[#FF8A65]/60 bg-[#FF8A65]/5" : "border-[#C9A96E]/50"
      } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-default"}`}
      onDragOver={disabled ? undefined : onDragOver}
      onDragLeave={disabled ? undefined : onDragLeave}
      onDrop={disabled ? undefined : onDrop}
    >
      <p className="text-[#e5e5e5] text-base">Or drag a folder here</p>
      <p className="text-[#e5e5e5] text-sm mt-2 opacity-60">
        MP4 · MOV · MKV
      </p>
    </div>
  );
}

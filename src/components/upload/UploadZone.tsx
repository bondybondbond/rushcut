export function UploadZone() {
  return (
    <div className="border-2 border-dashed border-white/20 rounded-lg p-12 text-center hover:border-white/30 transition-all duration-200">
      <p className="text-[#a3a3a3] text-sm">
        Drag clips here, or click to browse
      </p>
      <p className="text-[#555555] text-xs mt-2">
        MP4 &middot; MOV &middot; MKV &middot; up to 1 GB per file &middot; max 20 clips
      </p>
    </div>
  );
}

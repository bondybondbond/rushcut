export function ConfigurePanel({ projectId }: { projectId: string }) {
  return (
    <div className="space-y-4">
      <div className="border border-white/10 rounded-lg p-4">
        <p className="text-[#e5e5e5] text-sm font-medium mb-1">Order</p>
        <p className="text-[#a3a3a3] text-xs mb-3">
          Clips will play in the order uploaded. Drag to reorder.
        </p>
        <p className="text-[#555555] text-xs">[Clip order placeholder]</p>
      </div>
      <div className="border border-white/10 rounded-lg p-4">
        <p className="text-[#e5e5e5] text-sm font-medium mb-1">Music</p>
        <p className="text-[#a3a3a3] text-xs mb-3">
          A track will be chosen to match your brief.
        </p>
        <div className="flex gap-2">
          {["No music", "Auto", "Choose track"].map((opt) => (
            <span
              key={opt}
              className="text-xs border border-white/20 rounded px-2.5 py-1 text-[#a3a3a3]"
            >
              {opt}
            </span>
          ))}
        </div>
      </div>
      <div className="border border-white/10 rounded-lg p-4">
        <p className="text-[#e5e5e5] text-sm font-medium mb-1">Title card</p>
        <p className="text-[#a3a3a3] text-xs mb-3">
          We will generate a title from your brief or filename.
        </p>
        <div className="flex gap-2">
          {["On", "Off"].map((opt) => (
            <span
              key={opt}
              className="text-xs border border-white/20 rounded px-2.5 py-1 text-[#a3a3a3]"
            >
              {opt}
            </span>
          ))}
        </div>
      </div>
      <div className="border border-white/10 rounded-lg p-4">
        <p className="text-[#e5e5e5] text-sm font-medium mb-1">Style</p>
        <p className="text-[#a3a3a3] text-xs mb-3">
          Cuts and pacing will be chosen automatically.
        </p>
        <div className="flex gap-2">
          {["Auto", "Fast cuts", "Slow and cinematic"].map((opt) => (
            <span
              key={opt}
              className="text-xs border border-white/20 rounded px-2.5 py-1 text-[#a3a3a3]"
            >
              {opt}
            </span>
          ))}
        </div>
      </div>
      <p className="text-[#555555] text-xs pt-2">
        1 re-render included. Additional re-renders may use credits.
      </p>
    </div>
  );
}

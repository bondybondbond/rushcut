import { fmtMs } from "@/utils/fmtMs";

interface TopInfoBarProps {
  projectName: string;
  clipCount: number;
  totalMs: number;
}

export function TopInfoBar({ projectName, clipCount, totalMs }: TopInfoBarProps) {
  const clipLabel = `${clipCount} clip${clipCount !== 1 ? "s" : ""}`;
  const durLabel = totalMs > 0 ? ` · ${fmtMs(totalMs)}` : "";
  return (
    <div className="h-7 flex items-center pl-4 bg-[#0a0a0a] border-b border-white/10 text-sm text-[#e5e5e5] flex-shrink-0 select-none">
      <span className="font-semibold">{projectName}</span>
      <span className="text-[#a3a3a3]">&nbsp;·&nbsp;{clipLabel}{durLabel}</span>
    </div>
  );
}

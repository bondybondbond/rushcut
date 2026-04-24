import { useNavigate } from "react-router-dom";

export type StepId = "upload" | "trimmer" | "transitions" | "sound" | "render";

const STEPS: { id: StepId; label: string }[] = [
  { id: "upload",      label: "Upload" },
  { id: "trimmer",     label: "Trim" },
  { id: "transitions", label: "Transitions" },
  { id: "sound",       label: "Sound" },
  { id: "render",      label: "Render" },
];

interface StepNavProps {
  active: StepId;
  projectId?: string;
  /** Label for the right-side CTA button */
  nextLabel?: string;
  /** Called when the CTA is clicked */
  onNext?: () => void;
  /** Disables the CTA when true */
  nextDisabled?: boolean;
}

export function StepNav({
  active,
  projectId,
  nextLabel,
  onNext,
  nextDisabled,
}: StepNavProps) {
  const navigate = useNavigate();
  const activeIdx = STEPS.findIndex((s) => s.id === active);

  function handleStepClick(idx: number, id: StepId) {
    if (idx >= activeIdx) return; // can't jump forward
    if (!projectId) return;
    if (id === "upload") navigate("/upload");
    else if (id === "trimmer") navigate(`/trimmer/${projectId}`);
    else if (id === "transitions") navigate(`/transitions/${projectId}`);
    else if (id === "sound") navigate(`/sound/${projectId}`);
    else if (id === "render") navigate(`/render/${projectId}`);
  }

  return (
    <div className="flex items-center justify-between pl-12 pr-4 py-2 border-b border-white/10 bg-[#0a0a0a] flex-shrink-0">
      {/* Step breadcrumb */}
      <div className="flex items-center gap-1">
        {STEPS.map((step, idx) => {
          const isActive = step.id === active;
          const isPast = idx < activeIdx;
          const isFuture = idx > activeIdx;
          return (
            <div key={step.id} className="flex items-center gap-1">
              <button
                onClick={() => handleStepClick(idx, step.id)}
                disabled={!isPast}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  isActive
                    ? "text-[#FF8A65] bg-[#FF8A65]/10 border border-[#FF8A65]/40"
                    : isPast
                    ? "text-[#e5e5e5]/70 hover:text-[#e5e5e5] cursor-pointer"
                    : "text-[#e5e5e5]/20 cursor-default"
                }`}
              >
                {step.label}
              </button>
              {idx < STEPS.length - 1 && (
                <span className={`text-xs ${isFuture ? "text-[#e5e5e5]/15" : "text-[#e5e5e5]/30"}`}>
                  /
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Right: CTA */}
      {nextLabel && (
        <button
          onClick={onNext}
          disabled={nextDisabled}
          className="inline-flex items-center gap-2 px-4 py-1.5 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 text-sm disabled:opacity-30 disabled:cursor-not-allowed"
        >
          {nextLabel} &#8594;
        </button>
      )}
    </div>
  );
}

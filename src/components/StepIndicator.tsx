type Step = "upload" | "edit" | "render";

const STEPS: { key: Step; label: string }[] = [
  { key: "upload", label: "Upload" },
  { key: "edit", label: "Edit" },
  { key: "render", label: "Render" },
];

export function StepIndicator({ currentStep }: { currentStep: Step }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {STEPS.map((step, i) => {
        const isActive = step.key === currentStep;
        const isPast =
          STEPS.findIndex((s) => s.key === currentStep) > i;
        return (
          <div key={step.key} className="flex items-center gap-2">
            <span
              className={
                isActive
                  ? "text-[#e5e5e5] font-medium"
                  : isPast
                  ? "text-[#a3a3a3]"
                  : "text-[#555555]"
              }
            >
              {step.label}
            </span>
            {i < STEPS.length - 1 && (
              <span className="text-[#555555]">/</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

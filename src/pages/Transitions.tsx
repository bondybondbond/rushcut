import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectWithClips } from "@/types/project";
import { StepNav } from "@/components/StepNav";

type TransitionValue = "none" | "crossfade" | "dip_to_black";

const TRANSITIONS: { value: TransitionValue; label: string; description: string }[] = [
  { value: "none",        label: "None",        description: "Hard cut between clips — clean and fast." },
  { value: "crossfade",   label: "Crossfade",   description: "Smooth 1.5s dissolve between clips." },
  { value: "dip_to_black", label: "Dip to black", description: "Fades to black then back in — cinematic pacing." },
];

export default function Transitions() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [projectName, setProjectName] = useState("");
  const [clipCount, setClipCount] = useState(0);
  // sessionStorage persistence — survives back-navigation within the same WebView session
  const storageKey = `rc_transition_${projectId}`;
  const [transition, setTransition] = useState<TransitionValue>(
    () => (sessionStorage.getItem(storageKey) as TransitionValue | null) ?? "none"
  );

  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        setProjectName(data.project.name);
        setClipCount(data.clips.filter((c) => c.include !== 0).length);
      })
      .catch(() => {});
  }, [projectId]);

  function handleSelect(val: TransitionValue) {
    setTransition(val);
    sessionStorage.setItem(storageKey, val);
  }

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-[#e5e5e5]">
      <StepNav
        active="transitions"
        projectId={projectId}
        nextLabel="Next: Sound"
        onNext={() => navigate(`/editor/${projectId}`)}
        nextDisabled={false}
      />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">

          {/* Header */}
          <div>
            <h1 className="text-3xl font-semibold text-[#FF8A65]">Transitions</h1>
            <p className="text-base text-[#a3a3a3] mt-1">
              {projectName
                ? `${projectName} · ${clipCount} clip${clipCount !== 1 ? "s" : ""}`
                : "Loading…"}
            </p>
          </div>

          {/* Transition picker */}
          <div className="border border-white/15 rounded-lg p-6 space-y-4">
            <div>
              <p className="text-xl font-medium text-[#e5e5e5]">Between clips</p>
              <p className="text-sm text-[#a3a3a3] mt-0.5">
                How should RushCut cut between each clip in your film?
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              {TRANSITIONS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  data-testid={`chip-transition-${value}`}
                  onClick={() => handleSelect(value)}
                  className={`text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium ${
                    transition === value
                      ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                      : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Description of selected transition */}
            <p className="text-sm text-[#a3a3a3]">
              {TRANSITIONS.find((t) => t.value === transition)?.description}
            </p>
          </div>

          {/* Output info */}
          <p className="text-sm text-[#a3a3a3]">
            Your choice is saved automatically. Continue to Sound to choose music, or render directly from the Editor.
          </p>

        </div>
      </div>
    </div>
  );
}

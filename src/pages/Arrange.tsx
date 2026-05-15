import { useState, useEffect, useRef } from "react";
import { useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import type { Clip, ProjectWithClips } from "@/types/project";
import { EditorShell } from "@/components/EditorShell";
import { StickyFilmStrip } from "@/components/StickyFilmStrip";
import { useConfiguredTabs } from "@/hooks/useConfiguredTabs";
import { projectCache } from "@/utils/projectCache";

type TransitionValue = "none" | "crossfade" | "dip_to_black";
type ArrangeTab = "clips" | "transitions" | "cards";

const TRANSITIONS: { value: TransitionValue; label: string; description: string }[] = [
  { value: "none",        label: "None",        description: "Hard cut between clips — clean and fast." },
  { value: "crossfade",   label: "Crossfade",   description: "Smooth 1.5s dissolve between clips." },
  { value: "dip_to_black", label: "Dip to black", description: "Fades to black then back in — cinematic pacing." },
];

// Discrete volume presets — float multipliers written to clip_volume.
const VOLUME_PRESETS: { label: string; value: number }[] = [
  { label: "Mute", value: 0 },
  { label: "50%",  value: 0.5 },
  { label: "100%", value: 1.0 },
  { label: "150%", value: 1.5 },
  { label: "200%", value: 2.0 },
];

// Zoom chips — labels per PRD, mapped to zoom_mode values used by the pipeline.
const ZOOM_PRESETS: { label: string; value: string | null }[] = [
  { label: "Off",  value: null },
  { label: "1.3×", value: "gentle" },
  { label: "1.5×", value: "medium" },
  { label: "2×",   value: "tight" },
];

const ARRANGE_TABS: { id: ArrangeTab; label: string }[] = [
  { id: "clips",       label: "Clips" },
  { id: "transitions", label: "Transitions" },
  { id: "cards",       label: "Cards" },
];

function isVolumePreset(v: number): boolean {
  return VOLUME_PRESETS.some((p) => p.value === v);
}

export default function Arrange() {
  const { projectId } = useParams<{ projectId: string }>();

  const _cached = projectCache.get(projectId ?? "");
  const [projectName, setProjectName] = useState(_cached?.name ?? "");
  const [clips, setClips] = useState<Clip[]>(_cached?.clips ?? []);
  const [tab, setTab] = useState<ArrangeTab>("clips");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  const storageKey = `rc_transition_${projectId}`;
  const [transition, setTransition] = useState<TransitionValue>(
    () => (sessionStorage.getItem(storageKey) as TransitionValue | null) ?? "none"
  );

  // Custom-volume inline input: when true the chip row shows a number input instead.
  const [editingCustomVol, setEditingCustomVol] = useState(false);
  const [customVolInput, setCustomVolInput] = useState("");
  const focalImgRef = useRef<HTMLDivElement>(null);

  const configured = useConfiguredTabs(projectId ?? "");

  const inFilm = clips.filter((c) => c.include === 1).sort((a, b) => a.sort_order - b.sort_order);
  const clipCount = inFilm.length;
  const totalMs = inFilm.reduce((sum, c) => {
    const start = c.in_ms ?? 0;
    const end = c.out_ms ?? c.duration_ms;
    return sum + Math.max(0, end - start);
  }, 0);

  const selectedClip = selectedClipId ? clips.find((c) => c.id === selectedClipId) ?? null : null;

  const soundMoodVal = (() => {
    try {
      const raw = sessionStorage.getItem(`rc_sound_${projectId}`);
      return raw ? (JSON.parse(raw) as { mood?: string }).mood ?? null : null;
    } catch { return null; }
  })();

  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        projectCache.set(projectId, { name: data.project.name, clips: data.clips });
        setProjectName(data.project.name);
        setClips(data.clips);
      })
      .catch(() => {});
  }, [projectId]);

  function handleSelectTransition(val: TransitionValue) {
    setTransition(val);
    sessionStorage.setItem(storageKey, val);
  }

  // Optimistic local patch — keeps the right panel in sync without a refetch.
  function patchClip(clipId: string, patch: Partial<Clip>) {
    setClips((prev) => {
      const next = prev.map((c) => (c.id === clipId ? { ...c, ...patch } : c));
      if (projectId) projectCache.set(projectId, { name: projectName, clips: next });
      return next;
    });
  }

  async function saveVolume(clip: Clip, vol: number) {
    patchClip(clip.id, { clip_volume: vol });
    try {
      await invoke("update_clip_volume_cmd", { clipId: clip.id, clipVolume: vol });
    } catch (err) {
      console.error("[arrange] update_clip_volume_cmd failed", err);
    }
  }

  async function saveReview(clip: Clip, patch: Partial<Pick<Clip, "focal_x" | "focal_y" | "zoom_mode">>) {
    const merged = { ...clip, ...patch };
    patchClip(clip.id, patch);
    try {
      await invoke("update_clip_review_cmd", {
        clipId: clip.id,
        inMs: merged.in_ms,
        outMs: merged.out_ms,
        focalX: merged.focal_x,
        focalY: merged.focal_y,
        zoomMode: merged.zoom_mode,
        include: merged.include,
      });
    } catch (err) {
      console.error("[arrange] update_clip_review_cmd failed", err);
    }
  }

  function handleVolumeChip(clip: Clip, vol: number) {
    setEditingCustomVol(false);
    saveVolume(clip, vol);
  }

  function handleCustomChipClick(clip: Clip) {
    setCustomVolInput(String(Math.round(clip.clip_volume * 100)));
    setEditingCustomVol(true);
  }

  function commitCustomVolume(clip: Clip) {
    const parsed = parseFloat(customVolInput);
    // Invalid / empty → fall back to 100%. Otherwise clamp 0–200.
    const pct = Number.isFinite(parsed) ? Math.min(200, Math.max(0, parsed)) : 100;
    setEditingCustomVol(false);
    saveVolume(clip, pct / 100);
  }

  function handleFocalClick(clip: Clip, e: React.MouseEvent<HTMLDivElement>) {
    const el = focalImgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    saveReview(clip, { focal_x: x, focal_y: y });
  }

  return (
    <EditorShell
      projectId={projectId ?? ""}
      projectName={projectName}
      clipCount={clipCount}
      totalMs={totalMs}
      activeTab="arrange"
      configured={configured}
      transitionValue={transition}
      soundMood={soundMoodVal}
      timelineHud={
        <StickyFilmStrip
          clips={clips}
          projectId={projectId!}
          activeId={tab === "clips" ? selectedClipId : null}
          onSelectClip={tab === "clips" ? setSelectedClipId : undefined}
        />
      }
    >
      <div className="flex flex-col flex-1 min-w-0">
        {/* In-screen tab bar */}
        <div className="flex items-center gap-2 px-6 pt-4 pb-3 border-b border-white/10 flex-shrink-0">
          {ARRANGE_TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              data-testid={`arrange-tab-${id}`}
              onClick={() => setTab(id)}
              className={`text-sm rounded-md px-4 py-1.5 border transition-all duration-200 font-medium ${
                tab === id
                  ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                  : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* ── Clips tab ───────────────────────────────────────────── */}
        {tab === "clips" && (
          <div className="flex flex-1 min-h-0">
            {/* Main — selected clip preview / empty state */}
            <div className="flex-1 min-w-0 overflow-y-auto px-6 py-8">
              <h1 className="text-3xl font-semibold text-[#FF8A65]">Arrange</h1>
              <p className="text-base text-[#a3a3a3] mt-1">
                Adjust each clip's volume and zoom. Click a clip in the timeline below.
              </p>

              {selectedClip ? (
                <div className="mt-8 max-w-md">
                  <div className="rounded-lg overflow-hidden bg-black border border-white/10" style={{ aspectRatio: "16/9" }}>
                    {selectedClip.thumbnail_data ? (
                      <img
                        src={selectedClip.thumbnail_data}
                        alt={selectedClip.filename}
                        className="w-full h-full object-contain"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[#a3a3a3] text-sm">
                        No preview
                      </div>
                    )}
                  </div>
                  <p className="text-base text-[#e5e5e5] mt-3 truncate" title={selectedClip.filename}>
                    {selectedClip.filename}
                  </p>
                </div>
              ) : (
                <p className="text-sm text-[#a3a3a3] italic mt-8">
                  Select a clip in the timeline to adjust it
                </p>
              )}
            </div>

            {/* Right panel — per-clip controls */}
            <aside className="w-48 flex-shrink-0 border-l border-white/10 overflow-y-auto p-4 bg-[#0a0a0a]">
              {!selectedClip ? (
                <p className="text-sm text-[#a3a3a3] italic">
                  Select a clip in the timeline to adjust it
                </p>
              ) : (
                <div className="space-y-6">
                  {/* Volume */}
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-[#e5e5e5]">Volume</p>
                    {editingCustomVol ? (
                      <input
                        type="number"
                        min={0}
                        max={200}
                        autoFocus
                        value={customVolInput}
                        onChange={(e) => setCustomVolInput(e.target.value)}
                        onBlur={() => commitCustomVolume(selectedClip)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitCustomVolume(selectedClip);
                          if (e.key === "Escape") setEditingCustomVol(false);
                        }}
                        className="w-full text-sm rounded-md px-3 py-1.5 border border-[#99B3FF] bg-[#0a0a0a] text-[#e5e5e5] focus:outline-none"
                        placeholder="0–200"
                      />
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {VOLUME_PRESETS.map(({ label, value }) => {
                          const active = selectedClip.clip_volume === value;
                          return (
                            <button
                              key={label}
                              type="button"
                              data-testid={`chip-volume-${label}`}
                              onClick={() => handleVolumeChip(selectedClip, value)}
                              className={`text-sm rounded-md px-3 py-1.5 border transition-all duration-200 font-medium ${
                                active
                                  ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                                  : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                              }`}
                            >
                              {label}
                            </button>
                          );
                        })}
                        <button
                          type="button"
                          data-testid="chip-volume-custom"
                          onClick={() => handleCustomChipClick(selectedClip)}
                          className={`text-sm rounded-md px-3 py-1.5 border transition-all duration-200 font-medium ${
                            !isVolumePreset(selectedClip.clip_volume)
                              ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                              : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                          }`}
                        >
                          {isVolumePreset(selectedClip.clip_volume)
                            ? "Custom…"
                            : `${Math.round(selectedClip.clip_volume * 100)}%`}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Zoom */}
                  <div className="space-y-2 pt-4 border-t border-white/10">
                    <p className="text-sm font-medium text-[#e5e5e5]">Zoom</p>
                    <div className="flex flex-wrap gap-2">
                      {ZOOM_PRESETS.map(({ label, value }) => {
                        const active = (selectedClip.zoom_mode ?? null) === value;
                        return (
                          <button
                            key={label}
                            type="button"
                            data-testid={`chip-zoom-${label}`}
                            onClick={() => saveReview(selectedClip, { zoom_mode: value })}
                            className={`text-sm rounded-md px-3 py-1.5 border transition-all duration-200 font-medium ${
                              active
                                ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                                : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Focal point — only when zoom is on */}
                  {selectedClip.zoom_mode && (
                    <div className="space-y-2 pt-4 border-t border-white/10">
                      <p className="text-sm font-medium text-[#e5e5e5]">Focal point</p>
                      <div
                        ref={focalImgRef}
                        onClick={(e) => handleFocalClick(selectedClip, e)}
                        className="relative rounded-md overflow-hidden bg-black border border-white/15 cursor-crosshair"
                        style={{ aspectRatio: "16/9" }}
                      >
                        {selectedClip.thumbnail_data ? (
                          <img
                            src={selectedClip.thumbnail_data}
                            alt="focal target"
                            className="w-full h-full object-cover pointer-events-none"
                          />
                        ) : (
                          <div className="w-full h-full bg-white/5" />
                        )}
                        {selectedClip.focal_x !== null && selectedClip.focal_y !== null && (
                          <div
                            className="absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[#FF8A65] bg-[#FF8A65]/30 pointer-events-none"
                            style={{
                              left: `${selectedClip.focal_x * 100}%`,
                              top: `${selectedClip.focal_y * 100}%`,
                            }}
                          />
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => saveReview(selectedClip, { focal_x: null, focal_y: null })}
                        className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors"
                      >
                        Reset to centre
                      </button>
                    </div>
                  )}
                </div>
              )}
            </aside>
          </div>
        )}

        {/* ── Transitions tab ─────────────────────────────────────── */}
        {tab === "transitions" && (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">
              <div>
                <h1 className="text-3xl font-semibold text-[#FF8A65]">Transitions</h1>
                <p className="text-base text-[#a3a3a3] mt-1">
                  How should RushCut cut between each clip in your film?
                </p>
              </div>

              <div className="border border-white/15 rounded-lg p-6 space-y-4">
                <p className="text-xl font-medium text-[#e5e5e5]">Between clips</p>

                <div className="flex flex-wrap gap-3">
                  {TRANSITIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      data-testid={`chip-transition-${value}`}
                      onClick={() => handleSelectTransition(value)}
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

                <p className="text-sm text-[#a3a3a3]">
                  {TRANSITIONS.find((t) => t.value === transition)?.description}
                </p>
              </div>

              <p className="text-sm text-[#a3a3a3]">
                Your choice is saved automatically. Continue to Sound to choose music for your film.
              </p>
            </div>
          </div>
        )}

        {/* ── Cards tab ───────────────────────────────────────────── */}
        {tab === "cards" && (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-sm text-[#a3a3a3] italic">Coming soon</p>
          </div>
        )}
      </div>
    </EditorShell>
  );
}

import { useState, useEffect, useRef, useCallback } from "react";
import { useParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { convertFileSrc } from "@tauri-apps/api/core";
import { ChevronLeft, ChevronRight, Play, Pause, Shuffle, Trash2 } from "lucide-react";
import type { Clip, ProjectWithClips, TransitionValue } from "@/types/project";
import { EditorShell } from "@/components/EditorShell";
import { StickyFilmStrip, cardTextColor, type PositionedCard } from "@/components/StickyFilmStrip";
import { useConfiguredTabs } from "@/hooks/useConfiguredTabs";
import { projectCache } from "@/utils/projectCache";
import { fmtMs } from "@/utils/fmtMs";
import { readTransitionConfig, readPlacedCards, savePlacedCards } from "@/utils/buildJobConfig";
import type { TransitionConfig, PlacedCard, CardAnimation } from "@/utils/buildJobConfig";
import { effectiveFilmMs, clampedXfadeMs, filmTimeAtClipStart } from "@/utils/filmDuration";
import { getRenderPref, setRenderPref } from "@/utils/renderStore";
import {
  parseZoom, buildZoomMode, zoomLabel, FIXED_AMOUNTS, KB_AMOUNTS,
} from "@/utils/zoom";
import type { ZoomStyle, ZoomState } from "@/utils/zoom";

// #29: diagnostic logging (mirrors Trimmer.diagLog -> diag_log_cmd) to locate the
// sporadic selectedClipId->null reset. Instrumentation only; remove once root-caused.
function diagLog(line: string) {
  invoke("diag_log_cmd", { line }).catch(() => {});
}

type ArrangeTab = "zoom" | "transitions" | "cards" | "sound";
// #149 (revised after live user feedback): black + white presets only -- a 3rd swatch
// remembers the project's last custom colour (so picking a brand colour once carries
// forward to the next card without reopening the OS picker), plus an always-present
// "pick new" swatch that opens the native colour dialog (<input type="color">, which
// WebView2/Chromium renders as the real Windows dialog -- no Tauri dialog plugin
// needed). cardTextColor is the shared canonical version (StickyFilmStrip's, not a
// local duplicate — see DESIGN.md "CSS preview card" note).
const CARD_PRESET_COLORS = ["#0a0a0a", "#ffffff"];
const CARD_LAST_COLOR_KEY = (projectId: string) => `rc_cards_last_color_${projectId}`;
// "None" is first and the standard default -- matches the same convention already used
// for opening/closing transitions (OPEN_CLOSE_OPTIONS above).
const CARD_ANIMATIONS: { value: CardAnimation; label: string }[] = [
  { value: "none", label: "None" },
  { value: "appear", label: "Appear" },
  { value: "fade", label: "Fade" },
  { value: "fly_in", label: "Fly in" },
];
// CSS animation shorthand per choice, applied to the preview card's text wrapper only
// (#149 polish round) -- mirrors the Transitions tab's animated card-chip preview.
// "none" has no entry -- the preview renders statically, no animation style applied.
const CARD_ANIM_CSS: Partial<Record<CardAnimation, string>> = {
  appear: "rc-card-appear-in 3s infinite steps(1, end)",
  fade: "rc-card-fade-in 3s infinite ease-in-out",
  fly_in: "rc-card-fly-in 3s infinite ease-in-out",
};
interface ComposedCard {
  text: string;
  subtitle: string;
  color: string;
  animation: CardAnimation;
}
function blankComposedCard(color: string = CARD_PRESET_COLORS[0]): ComposedCard {
  return { text: "", subtitle: "", color, animation: "none" };
}

const TRANSITIONS: { value: TransitionValue; label: string }[] = [
  { value: "none",         label: "None" },
  { value: "crossfade",    label: "Crossfade" },
  { value: "dip_to_black", label: "Dip to black" },
  { value: "wipe",         label: "Wipe" },
  { value: "wipe_down",    label: "Wipe down" },
  { value: "zoom",         label: "Zoom" },
  { value: "dissolve",     label: "Dissolve" },
  { value: "barn_door",    label: "Barn door" },
  { value: "band_wipe",    label: "Band wipe" },
];

const ANIM_KEYS: Record<TransitionValue, { a: string; b: string }> = {
  none:         { a: "rc-trans-none-a 3s infinite steps(1, end)",  b: "rc-trans-none-b 3s infinite steps(1, end)" },
  crossfade:    { a: "rc-trans-cf-a 3s infinite ease-in-out",      b: "rc-trans-cf-b 3s infinite ease-in-out" },
  dip_to_black: { a: "rc-trans-dip-a 3s infinite ease-in-out",     b: "rc-trans-dip-b 3s infinite ease-in-out" },
  wipe:         { a: "rc-trans-wipe-a 3s infinite ease-in-out",    b: "rc-trans-wipe-b 3s infinite ease-in-out" },
  wipe_down:    { a: "rc-trans-wipd-a 3s infinite ease-in-out",    b: "rc-trans-wipd-b 3s infinite ease-in-out" },
  zoom:         { a: "rc-trans-zoom-a 3s infinite ease-in-out",    b: "rc-trans-zoom-b 3s infinite ease-in-out" },
  dissolve:     { a: "rc-trans-dis-a 3s infinite ease-in-out",     b: "rc-trans-dis-b 3s infinite ease-in-out" },
  barn_door:    { a: "rc-trans-barn-a 3s infinite ease-in-out",    b: "rc-trans-barn-b 3s infinite ease-in-out" },
  band_wipe:    { a: "rc-trans-band-a 3s infinite ease-in-out",    b: "rc-trans-band-b 3s infinite ease-in-out" },
};

// Random pool for the "Surprise me" opening/closing picker — excludes "none" and "dissolve".
// "dissolve" removed: FFmpeg noise-dither xfade renders as literal static/snow (V1.4 #60).
// SYNC: keep in sync with _SHUFFLE_POOL in pipeline/transitions.py (same members, different names).
const SHUFFLE_POOL: TransitionValue[] = ["crossfade", "dip_to_black", "wipe", "wipe_down", "zoom", "barn_door", "band_wipe"];

const OPEN_CLOSE_OPTIONS: { value: TransitionValue; label: string }[] = [
  { value: "none",         label: "None" },
  { value: "dip_to_black", label: "Dip to black" },
];

// Zoom model (parse / build / label) lives in @/utils/zoom — shared so badges
// on other screens never render the raw zoom_mode string. UI-only chip lists
// stay here.
const ZOOM_STYLES: { value: ZoomStyle; label: string }[] = [
  { value: "off",      label: "Off" },
  { value: "fixed",    label: "Fixed" },
  { value: "gradual",  label: "Gradual" },
];
const KB_DIRECTIONS: { value: "in" | "out"; label: string }[] = [
  { value: "in",  label: "Zoom in" },
  { value: "out", label: "Zoom out" },
];
// Speed = fraction of clip when zoom fully realizes, then holds.
const KB_SPEEDS: { value: string; label: string; sub: string }[] = [
  { value: "slow", label: "Slow", sub: "full clip" },
  { value: "med",  label: "Med",  sub: "75% of clip" },
  { value: "fast", label: "Fast", sub: "50% of clip" },
];

const zoomChipClass = (active: boolean) =>
  `text-sm rounded-md px-3 py-1.5 border transition-all duration-200 font-medium ${
    active
      ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
      : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
  }`;

const ARRANGE_TABS: { id: ArrangeTab; label: string }[] = [
  { id: "zoom",         label: "Zoom" },
  { id: "transitions",  label: "Transitions" },
  { id: "cards",        label: "Cards" },
  { id: "sound",        label: "Sound" },
];

const VOLUME_PRESETS = [0, 50, 100] as const;

const ZOOM_SCALE: Record<string, number> = { gentle: 1.3, medium: 1.5, tight: 2.0 };

// Gradual-zoom speed -> fraction of the trimmed clip the zoom animates over before
// holding. NEW TS const mirroring pipeline/zoom.py `_KB_SPEED_FRAC` so the preview
// animation finishes at the same time the rendered zoom does. (Unrelated to the
// KB_SPEEDS chip-label array above.)
const KB_SPEED_FRAC: Record<string, number> = { slow: 1.0, med: 0.75, fast: 0.5 };

// Smoothstep approximation of CSS ease-in-out (cubic-bezier 0.42, 0, 0.58, 1).
// Used to derive the current CSS animation scale from normalised clip progress so
// the destination crop box reads from the same progress model as the animation.
// NOTE — this is an approximation, not the exact Bezier curve. Name reflects that.
// TODO (U3d, deferred): the crop box keeps this smoothstep approximation of the
// WAAPI animation's cubic-bezier(0.42,0,0.58,1) ("ease-in-out") curve. They differ
// only at intermediate paused positions and the drift is not user-perceptible.
// Revisit (exact bezier evaluator) only if the drift ever becomes visible.
function approxKenBurnsProgress(t: number): number {
  const tc = Math.max(0, Math.min(t, 1));
  return tc * tc * (3 - 2 * tc);
}

// Preview duration (seconds) for the gradual-zoom CSS animation on a clip:
// trimmed-duration x speed-fraction, matching the render. Returns 0 for non-gradual
// clips (no preview animation). Min 0.1s so a near-zero trim never yields an invalid
// (and silently non-running) 0s animation.
function kbPreviewDurationSec(clip: Clip | null): number {
  if (!clip) return 0;
  const z = parseZoom(clip.zoom_mode);
  if (z.style !== "gradual") return 0;
  const trimmedMs = Math.max(0, (clip.out_ms ?? clip.duration_ms) - (clip.in_ms ?? 0));
  const frac = KB_SPEED_FRAC[z.kbSpeed] ?? 1.0;
  return Math.max(0.1, (trimmedMs / 1000) * frac);
}

export default function Arrange() {
  const { projectId } = useParams<{ projectId: string }>();

  const _cached = projectCache.get(projectId ?? "");
  const [projectName, setProjectName] = useState(_cached?.name ?? "");
  const [clips, setClips] = useState<Clip[]>(_cached?.clips ?? []);
  const [tab, setTab] = useState<ArrangeTab>("zoom");
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);

  // Clip playback state
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);

  const focalImgRef = useRef<HTMLDivElement>(null);
  const videoBoxRef = useRef<HTMLDivElement>(null);
  // Wrapper div that receives the Ken Burns CSS animation so the <video>
  // element itself is never transformed — avoids compositor conflicts that
  // cause choppy playback in WebView2.
  const videoWrapRef = useRef<HTMLDivElement>(null);
  // Web Animations API handle for the gradual Ken Burns zoom (U3d). Replaces the
  // old rc-kenburns CSS keyframe, which read var(--kb-*) and so could not be
  // promoted to the GPU compositor in WebView2 (choppy playback). WAAPI transform
  // animations with literal values ARE compositor-accelerated.
  const kbAnimRef = useRef<Animation | null>(null);
  const isDraggingFocalRef = useRef(false);
  // Gesture split on the big preview: a press that moves < DRAG_THRESHOLD_PX is a
  // click (toggle play); past the threshold it becomes a focal-point drag.
  const focalDownRef = useRef<{ x: number; y: number } | null>(null);
  const focalMovedRef = useRef(false);
  const selectedClipRef = useRef<Clip | null>(null);
  const loadedClipIdRef = useRef<string>("");
  const isPlayingRef    = useRef(false);   // mirror of isPlaying for use in effects
  // Tracks which clip the zoom-sync effect last ran for, so it can tell a clip
  // SWITCH (must land paused) apart from a param edit on the same clip (preserve
  // live play state). See the zoom-sync effect below for the stale-ref reason.
  const prevZoomClipIdRef = useRef<string | null>(null);

  // Sound tab — independent video instance + playback state
  const soundVideoRef = useRef<HTMLVideoElement>(null);
  const soundLoadedClipIdRef = useRef<string>("");
  const [soundIsPlaying, setSoundIsPlaying] = useState(false);
  const [soundCurrentMs, setSoundCurrentMs] = useState(0);
  const [soundDurationMs, setSoundDurationMs] = useState(0);

  // Sound tab — per-clip volume custom input + explicit Custom-chip visibility flag
  const [customVolInput, setCustomVolInput] = useState<number>(100);
  const [showCustomInput, setShowCustomInput] = useState(false);
  // Per-clip debounce map — keyed by clip id so rapid multi-clip muting does not
  // cancel a previous clip's pending DB write (bug: shared single timer would only
  // persist the last-clicked clip when muting several clips in quick succession).
  const volumeDebounceRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const storageKey = `rc_transition_${projectId}`;
  const [transConfig, setTransConfig] = useState<TransitionConfig>(
    () => readTransitionConfig(projectId ?? "")
  );

  // #149: cards can be placed anywhere -- replaces the old fixed start/end-only CardsState.
  const [placedCards, setPlacedCards] = useState<PlacedCard[]>(() => readPlacedCards(projectId ?? ""));
  // Which existing placed card (if any) is selected in the filmstrip -- drives "Edit card"
  // mode and the delete bin. null = composing a brand-new, not-yet-placed card.
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  // Remembers the last colour picked via the native OS picker, per project (#149 polish
  // round) -- so a brand colour chosen once carries forward to the next new card instead
  // of needing to reopen the OS dialog every time.
  const [lastCustomColor, setLastCustomColor] = useState<string | null>(
    () => (projectId ? getRenderPref(CARD_LAST_COLOR_KEY(projectId)) : null)
  );
  // In-progress "New card" draft -- kept SEPARATE from whatever's being edited, so
  // switching to inspect/edit an existing card and back to "New card" never loses
  // what was being typed (confirmed live: this used to reset on every mode switch).
  const [newCardDraft, setNewCardDraft] = useState<ComposedCard>(() => blankComposedCard(lastCustomColor ?? undefined));
  const cardsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // U4: tracks the previous tab so the tab-switch effect can detect zoom-tab-leave.
  const prevTabRef = useRef<ArrangeTab>("zoom");
  const configured = useConfiguredTabs(projectId ?? "");

  const inFilm = clips.filter((c) => c.include === 1).sort((a, b) => a.sort_order - b.sort_order);
  const clipCount = inFilm.length;
  // #62/#63: displayed runtime subtracts transition overlap (telescoped) + adds card seconds.
  // #149: source from live in-memory placedCards (not a re-read from localStorage) so the
  // runtime + strip tiles update instantly as the user places/edits/deletes on the Cards tab.
  const totalMs = effectiveFilmMs(inFilm, transConfig, placedCards.length);

  // #74/#149: live card tiles for the filmstrip — sourced from in-memory placedCards.
  const cardsForStrip: PositionedCard[] = placedCards.map((c) => ({
    card: { id: c.id, color: c.color, text: c.text },
    beforeClipId: c.beforeClipId,
  }));
  // Per-clip "card precedes this clip" map for filmTimeAtClipStart (generalizes the old
  // single cardFlags.open boolean to arbitrary mid-roll positions).
  const cardsBeforeClip = inFilm.map((c) => placedCards.some((p) => p.beforeClipId === c.id));

  // What the Cards tab form currently shows/edits: the selected existing card's live
  // data when editing, or the persistent new-card draft otherwise. Derived (not its own
  // state) so there's nothing to keep in sync -- editing a placed card always reads
  // straight from placedCards, and switching away from "New card" and back can never
  // lose the draft since newCardDraft is untouched by selection changes.
  const editingCard = selectedCardId ? placedCards.find((c) => c.id === selectedCardId) ?? null : null;
  const composed: ComposedCard = editingCard
    ? { text: editingCard.text, subtitle: editingCard.subtitle, color: editingCard.color, animation: editingCard.animation }
    : newCardDraft;

  const selectedClip = selectedClipId ? clips.find((c) => c.id === selectedClipId) ?? null : null;
  selectedClipRef.current = selectedClip;

  const soundMoodVal = (() => {
    try {
      const raw = getRenderPref(`rc_sound_${projectId}`);
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

  // Mutate + persist placedCards in one step — called from every mutation path
  // (place/edit/delete) so localStorage and in-memory state never drift. Takes an
  // updater (not a plain next-array) so callers never risk acting on a stale closure
  // of placedCards (e.g. a debounced text-edit firing after another change landed).
  const mutateCards = useCallback((updater: (prev: PlacedCard[]) => PlacedCard[]) => {
    setPlacedCards((prev) => {
      const next = updater(prev);
      if (projectId) savePlacedCards(projectId, next);
      return next;
    });
  }, [projectId]);

  // Pause the outgoing tab's video immediately on tab switch.
  useEffect(() => {
    if (tab !== "zoom") {
      videoRef.current?.pause();
      setIsPlaying(false);
    }
    if (tab !== "sound") {
      soundVideoRef.current?.pause();
      setSoundIsPlaying(false);
    }
    prevTabRef.current = tab;
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // When selected clip changes OR tab returns to "zoom", reload video source.
  // Skip reload if the same src is already loaded (e.g. returning from another tab).
  useEffect(() => {
    if (tab !== "zoom") return;
    const video = videoRef.current;
    if (!video) return;

    if (!selectedClip) {
      loadedClipIdRef.current = "";
      video.src = "";
      setIsPlaying(false);
      setCurrentMs(0);
      setDurationMs(0);
      return;
    }

    if (selectedClip.id === loadedClipIdRef.current) return; // same clip — keep playback position

    loadedClipIdRef.current = selectedClip.id;
    const src = selectedClip.proxy_path
      ? convertFileSrc(selectedClip.proxy_path)
      : convertFileSrc(selectedClip.local_path);
    setIsPlaying(false);
    setCurrentMs(0);
    setDurationMs(0);
    video.src = src;
    diagLog(`arrange zoom-load id=${selectedClip.id} tab=${tab}`);
    video.load();
  }, [selectedClipId, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // #29 instrumentation: log every selectedClipId transition, flagging null resets
  // (the reported "must re-pick a clip" symptom) with the prior value so the trigger
  // can be correlated against clips refreshes / event timing in the diag log.
  const prevSelectedIdRef = useRef<string | null>(selectedClipId);
  useEffect(() => {
    const prev = prevSelectedIdRef.current;
    prevSelectedIdRef.current = selectedClipId;
    if (selectedClipId === null && prev !== null) {
      diagLog(`arrange selectedClipId->null (was ${prev}) tab=${tab} clips=${clips.length}`);
    }
  }, [selectedClipId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep isPlayingRef in sync so the zoom animation effect can read play
  // state without adding isPlaying to its dependency array (which would
  // re-trigger the animation on every play/pause toggle).
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);

  // Gradual zoom preview — applied to a wrapper <div> (not the <video> itself)
  // so the video decoder and the CSS compositor run on separate layers,
  // eliminating WebView2 choppy-playback when scaling is active.
  // The zoom is PLAYHEAD-DRIVEN: on clip select / chip / focal change we
  // re-establish the animation params and position its clock to the current
  // playhead (paused = held at the start/seek frame, no auto-preview). Playback
  // events (play/pause/seek/clip-end) re-sync via syncZoomToPlayhead directly.
  useEffect(() => {
    if (tab !== "zoom") return; // other tabs own their own video; leave untouched
    // Distinguish a clip SWITCH from a param edit on the same clip. On a switch we
    // must NOT read isPlayingRef: the video-reload effect above just called
    // setIsPlaying(false), but that state change has not yet propagated to
    // isPlayingRef (the [isPlaying] sync effect runs on the NEXT render), so the
    // ref is stale `true` here. Reading it would re-arm and play() the zoom on the
    // new clip even though playback is paused (U4b bug).
    const clipChanged = prevZoomClipIdRef.current !== selectedClipId;
    prevZoomClipIdRef.current = selectedClipId;
    if (clipChanged) {
      // New clip always lands paused at its start frame (t=0). null -> first real
      // clipId also counts as a switch and is intentional — first load is paused.
      syncZoomToPlayhead(0, false);
      setCurrentMs(0);
      return;
    }
    // Same clip — a zoom-mode / focal / trim edit during the session. Preserve the
    // live play state. Read the live playhead off the element (not currentMs state)
    // so this effect need not depend on currentMs — depending on it would re-fire ~4Hz.
    const inMs = selectedClip?.in_ms ?? 0;
    const v = videoRef.current;
    const elapsedSec = v ? Math.max(0, v.currentTime - inMs / 1000) : 0;
    syncZoomToPlayhead(elapsedSec, isPlayingRef.current);
    // Sync React currentMs to the element's position so the crop box and the WAAPI
    // animation always agree — prevents any divergence after zoom-mode or focal
    // changes where currentMs state might be slightly behind v.currentTime (U3d).
    if (v) setCurrentMs(v.currentTime * 1000);
  }, [selectedClipId, selectedClip?.zoom_mode, selectedClip?.focal_x, selectedClip?.focal_y, selectedClip?.in_ms, selectedClip?.out_ms, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sound tab — independent video reload (mirrors zoom tab pattern, separate state)
  useEffect(() => {
    if (tab !== "sound") return;
    const video = soundVideoRef.current;
    if (!video) return;

    if (!selectedClip) {
      soundLoadedClipIdRef.current = "";
      video.src = "";
      setSoundIsPlaying(false);
      setSoundCurrentMs(0);
      setSoundDurationMs(0);
      return;
    }

    if (selectedClip.id === soundLoadedClipIdRef.current) return; // same clip — keep playback position

    soundLoadedClipIdRef.current = selectedClip.id;
    const src = selectedClip.proxy_path
      ? convertFileSrc(selectedClip.proxy_path)
      : convertFileSrc(selectedClip.local_path);
    setSoundIsPlaying(false);
    setSoundCurrentMs(0);
    setSoundDurationMs(0);
    video.src = src;
    diagLog(`arrange sound-load id=${selectedClip.id} tab=${tab}`);
    video.load();
  }, [selectedClipId, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  function saveTransConfig(next: TransitionConfig) {
    setTransConfig(next);
    setRenderPref(storageKey, JSON.stringify(next));
  }

  function handleSelectBetween(val: TransitionValue) {
    // "shuffle" is UI-only; mark flag but keep current between value for display
    if (val === ("shuffle" as string)) return; // guard — shuffle handled separately
    saveTransConfig({ ...transConfig, between: val, shuffleBetween: false });
  }

  function handleToggleShuffle() {
    saveTransConfig({ ...transConfig, shuffleBetween: !transConfig.shuffleBetween });
  }

  function handleSelectOpening(val: TransitionValue) {
    saveTransConfig({ ...transConfig, opening: val });
  }

  function handleSelectClosing(val: TransitionValue) {
    saveTransConfig({ ...transConfig, closing: val });
  }

  // Surprise me for opening/closing: resolves immediately to a random concrete value
  function handleSurpriseSlot(slot: "opening" | "closing") {
    const pick = SHUFFLE_POOL[Math.floor(Math.random() * SHUFFLE_POOL.length)];
    saveTransConfig({ ...transConfig, [slot]: pick });
  }

  // Optimistic local patch — keeps the right panel in sync without a refetch.
  function patchClip(clipId: string, patch: Partial<Clip>) {
    setClips((prev) => {
      const next = prev.map((c) => (c.id === clipId ? { ...c, ...patch } : c));
      if (projectId) projectCache.set(projectId, { name: projectName, clips: next });
      return next;
    });
  }

  // Reorder film clips (drag-to-reorder on StickyFilmStrip). Merge the new in-film id order back
  // into the full clips array and renumber sort_order = full-array index (matches reorder_clips_cmd).
  // The local renumber is required because StickyFilmStrip sorts by sort_order, not array order.
  async function handleReorder(orderedInFilmIds: string[]) {
    const previous = clips;
    const orderSet = new Set(orderedInFilmIds);
    const byId = new Map(clips.map((c) => [c.id, c]));
    const reorderedFilm = orderedInFilmIds.map((id) => byId.get(id)!);
    let k = 0;
    const merged = clips.map((c) => (orderSet.has(c.id) ? reorderedFilm[k++] : c));
    const next = merged.map((c, i) => ({ ...c, sort_order: i }));
    setClips(next);
    if (projectId) projectCache.set(projectId, { name: projectName, clips: next });
    try {
      await invoke("reorder_clips_cmd", { clipIds: next.map((c) => c.id) });
    } catch (err) {
      console.error("[arrange] reorder failed, rolling back", err);
      setClips(previous);
      if (projectId) projectCache.set(projectId, { name: projectName, clips: previous });
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

  // Merge a partial zoom change into the clip's zoom_mode string and persist.
  function updateZoom(clip: Clip, patch: Partial<ZoomState>) {
    const next = { ...parseZoom(clip.zoom_mode), ...patch };
    saveReview(clip, { zoom_mode: buildZoomMode(next) });
  }

  // Save per-clip volume (percent 0–200 → float 0–2.0).
  // Note: video.volume is clamped to 1.0 by the browser; 150/200% preview sounds
  // same as 100% but the value is saved and FFmpeg applies the real boost on render.
  function saveVolume(clip: Clip, percent: number) {
    const volume = Math.max(0, Math.min(200, Math.round(percent))) / 100;
    patchClip(clip.id, { clip_volume: volume });
    if (soundVideoRef.current) soundVideoRef.current.volume = Math.min(1.0, volume);
    const existing = volumeDebounceRef.current.get(clip.id);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(async () => {
      try {
        await invoke("update_clip_volume_cmd", { clipId: clip.id, clipVolume: volume });
      } catch (err) {
        console.error("[arrange] update_clip_volume_cmd failed", err);
      }
      volumeDebounceRef.current.delete(clip.id);
    }, 300);
    volumeDebounceRef.current.set(clip.id, timer);
  }

  function handleFocalClick(clip: Clip, e: React.MouseEvent<HTMLDivElement>) {
    const el = focalImgRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    saveReview(clip, { focal_x: x, focal_y: y });
  }

  function getFocalFromMouse(e: MouseEvent): { x: number; y: number } | null {
    const el = videoBoxRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }

  const DRAG_THRESHOLD_PX = 4;

  function handleVideoMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const clip = selectedClipRef.current;
    if (!clip) return;
    // Arm a pending gesture. Don't move the focal point yet — wait to see whether
    // this is a click (toggle play) or a drag (set focal) past the threshold.
    // A click always toggles play; a drag only sets focal when zoom is active.
    e.preventDefault();
    focalDownRef.current = { x: e.clientX, y: e.clientY };
    focalMovedRef.current = false;
    isDraggingFocalRef.current = false;
  }

  // Window-level gesture tracking for the big preview — runs once, reads from refs.
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const start = focalDownRef.current;
      if (!start) return;
      const clip = selectedClipRef.current;
      if (!clip || !clip.zoom_mode) return; // no focal to drag when zoom is off
      // Promote to a focal drag only once movement exceeds the threshold.
      if (!focalMovedRef.current) {
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        focalMovedRef.current = true;
        isDraggingFocalRef.current = true;
      }
      const pos = getFocalFromMouse(e);
      if (pos) patchClip(clip.id, { focal_x: pos.x, focal_y: pos.y });
    }
    function onUp(e: MouseEvent) {
      const start = focalDownRef.current;
      if (!start) return;
      focalDownRef.current = null;
      const clip = selectedClipRef.current;
      if (focalMovedRef.current) {
        // It was a drag — persist the focal point.
        isDraggingFocalRef.current = false;
        const pos = getFocalFromMouse(e);
        if (clip && pos) saveReview(clip, { focal_x: pos.x, focal_y: pos.y });
      } else {
        // No movement — treat as a click on the preview: toggle play/pause.
        togglePlay();
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Prev/Next clip navigation helpers.
  const selectedIndex = selectedClipId ? inFilm.findIndex((c) => c.id === selectedClipId) : -1;

  // Render-time (telescoped) overlap per cut — shared by the playhead + the filmstrip ruler.
  const xfadeOverlapMs = clampedXfadeMs(inFilm, transConfig);

  // Render-time position of the current clip playback — drives the StickyFilmStrip playhead.
  // Telescoped via the shared filmTimeAtClipStart so the playhead matches the ruler (#71).
  const filmPlayheadMs = selectedIndex >= 0 && selectedClip
    ? filmTimeAtClipStart(inFilm, selectedIndex, xfadeOverlapMs, cardsBeforeClip)
      + Math.max(0, currentMs - (selectedClip.in_ms ?? 0))
    : undefined;

  const prevClip = useCallback(() => {
    if (selectedIndex > 0) setSelectedClipId(inFilm[selectedIndex - 1].id);
  }, [selectedIndex, inFilm]);

  const nextClip = useCallback(() => {
    if (selectedIndex < inFilm.length - 1) setSelectedClipId(inFilm[selectedIndex + 1].id);
  }, [selectedIndex, inFilm]);

  // Sync the gradual-zoom preview to the current playhead via the Web Animations
  // API (U3d). The WAAPI transform animation runs on the GPU compositor (smooth
  // 60fps) — unlike the old rc-kenburns CSS keyframe, which read var(--kb-*) and
  // was therefore stuck on the main thread (choppy). We position the clock with
  // anim.currentTime (precise seek, no reflow-restart hack) and freeze/continue
  // it with anim.pause() / anim.play().
  // Called on discrete events ONLY (play / pause / seek / clip-end / select) —
  // never per timeupdate tick (that would re-fire the animation ~4Hz = steppy).
  function syncZoomToPlayhead(elapsedSec: number, playing: boolean) {
    const wrap = videoWrapRef.current;
    if (!wrap) return;
    const clip = selectedClipRef.current;
    const z = parseZoom(clip?.zoom_mode ?? null);
    if (z.style !== "gradual") {
      // Cancel any leftover Ken Burns animation, then null the ref BEFORE React's
      // fixed/off inline transform takes effect — cancel() clears the fill:both
      // frozen end-state so the inline style is not fighting a held animation.
      // Do NOT touch transformOrigin — fixed-zoom origin is React-managed via the
      // JSX style prop.
      kbAnimRef.current?.cancel();
      kbAnimRef.current = null;
      return;
    }
    const scale = parseFloat(z.kbRatio) || 1.5;
    const from = z.kbDir === "in" ? 1 : scale;
    const to   = z.kbDir === "in" ? scale : 1;
    const focalX = (clip?.focal_x ?? 0.5) * 100;
    const focalY = (clip?.focal_y ?? 0.5) * 100;
    // transformOrigin is not animated; set it on the element (works alongside a
    // WAAPI transform animation).
    wrap.style.transformOrigin = `${focalX}% ${focalY}%`;
    // Match the render timing: trimmed-duration x speed-fraction.
    const durMs = kbPreviewDurationSec(clip) * 1000;
    const elapsedMs = Math.min(Math.max(elapsedSec * 1000, 0), durMs);
    // Cancel first, then create — never let two WAAPI animations run on the same
    // element. fill:"both" parks the zoom on its end frame at clip-end; cancel()
    // on the next clip switch clears that frozen state before re-seeding.
    kbAnimRef.current?.cancel();
    const anim = wrap.animate(
      [{ transform: `scale(${from})` }, { transform: `scale(${to})` }],
      { duration: durMs, easing: "ease-in-out", fill: "both", iterations: 1 },
    );
    kbAnimRef.current = anim;
    anim.currentTime = elapsedMs;
    // Only play() when animation hasn't finished. Calling play() on a WAAPI
    // animation whose currentTime >= duration resets it to 0 per spec — that's
    // what caused zoom to snap back to scale(1) when resuming after the zoom
    // animation had already completed (e.g. Fast speed, paused past the zoom end).
    if (playing && elapsedMs < durMs) anim.play(); else anim.pause();
  }

  // Playback controls
  function togglePlay() {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      const inMs = selectedClipRef.current?.in_ms ?? 0;
      const outMs = selectedClipRef.current?.out_ms ?? (video.duration * 1000);
      if (video.currentTime * 1000 >= outMs) {
        video.currentTime = inMs / 1000;
        setCurrentMs(inMs);
      }
      video.play().catch(() => {});
      setIsPlaying(true);
      // Run the zoom from the current playhead alongside the clip.
      const inMs2 = selectedClipRef.current?.in_ms ?? 0;
      syncZoomToPlayhead(video.currentTime - inMs2 / 1000, true);
    } else {
      video.pause();
      setIsPlaying(false);
      // Hold the zoom at the current scale.
      const inMs2 = selectedClipRef.current?.in_ms ?? 0;
      syncZoomToPlayhead(video.currentTime - inMs2 / 1000, false);
    }
  }

  function handleTimeUpdate() {
    const video = videoRef.current;
    if (!video) return;
    const ms = video.currentTime * 1000;
    const outMs = selectedClipRef.current?.out_ms ?? (video.duration * 1000);
    if (ms >= outMs) {
      video.pause();
      video.currentTime = outMs / 1000;
      setIsPlaying(false);
      setCurrentMs(outMs);
      // Park the zoom at its end frame: stop FIRST (above), THEN sync with
      // playing=false explicitly — never pass isPlayingRef here (it may still
      // read true at clip-end and would re-arm the animation as "running").
      const inMs = selectedClipRef.current?.in_ms ?? 0;
      syncZoomToPlayhead((outMs - inMs) / 1000, false);
      return;
    }
    // TRAP: do NOT call syncZoomToPlayhead here — per-tick (~4Hz) re-sync causes
    // steppy zoom; sync only on play/pause/seek/clip-end.
    setCurrentMs(ms);
  }

  function handleLoadedMetadata() {
    const video = videoRef.current;
    if (!video) return;
    setDurationMs(video.duration * 1000);
    const inMs = selectedClipRef.current?.in_ms ?? 0;
    video.currentTime = inMs / 1000;
    setCurrentMs(inMs);
  }

  function handleVideoEnded() {
    setIsPlaying(false);
  }

  function handleScrubberChange(e: React.ChangeEvent<HTMLInputElement>) {
    const ms = parseFloat(e.target.value);
    setCurrentMs(ms);
    if (videoRef.current) videoRef.current.currentTime = ms / 1000;
    // Jump the zoom to this playhead position.
    const inMs = selectedClipRef.current?.in_ms ?? 0;
    syncZoomToPlayhead((ms - inMs) / 1000, isPlayingRef.current);
  }

  // Sound tab playback handlers (parallel to zoom tab handlers above)
  function soundTogglePlay() {
    const video = soundVideoRef.current;
    if (!video) return;
    if (video.paused) {
      const inMs = selectedClipRef.current?.in_ms ?? 0;
      const outMs = selectedClipRef.current?.out_ms ?? (video.duration * 1000);
      if (video.currentTime * 1000 >= outMs) {
        video.currentTime = inMs / 1000;
        setSoundCurrentMs(inMs);
      }
      video.play().catch(() => {});
      setSoundIsPlaying(true);
    } else {
      video.pause();
      setSoundIsPlaying(false);
    }
  }

  function soundHandleTimeUpdate() {
    const video = soundVideoRef.current;
    if (!video) return;
    const ms = video.currentTime * 1000;
    const outMs = selectedClipRef.current?.out_ms ?? (video.duration * 1000);
    if (ms >= outMs) {
      video.pause();
      video.currentTime = outMs / 1000;
      setSoundIsPlaying(false);
      setSoundCurrentMs(outMs);
      return;
    }
    setSoundCurrentMs(ms);
  }

  function soundHandleLoadedMetadata() {
    const video = soundVideoRef.current;
    if (!video) return;
    setSoundDurationMs(video.duration * 1000);
    const inMs = selectedClipRef.current?.in_ms ?? 0;
    video.currentTime = inMs / 1000;
    setSoundCurrentMs(inMs);
    video.volume = Math.min(1.0, selectedClipRef.current?.clip_volume ?? 1.0);
  }

  function soundHandleScrubberChange(e: React.ChangeEvent<HTMLInputElement>) {
    const ms = parseFloat(e.target.value);
    setSoundCurrentMs(ms);
    if (soundVideoRef.current) soundVideoRef.current.currentTime = ms / 1000;
  }

  function formatTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  // ── Cards tab (#149) ──────────────────────────────────────────────────────
  // Just switches mode -- newCardDraft is untouched, so whatever was being typed
  // before a detour into editing an existing card is still there (confirmed live:
  // this used to reset the draft on every switch back to "New card").
  function handleNewCard() {
    setSelectedCardId(null);
  }

  // Persists the project's "last custom colour" whenever the native OS picker is used
  // (never for a black/white preset click -- only genuine custom picks are remembered).
  function handleCustomColorPick(hex: string) {
    updateComposedField({ color: hex }, false);
    setLastCustomColor(hex);
    if (projectId) setRenderPref(CARD_LAST_COLOR_KEY(projectId), hex);
  }

  // Clicking a card tile in the filmstrip selects it -- the form (via the derived
  // `composed` const above) then reads straight from placedCards, no copy needed.
  function handleSelectCard(cardId: string) {
    setSelectedCardId(cardId);
  }

  // Updates whatever the form currently shows: the persistent new-card draft when
  // composing, or the selected placed card when editing -- instantly for swatch/
  // animation picks, debounced for text fields.
  function updateComposedField(patch: Partial<ComposedCard>, debounce: boolean) {
    if (selectedCardId === null) {
      setNewCardDraft((prev) => ({ ...prev, ...patch }));
      return;
    }
    const cardId = selectedCardId;
    const apply = () => mutateCards((prev) => prev.map((c) => (c.id === cardId ? { ...c, ...patch } : c)));
    if (!debounce) { apply(); return; }
    if (cardsDebounceRef.current) clearTimeout(cardsDebounceRef.current);
    cardsDebounceRef.current = setTimeout(apply, 300);
  }

  // Core placement, shared by drag-drop and "+ Add to film". Always creates a NEW
  // card from the current draft -- this never repositions an already-placed card
  // (dragging while editing an existing one is disabled below); reposition-after-
  // placement is explicitly out of scope for #149.
  function placeComposedCard(beforeClipId: string | null) {
    const text = newCardDraft.text.trim();
    if (text === "") return;
    const card: PlacedCard = { id: crypto.randomUUID(), ...newCardDraft, text, beforeClipId };
    mutateCards((prev) => [...prev, card]);
    setNewCardDraft(blankComposedCard(lastCustomColor ?? undefined));
  }

  function handleDropCard(beforeClipId: string | null) {
    placeComposedCard(beforeClipId);
  }

  function handleAddToFilm() {
    placeComposedCard(null);
  }

  function handleDeleteCard(cardId: string) {
    mutateCards((prev) => prev.filter((c) => c.id !== cardId));
    setSelectedCardId(null);
  }

  function handleCardPreviewDragStart(e: React.DragEvent<HTMLDivElement>) {
    e.dataTransfer.setData("application/x-rushcut-card", "1");
    e.dataTransfer.effectAllowed = "copy";
  }

  return (
    <EditorShell
      projectId={projectId ?? ""}
      projectName={projectName}
      clipCount={clipCount}
      totalMs={totalMs}
      activeTab="arrange"
      configured={configured}
      transitionValue={transConfig.shuffleBetween ? "shuffle" : transConfig.between}
      openingTransition={transConfig.opening}
      closingTransition={transConfig.closing}
      soundMood={soundMoodVal}
      timelineHud={
        <StickyFilmStrip
          clips={clips}
          projectId={projectId!}
          activeId={tab === "zoom" || tab === "sound" ? selectedClipId : null}
          onSelectClip={tab === "zoom" || tab === "sound" ? setSelectedClipId : undefined}
          onReorder={handleReorder}
          playheadMs={tab === "zoom" ? filmPlayheadMs : undefined}
          xfadeOverlapMs={xfadeOverlapMs}
          cards={cardsForStrip}
          activeCardId={tab === "cards" ? selectedCardId : null}
          onSelectCard={tab === "cards" ? handleSelectCard : undefined}
          onDropCard={tab === "cards" ? handleDropCard : undefined}
        />
      }
      timelineGutter={
        tab === "cards" && selectedCardId !== null ? (
          <div className="flex justify-center pt-2">
            <button
              type="button"
              onClick={() => handleDeleteCard(selectedCardId)}
              className="w-10 h-10 rounded-full flex items-center justify-center border border-red-400/60 text-red-400 hover:bg-red-400/10 hover:border-red-400 transition-all duration-200"
              title="Delete this card"
              aria-label="Delete this card"
            >
              <Trash2 size={18} />
            </button>
          </div>
        ) : null
      }
    >
      <div className="flex flex-col flex-1 min-w-0">
        {/* In-screen tab bar — centred */}
        <div className="flex items-center justify-center gap-2 px-6 pt-3 pb-3 border-b border-white/10 flex-shrink-0">
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

        {/* ── Zoom tab — kept mounted (hidden not unmounted) so video never reloads on tab switch */}
        <div className={tab === "zoom" ? "flex flex-1 min-h-0" : "hidden"}>

            {/* Left clip rail */}
            <div className="w-40 flex-shrink-0 border-r border-white/10 overflow-y-auto bg-[#0a0a0a] p-2">
              <p className="text-xs text-[#a3a3a3] px-1 pb-2">clips</p>
              <div className="flex flex-col gap-1.5">
                {inFilm.map((clip, idx) => {
                  const isActive = clip.id === selectedClipId;
                  const trimmedMs = Math.max(0, (clip.out_ms ?? clip.duration_ms) - (clip.in_ms ?? 0));
                  return (
                    <button
                      key={clip.id}
                      type="button"
                      data-testid={`arrange-rail-clip-${clip.id}`}
                      onClick={() => setSelectedClipId(clip.id)}
                      className={`relative rounded-md overflow-hidden border-2 transition-all duration-200 focus:outline-none ${
                        isActive
                          ? "border-[#FF8A65]"
                          : "border-[#99B3FF]/25 hover:border-[#99B3FF]/50"
                      }`}
                      style={{ aspectRatio: "16/9", background: "#111" }}
                    >
                      {clip.thumbnail_data ? (
                        <img
                          src={clip.thumbnail_data}
                          alt={clip.filename}
                          className="w-full h-full object-cover pointer-events-none"
                        />
                      ) : (
                        <div className="w-full h-full bg-white/5" />
                      )}
                      {/* Clip number badge — top-left */}
                      <div className="absolute top-0.5 left-0.5 min-w-[16px] h-4 px-0.5 rounded bg-[#99B3FF] flex items-center justify-center pointer-events-none">
                        <span className="text-[9px] text-[#0a0a0a] font-bold leading-none">{idx + 1}</span>
                      </div>
                      {/* Duration + zoom badge row — bottom */}
                      <div className="absolute bottom-0 inset-x-0 flex items-end justify-between bg-gradient-to-t from-black/80 to-transparent pt-3 px-1 pb-0.5 pointer-events-none">
                        <span className="text-[9px] text-white font-mono drop-shadow-sm">{fmtMs(trimmedMs)}</span>
                        {clip.zoom_mode != null && (
                          <div
                            className="w-3.5 h-3.5 rounded-sm bg-[#22c55e] flex items-center justify-center"
                            title={zoomLabel(clip.zoom_mode)}
                          >
                            <span className="text-[8px] font-bold text-[#0a0a0a] leading-none select-none">Z</span>
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}
                {inFilm.length === 0 && (
                  <p className="text-xs text-[#a3a3a3] italic px-1">No clips in film</p>
                )}
              </div>
            </div>

            {/* Centre — preview + playback */}
            <div className="flex-1 min-w-0 flex flex-col min-h-0 px-4 py-4 gap-3">
              {/* Prev | video | Next row — fills available height */}
              <div className="flex gap-4 flex-1 min-h-0">
                {/* Prev */}
                <button
                  type="button"
                  data-testid="arrange-prev"
                  onClick={prevClip}
                  disabled={selectedIndex <= 0}
                  className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft size={14} />
                  Prev
                </button>

                {/* Video wrapper — stretches to row height, then 16:9 box centered inside */}
                <div className="flex-1 min-w-0 self-stretch flex items-center justify-center overflow-hidden">
                  {(() => {
                    const zoomState = parseZoom(selectedClip?.zoom_mode ?? null);
                    const fixedScale = zoomState.style === "fixed"
                      ? (ZOOM_SCALE[zoomState.fixedRatio] ?? 1) : 1;
                    const focalX = (selectedClip?.focal_x ?? 0.5) * 100;
                    const focalY = (selectedClip?.focal_y ?? 0.5) * 100;
                    return (
                      <div
                        ref={videoBoxRef}
                        className="relative bg-black border border-white/10 rounded-lg overflow-hidden"
                        style={{
                          height: "100%",
                          aspectRatio: "16/9",
                          maxWidth: "100%",
                          // pointer (finger) for all interactive states — hint text below
                          // the scrubber tells the user about drag-to-set-focal.
                          cursor: selectedClip ? "pointer" : "default",
                        }}
                        onMouseDown={handleVideoMouseDown}
                      >
                        {/* Wrapper receives the gradual zoom CSS animation so the
                            video decoder and compositor run on separate layers —
                            avoids choppy playback when scaling. */}
                        <div
                          ref={videoWrapRef}
                          className="absolute inset-0"
                          style={{
                            // Write transition FIRST so it is "none" before
                            // React removes the inline transform below — prevents
                            // a 0.3s CSS transition flash to scale(1) during the
                            // one-frame gap before the WAAPI effect fires (U3d).
                            transition: zoomState.style === "fixed" ? "transform 0.3s ease" : "none",
                            // Fixed zoom is applied here as a static scale so it
                            // shares the same layer isolation benefit.
                            transform: zoomState.style === "fixed" && fixedScale > 1
                              ? `scale(${fixedScale})` : undefined,
                            transformOrigin: `${focalX}% ${focalY}%`,
                          }}
                        >
                          <video
                            ref={videoRef}
                            className="absolute inset-0 w-full h-full object-cover"
                            onTimeUpdate={handleTimeUpdate}
                            onLoadedMetadata={handleLoadedMetadata}
                            onEnded={handleVideoEnded}
                            onError={() => {
                              const video = videoRef.current;
                              if (!video || !selectedClip) return;
                              if (selectedClip.proxy_path) {
                                video.src = convertFileSrc(selectedClip.local_path);
                                video.load();
                              }
                            }}
                          />
                        </div>
                        {/* Destination crop box — zoom-in only, paused only.
                            Drawn at videoBox level (outside the animated videoWrapRef)
                            so the CSS transform does not affect its position.
                            Always shows the absolute final crop (end-state scale),
                            not the remaining crop from current playhead progress.
                            Box math: visible crop = 1/scale of the source frame,
                            centred on the focal point and clamped to [0, 100-size]. */}
                        {selectedClip && zoomState.style === "gradual" && zoomState.kbDir === "in" && !isPlaying && (() => {
                          const kbScale    = parseFloat(zoomState.kbRatio) || 1.5;
                          // Normalise against zoom animation duration (not full clip duration)
                          // so the box disappears once the Ken Burns animation completes.
                          // kbPreviewDurationSec already bakes in the speed fraction
                          // (slow=1.0, med=0.75, fast=0.5), matching the CSS animation exactly.
                          const inMs       = selectedClip.in_ms ?? 0;
                          const animDurSec = kbPreviewDurationSec(selectedClip);
                          if (animDurSec <= 0) return null;          // guard divide-by-zero
                          const elapsedSec = (currentMs - inMs) / 1000;
                          const t_raw      = elapsedSec / animDurSec;
                          if (t_raw >= 1) return null;               // zoom complete — box gone
                          const sCur    = 1 + (kbScale - 1) * approxKenBurnsProgress(t_raw);
                          // Destination box in source-frame space (what the final crop covers)
                          const cropPct  = 100 / kbScale;
                          const srcLeft  = Math.max(0, Math.min(focalX - cropPct / 2, 100 - cropPct));
                          const srcTop   = Math.max(0, Math.min(focalY - cropPct / 2, 100 - cropPct));
                          // Project to screen space via the same CSS transform the animation uses.
                          // At t=0: sCur=1, screen coords = source coords (full destination box).
                          // At t=1: sCur=kbScale, box fills the screen (zoom complete).
                          const screenW    = cropPct * sCur;
                          const screenH    = cropPct * sCur;
                          const screenLeft = focalX + (srcLeft - focalX) * sCur;
                          const screenTop  = focalY + (srcTop  - focalY) * sCur;
                          return (
                            <div
                              className="absolute border-2 border-[#FF8A65] rounded-sm pointer-events-none"
                              style={{
                                left:      `${screenLeft}%`,
                                top:       `${screenTop}%`,
                                width:     `${screenW}%`,
                                height:    `${screenH}%`,
                                boxShadow: "0 0 0 1px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(0,0,0,0.6)",
                              }}
                            />
                          );
                        })()}
                        {!selectedClip && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <p className="text-sm text-[#a3a3a3] italic">Select a clip from the left to adjust</p>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>

                {/* Next */}
                <button
                  type="button"
                  data-testid="arrange-next"
                  onClick={nextClip}
                  disabled={selectedIndex < 0 || selectedIndex >= inFilm.length - 1}
                  className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next
                  <ChevronRight size={14} />
                </button>
              </div>

              {/* Filename + resolution */}
              {selectedClip && (
                <p
                  className="text-sm text-[#a3a3a3] truncate"
                  data-testid="arrange-selected-filename"
                >
                  {selectedClip.filename}
                  {selectedClip.width && selectedClip.height
                    ? ` · ${selectedClip.width}x${selectedClip.height}`
                    : ""}
                </p>
              )}

              {/* Play + scrubber */}
              {selectedClip && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    data-testid="arrange-play-btn"
                    onClick={togglePlay}
                    className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-full bg-[#FF8A65] text-white hover:bg-[#ff9e7a] transition-all duration-200"
                  >
                    {isPlaying
                      ? <Pause size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />
                      : <Play  size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />}
                  </button>
                  {(() => {
                    const clipInMs = selectedClip.in_ms ?? 0;
                    const clipOutMs = selectedClip.out_ms ?? durationMs;
                    const trimmedMs = Math.max(0, clipOutMs - clipInMs);
                    return (
                      <>
                        <input
                          type="range"
                          min={clipInMs}
                          max={clipOutMs || clipInMs + 1}
                          step={100}
                          value={currentMs}
                          onChange={handleScrubberChange}
                          className="flex-1 accent-[#FF8A65] h-1 cursor-pointer"
                          data-testid="arrange-scrubber"
                        />
                        <span className="text-xs text-[#a3a3a3] flex-shrink-0 tabular-nums w-20 text-right">
                          {formatTime(Math.max(0, currentMs - clipInMs))} / {formatTime(trimmedMs)}
                        </span>
                      </>
                    );
                  })()}
                </div>
              )}
              {/* Hint — only when zoom is active; tells users about drag-to-focal */}
              {selectedClip && parseZoom(selectedClip.zoom_mode).style !== "off" && (
                <p className="text-xs text-[#a3a3a3] italic text-right pr-1 -mt-1">
                  Drag preview to set focal point
                </p>
              )}
            </div>

            {/* Right panel — zoom + focal */}
            <aside className="w-56 flex-shrink-0 border-l border-white/10 overflow-y-auto p-4 bg-[#0a0a0a]">
              {!selectedClip ? (
                <p className="text-sm text-[#a3a3a3] italic">Select a clip from the left to adjust</p>
              ) : (
                <div className="space-y-5">
                  {(() => {
                    const zoomState = parseZoom(selectedClip.zoom_mode);
                    return (
                      <>
                        {/* Style — Off / Fixed / Gradual */}
                        <div className="space-y-2">
                          <p className="text-sm font-medium text-[#e5e5e5]">Zoom</p>
                          <div className="flex flex-wrap gap-2">
                            {ZOOM_STYLES.map(({ value, label }) => (
                              <button
                                key={value}
                                type="button"
                                data-testid={`chip-zoom-style-${value}`}
                                onClick={() => updateZoom(selectedClip, { style: value })}
                                className={zoomChipClass(zoomState.style === value)}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Fixed — amount */}
                        {zoomState.style === "fixed" && (
                          <div className="space-y-2">
                            <p className="text-sm font-medium text-[#e5e5e5]">Amount</p>
                            <div className="flex flex-wrap gap-2">
                              {FIXED_AMOUNTS.map(({ value, label }) => (
                                <button
                                  key={value}
                                  type="button"
                                  data-testid={`chip-zoom-amount-${value}`}
                                  onClick={() => updateZoom(selectedClip, { fixedRatio: value })}
                                  className={zoomChipClass(zoomState.fixedRatio === value)}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Gradual — direction / amount / speed */}
                        {zoomState.style === "gradual" && (
                          <>
                            <div className="space-y-2">
                              <p className="text-sm font-medium text-[#e5e5e5]">Direction</p>
                              <div className="flex flex-wrap gap-2">
                                {KB_DIRECTIONS.map(({ value, label }) => (
                                  <button
                                    key={value}
                                    type="button"
                                    data-testid={`chip-zoom-dir-${value}`}
                                    onClick={() => updateZoom(selectedClip, { kbDir: value })}
                                    className={zoomChipClass(zoomState.kbDir === value)}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className="space-y-2">
                              <p className="text-sm font-medium text-[#e5e5e5]">Amount</p>
                              <div className="flex flex-wrap gap-2">
                                {KB_AMOUNTS.map(({ value, label }) => (
                                  <button
                                    key={value}
                                    type="button"
                                    data-testid={`chip-zoom-kb-${value}`}
                                    onClick={() => updateZoom(selectedClip, { kbRatio: value })}
                                    className={zoomChipClass(zoomState.kbRatio === value)}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <div className="space-y-2">
                              <p className="text-sm font-medium text-[#e5e5e5]">Speed</p>
                              <div className="flex flex-wrap gap-2">
                                {KB_SPEEDS.map(({ value, label, sub }) => (
                                  <button
                                    key={value}
                                    type="button"
                                    data-testid={`chip-zoom-speed-${value}`}
                                    onClick={() => updateZoom(selectedClip, { kbSpeed: value })}
                                    className={zoomChipClass(zoomState.kbSpeed === value)}
                                    title={sub}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                              <p className="text-xs text-[#a3a3a3]">
                                {KB_SPEEDS.find(s => s.value === zoomState.kbSpeed)?.sub ?? ""}
                              </p>
                            </div>
                            {/* Previewer-only judder note (60fps compositor vs 30fps source
                                content) -- inherent, doesn't reach the render. See
                                docs/LEARNINGS.md "WebView2 -- gradual zoom preview judder". */}
                            <p className="text-xs text-[#a3a3a3] italic">
                              Preview may look slightly stuttery during the zoom -- final render is unaffected.
                            </p>
                          </>
                        )}

                        {/* Focal point — when any zoom is active */}
                        {zoomState.style !== "off" && (
                          <div className="space-y-2 pt-4 border-t border-white/10">
                            <p className="text-sm font-medium text-[#e5e5e5]">Focal point</p>
                            <div
                              ref={focalImgRef}
                              onClick={(e) => handleFocalClick(selectedClip, e)}
                              className="relative rounded-md overflow-hidden bg-[#1a1a1a] border border-white/15 cursor-crosshair"
                              style={{ aspectRatio: "16/9" }}
                            >
                              {/* Static neutral target — the coordinate is what matters,
                                  not the frame (the big preview shows the real frame).
                                  Faint centre guides give a positional reference. */}
                              <div className="absolute inset-0 pointer-events-none">
                                <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-white/10" />
                                <div className="absolute top-1/2 left-0 right-0 h-px -translate-y-1/2 bg-white/10" />
                              </div>
                              {selectedClip.focal_x !== null && selectedClip.focal_y !== null && (
                                <div
                                  className="absolute w-4 h-4 rounded-full border-2 border-[#FF8A65] bg-[#FF8A65]/30 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
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
                            {zoomState.style === "gradual" && (
                              <p className="text-sm text-[#a3a3a3]">RushCut zooms toward this point.</p>
                            )}
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}
            </aside>
          </div>

        {/* ── Transitions tab ─────────────────────────────────────── */}
        {tab === "transitions" && (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
              <div>
                <h1 className="text-3xl font-semibold text-[#FF8A65]">Transitions</h1>
                <p className="text-base text-[#a3a3a3] mt-1">
                  How should RushCut cut between each clip in your film?
                </p>
              </div>

              {/* ── Between clips — left rail + centre preview ─────── */}
              {(() => {
                const fc = clips.filter(c => c.include === 1 && c.thumbnail_data);
                const tA = fc[0]?.thumbnail_data ?? null;
                const tB = (fc.length > 1 ? fc[fc.length - 1] : fc[0])?.thumbnail_data ?? null;
                const bgStyle = (t: string | null, fallback: string) =>
                  t ? { backgroundImage: `url(${t})`, backgroundSize: "cover", backgroundPosition: "center" }
                    : { backgroundColor: fallback };
                // The value shown in the centre preview:
                // when shuffle is on, preview the last-selected between value (or crossfade as default)
                const previewVal = transConfig.shuffleBetween
                  ? (transConfig.between !== "none" ? transConfig.between : "crossfade")
                  : transConfig.between;
                return (
                  <div className="border border-white/15 rounded-lg p-6 space-y-4">
                    <p className="text-xl font-medium text-[#e5e5e5]">Between clips</p>
                    <div className="flex gap-6">
                      {/* Left rail — 5 type cards + Surprise me */}
                      <aside className="w-52 flex-shrink-0 flex flex-col gap-2">
                        {TRANSITIONS.map(({ value, label }) => {
                          const isActive = !transConfig.shuffleBetween && transConfig.between === value;
                          return (
                            <button
                              key={value}
                              type="button"
                              data-testid={`chip-transition-${value}`}
                              onClick={() => handleSelectBetween(value)}
                              className={`rc-trans-card w-full flex flex-row items-center gap-3 rounded-lg overflow-hidden border-2 transition-colors duration-200 focus:outline-none ${
                                isActive
                                  ? "rc-trans-card--selected border-[#99B3FF] bg-[#99B3FF]/5"
                                  : "border-white/20 hover:border-white/50"
                              }`}
                            >
                              {/* Mini preview thumbnail — only animates when this card is selected */}
                              <div className="relative w-16 h-10 bg-black flex-shrink-0 overflow-hidden">
                                <div
                                  className="rc-trans-preview-a absolute inset-0"
                                  style={{ animation: isActive ? ANIM_KEYS[value].a : "none", ...bgStyle(tA, "#1e3a4c") }}
                                />
                                <div
                                  className="rc-trans-preview-b absolute inset-0"
                                  style={{ animation: isActive ? ANIM_KEYS[value].b : "none", ...bgStyle(tB, "#2d1a2f") }}
                                />
                              </div>
                              <span className="text-sm font-medium text-[#e5e5e5] py-2 pr-2">{label}</span>
                            </button>
                          );
                        })}
                        {/* Shuffle card */}
                        <button
                          type="button"
                          data-testid="chip-transition-shuffle"
                          onClick={handleToggleShuffle}
                          className={`w-full flex flex-row items-center gap-3 rounded-lg border-2 transition-colors duration-200 focus:outline-none px-3 py-2 ${
                            transConfig.shuffleBetween
                              ? "border-[#99B3FF] bg-[#99B3FF]/5 text-[#99B3FF]"
                              : "border-white/20 hover:border-white/50 text-[#e5e5e5]"
                          }`}
                        >
                          <Shuffle size={16} className="flex-shrink-0" />
                          <span className="text-sm font-medium">Shuffle</span>
                        </button>
                      </aside>

                      {/* Centre preview — only animates when a real transition is selected */}
                      {(() => {
                        const shouldAnimate = transConfig.shuffleBetween || transConfig.between !== "none";
                        return (
                      <div className="flex-1 flex flex-col gap-3">
                        <div className="relative h-56 rounded-lg overflow-hidden border border-white/15 bg-black">
                          <div
                            className="rc-trans-preview-a absolute inset-0"
                            style={{ animation: shouldAnimate ? ANIM_KEYS[previewVal].a : "none", ...bgStyle(tA, "#1e3a4c") }}
                          />
                          <div
                            className="rc-trans-preview-b absolute inset-0"
                            style={{ animation: shouldAnimate ? ANIM_KEYS[previewVal].b : "none", ...bgStyle(tB, "#2d1a2f") }}
                          />
                        </div>
                        <div>
                          <p className="text-base font-medium text-[#e5e5e5]">
                            {transConfig.shuffleBetween
                              ? "Shuffle"
                              : (TRANSITIONS.find(t => t.value === transConfig.between)?.label ?? "None")}
                          </p>
                          <p className="text-sm text-[#a3a3a3]">
                            {transConfig.shuffleBetween
                              ? "A different transition will be picked at random for each cut."
                              : "Applied between every clip in your film."}
                          </p>
                        </div>
                      </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })()}

              {/* ── Opening transition ───────────────────────────── */}
              <div className="border border-white/15 rounded-lg p-6">
                <p className="text-xl font-medium text-[#e5e5e5] mb-1">Film opening</p>
                <p className="text-sm text-[#a3a3a3] mb-4">Fade in from black at the start of your film.</p>
                <div className="flex gap-2">
                  {OPEN_CLOSE_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      data-testid={`chip-opening-${value}`}
                      onClick={() => handleSelectOpening(value)}
                      className={`text-sm font-medium rounded-lg px-4 py-2 border-2 transition-colors duration-200 focus:outline-none ${
                        transConfig.opening === value
                          ? "border-[#99B3FF] bg-[#99B3FF]/5 text-[#99B3FF]"
                          : "border-white/20 hover:border-white/50 text-[#e5e5e5]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Closing transition ───────────────────────────── */}
              <div className="border border-white/15 rounded-lg p-6">
                <p className="text-xl font-medium text-[#e5e5e5] mb-1">Film closing</p>
                <p className="text-sm text-[#a3a3a3] mb-4">Fade out to black at the end of your film.</p>
                <div className="flex gap-2">
                  {OPEN_CLOSE_OPTIONS.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      data-testid={`chip-closing-${value}`}
                      onClick={() => handleSelectClosing(value)}
                      className={`text-sm font-medium rounded-lg px-4 py-2 border-2 transition-colors duration-200 focus:outline-none ${
                        transConfig.closing === value
                          ? "border-[#99B3FF] bg-[#99B3FF]/5 text-[#99B3FF]"
                          : "border-white/20 hover:border-white/50 text-[#e5e5e5]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <p className="text-sm text-[#a3a3a3]">
                All choices are saved automatically. Continue to Sound to choose music for your film.
              </p>
            </div>
          </div>
        )}

        {/* ── Cards tab (#149, revised after live user feedback) ─────
            Left rail + centre preview, mirroring the Transitions tab layout
            (DESIGN.md "Left-rail + centre-preview layout"). */}
        {tab === "cards" && (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="flex gap-6 max-w-5xl mx-auto items-start">

              {/* Left: New card / Edit card mode indicator. Peach (not the usual
                  #99B3FF chip blue) is a deliberate exception here — the user asked
                  for the compose-mode choice to read with the same visual weight as
                  the "Add to film" CTA, since it's the primary "what am I doing right
                  now" signal on this screen. See DESIGN.md. */}
              <aside className="w-40 flex-shrink-0 space-y-2">
                <button
                  type="button"
                  onClick={handleNewCard}
                  data-testid="btn-new-card"
                  className={`w-full text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium ${
                    selectedCardId === null
                      ? "border-[#FF8A65] text-[#FF8A65] bg-[#FF8A65]/10"
                      : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                  }`}
                >
                  New card
                </button>
                {/* Not independently clickable -- clicking a card tile in the filmstrip
                    already enters edit mode; this just reflects that state. */}
                <div
                  data-testid="indicator-edit-card"
                  className={`w-full text-sm rounded-md px-4 py-2 border font-medium text-center ${
                    selectedCardId !== null
                      ? "border-[#FF8A65] text-[#FF8A65] bg-[#FF8A65]/10"
                      : "border-white/15 text-[#555555]"
                  }`}
                >
                  Edit card
                </div>
                <p className="text-xs text-[#a3a3a3]">
                  {selectedCardId === null
                    ? "Composing a new card."
                    : "Editing the selected card -- click another card, or New card, to switch."}
                </p>
              </aside>

              {/* Centre: controls card + large animated preview */}
              <div className="flex-1 space-y-6">
                <div className="border border-white/15 rounded-lg p-6 space-y-5">
                  <div className="flex gap-6">
                    <div className="flex-1 space-y-4">
                      {/* Title */}
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-[#e5e5e5]">Title</p>
                        <input
                          type="text"
                          maxLength={60}
                          value={composed.text}
                          onChange={(e) => updateComposedField({ text: e.target.value }, true)}
                          placeholder="e.g. Day Two: The Coast"
                          className="w-full border border-white/15 rounded-md px-3 py-2 text-sm text-[#e5e5e5] bg-white/5 focus:border-white/40 focus:outline-none"
                        />
                        <p className="text-xs text-[#a3a3a3] text-right">{composed.text.length}/60</p>
                      </div>

                      {/* Subtitle */}
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-[#e5e5e5]">Subtitle</p>
                        <input
                          type="text"
                          maxLength={80}
                          value={composed.subtitle}
                          onChange={(e) => updateComposedField({ subtitle: e.target.value }, true)}
                          placeholder="Optional"
                          className="w-full border border-white/15 rounded-md px-3 py-2 text-sm text-[#e5e5e5] bg-white/5 focus:border-white/40 focus:outline-none"
                        />
                        <p className="text-xs text-[#a3a3a3] text-right">{composed.subtitle.length}/80</p>
                      </div>
                    </div>

                    {/* Background swatches -- black + white presets, a swatch that
                        remembers the project's last custom colour, and an always-
                        present "pick new" swatch opening the native OS colour picker
                        (<input type="color">, rendered natively by WebView2/Chromium
                        on Windows -- no Tauri dialog plugin needed). Revised after
                        live feedback: no peach preset (peach is UI chrome, not a
                        neutral card-colour default). */}
                    <div className="flex-shrink-0 space-y-2">
                      <p className="text-sm font-medium text-[#e5e5e5]">Background</p>
                      <div className="flex gap-3">
                        {CARD_PRESET_COLORS.map((hex) => (
                          <button
                            key={hex}
                            type="button"
                            onClick={() => updateComposedField({ color: hex }, false)}
                            style={{ background: hex }}
                            className={`w-8 h-8 rounded-full transition-all focus:outline-none ${
                              hex === "#0a0a0a" ? "border border-white/30" : ""
                            } ${
                              composed.color === hex
                                ? "ring-2 ring-[#FF8A65] ring-offset-2 ring-offset-[#0a0a0a]"
                                : ""
                            }`}
                            aria-label={hex}
                          />
                        ))}
                        {/* Fixed 3rd slot -- always reserved so the picker swatch never
                            shifts position once a custom colour exists (confirmed
                            confusing when this slot only appeared conditionally). Shows
                            a dashed empty placeholder until a custom colour is picked. */}
                        {lastCustomColor ? (
                          <button
                            type="button"
                            onClick={() => updateComposedField({ color: lastCustomColor }, false)}
                            style={{ background: lastCustomColor }}
                            className={`w-8 h-8 rounded-full border border-white/30 transition-all focus:outline-none ${
                              composed.color === lastCustomColor
                                ? "ring-2 ring-[#FF8A65] ring-offset-2 ring-offset-[#0a0a0a]"
                                : ""
                            }`}
                            aria-label="Last custom colour"
                            title="Last custom colour used on this project"
                          />
                        ) : (
                          <div
                            className="w-8 h-8 rounded-full border border-dashed border-white/20"
                            aria-hidden
                            title="Your last custom colour will appear here"
                          />
                        )}
                        <label
                          className={`relative w-8 h-8 rounded-full cursor-pointer overflow-hidden focus-within:outline-none ${
                            !CARD_PRESET_COLORS.includes(composed.color) && composed.color !== lastCustomColor
                              ? "ring-2 ring-[#FF8A65] ring-offset-2 ring-offset-[#0a0a0a]"
                              : ""
                          }`}
                          style={{ background: "conic-gradient(from 0deg, #FF8A65, #99B3FF, #22c55e, #FF8A65)" }}
                          title="Pick your own colour"
                        >
                          <input
                            type="color"
                            value={composed.color}
                            onChange={(e) => handleCustomColorPick(e.target.value)}
                            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                            aria-label="Pick your own colour"
                          />
                        </label>
                      </div>
                    </div>
                  </div>

                  {/* Animation -- horizontally scrollable chip row (#149 design
                      choice: extends cleanly when more animation types are added,
                      unlike stacked radio buttons). Also drives the live preview
                      animation below. Stored for forward-compat only -- no FFmpeg-
                      level card animation exists yet, see follow-up issue. */}
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-[#e5e5e5]">Animation</p>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {CARD_ANIMATIONS.map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => updateComposedField({ animation: value }, false)}
                          data-testid={`chip-card-anim-${value}`}
                          className={`flex-shrink-0 text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium ${
                            composed.animation === value
                              ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                              : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Large centred preview -- also the drag handle for placing the card
                    (#149 design choice). Only draggable while composing a brand-new
                    card: dragging an already-placed card is disabled, since
                    repositioning an existing card is out of scope for this issue.
                    Plays the chosen entrance animation on loop, mirroring the
                    Transitions tab's animated card-chip preview. */}
                <div className="flex flex-col items-center gap-2">
                  <p className="text-sm font-medium text-[#e5e5e5] self-start">Preview</p>
                  {(() => {
                    const textCol = cardTextColor(composed.color);
                    const subtextCol = textCol === "#0a0a0a" ? "rgba(10,10,10,0.6)" : "rgba(229,229,229,0.6)";
                    const draggableNow = selectedCardId === null && composed.text.trim() !== "";
                    return (
                      <div
                        draggable={draggableNow}
                        onDragStart={draggableNow ? handleCardPreviewDragStart : undefined}
                        data-testid="card-preview"
                        className={`w-full max-w-md aspect-video rounded-lg flex flex-col items-center justify-center gap-2 overflow-hidden border border-white/15 ${
                          draggableNow ? "cursor-grab active:cursor-grabbing" : ""
                        }`}
                        style={{ background: composed.color }}
                        title={draggableNow ? "Drag onto the timeline below to place this card" : undefined}
                      >
                        {composed.text ? (
                          <div
                            key={composed.animation}
                            className="flex flex-col items-center gap-2 px-6"
                            style={{ animation: CARD_ANIM_CSS[composed.animation] }}
                          >
                            <span className="font-semibold text-center" style={{ color: textCol, fontSize: "clamp(1rem, 3vw, 1.75rem)" }}>
                              {composed.text}
                            </span>
                            {composed.subtitle && (
                              <span className="text-center" style={{ color: subtextCol, fontSize: "clamp(0.75rem, 1.6vw, 1.1rem)" }}>
                                {composed.subtitle}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-sm" style={{ color: textCol === "#0a0a0a" ? "rgba(10,10,10,0.4)" : "rgba(229,229,229,0.4)" }}>
                            preview
                          </span>
                        )}
                      </div>
                    );
                  })()}
                </div>

              </div>

              {/* Right: non-drag fallback + discoverability hint -- only relevant
                  while composing a brand-new card; hidden entirely while editing an
                  already-placed one (there's nothing to add-to-film or drag). Kept
                  as its own column (not centred below the preview) so it doesn't
                  push the "click a card to edit" line out of view lower down. */}
              {selectedCardId === null && (
                <aside className="w-48 flex-shrink-0 space-y-3 pt-1">
                  <button
                    type="button"
                    onClick={handleAddToFilm}
                    disabled={composed.text.trim() === ""}
                    data-testid="btn-add-card-to-film"
                    className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 text-base disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    + Add to film
                  </button>
                  <p className="text-sm text-[#a3a3a3]">
                    Drag from preview to the timeline below to add the card exactly where you want it -- it snaps to the nearest cut.
                  </p>
                </aside>
              )}
            </div>

            <p className="text-sm text-[#a3a3a3] mt-4 max-w-5xl mx-auto">
              Click a card in the timeline below to edit or delete it.
            </p>
          </div>
        )}

        {/* ── Sound tab — per-clip volume (kept mounted, hidden not unmounted) ── */}
        <div className={tab === "sound" ? "flex flex-1 min-h-0" : "hidden"}>
          {/* Left clip rail — copy of zoom tab rail, intentionally not extracted */}
          <div className="w-40 flex-shrink-0 border-r border-white/10 overflow-y-auto bg-[#0a0a0a] p-2">
            <p className="text-xs text-[#a3a3a3] px-1 pb-2">clips</p>
            <div className="flex flex-col gap-1.5">
              {inFilm.map((clip, idx) => {
                const isActive = clip.id === selectedClipId;
                const trimmedMs = Math.max(0, (clip.out_ms ?? clip.duration_ms) - (clip.in_ms ?? 0));
                const vol = clip.clip_volume ?? 1.0;
                const volPct = Math.round(vol * 100);
                return (
                  <button
                    key={clip.id}
                    type="button"
                    data-testid={`sound-rail-clip-${clip.id}`}
                    onClick={() => setSelectedClipId(clip.id)}
                    className={`relative rounded-md overflow-hidden border-2 transition-all duration-200 focus:outline-none ${
                      isActive
                        ? "border-[#FF8A65]"
                        : "border-[#99B3FF]/25 hover:border-[#99B3FF]/50"
                    }`}
                    style={{ aspectRatio: "16/9", background: "#111" }}
                  >
                    {clip.thumbnail_data ? (
                      <img
                        src={clip.thumbnail_data}
                        alt={clip.filename}
                        className="w-full h-full object-cover pointer-events-none"
                      />
                    ) : (
                      <div className="w-full h-full bg-white/5" />
                    )}
                    {/* Clip number badge */}
                    <div className="absolute top-0.5 left-0.5 min-w-[16px] h-4 px-0.5 rounded bg-[#99B3FF] flex items-center justify-center pointer-events-none">
                      <span className="text-[9px] text-[#0a0a0a] font-bold leading-none">{idx + 1}</span>
                    </div>
                    {/* Duration + volume label */}
                    <div className="absolute bottom-0 inset-x-0 flex items-end justify-between bg-gradient-to-t from-black/80 to-transparent pt-3 px-1 pb-0.5 pointer-events-none">
                      <span className="text-[9px] text-white font-mono drop-shadow-sm">{fmtMs(trimmedMs)}</span>
                      {vol !== 1.0 && (
                        <span className="text-[10px] font-bold font-mono drop-shadow-sm" style={{ color: vol === 0 ? "#f87171" : "#B794F4" }}>
                          {volPct}%
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
              {inFilm.length === 0 && (
                <p className="text-xs text-[#a3a3a3] italic px-1">No clips in film</p>
              )}
            </div>
          </div>

          {/* Centre — preview + playback */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0 px-4 py-4 gap-3">
            <div className="flex gap-4 flex-1 min-h-0">
              {/* Prev */}
              <button
                type="button"
                data-testid="sound-prev"
                onClick={prevClip}
                disabled={selectedIndex <= 0}
                className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={14} />
                Prev
              </button>

              {/* Video wrapper */}
              <div className="flex-1 min-w-0 self-stretch flex items-center justify-center overflow-hidden">
                <div
                  className="relative bg-black border border-white/10 rounded-lg overflow-hidden"
                  style={{ height: "100%", aspectRatio: "16/9", maxWidth: "100%", cursor: selectedClip ? "pointer" : "default" }}
                  onClick={soundTogglePlay}
                >
                  <video
                    ref={soundVideoRef}
                    className="absolute inset-0 w-full h-full object-cover"
                    onTimeUpdate={soundHandleTimeUpdate}
                    onLoadedMetadata={soundHandleLoadedMetadata}
                    onEnded={() => setSoundIsPlaying(false)}
                    onError={() => {
                      const video = soundVideoRef.current;
                      if (!video || !selectedClip) return;
                      if (selectedClip.proxy_path) {
                        video.src = convertFileSrc(selectedClip.local_path);
                        video.load();
                      }
                    }}
                  />
                  {!selectedClip && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <p className="text-sm text-[#a3a3a3] italic">Select a clip from the left to adjust</p>
                    </div>
                  )}
                </div>
              </div>

              {/* Next */}
              <button
                type="button"
                data-testid="sound-next"
                onClick={nextClip}
                disabled={selectedIndex < 0 || selectedIndex >= inFilm.length - 1}
                className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next
                <ChevronRight size={14} />
              </button>
            </div>

            {/* Filename */}
            {selectedClip && (
              <p className="text-sm text-[#a3a3a3] truncate" data-testid="sound-selected-filename">
                {selectedClip.filename}
                {selectedClip.width && selectedClip.height ? ` · ${selectedClip.width}x${selectedClip.height}` : ""}
              </p>
            )}

            {/* Play + scrubber */}
            {selectedClip && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  data-testid="sound-play-btn"
                  onClick={soundTogglePlay}
                  className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-full bg-[#FF8A65] text-white hover:bg-[#ff9e7a] transition-all duration-200"
                >
                  {soundIsPlaying
                    ? <Pause size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />
                    : <Play  size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />}
                </button>
                {(() => {
                  const clipInMs = selectedClip.in_ms ?? 0;
                  const clipOutMs = selectedClip.out_ms ?? soundDurationMs;
                  const trimmedMs = Math.max(0, clipOutMs - clipInMs);
                  return (
                    <>
                      <input
                        type="range"
                        min={clipInMs}
                        max={clipOutMs || clipInMs + 1}
                        step={100}
                        value={soundCurrentMs}
                        onChange={soundHandleScrubberChange}
                        className="flex-1 accent-[#FF8A65] h-1 cursor-pointer"
                        data-testid="sound-scrubber"
                      />
                      <span className="text-xs text-[#a3a3a3] flex-shrink-0 tabular-nums w-20 text-right">
                        {formatTime(Math.max(0, soundCurrentMs - clipInMs))} / {formatTime(trimmedMs)}
                      </span>
                    </>
                  );
                })()}
              </div>
            )}
          </div>

          {/* Right panel — volume chips */}
          <aside className="w-56 flex-shrink-0 border-l border-white/10 overflow-y-auto p-4 bg-[#0a0a0a]">
            {!selectedClip ? (
              <p className="text-sm text-[#a3a3a3] italic">Select a clip from the left to adjust</p>
            ) : (() => {
              const vol = selectedClip.clip_volume ?? 1.0;
              const volPct = Math.round(vol * 100);
              const isPreset = VOLUME_PRESETS.includes(volPct as typeof VOLUME_PRESETS[number]);
              const isCustomActive = !isPreset || showCustomInput;
              return (
                <div className="space-y-4">
                  <p className="text-sm font-medium text-[#e5e5e5]">Volume</p>
                  <div className="flex flex-wrap gap-2">
                    {VOLUME_PRESETS.map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        data-testid={`chip-vol-${pct}`}
                        onClick={() => {
                          saveVolume(selectedClip, pct);
                          setCustomVolInput(pct);
                          setShowCustomInput(false);
                        }}
                        className={`text-sm rounded-md px-3 py-1.5 border transition-all duration-200 font-medium ${
                          !isCustomActive && volPct === pct
                            ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                            : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                        }`}
                      >
                        {pct === 0 ? "Mute" : `${pct}%`}
                      </button>
                    ))}
                    <button
                      type="button"
                      data-testid="chip-vol-custom"
                      onClick={() => {
                        setCustomVolInput(volPct);
                        setShowCustomInput(true);
                      }}
                      className={`text-sm rounded-md px-3 py-1.5 border transition-all duration-200 font-medium ${
                        isCustomActive
                          ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                          : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                      }`}
                    >
                      Custom
                    </button>
                  </div>

                  {/* Custom numeric input — shown when no preset matches */}
                  {isCustomActive && (
                    <div className="flex items-center gap-2 mt-1">
                      <input
                        type="number"
                        min={0}
                        max={200}
                        step={1}
                        value={customVolInput}
                        data-testid="input-vol-custom"
                        onChange={(e) => {
                          const v = parseInt(e.target.value, 10);
                          if (!isNaN(v)) setCustomVolInput(v);
                        }}
                        onBlur={() => {
                          const clamped = Math.max(0, Math.min(200, customVolInput));
                          setCustomVolInput(clamped);
                          saveVolume(selectedClip, clamped);
                        }}
                        className="bg-transparent border border-white/35 rounded px-2 py-1 w-16 text-sm text-[#e5e5e5] focus:border-[#99B3FF] focus:outline-none tabular-nums"
                      />
                      <span className="text-sm text-[#a3a3a3]">%</span>
                    </div>
                  )}
                </div>
              );
            })()}
          </aside>
        </div>
      </div>
    </EditorShell>
  );
}

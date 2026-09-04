import { useState, useEffect, useRef } from "react";
import { Play, Pause } from "lucide-react";
import { useParams } from "react-router-dom";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { Clip, ProjectWithClips } from "@/types/project";
import { EditorShell } from "@/components/EditorShell";
import { StickyFilmStrip, cardTextColor, type PositionedCard } from "@/components/StickyFilmStrip";
import { useConfiguredTabs } from "@/hooks/useConfiguredTabs";
import { fmtMs } from "@/utils/fmtMs";
import { projectCache } from "@/utils/projectCache";
import { readTransitionConfig, readPlacedCards, orderedCardRuns } from "@/utils/buildJobConfig";
import type { PlacedCard } from "@/utils/buildJobConfig";
import { effectiveFilmMs, clampedXfadeMs, cardRegionMs, CARD_DUR_MS } from "@/utils/filmDuration";
import {
  buildSequence,
  advanceSequenceClock,
  reconcile,
  mediaToFilm,
  filmToMedia,
  itemToFilm,
  type Sequence,
  type ClockState,
} from "@/utils/sequenceClock";
import { getRenderPref, setRenderPref } from "@/utils/renderStore";

type MusicMood = "none" | "cinematic" | "upbeat" | "chill" | "electronic" | "custom";
type LibraryMood = "cinematic" | "upbeat" | "chill" | "electronic";
type MusicSource = "none" | "library" | "custom";
type MusicVolume = "subtle" | "balanced" | "prominent";
type MusicFadeOut = "none" | "2s" | "5s";
type MusicTab = "music" | "mixer";

interface SoundState {
  mood: MusicMood;
  volume: MusicVolume;
  customPath?: string;
  musicFadeOut: MusicFadeOut;
  musicLoop: boolean;
}

const LIBRARY_MOODS: { value: LibraryMood; label: string; description: string }[] = [
  { value: "cinematic",  label: "Cinematic",  description: "Epic orchestral score -- great for travel and nature." },
  { value: "upbeat",     label: "Upbeat",     description: "Energetic and positive -- great for action and sport." },
  { value: "chill",      label: "Chill",      description: "Laid-back and warm -- great for everyday memories." },
  { value: "electronic", label: "Electronic", description: "Driving synth beats -- great for fast-cut montages." },
];

const VOLUMES: { value: MusicVolume; label: string }[] = [
  { value: "subtle",    label: "Subtle" },
  { value: "balanced",  label: "Balanced" },
  { value: "prominent", label: "Prominent" },
];

const VOLUME_LEVELS: Record<MusicVolume, number> = { subtle: 0.3, balanced: 0.6, prominent: 1.0 };
// Music volume for rough-mix playback — same scale, used for musicAudioRef.volume
const MUSIC_VOLUME: Record<MusicVolume, number> = { subtle: 0.3, balanced: 0.6, prominent: 1.0 };

const FADE_OUT_OPTIONS: { value: MusicFadeOut; label: string }[] = [
  { value: "none", label: "None" },
  { value: "2s",   label: "2s" },
  { value: "5s",   label: "5s" },
];

const DEFAULT_SOUND: SoundState = { mood: "none", volume: "balanced", musicFadeOut: "2s", musicLoop: true };
const PREVIEW_DURATION_MS = 30_000;

// #189 logs-first: minimal music-lifecycle trace. Fire-and-forget append to
// %TEMP%\rushcut\playback-trace.log (same file/command Trimmer.tsx uses). Every
// line is prefixed `sound ` so a combined trace is disambiguable from the
// Trimmer film-mode lines. Low-frequency user-driven boundaries only -- never
// per-rVFC-frame / per-timeupdate.
function diagLog(line: string) {
  invoke("diag_log_cmd", { line: `sound ${line}` }).catch(() => {});
}
function maTail(src: string | null | undefined): string {
  if (!src) return "<none>";
  const i = src.lastIndexOf("/");
  return i >= 0 ? src.slice(i + 1) : src;
}

function deriveSource(mood: MusicMood): MusicSource {
  if (mood === "none") return "none";
  if (mood === "custom") return "custom";
  return "library";
}

function deriveLibraryMood(mood: MusicMood): LibraryMood | null {
  const lib: LibraryMood[] = ["cinematic", "upbeat", "chill", "electronic"];
  return lib.includes(mood as LibraryMood) ? (mood as LibraryMood) : null;
}

function readStorage(key: string): SoundState {
  try {
    const raw = getRenderPref(key);
    if (!raw) return DEFAULT_SOUND;
    const parsed = JSON.parse(raw) as Partial<SoundState>;
    const VALID_MOODS: MusicMood[] = ["none", "cinematic", "upbeat", "chill", "electronic", "custom"];
    const VALID_VOLUMES: MusicVolume[] = ["subtle", "balanced", "prominent"];
    const mood = VALID_MOODS.includes(parsed.mood as MusicMood) ? (parsed.mood as MusicMood) : DEFAULT_SOUND.mood;
    const VALID_FADE_OUTS: MusicFadeOut[] = ["none", "2s", "5s"];
    return {
      mood,
      volume: VALID_VOLUMES.includes(parsed.volume as MusicVolume) ? (parsed.volume as MusicVolume) : DEFAULT_SOUND.volume,
      customPath: typeof parsed.customPath === "string" ? parsed.customPath : undefined,
      musicFadeOut: VALID_FADE_OUTS.includes(parsed.musicFadeOut as MusicFadeOut) ? (parsed.musicFadeOut as MusicFadeOut) : DEFAULT_SOUND.musicFadeOut,
      // Back-compat: existing (pre-U6) projects have no musicLoop key -> default ON (matches today's always-loop render)
      musicLoop: typeof parsed.musicLoop === "boolean" ? parsed.musicLoop : DEFAULT_SOUND.musicLoop,
    };
  } catch {
    return DEFAULT_SOUND;
  }
}

export default function Sound() {
  const { projectId } = useParams<{ projectId: string }>();

  const _cached = projectCache.get(projectId ?? "");
  const [projectName, setProjectName] = useState(_cached?.name ?? "");
  const [clips, setClips] = useState<Clip[]>(_cached?.clips ?? []);
  const [musicDir, setMusicDir] = useState<string | null>(null);
  const [trackDurations, setTrackDurations] = useState<Partial<Record<LibraryMood, number>>>({});
  const [customDurationMs, setCustomDurationMs] = useState<number | null>(null);
  const [previewingMood, setPreviewingMood] = useState<LibraryMood | null>(null);
  const [previewingCustom, setPreviewingCustom] = useState(false);

  const storageKey = `rc_sound_${projectId}`;
  const [sound, setSound] = useState<SoundState>(() => readStorage(storageKey));
  const [musicTab, setMusicTab] = useState<MusicTab>("music");

  const audioRef = useRef<HTMLAudioElement>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probedRef = useRef(false);

  // Rough-mix playback refs — dual-buffer A/B slots (mirrors Trimmer.tsx dual-buffer engine)
  const filmVideoARef = useRef<HTMLVideoElement>(null);  // slot A
  const filmVideoBRef = useRef<HTMLVideoElement>(null);  // slot B
  const activeFilmSlotRef = useRef<"a" | "b">("a");      // which slot is currently visible
  const pendingGateSlotRef = useRef<"a" | "b" | null>(null); // slot mid-frame-reveal-gate (playing but not yet active/visible) — #91
  const slotGenRef = useRef<{ a: number; b: number }>({ a: 0, b: 0 }); // invalidates stale rVFC callbacks
  const musicAudioRef = useRef<HTMLAudioElement>(null);  // music track during rough mix
  // #189: monotonic generation for the music element -- bumped on every src swap.
  // Stale async callbacks (canplay / seeked / play().then/.catch) captured a gen
  // and must no-op if it no longer matches. Instrumented now; consumed by the
  // syncMusic() controller in the follow-up step.
  const musicGenRef = useRef(0);
  const filmPlayingRef = useRef(false);                  // imperative flag (avoids stale closures)
  const filmPlayIdxRef = useRef(0);                      // current clip index (fast access)
  const inFilmRef = useRef<typeof inFilm>([]);           // stable ref for event callbacks
  const progressBarFillRef = useRef<HTMLDivElement>(null); // imperative progress bar fill (avoids re-render)
  const elapsedLabelRef = useRef<HTMLSpanElement>(null);   // imperative elapsed-time label
  const hasPlayedRef = useRef(false);                      // true once playback has started; hides "Press play" overlay after film ends

  // #174 -- single authoritative sequence clock for the Master-tab film needle,
  // mirroring Trimmer.tsx Phase B. The needle no longer derives from
  // `filmPlayheadAtClip(...) + offsetInClip` (which stepped BACKWARD ~xfadeMs at
  // every crossfade cut -- #164) or from a naive raw-clip-sum for the fade/label
  // math (which omitted mid-roll card seconds -- #160). A `performance.now()`-
  // anchored clock free-runs while a clip plays and is drift-corrected (snap-only
  // on this tab -- NO playbackRate nudge, which would pitch-shift clip audio) via
  // `reconcile` against the <video>'s real media time. The strip needle, progress
  // bar and fade math are all pure projections of `seqNeedleMs` / `filmSeq.totalMs`.
  const filmSeqRef = useRef<Sequence | null>(null);
  const seqClockRef = useRef<ClockState>({ seqTimeMs: 0, lastSampleMs: 0 });
  const seqVisibleRef = useRef(true);
  const seqRafRef = useRef<number | null>(null);
  const seqNeedleWriteRef = useRef(0);
  const [seqNeedleMs, setSeqNeedleMsRaw] = useState(0);
  const cardHoldRef = useRef(false);
  // #174 Gate 3 (finding #2): suppress `reconcile` for a short window after any
  // discrete position change -- playback start, a <video> src swap (erratic
  // `timeupdate` cadence for a few hundred ms), a seek, and while music audio is
  // still buffering. Without this, the first jittery post-swap frames can trigger
  // a spurious snap right at the card/clip boundary where a bad correction is most
  // visible.
  const reconcileGateUntilRef = useRef(0);
  // #174 Gate 3 (finding #10): DEV-only one-writer guard. Every write to the
  // needle state goes through `setSeqNeedle(ms, owner)`; a write from any path
  // outside this allowlist is the #164/#166 "second needle writer" regression and
  // is surfaced loudly in dev. The union type enforces it at compile time; the
  // runtime check catches a JS-level bypass a future edit might introduce.
  const SEQ_NEEDLE_OWNERS = ["raf", "reconcile", "anchor", "cardTicker", "stop"] as const;
  function setSeqNeedle(ms: number, owner: (typeof SEQ_NEEDLE_OWNERS)[number]) {
    if (import.meta.env.DEV && !SEQ_NEEDLE_OWNERS.includes(owner)) {
      // eslint-disable-next-line no-console
      console.error(`[sound] seqNeedleMs written by unexpected owner: ${owner}`);
    }
    setSeqNeedleMsRaw(ms);
  }

  // Rough-mix playback state
  const [isFilmPlaying, setIsFilmPlaying] = useState(false);
  const [isFilmPaused, setIsFilmPaused] = useState(false);
  const [filmPlayIdx, setFilmPlayIdx] = useState(0);    // drives "Clip N / M" label
  // #150 (revised: autoplay, not indefinite hold — a card is a real CARD_DUR_MS clip in
  // the render, so preview mirrors that): natural playback reaching a card pauses the
  // VIDEO ONLY (music keeps playing straight through, matching the render — cards never
  // silence the music track) and shows the overlay for CARD_DUR_MS, then continues
  // automatically. isFilmPlaying stays true throughout (the film IS still playing, just
  // showing a card). cardHold is the single source of truth for "must not advance"; every
  // legitimate exit (the autoplay ticker firing, pause/resume mid-card, stopFilmPlayback,
  // startFilmPlayback, leaving the mixer tab) clears it (and cardHoldTickerRef) back to null.
  const [cardHold, setCardHold] = useState<{ filmMs: number; color: string; text: string; subtitle: string } | null>(null);
  // The in-film index to promote to once the card hold ends. clips_.length sentinel means
  // "trailing end-card, nothing after it."
  const pendingCardAdvanceIdxRef = useRef<number | null>(null);
  // #184: cards still to auto-hold in the current run before the pending promotion.
  const pendingCardRunRef = useRef<PlacedCard[]>([]);
  // The autoplay-through-card countdown, as a ~100ms ticker (not a single setTimeout) so the
  // strip needle visibly moves across the hold instead of sitting frozen (#150 live feedback:
  // "the seeker just stops" looked indistinguishable from the old silent-stop bug). Stopping
  // the ticker (pause) preserves cardHoldElapsedMs so resuming continues from where it left off.
  const cardHoldTickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cardHoldStartAtRef = useRef(0);
  const [cardHoldElapsedMs, setCardHoldElapsedMs] = useState(0);
  // #51/#97: persistent note shown when a clip's proxy is missing and we fell back to the
  // source file. Cleared when that clip's proxy-progress event fires or the user dismisses it.
  const [proxyFallbackClipId, setProxyFallbackClipId] = useState<string | null>(null);
  const proxyFallbackClipIdRef = useRef<string | null>(null);
  useEffect(() => { proxyFallbackClipIdRef.current = proxyFallbackClipId; }, [proxyFallbackClipId]);

  const configured = useConfiguredTabs(projectId ?? "");

  const source = deriveSource(sound.mood);
  const libraryMood = deriveLibraryMood(sound.mood);

  const inFilm = clips.filter((c) => c.include === 1).sort((a, b) => a.sort_order - b.sort_order);
  const clipCount = inFilm.length;
  const placedCards = readPlacedCards(projectId ?? "");
  const effectiveMs = effectiveFilmMs(inFilm, readTransitionConfig(projectId ?? ""), placedCards.length);

  // #174: the ONE canonical timeline for the Master tab -- same inputs the
  // StickyFilmStrip ruler uses, so the needle and ruler cannot geometrically
  // disagree. Stashed in a ref for the rAF loop. `filmSeq.totalMs` is the
  // telescoped, card-inclusive playback runtime -- it replaces the old naive
  // raw-clip sum that drove the scrub bar / fade marker / fade math and silently
  // omitted mid-roll card seconds (#160). (The EditorShell top-bar label stays on
  // `effectiveMs`, which additionally nets +100ms/black-fade the preview doesn't
  // traverse -- see sequenceClock.ts `playbackTotalFromEffective`.)
  const filmSeq = buildSequence(inFilm, readTransitionConfig(projectId ?? ""), placedCards);
  filmSeqRef.current = filmSeq;
  const totalMs = filmSeq.totalMs;
  const filmXfadeOverlapMs = clampedXfadeMs(inFilm, readTransitionConfig(projectId ?? ""));
  const filmCardRegionMs = cardRegionMs(filmXfadeOverlapMs);

  // Keep inFilmRef current so playback callbacks always read the latest clip list
  // without needing to re-subscribe on every render.
  inFilmRef.current = inFilm;

  const { transitionVal, openingTransitionVal, closingTransitionVal } = (() => {
    try {
      const tc = readTransitionConfig(projectId ?? "");
      return {
        transitionVal: tc.shuffleBetween ? "shuffle" : (tc.between !== "none" ? tc.between : null),
        openingTransitionVal: tc.opening !== "none" ? tc.opening : null,
        closingTransitionVal: tc.closing !== "none" ? tc.closing : null,
      };
    } catch { return { transitionVal: null, openingTransitionVal: null, closingTransitionVal: null }; }
  })();

  // #174: film needle position for the StickyFilmStrip cursor. The CLIP-playback
  // needle is a pure projection of the authoritative sequence clock (`seqNeedleMs`);
  // the CARD-region needle rides `cardHoldElapsedMs` clamped to the telescoped
  // card-region width (that wall-clock -> telescoped remap is card-specific; the
  // clock is paused while parked on a card and re-anchored to the next clip's
  // start when the hold ends). Identical shape to Trimmer.tsx `filmPositionMs`.
  const filmPositionMs = musicTab === "mixer"
    ? (cardHold
        ? cardHold.filmMs + Math.min(cardHoldElapsedMs, filmCardRegionMs)
        : inFilm.length > 0
          ? seqNeedleMs
          : undefined)
    : undefined;

  /**
   * #174: re-anchor the authoritative sequence clock to an exact telescoped
   * film-time. Called on every discrete position change (playback start, clip
   * promote, seek, card hold -> next clip) so the free-running clock starts from
   * ground truth rather than drifting from wherever it happened to be.
   */
  function anchorSeqClock(filmMs: number) {
    const total = filmSeqRef.current?.totalMs ?? 0;
    const clamped = Math.max(0, Math.min(filmMs, total || filmMs));
    seqClockRef.current = { seqTimeMs: clamped, lastSampleMs: performance.now() };
    setSeqNeedle(clamped, "anchor");
  }

  /**
   * #174: the Master tab uses SNAP-ONLY reconciliation (see `reconcile`'s own
   * caller-guidance note) -- a `playbackRate` nudge on the clip <video> would be an
   * audible pitch shift while the user is judging music timing. This resets any
   * rate the shared engine might carry on both dual-buffer slots. Kept for parity
   * with Trimmer.tsx and as a guard if the snap-only decision is ever revisited.
   */
  function resetFilmPlaybackRate() {
    for (const v of [filmVideoARef.current, filmVideoBRef.current]) {
      if (!v) continue;
      (v as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true;
      v.playbackRate = 1;
    }
  }

  // #174: mirror for the rAF loop / reconcile without re-subscribing every render.
  useEffect(() => { cardHoldRef.current = cardHold !== null; }, [cardHold]);

  // #174: single rAF sampling loop for the sequence clock while the Master tab is
  // active. The clock only ACCRUES while playing, visible, and not parked on a
  // card. rAF is only the sampling tick -- advanceSequenceClock does the
  // wall-clock arithmetic and discards huge deltas from a hidden tab / OS sleep.
  // Ported verbatim from Trimmer.tsx (keyed on musicTab==="mixer" here instead of
  // viewMode==="film").
  useEffect(() => {
    if (musicTab !== "mixer") {
      if (seqRafRef.current !== null) cancelAnimationFrame(seqRafRef.current);
      seqRafRef.current = null;
      return;
    }
    const onVis = () => {
      const nowVisible = document.visibilityState === "visible";
      seqVisibleRef.current = nowVisible;
      // Returning to visible: re-seat lastSampleMs so the hidden gap is never
      // integrated, AND re-seat seqTimeMs from the real media position if a clip
      // is currently the active element -- the picture is ground truth after a
      // background gap (WebView2 throttles rAF on focus loss without flipping
      // visibilityState, so the clock may have quietly drifted).
      let seatMs = seqClockRef.current.seqTimeMs;
      const seq = filmSeqRef.current;
      const v = getFilmVideo(activeFilmSlotRef.current);
      if (nowVisible && seq && v && v.readyState >= 2 && !cardHoldRef.current
          && performance.now() >= reconcileGateUntilRef.current) {
        seatMs = mediaToFilm(seq, filmPlayIdxRef.current, v.currentTime * 1000);
      }
      seqClockRef.current = { seqTimeMs: seatMs, lastSampleMs: performance.now() };
    };
    document.addEventListener("visibilitychange", onVis);
    seqVisibleRef.current = document.visibilityState === "visible";

    const tick = () => {
      const seq = filmSeqRef.current;
      if (seq) {
        // #174 fix: a clip plays its FULL media length, but its telescoped
        // sequence span is one xfade shorter. Ceil the free-running clock at the
        // ACTIVE item's telescoped end so the needle PARKS at the cut during the
        // crossfade-overlap tail instead of over-running past it (which reconcile
        // then hard-snaps backward -- the exact #164 backstep). filmEnd == totalMs
        // on the final element, so this is a no-op there.
        const activeItem = seq.items.find(
          (it) => it.kind === "clip" && it.index === filmPlayIdxRef.current,
        );
        const ceilMs = activeItem && !cardHoldRef.current ? activeItem.filmEndMs : seq.totalMs;
        seqClockRef.current = advanceSequenceClock(seqClockRef.current, performance.now(), {
          visible: seqVisibleRef.current,
          isPlaying: filmPlayingRef.current && !cardHoldRef.current,
          totalMs: Math.min(seq.totalMs, ceilMs),
        });
        const now = performance.now();
        if (now - seqNeedleWriteRef.current >= 50) {
          seqNeedleWriteRef.current = now;
          setSeqNeedle(seqClockRef.current.seqTimeMs, "raf");
          // Imperative progress bar + elapsed label off the same clock (never a
          // naive raw-clip sum). Skipped while parked on a card -- the ticker owns
          // those pixels then (it advances across the telescoped card region).
          if (!cardHoldRef.current) {
            const nMs = seqClockRef.current.seqTimeMs;
            const tot = seq.totalMs;
            if (progressBarFillRef.current && tot > 0) {
              progressBarFillRef.current.style.width = `${Math.min(100, (nMs / tot) * 100)}%`;
            }
            if (elapsedLabelRef.current) {
              elapsedLabelRef.current.textContent = `${fmtMs(nMs)} / ${fmtMs(tot)}`;
            }
          }
        }
      }
      seqRafRef.current = requestAnimationFrame(tick);
    };
    seqRafRef.current = requestAnimationFrame(tick);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      if (seqRafRef.current !== null) cancelAnimationFrame(seqRafRef.current);
      seqRafRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [musicTab]);

  useEffect(() => {
    if (!projectId) return;
    invoke<ProjectWithClips>("get_project", { projectId })
      .then((data) => {
        projectCache.set(projectId, { name: data.project.name, clips: data.clips });
        setProjectName(data.project.name);
        setClips(data.clips);
      })
      .catch(() => {});
    invoke<string>("get_music_dir_cmd")
      .then((dir) => {
        if (!dir) return;
        setMusicDir(dir);
        if (probedRef.current) return;
        probedRef.current = true;
        const moods: LibraryMood[] = ["cinematic", "upbeat", "chill", "electronic"];
        moods.forEach((mood) => {
          const a = new Audio();
          a.preload = "metadata";
          a.src = convertFileSrc(dir + "\\" + mood + ".mp3");
          a.addEventListener("loadedmetadata", () => {
            setTrackDurations((prev) => ({ ...prev, [mood]: a.duration }));
          }, { once: true });
        });
      })
      .catch(() => {});
  }, [projectId]);

  // #97: Sound previously had no proxy-progress listener at all, so a fallback note here
  // could never self-clear on completion (unlike Trimmer's). Mirrors Trimmer.tsx's listener.
  useEffect(() => {
    if (!projectId) return;
    let unlisten: (() => void) | undefined;
    listen<{ projectId: string; clipId: string; winPath: string }>(
      "proxy-progress",
      (ev) => {
        if (ev.payload.projectId !== projectId) return;
        const { clipId, winPath } = ev.payload;
        setClips((prev) =>
          prev.map((c) => c.id === clipId ? { ...c, proxy_path: winPath } : c)
        );
        if (proxyFallbackClipIdRef.current === clipId) {
          setProxyFallbackClipId(null);
        }
      }
    ).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [projectId]);

  // Both film slots start hidden; setSlotVisible manages visibility imperatively (avoids React async paint race)
  useEffect(() => {
    if (filmVideoARef.current) { filmVideoARef.current.style.opacity = "0"; filmVideoARef.current.style.pointerEvents = "none"; }
    if (filmVideoBRef.current) { filmVideoBRef.current.style.opacity = "0"; filmVideoBRef.current.style.pointerEvents = "none"; }
  }, []);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
      // Stop rough-mix playback on route leave
      filmVideoARef.current?.pause();
      filmVideoBRef.current?.pause();
      // #189: pause AND drop the src -- pausing alone leaves the element holding
      // a live decoded buffer; clearing src (then load() to release it, MDN-
      // recommended pattern) guarantees no orphan audio survives the unmount.
      if (musicAudioRef.current) {
        musicAudioRef.current.pause();
        musicAudioRef.current.removeAttribute("src");
        musicAudioRef.current.load();
      }
      musicGenRef.current++; // invalidate any in-flight syncMusic callback
      filmPlayingRef.current = false;
      // #150: don't let an armed autoplay-through-card ticker fire against an unmounted component.
      if (cardHoldTickerRef.current !== null) clearInterval(cardHoldTickerRef.current);
    };
  }, []);

  // Real-time volume sync — if music is playing and user changes the volume chip, take effect immediately
  useEffect(() => {
    if (!isFilmPlaying) return;
    const ma = musicAudioRef.current;
    if (!ma) return;
    ma.volume = MUSIC_VOLUME[sound.volume];
  }, [sound.volume, isFilmPlaying]);

  // ---------------------------------------------------------------------------
  // Dual-buffer film engine (ported from Trimmer.tsx lines 340–498)
  // ---------------------------------------------------------------------------

  function getFilmVideo(slot: "a" | "b") {
    return slot === "a" ? filmVideoARef.current : filmVideoBRef.current;
  }

  // #51: stamp which clip + source-kind a slot's <video> currently holds, so the
  // onError handler can resolve the clip and decide whether a fallback is still possible.
  // usingSource="0" -> currently playing the proxy; "1" -> already on the original source file.
  function stampSlot(v: HTMLVideoElement, clip: Clip) {
    v.dataset.clipId = clip.id;
    v.dataset.usingSource = clip.proxy_path ? "0" : "1";
  }

  // #51: a slot's <video> failed to load/play. If it was on the proxy, fall back to the
  // original source file (dual-buffer aware): the PRELOADED (inactive) slot retries silently
  // so it is ready when promoted; the ACTIVE slot recovers mid-playback and surfaces a note.
  // If it was already on the source, give up gracefully (advance past the clip if active) so
  // the film never stalls.
  function handleSlotError(slot: "a" | "b") {
    const v = getFilmVideo(slot);
    if (!v) return;
    const clip = inFilmRef.current.find((c) => c.id === v.dataset.clipId);
    if (!clip) return;
    const isActive = slot === activeFilmSlotRef.current;

    if (v.dataset.usingSource === "1" || !clip.proxy_path) {
      // Already on the source (or no proxy to fall back from) and still failing.
      if (isActive && filmPlayingRef.current) {
        console.warn("[sound] active slot source playback failed, advancing past clip", clip.id);
        advanceFilmClipRough();
      }
      return;
    }

    // Proxy failed -> swap to the original source file at the clip's in-point.
    const sourceSrc = convertFileSrc(clip.local_path);
    const seekSec = (clip.in_ms ?? 0) / 1000;
    v.dataset.usingSource = "1";
    v.src = sourceSrc;
    v.addEventListener("loadedmetadata", () => {
      v.currentTime = seekSec;
      if (isActive && filmPlayingRef.current) v.play().catch(() => {});
    }, { once: true });
    v.load();

    if (isActive) {
      setProxyFallbackClipId(clip.id);
    }
  }

  function setSlotVisible(slot: "a" | "b" | "none") {
    const vA = filmVideoARef.current;
    const vB = filmVideoBRef.current;
    if (vA) { vA.style.opacity = slot === "a" ? "1" : "0"; vA.style.pointerEvents = slot === "a" ? "" : "none"; }
    if (vB) { vB.style.opacity = slot === "b" ? "1" : "0"; vB.style.pointerEvents = slot === "b" ? "" : "none"; }
  }

  function gateFrameRevealThen(
    v: HTMLVideoElement,
    slot: "a" | "b",
    thisGen: number,
    targetSec: number,
    onReady: () => void,
  ) {
    const TOLERANCE_SEC = 0.05;
    const MAX_WAITS = 30;
    let waits = 0;
    v.play().catch(() => {});

    const rVFC = (v as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, metadata: { mediaTime: number }) => void) => void;
    }).requestVideoFrameCallback;

    function check(_now: number, metadata: { mediaTime: number }) {
      // Only a genuine invalidation (superseded load/gen) should abandon the poll.
      // A pause must NOT abandon it — rVFC fires per presented frame, so a bare
      // `return` here would leave nothing listening once resumeFilmPlayback plays
      // the video again, permanently stranding this reveal (#91 fix).
      if (slotGenRef.current[slot] !== thisGen) return;
      if (!filmPlayingRef.current) {
        rVFC?.call(v, check);
        return;
      }
      const frameTime = metadata?.mediaTime ?? v.currentTime;
      if (frameTime >= targetSec - TOLERANCE_SEC) {
        onReady();
        return;
      }
      if (waits >= MAX_WAITS) {
        console.warn("film-seek: rVFC mediaTime gate hit safety cap");
        onReady();
        return;
      }
      waits++;
      rVFC?.call(v, check);
    }

    if (rVFC) {
      rVFC.call(v, check);
    } else {
      function fallbackCheck() {
        if (slotGenRef.current[slot] !== thisGen) return;
        if (!filmPlayingRef.current) {
          requestAnimationFrame(() => requestAnimationFrame(fallbackCheck));
          return;
        }
        onReady();
      }
      requestAnimationFrame(() => requestAnimationFrame(fallbackCheck));
    }
  }

  function loadIntoSlot(idx: number, slot: "a" | "b", startMs?: number) {
    const filmClip = inFilmRef.current[idx];
    if (!filmClip) return;
    filmPlayIdxRef.current = idx;
    setFilmPlayIdx(idx);

    const v = getFilmVideo(slot);
    if (!v) return;

    const seekMs = startMs !== undefined ? startMs : (filmClip.in_ms ?? 0);
    const src = convertFileSrc(filmClip.proxy_path ?? filmClip.local_path);

    slotGenRef.current[slot]++;
    const thisGen = slotGenRef.current[slot];

    function activate() {
      if (!filmPlayingRef.current || !v || slotGenRef.current[slot] !== thisGen) return;
      // #91 fix: defer the activeFilmSlotRef flip + reveal until the frame gate
      // confirms the compositor actually shows the target frame — flipping early
      // (as this used to) lets handleFilmTimeUpdate start driving progress off this
      // slot's currentTime before the still-hidden video has caught up.
      pendingGateSlotRef.current = slot;
      gateFrameRevealThen(v, slot, thisGen, seekMs / 1000, () => {
        if (pendingGateSlotRef.current === slot) pendingGateSlotRef.current = null;
        if (slotGenRef.current[slot] !== thisGen || !filmPlayingRef.current) return;
        activeFilmSlotRef.current = slot;
        v.volume = Math.min(1, filmClip.clip_volume ?? 1.0);
        setSlotVisible(slot);
        const nextIdx = idx + 1;
        if (nextIdx < inFilmRef.current.length) {
          const nextSlot: "a" | "b" = slot === "a" ? "b" : "a";
          preloadIntoSlot(nextIdx, nextSlot);
        }
      });
    }

    v.style.opacity = "0";
    v.style.pointerEvents = "none";
    v.src = src;
    stampSlot(v, filmClip);
    v.addEventListener("loadedmetadata", () => {
      if (!filmPlayingRef.current) return;
      v.addEventListener("seeked", activate, { once: true });
      v.currentTime = seekMs / 1000;
    }, { once: true });
    v.load();
  }

  function preloadIntoSlot(idx: number, slot: "a" | "b") {
    const filmClip = inFilmRef.current[idx];
    if (!filmClip) return;
    const v = getFilmVideo(slot);
    if (!v) return;
    const src = convertFileSrc(filmClip.proxy_path ?? filmClip.local_path);
    slotGenRef.current[slot]++;
    const thisGen = slotGenRef.current[slot];
    v.src = src;
    stampSlot(v, filmClip);
    v.addEventListener("loadedmetadata", () => {
      if (slotGenRef.current[slot] !== thisGen) return;
      v.currentTime = (filmClip.in_ms ?? 0) / 1000;
    }, { once: true });
    v.load();
  }

  function crossSeekToClip(idx: number, seekMs: number) {
    const filmClip = inFilmRef.current[idx];
    if (!filmClip) return;
    const currentSlot = activeFilmSlotRef.current;
    const targetSlot: "a" | "b" = currentSlot === "a" ? "b" : "a";
    const newV = getFilmVideo(targetSlot);
    const oldV = getFilmVideo(currentSlot);
    if (!newV) return;

    const src = convertFileSrc(filmClip.proxy_path ?? filmClip.local_path);
    slotGenRef.current[targetSlot]++;
    const thisGen = slotGenRef.current[targetSlot];

    newV.src = src;
    stampSlot(newV, filmClip);
    newV.addEventListener("loadedmetadata", () => {
      if (slotGenRef.current[targetSlot] !== thisGen || !filmPlayingRef.current) return;
      newV.addEventListener("seeked", () => {
        if (slotGenRef.current[targetSlot] !== thisGen || !filmPlayingRef.current) return;
        pendingGateSlotRef.current = targetSlot;
        gateFrameRevealThen(newV, targetSlot, thisGen, seekMs / 1000, () => {
          if (pendingGateSlotRef.current === targetSlot) pendingGateSlotRef.current = null;
          filmPlayIdxRef.current = idx;
          setFilmPlayIdx(idx);
          activeFilmSlotRef.current = targetSlot;
          newV.volume = Math.min(1, filmClip.clip_volume ?? 1.0);
          setSlotVisible(targetSlot);
          oldV?.pause();
          const nextIdx = idx + 1;
          if (nextIdx < inFilmRef.current.length) {
            preloadIntoSlot(nextIdx, currentSlot);
          }
        });
      }, { once: true });
      newV.currentTime = seekMs / 1000;
    }, { once: true });
    newV.load();
  }

  function stopPreview() {
    audioRef.current?.pause();
    setPreviewingMood(null);
    setPreviewingCustom(false);
    if (previewTimerRef.current !== null) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Rough-mix live playback
  // ---------------------------------------------------------------------------

  /**
   * Promote clip[nextIdx] to active — the frame-confirmed reveal body, unchanged from
   * the pre-#150 advanceFilmClipRough. Shared by the natural-advance path (when no card
   * sits at the boundary) and by the resume-past-a-card-hold path, so both go through
   * the exact same readiness gate (gateFrameRevealThen) rather than a second, weaker
   * ad hoc swap — mirrors Trimmer.tsx's promoteToFilmClip extraction for the same reason.
   */
  function promoteToFilmClipRough(nextIdx: number) {
    const nextClip = inFilmRef.current[nextIdx];
    const nextSlot: "a" | "b" = activeFilmSlotRef.current === "a" ? "b" : "a";
    const nextV = getFilmVideo(nextSlot);
    if (!nextV || !nextClip) return;

    // Preload for this slot may not have started/finished yet (very short clips can
    // outrun the lookahead preload) — fall back to a full load rather than gating on
    // a video that was never given the right src.
    if (nextV.dataset.clipId !== nextClip.id) {
      loadIntoSlot(nextIdx, nextSlot);
      return;
    }

    const targetSec = (nextClip.in_ms ?? 0) / 1000;
    const thisGen = slotGenRef.current[nextSlot];

    // #91 fix: don't reveal the next clip / snap progress until the compositor has
    // actually confirmed the target frame (same gate loadIntoSlot/crossSeekToClip
    // already use) — was previously an unguarded, immediate reveal (see LEARNINGS.md
    // "WebView2 — GPU compositor presents frame 0 first").
    pendingGateSlotRef.current = nextSlot;
    gateFrameRevealThen(nextV, nextSlot, thisGen, targetSec, () => {
      if (pendingGateSlotRef.current === nextSlot) pendingGateSlotRef.current = null;
      if (slotGenRef.current[nextSlot] !== thisGen || !filmPlayingRef.current) return;

      filmPlayIdxRef.current = nextIdx;
      setFilmPlayIdx(nextIdx);
      activeFilmSlotRef.current = nextSlot;
      nextV.volume = Math.min(1, nextClip.clip_volume ?? 1.0);
      setSlotVisible(nextSlot);

      // #174: re-anchor the sequence clock to this clip's telescoped start and
      // gate reconcile briefly (erratic post-swap timeupdate cadence). The rAF
      // loop refreshes the progress bar + label off the clock within ~50ms.
      const seq = filmSeqRef.current;
      if (seq) anchorSeqClock(itemToFilm(seq, "clip", nextIdx, 0));
      reconcileGateUntilRef.current = performance.now() + 350;
      resetFilmPlaybackRate();

      const afterNextIdx = nextIdx + 1;
      if (afterNextIdx < inFilmRef.current.length) {
        const afterNextSlot: "a" | "b" = nextSlot === "a" ? "b" : "a";
        preloadIntoSlot(afterNextIdx, afterNextSlot);
      }
    });
  }

  function advanceFilmClipRough() {
    // Guard against stray onEnded re-entry after the film already stopped (e.g. a
    // buffered/preloaded slot firing `ended` post-seek). Without this, the advance
    // state machine plays one extra clip with no music sync. See U6 follow-up Bug A.
    if (!filmPlayingRef.current) return;

    // #150 idempotency guard: already parked on a card — a stray re-entrant tick must
    // be a no-op, not a second transition. filmPlayIdxRef is never mutated while
    // cardHold is set, so this is also true by construction — the explicit check
    // just makes it self-evident (mirrors Trimmer.tsx's advanceFilmClip).
    if (cardHold) return;

    // Pause the outgoing slot FIRST, synchronously, before anything else. A paused
    // video fires no more `timeupdate`, which is what actually prevents a second
    // `advanceFilmClipRough` re-entry while the reveal below waits on the frame gate
    // (#91 fix — activeFilmSlotRef used to flip synchronously here and do that job;
    // now it doesn't flip until the frame is confirmed, so pause must stand alone).
    getFilmVideo(activeFilmSlotRef.current)?.pause();

    const nextIdx = filmPlayIdxRef.current + 1;

    // #150: card-aware boundary check — same cardBefore/endCard lookup pattern as
    // Trimmer.tsx's advanceFilmClip/seekFilmTo, built from readPlacedCards(). A card
    // immediately before clips_[nextIdx], or a trailing end-card once nextIdx runs past
    // the last clip, must pause (video + music together — no continue-under-card, to
    // avoid position drift during an indefinite hold) and hold rather than silently
    // advancing/stopping.
    const clips_ = inFilmRef.current;
    const cardsNow = clips_.length > 0 ? readPlacedCards(projectId ?? "") : [];
    const runs = orderedCardRuns(cardsNow, clips_.map((c) => c.id));
    const upcomingRun = nextIdx < clips_.length ? (runs.before.get(clips_[nextIdx].id) ?? []) : runs.end;

    if (upcomingRun.length > 0) {
      // #150 revision (live feedback): a card is a real CARD_DUR_MS clip in the render —
      // autoplay through it instead of holding indefinitely for a click. Music is
      // deliberately NOT paused here — it plays straight through the card, matching the
      // render (cards never silence the music track). Video pause mirrors
      // pauseFilmPlayback's "pause both slots, not just the active one" — a pending gate
      // (#91) may already have the inactive slot playing invisibly.
      filmVideoARef.current?.pause();
      filmVideoBRef.current?.pause();
      pendingCardAdvanceIdxRef.current = nextIdx; // may be >= clips_.length — trailing end run
      pendingCardRunRef.current = upcomingRun.slice(1); // #184: card[0] held now, rest queued
      holdCard(upcomingRun[0]);
      return;
    }

    if (nextIdx >= clips_.length) {
      stopFilmPlayback();
      return;
    }

    promoteToFilmClipRough(nextIdx);
  }

  function handleFilmTimeUpdate(slot: "a" | "b", currentTimeSec: number) {
    // Ignore events from the inactive slot — only the active slot drives progress.
    // #163/F6: this is also the seek-intermediate guard for the needle write below —
    // crossSeekToClip/promoteToFilmClipRough only flip activeFilmSlotRef to the seeking
    // slot INSIDE the rVFC frame-reveal gate (after the presented frame's mediaTime
    // matches the seek target), and the outgoing slot is paused before every transition,
    // so a mid-seek `timeupdate` carrying an intermediate currentTime can't reach the
    // playhead. The one same-clip direct-seek path (seekToFilmMs) sets the needle
    // explicitly first, so a trailing timeupdate only re-affirms the same position.
    if (!filmPlayingRef.current || slot !== activeFilmSlotRef.current) return;
    const clip = inFilmRef.current[filmPlayIdxRef.current];
    if (!clip) return;

    // Respect user trim out_ms — onEnded fires at the END of the source file,
    // not at the user's trim point.
    const outSec = (clip.out_ms ?? clip.duration_ms) / 1000;
    if (currentTimeSec >= outSec) {
      advanceFilmClipRough();
      return;
    }

    // #174: drift-correct the authoritative sequence clock against what the
    // <video> is actually presenting. SNAP-ONLY on the Master tab -- a
    // `playbackRate` nudge would be an audible pitch shift on clip audio while the
    // user judges music timing (see `reconcile`'s caller-guidance note). Suppressed
    // briefly after any src swap / seek / playback start (Gate 3 finding #2): the
    // erratic first post-swap `timeupdate` frames must not trigger a spurious snap
    // at the card/clip boundary where a bad correction is most visible. The strip
    // needle + progress bar + label are all pure projections of this clock (rAF
    // loop) -- there is no separate media-derived film position anymore (#164/#166).
    const seq = filmSeqRef.current;
    if (seq && !cardHoldRef.current && performance.now() >= reconcileGateUntilRef.current) {
      const mediaFilmMs = mediaToFilm(seq, filmPlayIdxRef.current, currentTimeSec * 1000);
      const r = reconcile(seqClockRef.current.seqTimeMs, mediaFilmMs);
      if (r.seqTimeMs !== undefined) {
        seqClockRef.current = { seqTimeMs: r.seqTimeMs, lastSampleMs: performance.now() };
        setSeqNeedle(r.seqTimeMs, "reconcile");
        // #174 Gate 3 (#10): count hard snaps so the film-mode WDIO spec can assert
        // reconcile isn't fighting a stuck decoder / a second writer (budget:
        // SYNC_CONTRACT.MAX_SNAPS_PER_MIN). DEV/test only.
        if (import.meta.env.DEV) {
          const w = window as unknown as { __rc_seqSnapCount?: number };
          w.__rc_seqSnapCount = (w.__rc_seqSnapCount ?? 0) + 1;
        }
      }
      // r.playbackRate is deliberately ignored on the Master tab (audio pitch).
    }

    // Music fade-out — anchored to the END OF THE ENTIRE FILM, measured from the
    // telescoped card-inclusive sequence total (not a naive raw-clip sum that
    // omitted mid-roll card seconds — #160), and clamped to the music track's own
    // length: loop ON -> the track always covers the film so `totalMs` governs;
    // loop OFF + shorter track -> the audible fade rides the earlier of the two,
    // matching the "plays once, then silence" loop note (Gate 3 finding #2b).
    const ma = musicAudioRef.current;
    if (!ma) return;
    const fadeMs = ({ none: 0, "2s": 2000, "5s": 5000 } as Record<string, number>)[sound.musicFadeOut] ?? 0;
    const seqTot = seq?.totalMs ?? 0;
    if (fadeMs > 0 && seqTot > 0) {
      const trackMs = !sound.musicLoop && ma.duration ? ma.duration * 1000 : Infinity;
      const fadeTotalMs = Math.min(seqTot, trackMs);
      const remainingMs = fadeTotalMs - seqClockRef.current.seqTimeMs;
      if (remainingMs <= fadeMs) {
        ma.volume = MUSIC_VOLUME[sound.volume] * Math.max(0, remainingMs / fadeMs);
      }
    }
  }

  // #189: single-owner music controller. Every place that used to poke
  // `musicAudioRef` directly (assign `.src`, call `.load()`/`.play()`, seek
  // `.currentTime`) now routes through here. Commands:
  //   "new-source"            -- mood/track changed (or first play): resolve src,
  //                              load(), seek to positionMs, play iff opts.play.
  //   "same-source-reanchor"  -- same track, re-seek to positionMs (e.g. a scrub
  //                              seek, or landing on a card), play iff opts.play.
  //   "pause" / "resume"      -- no src/position change, just toggle playback.
  // `musicGenRef` is bumped on every "new-source" call; every async callback
  // (canplay/loadedmetadata/seeked/play().then/.catch) captures that gen and is
  // a no-op if a later swap has since superseded it -- the fix for "stale
  // callback resumes the old track". Idempotent under React 18 Strict Mode:
  // each call is self-contained (resolves src from current `sound` state fresh,
  // no external mutable setup step), so a duplicate invocation just repeats the
  // same swap and only the last gen wins -- no inconsistent end state.
  function syncMusic(cmd: "new-source" | "same-source-reanchor" | "pause" | "resume", opts: { play: boolean; positionMs: number }) {
    const ma = musicAudioRef.current;
    if (!ma) return;

    if (cmd === "pause") {
      diagLog(`syncMusic pause maCurTime=${ma.currentTime.toFixed(2)}`);
      ma.pause();
      return;
    }

    const firePlay = (gen: number) => {
      if (musicGenRef.current !== gen) return; // superseded
      ma.play().then(
        () => diagLog(`syncMusic play ok gen=${gen} curTime=${ma.currentTime.toFixed(2)}`),
        (e) => {
          const name = (e as Error)?.name;
          if (name === "AbortError") return; // expected: superseded by a newer load/seek
          diagLog(`syncMusic play rej gen=${gen} name=${name}`);
        },
      );
    };

    if (cmd === "resume") {
      const gen = musicGenRef.current;
      diagLog(`syncMusic resume gen=${gen} maCurTime=${ma.currentTime.toFixed(2)} readyState=${ma.readyState}`);
      firePlay(gen);
      return;
    }

    if (sound.mood === "none") {
      ma.pause();
      return;
    }
    const src =
      sound.mood === "custom" && sound.customPath
        ? convertFileSrc(sound.customPath)
        : musicDir
        ? convertFileSrc(musicDir + "\\" + sound.mood + ".mp3")
        : null;
    if (!src) return;

    const gen = cmd === "new-source" ? ++musicGenRef.current : musicGenRef.current;
    const targetSec = opts.positionMs / 1000;

    const seekAndMaybePlay = () => {
      if (musicGenRef.current !== gen) return; // superseded
      // Guard against NaN duration (unloaded element) collapsing target -> 0
      // (the #189 bug-3 root cause) -- defer instead of computing x % x.
      const trackDur = Number.isFinite(ma.duration) && ma.duration > 0 ? ma.duration : null;
      if (trackDur === null) {
        ma.addEventListener("durationchange", seekAndMaybePlay, { once: true });
        return;
      }
      const target = sound.musicLoop ? targetSec % trackDur : Math.min(targetSec, trackDur - 0.05);
      diagLog(
        `syncMusic ${cmd} gen=${gen} target=${target.toFixed(2)} trackDur=${trackDur.toFixed(2)} maCurTime=${ma.currentTime.toFixed(2)} play=${opts.play}`,
      );
      if (Math.abs(target - ma.currentTime) < 0.1) {
        if (opts.play) firePlay(gen);
        return;
      }
      // Mute-bridge the reseek (WebView2 audio dropout on currentTime write);
      // play() must fire inside the seeked handler, never right after the
      // currentTime assignment (LEARNINGS: play()-after-seek race).
      ma.muted = true;
      ma.addEventListener(
        "seeked",
        () => {
          if (musicGenRef.current !== gen) return;
          ma.muted = false;
          if (opts.play) firePlay(gen);
        },
        { once: true },
      );
      ma.currentTime = target;
    };

    if (cmd === "new-source") {
      diagLog(
        `syncMusic new-source gen=${gen} mood=${sound.mood} reqSrc=${maTail(src)} curSrc=${maTail(ma.currentSrc)} readyState=${ma.readyState}`,
      );
      ma.src = src;
      ma.loop = sound.musicLoop;
      ma.volume = MUSIC_VOLUME[sound.volume];
      ma.load(); // resets currentTime to 0 -- seekAndMaybePlay re-seeks once ready
      if (ma.readyState >= 2) seekAndMaybePlay();
      else ma.addEventListener("canplay", seekAndMaybePlay, { once: true });
      return;
    }

    // same-source-reanchor
    ma.loop = sound.musicLoop;
    ma.volume = MUSIC_VOLUME[sound.volume];
    if (ma.readyState >= 1) seekAndMaybePlay();
    else ma.addEventListener("loadedmetadata", seekAndMaybePlay, { once: true });
  }

  // #189: mood/custom-track/musicDir changed. If the film is active (playing or
  // paused), swap the loaded track immediately per the user-confirmed decision:
  // playing -> swap + reanchor to the current needle + keep playing; paused ->
  // swap + reanchor, stay paused (correct track sounds on next play). Idle (no
  // playback started yet) is a no-op -- the next startFilmPlayback resolves the
  // current mood fresh anyway. Effect fires on mount too (musicDir hydrates
  // async) but is a no-op then since nothing is playing/paused yet.
  useEffect(() => {
    if (!filmPlayingRef.current && !isFilmPaused) return;
    if (sound.mood === "none") {
      syncMusic("pause", { play: false, positionMs: 0 });
      return;
    }
    syncMusic("new-source", { play: filmPlayingRef.current, positionMs: seqClockRef.current.seqTimeMs });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sound.mood, sound.customPath, musicDir]);

  function startFilmPlayback() {
    stopPreview(); // stop any mood chip preview
    hasPlayedRef.current = true;
    filmPlayingRef.current = true;
    setCardHold(null); // #150: any stale hold from a prior playback session is moot
    pendingCardAdvanceIdxRef.current = null;
    pendingCardRunRef.current = []; // #184
    stopCardHoldTicker();
    setCardHoldElapsedMs(0);
    filmPlayIdxRef.current = 0;
    activeFilmSlotRef.current = "a";
    slotGenRef.current = { a: 0, b: 0 };
    pendingGateSlotRef.current = null;
    setFilmPlayIdx(0);
    setIsFilmPlaying(true);

    // #174: start the authoritative clock at film-time 0 and gate reconcile while
    // slot A loads/seeks and music buffers (Gate 3 finding #2).
    anchorSeqClock(0);
    reconcileGateUntilRef.current = performance.now() + 350;
    resetFilmPlaybackRate();
    seqVisibleRef.current = document.visibilityState === "visible";
    if (import.meta.env.DEV) {
      (window as unknown as { __rc_seqSnapCount?: number }).__rc_seqSnapCount = 0;
    }

    syncMusic("new-source", { play: true, positionMs: 0 });

    // #187: if the film opens with a card, hold it from film-time 0 instead of
    // jumping straight into clip 0 -- mirrors the card-seek / natural-advance
    // card paths (video parked on the overlay, music keeps playing straight
    // through, per the same #189 decision).
    const seq = filmSeqRef.current;
    const firstItem = seq?.items[0];
    if (firstItem && firstItem.kind === "card" && firstItem.card) {
      const runFromHere: PlacedCard[] = [];
      let nextClipIdx = inFilmRef.current.length;
      for (const it of seq.items) {
        if (it.kind === "card" && it.card) runFromHere.push(it.card);
        else if (it.kind === "clip") { nextClipIdx = it.index; break; }
      }
      pendingCardAdvanceIdxRef.current = nextClipIdx;
      pendingCardRunRef.current = runFromHere.slice(1);
      holdCard(runFromHere[0]);
      return;
    }

    // Dual-buffer: load clip 0 into slot A; preload of clip 1 into slot B happens inside loadIntoSlot's onReady
    loadIntoSlot(0, "a");
  }

  function pauseFilmPlayback() {
    diagLog(
      `pause maCurTime=${musicAudioRef.current?.currentTime.toFixed(2)} maPaused=${musicAudioRef.current?.paused} needle=${seqClockRef.current.seqTimeMs.toFixed(0)}`,
    );
    filmPlayingRef.current = false;
    // Pause BOTH slots, not just the active one — a pending advance/load gate (#91)
    // may already have the inactive slot playing (still invisible) while it waits
    // for its frame to be confirmed. Leaving it running would keep drifting past
    // its target during the pause and desync the eventual reveal.
    filmVideoARef.current?.pause();
    filmVideoBRef.current?.pause();
    musicAudioRef.current?.pause();
    setIsFilmPlaying(false);
    setIsFilmPaused(true);
  }

  function resumeFilmPlayback() {
    filmPlayingRef.current = true;
    getFilmVideo(activeFilmSlotRef.current)?.play().catch(() => {});
    // Also resume the slot mid-frame-reveal-gate (#91), if any — pauseFilmPlayback
    // paused it too, and without resuming it here that pending advance/load would
    // never resolve. Only the slot the gate is actually tracking, never a merely
    // preloaded-and-waiting slot (which must stay paused until its own turn).
    if (pendingGateSlotRef.current && pendingGateSlotRef.current !== activeFilmSlotRef.current) {
      getFilmVideo(pendingGateSlotRef.current)?.play().catch(() => {});
    }
    // #189 bug-2: the loaded track can be stale here -- e.g. the mood was changed
    // via the Music tab while the film sat paused and the [mood] effect above was
    // a no-op back then (paused already handled it, but guard anyway for any path
    // that could leave a mismatch, e.g. custom-path edge cases). Re-resolve
    // expected src and reconcile via syncMusic instead of a bare play().
    {
      const ma = musicAudioRef.current;
      if (ma && sound.mood !== "none") {
        const expectedSrc =
          sound.mood === "custom" && sound.customPath
            ? convertFileSrc(sound.customPath)
            : musicDir
            ? convertFileSrc(musicDir + "\\" + sound.mood + ".mp3")
            : null;
        if (expectedSrc && ma.currentSrc !== expectedSrc) {
          diagLog(`resume stale-src expected=${maTail(expectedSrc)} actual=${maTail(ma.currentSrc)}`);
          syncMusic("new-source", { play: true, positionMs: seqClockRef.current.seqTimeMs });
        } else {
          syncMusic("resume", { play: true, positionMs: 0 });
        }
      }
    }
    setIsFilmPlaying(true);
    setIsFilmPaused(false);
  }

  /**
   * #150: (re)start the autoplay-through-card ticker from `fromMs` elapsed — 0 for a fresh
   * hold, cardHoldElapsedMs for resuming after a manual pause. `baseFilmMs` is passed
   * explicitly (not read from cardHold state) because the very first call happens in the
   * same synchronous block as the setCardHold() that creates the hold — React state
   * wouldn't reflect it yet. ~100ms tick (matching the existing playhead-throttle
   * convention in handleFilmTimeUpdate) advances filmPlayheadMs so the strip needle
   * visibly moves, and fires continueFromCardHold at CARD_DUR_MS.
   */
  function startCardHoldTicker(fromMs: number, baseFilmMs: number) {
    cardHoldStartAtRef.current = performance.now() - fromMs;
    // #163/#174: baseFilmMs is the telescoped card-region START (from the sequence).
    // The strip needle is derived elsewhere (`filmPositionMs` = cardHold.filmMs +
    // clamped cardHoldElapsedMs); this ticker owns only the imperative progress bar
    // + label while parked (the rAF loop skips those pixels during a hold). Clamp to
    // the card-region WIDTH so at the hold's end it sits exactly at the next clip's
    // telescoped start -- no overshoot during the last ~xfade of the 3s hold.
    const holdRegionMs = filmCardRegionMs;
    if (cardHoldTickerRef.current !== null) clearInterval(cardHoldTickerRef.current);
    cardHoldTickerRef.current = setInterval(() => {
      const elapsed = performance.now() - cardHoldStartAtRef.current;
      if (elapsed >= CARD_DUR_MS) {
        if (cardHoldTickerRef.current !== null) {
          clearInterval(cardHoldTickerRef.current);
          cardHoldTickerRef.current = null;
        }
        continueFromCardHold();
      } else {
        setCardHoldElapsedMs(elapsed);
        const nMs = baseFilmMs + Math.min(elapsed, holdRegionMs);
        const tot = filmSeqRef.current?.totalMs ?? 0;
        if (progressBarFillRef.current && tot > 0) {
          progressBarFillRef.current.style.width = `${Math.min(100, (nMs / tot) * 100)}%`;
        }
        if (elapsedLabelRef.current) {
          elapsedLabelRef.current.textContent = `${fmtMs(nMs)} / ${fmtMs(tot)}`;
        }
      }
    }, 100);
  }

  /** Stop the ticker without resolving the hold — cardHoldElapsedMs is left as-is so a
   *  subsequent startCardHoldTicker(cardHoldElapsedMs) resumes from the same position. */
  function stopCardHoldTicker() {
    if (cardHoldTickerRef.current !== null) {
      clearInterval(cardHoldTickerRef.current);
      cardHoldTickerRef.current = null;
    }
  }

  /**
   * #184: arm a single card's hold — anchors the needle to that card's telescoped
   * filmStartMs (from the authoritative sequence), shows the overlay, starts the ticker.
   */
  function holdCard(card: PlacedCard) {
    const seq = filmSeqRef.current;
    const cardSeg = seq?.items.find((it) => it.kind === "card" && it.card?.id === card.id);
    const filmMs = cardSeg ? cardSeg.filmStartMs : (seq?.totalMs ?? 0);
    setCardHold({ filmMs, color: card.color, text: card.text, subtitle: card.subtitle });
    startCardHoldTicker(0, filmMs);
  }

  /**
   * #150/#184: end a card hold — fired by the autoplay ticker when it elapses, or by the
   * click handlers when the user manually skips ahead. If more cards remain in the run
   * (#184), hold the next one. Otherwise promote into the pending clip (music resumes
   * from where it already is — it was never paused) or cleanly end playback.
   */
  function continueFromCardHold() {
    stopCardHoldTicker();
    setCardHoldElapsedMs(0);
    // #184: still cards queued in this run — hold the next, don't promote yet.
    const run = pendingCardRunRef.current;
    if (run.length > 0) {
      pendingCardRunRef.current = run.slice(1);
      holdCard(run[0]);
      return;
    }
    const pendingIdx = pendingCardAdvanceIdxRef.current;
    setCardHold(null);
    pendingCardAdvanceIdxRef.current = null;
    pendingCardRunRef.current = []; // #184
    if (pendingIdx === null || pendingIdx >= inFilmRef.current.length) {
      stopFilmPlayback();
      return;
    }
    // #174: anchor the clock to the next clip's telescoped start NOW -- the derived
    // needle flips from the cardHold branch to `seqNeedleMs` the instant
    // setCardHold(null) commits, so the clock must already be there or the needle
    // snaps back to the card-region start for a frame before promoteToFilmClipRough
    // re-anchors it (that re-anchor is then idempotent).
    const seq = filmSeqRef.current;
    if (seq) anchorSeqClock(itemToFilm(seq, "clip", pendingIdx, 0));
    reconcileGateUntilRef.current = performance.now() + 350;
    filmPlayingRef.current = true;
    setIsFilmPlaying(true);
    setIsFilmPaused(false);
    // Defensive: music is only ever paused here if the user paused mid-card and then used
    // the overlay's "skip now" click rather than the play/pause button to resume — ensure
    // it's playing regardless of entry path. A no-op if it was never paused.
    musicAudioRef.current?.play().catch(() => {});
    promoteToFilmClipRough(pendingIdx);
  }

  /**
   * #150: pause/resume the play/pause button while a card is autoplaying — behaves like
   * pausing any other clip (freeze/re-arm the ticker from where it left off, and pause
   * music too — pausing playback is a real pause, unlike the card-entry point which
   * deliberately leaves music running) rather than skipping ahead.
   */
  function toggleCardHoldPause() {
    if (isFilmPlaying) {
      stopCardHoldTicker();
      filmPlayingRef.current = false;
      musicAudioRef.current?.pause();
      setIsFilmPlaying(false);
      setIsFilmPaused(true);
    } else {
      filmPlayingRef.current = true;
      musicAudioRef.current?.play().catch(() => {});
      setIsFilmPlaying(true);
      setIsFilmPaused(false);
      startCardHoldTicker(cardHoldElapsedMs, cardHold?.filmMs ?? 0);
    }
  }

  function stopFilmPlayback() {
    filmPlayingRef.current = false;
    pendingGateSlotRef.current = null;
    setCardHold(null); // #150: stopping mid-hold must not leave a stale overlay/pending index
    pendingCardAdvanceIdxRef.current = null;
    pendingCardRunRef.current = []; // #184
    stopCardHoldTicker();
    setCardHoldElapsedMs(0);
    filmVideoARef.current?.pause();
    filmVideoBRef.current?.pause();
    musicAudioRef.current?.pause();
    setIsFilmPlaying(false);
    setIsFilmPaused(false);
    filmPlayIdxRef.current = 0;
    // Do NOT call setSlotVisible("none") here — leave the last frame visible in the active slot.
    // startFilmPlayback resets activeFilmSlotRef and slotGenRef when restarting.
    setFilmPlayIdx(0);
    // #174: leave the sequence clock where playback stopped (≈ totalMs on a
    // natural end) so the strip needle + progress bar stay at the end frame,
    // matching Trimmer. startFilmPlayback re-anchors to 0 on replay.
  }

  // Seek the film to a telescoped sequence-time ms — the StickyFilmStrip ruler
  // domain AND the scrub-bar domain (both now card-inclusive). Works from idle,
  // playing, or paused. Music is kept in sync. #174: routes through the ONE
  // sequence resolver (`filmToMedia`) — no naive raw-clip walk, no open-card
  // special-case, no telescoped->naive conversion.
  function seekToFilmMs(targetMs: number) {
    const clips = inFilmRef.current;
    const seq = filmSeqRef.current;
    if (clips.length === 0 || !seq || seq.totalMs <= 0) return;

    // A seek is a legitimate exit from a card hold.
    setCardHold(null);
    pendingCardAdvanceIdxRef.current = null;
    pendingCardRunRef.current = []; // #184
    stopCardHoldTicker();
    setCardHoldElapsedMs(0);

    const clamped = Math.max(0, Math.min(targetMs, seq.totalMs));
    anchorSeqClock(clamped);
    reconcileGateUntilRef.current = performance.now() + 350;

    // Visual indicators jump immediately; the rAF loop keeps them live after.
    if (progressBarFillRef.current && seq.totalMs > 0) {
      progressBarFillRef.current.style.width = `${(clamped / seq.totalMs) * 100}%`;
    }
    if (elapsedLabelRef.current) {
      elapsedLabelRef.current.textContent = `${fmtMs(clamped)} / ${fmtMs(seq.totalMs)}`;
    }

    const media = filmToMedia(seq, clamped);

    // --- Landed on a card region: park the overlay (parity with Trimmer's
    // seekFilmTo B-lite park — press play then promotes into the next clip).
    if (media.kind === "card") {
      diagLog(
        `card-seek film=${clamped} cardIndex=${media.cardIndex} maPausedBefore=${musicAudioRef.current?.paused} maCurTime=${musicAudioRef.current?.currentTime.toFixed(2)}`,
      );
      const seg = seq.items.findIndex((it) => it.kind === "card" && it.index === media.cardIndex);
      if (seg < 0) return; // defensive: card index not found in sequence (shouldn't happen)

      // #189 bug-4: seeking onto a card now plays STRAIGHT THROUGH it (mirrors
      // advanceFilmClipRough's natural-advance card path) instead of pausing
      // music and parking indefinitely -- cards never silence music in the
      // render, and the old pause-without-reseeking left ma.currentTime stuck
      // at whatever position playback was at before the click (confirmed via
      // the #189 trace: clicking card 0 after 10s of playback left music
      // resuming from 10s in, not from the card's own position).
      filmVideoARef.current?.pause();
      filmVideoBRef.current?.pause();

      const runFromHere: PlacedCard[] = [];
      let nextClipIdx = clips.length; // trailing end-card sentinel
      for (let i = seg; i < seq.items.length; i++) {
        const it = seq.items[i];
        if (it.kind === "card" && it.card) runFromHere.push(it.card);
        else if (it.kind === "clip") { nextClipIdx = it.index; break; }
      }
      pendingCardAdvanceIdxRef.current = nextClipIdx;
      pendingCardRunRef.current = runFromHere.slice(1);

      filmPlayingRef.current = true;
      setIsFilmPlaying(true);
      setIsFilmPaused(false);

      syncMusic("same-source-reanchor", { play: true, positionMs: clamped });

      const card = runFromHere[0];
      const cardStartMs = seq.items[seg].filmStartMs;
      // Resume the hold from wherever inside the card the user actually clicked,
      // not always from the card's start.
      setCardHold({ filmMs: cardStartMs, color: card.color, text: card.text, subtitle: card.subtitle });
      startCardHoldTicker(Math.max(0, clamped - cardStartMs), cardStartMs);
      return;
    }

    // --- Landed in a clip.
    const idx = media.clipIndex;
    const seekMs = media.mediaMs;

    const wasIdle = !filmPlayingRef.current && !isFilmPaused;

    if (wasIdle) {
      syncMusic("new-source", { play: sound.mood !== "none", positionMs: clamped });
    } else {
      const stillPlaying = filmPlayingRef.current && !isFilmPaused;
      syncMusic("same-source-reanchor", { play: stillPlaying, positionMs: clamped });
    }

    if (wasIdle) {
      hasPlayedRef.current = true;
      filmPlayingRef.current = true;
      activeFilmSlotRef.current = "a";
      slotGenRef.current = { a: 0, b: 0 };
      setIsFilmPlaying(true);
      setIsFilmPaused(false);
      // Load into slot A with seek target; music play/position is handled by syncMusic above
      loadIntoSlot(idx, "a", seekMs);
      return;
    }

    // Mid-playback or paused: use cross-slot seek if different clip, direct seek if same
    if (filmPlayIdxRef.current === idx) {
      // Same clip — seek in the active slot directly
      const v = getFilmVideo(activeFilmSlotRef.current);
      if (v) {
        v.currentTime = seekMs / 1000;
        if (filmPlayingRef.current) v.play().catch(() => {});
      }
      filmPlayIdxRef.current = idx;
      setFilmPlayIdx(idx);
    } else {
      // Different clip — use crossSeekToClip (outgoing frame stays visible until new frame ready)
      crossSeekToClip(idx, seekMs);
    }
  }

  // #174: the StickyFilmStrip ruler already speaks telescoped, card-inclusive
  // sequence time — the exact domain seekToFilmMs now consumes — so a strip click
  // is a straight passthrough. (Was: a `hasOpenCard` special-case plus a
  // telescoped->naive conversion walk, both removed with the naive timeline.)
  function handleStripSeek(telescopedMs: number) {
    seekToFilmMs(telescopedMs);
  }

  function startCustomPreview() {
    if (!sound.customPath || !audioRef.current) return;
    const audio = audioRef.current;
    audio.src = convertFileSrc(sound.customPath);
    audio.volume = VOLUME_LEVELS[sound.volume];
    audio.currentTime = 0;
    audio.play().catch(() => {});
    setPreviewingCustom(true);
    if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      audioRef.current?.pause();
      setPreviewingCustom(false);
      previewTimerRef.current = null;
    }, PREVIEW_DURATION_MS);
  }

  function startPreview(mood: LibraryMood, volume: MusicVolume = sound.volume) {
    if (!musicDir || !audioRef.current) return;
    const audio = audioRef.current;
    audio.src = convertFileSrc(musicDir + "\\" + mood + ".mp3");
    audio.volume = VOLUME_LEVELS[volume];
    audio.currentTime = 0;
    audio.play().catch(() => {});
    setPreviewingMood(mood);
    if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(() => {
      audioRef.current?.pause();
      setPreviewingMood(null);
      previewTimerRef.current = null;
    }, PREVIEW_DURATION_MS);
  }

  function persist(next: SoundState) {
    if (next.mood !== sound.mood || next.customPath !== sound.customPath) {
      diagLog(
        `mood-change ${sound.mood}->${next.mood} filmPlaying=${filmPlayingRef.current} isFilmPaused=${isFilmPaused} needle=${seqClockRef.current.seqTimeMs.toFixed(0)} maCurSrc=${maTail(musicAudioRef.current?.currentSrc)}`,
      );
    }
    setSound(next);
    setRenderPref(storageKey, JSON.stringify(next));
  }

  function handleSourceClick(newSource: MusicSource) {
    if (newSource === "none") {
      stopPreview();
      setCustomDurationMs(null);
      persist({ ...sound, mood: "none" });
    } else if (newSource === "library") {
      if (source === "library") return;
      stopPreview();
      setCustomDurationMs(null);
      const targetMood = libraryMood ?? "cinematic";
      persist({ ...sound, mood: targetMood });
    } else {
      if (source === "custom") return;
      stopPreview();
      persist({ ...sound, mood: "custom" });
    }
  }

  function handleLibraryMoodClick(mood: LibraryMood) {
    persist({ ...sound, mood });
    startPreview(mood);
  }

  function handleMusicTabChange(t: MusicTab) {
    if (t !== "mixer" && (isFilmPlaying || isFilmPaused)) stopFilmPlayback();
    if (t === "mixer") stopPreview();   // stop mood chip preview when entering Master
    setMusicTab(t);
  }

  function handleVolume(volume: MusicVolume) {
    persist({ ...sound, volume });
    if (audioRef.current && (previewingMood || previewingCustom)) {
      audioRef.current.volume = VOLUME_LEVELS[volume];
    }
    // real-time update handled by useEffect above
  }

  function handleFadeOut(musicFadeOut: MusicFadeOut) {
    persist({ ...sound, musicFadeOut });
  }

  function handleLoopToggle() {
    const musicLoop = !sound.musicLoop;
    // Apply to a live preview immediately so the user hears the change without restarting
    if (musicAudioRef.current) musicAudioRef.current.loop = musicLoop;
    persist({ ...sound, musicLoop });
  }

  async function handleCustomTrack() {
    stopPreview();
    const result = await open({ filters: [{ name: "Audio", extensions: ["mp3", "m4a", "wav", "aac", "flac"] }] });
    if (!result) return;
    const customPath = typeof result === "string" ? result : Array.isArray(result) ? result[0] : null;
    if (!customPath) return;
    persist({ ...sound, mood: "custom", customPath });
    if (audioRef.current) {
      const handler = () => {
        setCustomDurationMs((audioRef.current?.duration ?? 0) * 1000);
      };
      audioRef.current.addEventListener("loadedmetadata", handler, { once: true });
      audioRef.current.preload = "metadata";
      audioRef.current.src = convertFileSrc(customPath);
    }
  }

  function sourceChipClass(s: MusicSource): string {
    const base = "text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium";
    const isActive = source === s;
    if (s === "none") {
      return isActive
        ? `${base} border-white/60 text-white bg-white/15`
        : `${base} border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5`;
    }
    return isActive
      ? `${base} border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10`
      : `${base} border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5`;
  }

  function moodChipClass(value: LibraryMood): string {
    const base = "text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium";
    return libraryMood === value
      ? `${base} border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10`
      : `${base} border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5`;
  }

  const moodDescription =
    source === "library" && libraryMood
      ? LIBRARY_MOODS.find((m) => m.value === libraryMood)?.description
      : source === "custom" && sound.customPath
      ? "Your own audio track will be mixed with your clips."
      : source === "none"
      ? "Your film will render without a music track."
      : null;

  const selectedTrackMs =
    source === "library" && libraryMood && trackDurations[libraryMood] !== undefined
      ? trackDurations[libraryMood]! * 1000
      : source === "custom" && customDurationMs !== null
      ? customDurationMs
      : null;

  // #62: music coverage/loop math compares the track to the EFFECTIVE (telescoped) film.
  const showComparison = source !== "none" && effectiveMs > 0 && selectedTrackMs !== null;

  const loopNote: React.ReactNode =
    !showComparison ? null
    : selectedTrackMs! >= effectiveMs
    ? <span className="text-[#22c55e]"> &mdash; long enough</span>
    : sound.musicLoop
    ? <span> &mdash; will loop ~{Math.ceil(effectiveMs / selectedTrackMs!)}x</span>
    : <span> &mdash; plays once, then silence</span>;

  return (
    <EditorShell
      projectId={projectId ?? ""}
      projectName={projectName}
      clipCount={clipCount}
      totalMs={effectiveMs}
      activeTab="sound"
      configured={configured}
      transitionValue={transitionVal}
      openingTransition={openingTransitionVal}
      closingTransition={closingTransitionVal}
      soundMood={sound.mood}
      timelineGutter={
        proxyFallbackClipId ? (
          <div className="h-full flex items-start p-3">
            <div className="w-full bg-white/5 border border-white/10 border-l-2 border-l-[#FF8A65] rounded-md p-3 flex items-start justify-between gap-2">
              <p className="text-sm text-[#e5e5e5]">Video may look choppy right now -- it'll smooth out on its own.</p>
              <button
                type="button"
                onClick={() => setProxyFallbackClipId(null)}
                className="text-[#a3a3a3] hover:text-[#e5e5e5] flex-shrink-0 leading-none"
                aria-label="Dismiss"
              >
                &times;
              </button>
            </div>
          </div>
        ) : null
      }
      timelineHud={
        <StickyFilmStrip
          clips={clips}
          projectId={projectId!}
          xfadeOverlapMs={clampedXfadeMs(inFilm, readTransitionConfig(projectId ?? ""))}
          cards={placedCards.map((c): PositionedCard => ({
            card: { id: c.id, color: c.color, text: c.text },
            beforeClipId: c.beforeClipId,
          }))}
          playheadMs={filmPositionMs}
          onSeek={handleStripSeek}
        />
      }
    >
      <audio ref={audioRef} />
      <audio ref={musicAudioRef} />

      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {/* In-screen tab bar */}
        <div className="flex items-center justify-center gap-2 px-6 pt-3 pb-3 border-b border-white/10 flex-shrink-0">
          {(["music", "mixer"] as MusicTab[]).map((t) => (
            <button
              key={t}
              type="button"
              data-testid={`music-tab-${t}`}
              onClick={() => handleMusicTabChange(t)}
              className={`text-sm rounded-md px-4 py-1.5 border transition-all duration-200 font-medium ${
                musicTab === t
                  ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                  : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
              }`}
            >
              {t === "music" ? "Music" : "Master"}
            </button>
          ))}
        </div>

        {/* ── Music tab ──────────────────────────────────────────────── */}
        <div className={musicTab === "music" ? "flex-1 overflow-y-auto" : "hidden"}>
          <div className="max-w-2xl mx-auto px-6 py-10 space-y-8">
            <h1 className="text-3xl font-semibold text-[#FF8A65]">Music</h1>

            {/* Music picker card */}
            <div className="border border-white/15 rounded-lg p-6 space-y-4">
              {/* Source selector — 3 top-level options */}
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  data-testid="chip-mood-none"
                  onClick={() => handleSourceClick("none")}
                  className={sourceChipClass("none")}
                >
                  No Music
                </button>
                <button
                  type="button"
                  data-testid="chip-source-library"
                  onClick={() => handleSourceClick("library")}
                  className={sourceChipClass("library")}
                >
                  Rushcut Library
                </button>
                <button
                  type="button"
                  data-testid="chip-mood-custom"
                  onClick={() => handleSourceClick("custom")}
                  className={sourceChipClass("custom")}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="w-3.5 h-3.5 mr-1.5 shrink-0 inline-block"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Upload Own Track
                </button>
              </div>

              {/* Library mood sub-chips */}
              {source === "library" && (
                <>
                  <div className="border-t border-white/10" />
                  <div className="flex flex-wrap gap-3">
                    {LIBRARY_MOODS.map(({ value, label }) => (
                      <button
                        key={value}
                        type="button"
                        data-testid={`chip-mood-${value}`}
                        onClick={() => handleLibraryMoodClick(value)}
                        className={moodChipClass(value)}
                      >
                        {label}{trackDurations[value] !== undefined ? ` · ${fmtMs(trackDurations[value]! * 1000)}` : ""}
                      </button>
                    ))}
                  </div>
                </>
              )}

              {/* Custom track — empty state */}
              {source === "custom" && !sound.customPath && (
                <button
                  type="button"
                  onClick={handleCustomTrack}
                  className="flex items-center gap-2 w-full px-4 py-3 rounded-md border border-dashed border-white/25 text-sm text-[#a3a3a3] hover:border-white/50 hover:text-[#e5e5e5] transition-all duration-200"
                >
                  <svg
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                    strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 shrink-0"
                  >
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                  Choose audio file...
                </button>
              )}

              {/* Custom track — file chosen */}
              {source === "custom" && sound.customPath && (
                <div className="flex items-center gap-3">
                  <p className="text-base font-semibold text-[#e5e5e5] truncate flex-1">
                    {sound.customPath.split("\\").pop() ?? sound.customPath.split("/").pop()}
                  </p>
                  <button
                    type="button"
                    onClick={previewingCustom ? stopPreview : startCustomPreview}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm font-medium transition-all duration-200 shrink-0 ${
                      previewingCustom
                        ? "border-white/60 text-white bg-white/10"
                        : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                    }`}
                  >
                    {previewingCustom ? (
                      <>
                        <svg viewBox="0 0 15 15" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                          <rect x="3" y="3" width="9" height="9" rx="0.5" />
                        </svg>
                        Stop
                      </>
                    ) : (
                      <>
                        {/* Play — teenyicons MIT: https://github.com/teenyicons/teenyicons */}
                        <svg viewBox="0 0 15 15" fill="currentColor" className="w-3.5 h-3.5 shrink-0">
                          <path d="M4.79062 2.09314C4.63821 1.98427 4.43774 1.96972 4.27121 2.05542C4.10467 2.14112 4 2.31271 4 2.5V12.5C4 12.6873 4.10467 12.8589 4.27121 12.9446C4.43774 13.0303 4.63821 13.0157 4.79062 12.9069L11.7906 7.90687C11.922 7.81301 12 7.66148 12 7.5C12 7.33853 11.922 7.18699 11.7906 7.09314L4.79062 2.09314Z" />
                        </svg>
                        Preview
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleCustomTrack}
                    className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors shrink-0"
                  >
                    Change
                  </button>
                </div>
              )}

              {/* Stop preview link */}
              {previewingMood && (
                <button
                  onClick={stopPreview}
                  className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] cursor-pointer transition-colors"
                >
                  Stop preview
                </button>
              )}

              {/* Description */}
              {moodDescription && (
                <p className="text-sm text-[#a3a3a3]">{moodDescription}</p>
              )}

              {/* Film vs track duration comparison */}
              {showComparison && (
                <p className="text-sm text-[#a3a3a3]">
                  Film: {fmtMs(effectiveMs)} &middot; Track: {fmtMs(selectedTrackMs!)}{loopNote}
                </p>
              )}
            </div>

            {/* Music fade-out — set here once, applied at render and in the Master preview */}
            <div className="border border-white/15 rounded-lg p-5 space-y-3">
              <div>
                <p className="text-base font-medium text-[#e5e5e5]">Music fade-out</p>
                <p className="text-sm text-[#a3a3a3] mt-0.5">
                  How should the music tail off at the end of the film?
                </p>
              </div>
              <div className="flex gap-3">
                {FADE_OUT_OPTIONS.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`chip-fadeout-${value}`}
                    onClick={() => handleFadeOut(value)}
                    className={`text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium ${
                      sound.musicFadeOut === value
                        ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                        : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Loop music — fill the film when the track is shorter than the film */}
            <div className="border border-white/15 rounded-lg p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-base font-medium text-[#e5e5e5]">Loop music to fill film</p>
                <p className="text-sm text-[#a3a3a3] mt-0.5">
                  When the track is shorter than the film, repeat it. Off plays the track once, then silence.
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={sound.musicLoop}
                data-testid="toggle-music-loop"
                onClick={handleLoopToggle}
                className={`relative w-11 h-6 rounded-full flex-shrink-0 transition-colors duration-200 ${
                  sound.musicLoop ? "bg-[#99B3FF]" : "bg-white/25"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-200 ${
                    sound.musicLoop ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            <p className="text-sm text-[#a3a3a3]">
              Settings are saved automatically. Head to Master to preview with music.
            </p>
          </div>
        </div>

        {/* ── Master mixer tab — full film preview + music controls ── */}
        <div className={musicTab === "mixer" ? "flex flex-1 min-h-0" : "hidden"}>

          {/* Center: video player + controls bar */}
          <div className="flex flex-col flex-1 min-h-0 min-w-0">
            {/* Video area — dual-buffer A/B slots (mirrors Trimmer.tsx lines 770–846) */}
            <div className="flex-1 bg-black min-h-0 relative overflow-hidden">
              {/* Slot A */}
              <video
                ref={filmVideoARef}
                preload="auto"
                playsInline
                className={`absolute inset-0 w-full h-full object-contain ${inFilm.length > 0 ? "cursor-pointer" : ""}`}
                onClick={
                  cardHold ? toggleCardHoldPause
                  : isFilmPlaying ? pauseFilmPlayback
                  : isFilmPaused ? resumeFilmPlayback
                  : inFilm.length > 0 ? startFilmPlayback
                  : undefined
                }
                onEnded={() => { if (activeFilmSlotRef.current === "a") advanceFilmClipRough(); }}
                onError={() => handleSlotError("a")}
                onTimeUpdate={(e) => {
                  if (activeFilmSlotRef.current !== "a") return;
                  handleFilmTimeUpdate("a", (e.currentTarget as HTMLVideoElement).currentTime);
                }}
              />
              {/* Slot B */}
              <video
                ref={filmVideoBRef}
                preload="auto"
                playsInline
                className={`absolute inset-0 w-full h-full object-contain ${inFilm.length > 0 ? "cursor-pointer" : ""}`}
                onClick={
                  cardHold ? toggleCardHoldPause
                  : isFilmPlaying ? pauseFilmPlayback
                  : isFilmPaused ? resumeFilmPlayback
                  : inFilm.length > 0 ? startFilmPlayback
                  : undefined
                }
                onEnded={() => { if (activeFilmSlotRef.current === "b") advanceFilmClipRough(); }}
                onError={() => handleSlotError("b")}
                onTimeUpdate={(e) => {
                  if (activeFilmSlotRef.current !== "b") return;
                  handleFilmTimeUpdate("b", (e.currentTarget as HTMLVideoElement).currentTime);
                }}
              />
              {/* Placeholder — shown only when truly idle and never started playing.
                  hasPlayedRef prevents re-showing after natural film end. */}
              {!isFilmPlaying && !isFilmPaused && !hasPlayedRef.current && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <p className="text-sm text-[#a3a3a3]">
                    {inFilm.length === 0 ? "No clips in film" : "Press play to preview"}
                  </p>
                </div>
              )}
              {/* U6 Bug B: idle click-catcher. The slot <video>s start at pointer-events:none
                  (set on mount + by setSlotVisible), so on first entry no element receives the
                  click. This transparent overlay (z-10, above the videos) lets a click anywhere
                  on the preview start playback. It unmounts the instant playback starts, so it
                  never intercepts the pause/resume toggle that the visible slot then handles. */}
              {!isFilmPlaying && !isFilmPaused && inFilm.length > 0 && (
                <div
                  className="absolute inset-0 z-10 cursor-pointer"
                  onClick={startFilmPlayback}
                />
              )}
              {/* #150: full parity with Trimmer's card-hold colour overlay (src/pages/Trimmer.tsx) —
                  ported verbatim, plus a click-to-resume affordance matching Sound's existing
                  click-video-to-play-pause pattern. */}
              {cardHold && (
                <div
                  className="absolute inset-0 flex items-center justify-center z-20 cursor-pointer"
                  style={{ background: cardHold.color }}
                  onClick={continueFromCardHold}
                >
                  {(cardHold.text || cardHold.subtitle) && (
                    <div className="flex flex-col items-center gap-2 px-8 select-none">
                      {cardHold.text && (
                        <p
                          className="text-center font-semibold"
                          style={{ color: cardTextColor(cardHold.color), fontSize: "clamp(1.25rem, 3vw, 2.5rem)" }}
                        >
                          {cardHold.text}
                        </p>
                      )}
                      {cardHold.subtitle && (
                        <p
                          className="text-center font-normal"
                          style={{ color: cardTextColor(cardHold.color), fontSize: "clamp(0.875rem, 1.8vw, 1.5rem)", opacity: 0.75 }}
                        >
                          {cardHold.subtitle}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Controls bar — relative z-20 so scrubber + play button always win the
                stacking order over the idle click-catcher overlay (defensive; they're
                already a separate sibling below the video area). */}
            <div className="relative z-20 flex items-center gap-3 px-4 py-3 border-t border-white/10 flex-shrink-0">
              {/* Play / Pause button — canonical media button per DESIGN.md */}
              <button
                data-testid="master-playpause"
                disabled={inFilm.length === 0}
                onClick={
                  cardHold ? toggleCardHoldPause
                  : isFilmPlaying ? pauseFilmPlayback
                  : isFilmPaused ? resumeFilmPlayback
                  : startFilmPlayback
                }
                className="w-10 h-10 flex items-center justify-center rounded-full bg-[#FF8A65] text-white hover:bg-[#ff9e7a] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex-shrink-0"
              >
                {isFilmPlaying
                  ? <Pause size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />
                  : <Play  size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />
                }
              </button>

              {/* Seekable progress bar with fade-out marker */}
              <div
                role="slider"
                aria-label="Film progress"
                className="flex-1 h-1.5 bg-white/20 rounded-full cursor-pointer relative"
                onClick={(e) => {
                  if (inFilm.length === 0 || totalMs === 0) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  seekToFilmMs(Math.round(frac * totalMs));
                }}
              >
                <div
                  ref={progressBarFillRef}
                  className="h-full bg-[#FF8A65] rounded-full pointer-events-none"
                  style={{ width: "0%" }}
                />
                {/* Fade-out marker — vertical tick + label showing where music starts fading */}
                {(() => {
                  const fadeMs = ({ none: 0, "2s": 2000, "5s": 5000 } as Record<string, number>)[sound.musicFadeOut] ?? 0;
                  if (fadeMs <= 0 || totalMs <= 0 || sound.mood === "none") return null;
                  const pct = Math.max(0, ((totalMs - fadeMs) / totalMs) * 100);
                  return (
                    <div
                      className="absolute pointer-events-none"
                      style={{ left: `${pct}%`, top: "50%", transform: "translate(-50%, -50%)" }}
                    >
                      {/* Label above the tick — "fade 2s" */}
                      <span className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 text-[9px] text-white/50 whitespace-nowrap leading-none">
                        fade {sound.musicFadeOut}
                      </span>
                      {/* Tick */}
                      <div className="h-3 w-0.5 bg-white/70 mx-auto" />
                    </div>
                  );
                })()}
              </div>

              {/* Elapsed / total timer */}
              <span
                ref={elapsedLabelRef}
                className="text-sm text-[#e5e5e5] flex-shrink-0 tabular-nums font-mono"
              >
                {`${fmtMs(0)} / ${fmtMs(totalMs)}`}
              </span>
            </div>
          </div>

          {/* Right sidebar: music controls */}
          <div className="w-52 flex-shrink-0 border-l border-white/10 overflow-y-auto">
            <div className="p-4 space-y-6">

              {/* Current music selection */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[#a3a3a3] mb-2">Music</p>
                {sound.mood === "none" ? (
                  <p className="text-sm text-[#a3a3a3]">None &mdash; set in Music tab</p>
                ) : sound.mood === "custom" ? (
                  <p className="text-sm text-[#e5e5e5] truncate">
                    {sound.customPath?.split("\\").pop() ?? "Custom track"}
                  </p>
                ) : (
                  <p className="text-sm font-medium text-[#e5e5e5]">
                    {LIBRARY_MOODS.find((m) => m.value === sound.mood)?.label}
                  </p>
                )}
              </div>

              {/* Volume */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-[#a3a3a3] mb-2">Volume</p>
                <div className="flex flex-col gap-2">
                  {VOLUMES.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      data-testid={`chip-volume-${value}`}
                      onClick={() => handleVolume(value)}
                      className={`text-sm rounded-md px-3 py-1.5 border transition-all duration-200 font-medium text-left ${
                        sound.volume === value
                          ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                          : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <p className="text-xs text-[#a3a3a3]">
                Settings saved automatically.{sound.musicFadeOut !== "none" ? ` Fade-out: ${sound.musicFadeOut}.` : ""}
              </p>
            </div>
          </div>
        </div>
      </div>
    </EditorShell>
  );
}

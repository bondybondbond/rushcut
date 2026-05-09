# RushCut Design System

> Lock this down before any UI work. All colours, sizes, and component patterns here are canonical.

## Product positioning

> **"RushCut does not decide your memories for you. It helps you shape them quickly."**

User decides. Pipeline executes. Every UI decision should reinforce this: give control clearly, remove friction fast, never surprise the user with an invisible choice the system made on their behalf.

---

## Colours

| Token                 | Hex                      | Usage                                                              |
| --------------------- | ------------------------ | ------------------------------------------------------------------ |
| `--rc-bg`             | `#0a0a0a`                | Page background (forced dark)                                      |
| `--rc-surface`        | `rgba(255,255,255,0.05)` | Card / row surfaces                                                |
| `--rc-border`         | `rgba(255,255,255,0.15)` | Default borders                                                    |
| `--rc-border-strong`  | `rgba(255,255,255,0.35)` | Hover / active borders                                             |
| `--rc-text-primary`   | `#e5e5e5`                | Body text, labels                                                  |
| `--rc-text-secondary` | `#a3a3a3`                | Subtext, descriptions                                              |
| `--rc-text-muted`     | `#555555`                | Placeholder, de-emphasised                                         |
| **`--rc-peach`**      | `#FF8A65`                | **Headings, primary CTA, active state**                            |
| `--rc-peach-hover`    | `#ff9e7a`                | CTA hover                                                          |
| **`--rc-sand`**       | `#C9A96E`                | **Upload zone border, secondary accents (warm layer under peach)** |
| `--rc-green`          | `#22c55e`                | Progress bars (upload + render)                                    |
| `--rc-red`            | red-400 Tailwind         | Errors, probe failures                                             |

### Text colour rules

- **Never use `#555555` (`--rc-text-muted`) for visible readable content** — it is too dim on dark backgrounds. Use only for purely decorative / placeholder text.
- **Never use grey (`text-gray-*`, `text-[#808080]` etc.) anywhere** — use `#e5e5e5` (primary) or `#a3a3a3` (secondary) only.
- Minimum readable text colour: `#a3a3a3`.

---

## Typography

All sizes are 2 steps above base Tailwind defaults (i.e. never use `text-xs` for readable content).

| Role            | Class                                   | Size        |
| --------------- | --------------------------------------- | ----------- |
| Page heading    | `text-3xl font-semibold text-[#FF8A65]` | 30px, peach |
| Section heading | `text-xl font-medium text-[#e5e5e5]`    | 20px        |
| Body / labels   | `text-base text-[#e5e5e5]`              | 16px        |
| Secondary text  | `text-base text-[#a3a3a3]`              | 16px        |
| Small label     | `text-sm text-[#a3a3a3]`                | 14px        |
| Muted / hint    | `text-sm text-[#555555]`                | 14px        |

---

## Buttons

### Primary CTA (peach)

```tsx
className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 text-base disabled:opacity-40 disabled:cursor-not-allowed"
```

### Secondary (outlined)

```tsx
className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
```

---

## Progress Bars

Always **green** (`#22c55e`), never white/grey.

```tsx
{/* Determinate (upload per-file) */}
<div className="h-1 bg-white/10 rounded-full overflow-hidden">
  <div className="h-full bg-[#22c55e] transition-all duration-300" style={{ width: `${pct}%` }} />
</div>

{/* Indeterminate (render polling) — uses globals.css .progress-indeterminate */}
<div className="h-2 bg-white/10 rounded-full overflow-hidden relative">
  <div className="progress-indeterminate absolute top-0 bottom-0 bg-[#22c55e] rounded-full" />
</div>

{/* Complete */}
<div className="h-2 bg-white/10 rounded-full overflow-hidden">
  <div className="h-full w-full bg-[#22c55e] rounded-full" />
</div>
```

---

## Configure Panel Chips

Chip active accent: `#99B3FF` (blue) — used for music mood, volume preset, transition chips.
Card color-swatch selected ring: `#FF8A65` (peach) — kept for card background pickers only.

**Chip text size: minimum `text-sm`.** Never `text-xs` — chip labels are readable interactive content, not decorative. Note: `SettingsPanel.tsx` currently uses `text-xs` on its chips (pre-15e deviation); new screens must use `text-sm`.

```tsx
{/* Active */}
"text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"

{/* Inactive */}
"text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
```

Toggle: ON = `bg-[#99B3FF]`, OFF = `bg-white/25`.

### Resolution gate chip (Render screen pattern)

When a render setting must be locked before the render commits (e.g. output resolution), show the choice as a chip row inside a bordered card followed by a primary CTA. Once the CTA is clicked and the job starts, the entire chip row disappears — it only exists in the `"ready"` phase.

Trigger: only show the gate when the project actually has the capability (e.g. 4K clips detected via `has_4k_clips_cmd`). Projects without 4K clips auto-start with no gate — no friction.

```tsx
{phase === "ready" && (
  <div className="space-y-6">
    <div className="border border-white/15 rounded-lg p-6 space-y-4">
      <div>
        <p className="text-xl font-medium text-[#e5e5e5]">Setting Heading</p>
        <p className="text-sm text-[#a3a3a3] mt-0.5">Explanation of the choice.</p>
      </div>
      <div className="flex gap-3">
        {(["option-a", "option-b"] as const).map((r) => (
          <button key={r} type="button" data-testid={`chip-res-${r}`}
            onClick={() => handleSelect(r)}
            className={`text-sm rounded-md px-4 py-2 border transition-all duration-200 font-medium ${
              selected === r
                ? "border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10"
                : "border-white/35 text-[#e5e5e5] hover:border-white/60 hover:bg-white/5"
            }`}>
            {r}
          </button>
        ))}
      </div>
    </div>
    <button data-testid="btn-render-film" onClick={handleCommit}
      className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 text-base">
      Render Film
    </button>
  </div>
)}
```

Rules:
- Selection persists to `sessionStorage` so Retry re-reads it.
- `buildConfig()` is called at click time (not at mount) so it captures the current chip state.
- `"ready"` phase is conditional: only entered when `is4K === true`. Non-4K projects skip directly to `"starting"`.

### Conditional chip row (Sound screen pattern)

When a secondary chip group only applies in certain states (e.g. volume only when a music mood is selected), render it conditionally — no animation, plain `{condition && <div>...</div>}`. Separate from the primary chip group with `border-t border-white/10 pt-2 space-y-3`. Sub-heading uses `text-base font-medium text-[#e5e5e5]` + description `text-sm text-[#a3a3a3]`.

```tsx
{primaryValue !== "none" && (
  <div className="pt-2 border-t border-white/10 space-y-3">
    <div>
      <p className="text-base font-medium text-[#e5e5e5]">Sub-heading</p>
      <p className="text-sm text-[#a3a3a3] mt-0.5">Description.</p>
    </div>
    <div className="flex flex-wrap gap-3">
      {/* chips */}
    </div>
  </div>
)}
```

### Source selector pattern (Sound screen — three top-level sources)

When the user chooses between fundamentally different content sources (e.g. No Music / Rushcut Library / Upload Own Track), render three source chips in a row at the top of the card. Selecting a source expands sub-content below with a thin separator.

**Active state per source type:**
- "Off" source (e.g. No Music): `border-white/60 text-white bg-white/15` — bright white signals "off" unambiguously, not music-blue
- "On" sources (Library, Upload): standard `border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10`

**Critical:** the off-state active class must use a token *not* present as a hover variant in the inactive class. Use `bg-white/15` (not `border-white/60`) as the E2E discriminator — inactive class has `hover:border-white/60` which would cause false matches.

```tsx
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
```

Sub-chips (e.g. mood chips inside Library): separated by `border-t border-white/10`, rendered only when that source is active. Use standard `#99B3FF` active style.

**Clicking a source chip must NOT open OS dialogs automatically** — clicking "Upload Own Track" expands the section; the file picker opens only via an explicit "Choose file" / "Change" button inside the expanded area. This prevents re-opening the dialog when the user has already picked a file and switches sources temporarily.

**State persistence across source switches:** preserve `customPath` in all state mutations even when switching to Library or No Music, so switching back to "Upload Own Track" restores the previously picked file without requiring re-upload.

### File picker empty/filled state (Upload Own Track pattern)

When a source requires a file picked via OS dialog, show two distinct states inside the expanded section:

**Empty state** — no file chosen yet:
```tsx
<button type="button" onClick={handleCustomTrack}
  className="flex items-center gap-2 w-full px-4 py-3 rounded-md border border-dashed border-white/25 text-sm text-[#a3a3a3] hover:border-white/50 hover:text-[#e5e5e5] transition-all duration-200">
  <UploadSVG className="w-4 h-4 shrink-0" />
  Choose audio file...
</button>
```

**File chosen** — filename (prominent) + preview button + change link in a single row:
```tsx
<div className="flex items-center gap-3">
  <p className="text-base font-semibold text-[#e5e5e5] truncate flex-1">filename.mp3</p>
  <button ...>Preview / Stop</button>    {/* bordered chip button */}
  <button onClick={handleCustomTrack} className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] transition-colors shrink-0">Change</button>
</div>
```

Filename: `text-base font-semibold text-[#e5e5e5]` — 2 size steps above description text so it reads as a selected value, not a label. Extract basename only: `.split("\\").pop() ?? .split("/").pop()`.

`open()` from `@tauri-apps/plugin-dialog` returns a plain `string` on Windows. Guard: `typeof result === "string" ? result : Array.isArray(result) ? result[0] : null`. `dialog:allow-open` capability is already wired.

### Duration badge on chips

When a chip represents content with a known duration (e.g. a music track), append the duration inline in the chip label: `"Cinematic · 2:34"`. The badge is part of the chip text node — not a separate element — so it inherits the chip's active/inactive colour automatically.

Rules:
- Use `·` (middle dot `&middot;`) as the separator, with a space on each side.
- Format via `fmtMs(ms)` — `M:SS` (minutes + zero-padded seconds). Define inline per file, not as a shared util.
- Only show the badge when the duration is known. Render the bare label while probing: `{label}{dur !== undefined ? \` · ${fmtMs(dur * 1000)}\` : ""}`.
- Probe library track durations with `audio.preload = "metadata"` — fetches only ID3 headers, not the full file. Gate with a `probedRef` to prevent repeat probes on re-mount.
- The `·` separator sits inside the chip text, so chip width grows naturally. No fixed-width layout needed.

```tsx
{label}{trackDurations[value] !== undefined ? ` · ${fmtMs(trackDurations[value]! * 1000)}` : ""}
```

### Film vs track duration comparison line

When both film duration and selected track duration are known, show a one-line summary below the mood description, before the Volume row:

```tsx
<p className="text-sm text-[#a3a3a3]">
  Film: {fmtMs(filmDurationMs)} &middot; Track: {fmtMs(selectedTrackMs)}{loopNote}
</p>
```

Where `loopNote` is a derived `React.ReactNode` (computed above `return`, not an IIFE in JSX):
- Track ≥ film: `<span className="text-[#22c55e]"> &mdash; long enough</span>` — green (`--rc-green`)
- Track < film: `<span> &mdash; will loop ~{Math.ceil(filmDurationMs / selectedTrackMs)}x</span>` — secondary text, neutral

Only render when `filmDurationMs > 0 && selectedTrackMs !== null` — never show "0:00" or an empty comparison while data is loading.

### Audio preview pattern (hidden `<audio>` + stop-link)

For mood/track previewing without visible player controls:

```tsx
const audioRef = useRef<HTMLAudioElement>(null);
const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);  // must be useRef, not useState

// Render — hidden, no controls
<audio ref={audioRef} />

// Start preview
function startPreview(mood: LibraryMood, volume: MusicVolume = sound.volume) {
  if (!musicDir || !audioRef.current) return;
  const audio = audioRef.current;
  audio.src = convertFileSrc(musicDir + "\\" + mood + ".mp3");
  audio.volume = VOLUME_LEVELS[volume];  // VOLUME_LEVELS = { subtle: 0.3, balanced: 0.6, prominent: 1.0 }
  audio.currentTime = 0;
  audio.play().catch(() => {});
  setPreviewingMood(mood);
  if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
  previewTimerRef.current = setTimeout(() => {
    audioRef.current?.pause();
    setPreviewingMood(null);
    previewTimerRef.current = null;
  }, 30_000);
}

// Stop link — shown only while preview is active
{previewingMood && (
  <button onClick={stopPreview}
    className="text-sm text-[#a3a3a3] hover:text-[#e5e5e5] cursor-pointer transition-colors">
    Stop preview
  </button>
)}

// Unmount cleanup
useEffect(() => () => {
  audioRef.current?.pause();
  if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
}, []);
```

**`previewTimerRef` must be `useRef`, never `useState` or `let`.** A plain `let` is re-created on every render — `clearTimeout` cancels the wrong ID. `useState` causes an extra render on set. `useRef` persists the timer handle identity across renders.

Volume chip changes must update live preview volume: `if (audioRef.current && isPlaying) audioRef.current.volume = VOLUME_LEVELS[volume]`.

Music dir is fetched on mount via `invoke<string>("get_music_dir_cmd")` — graceful degradation if it returns empty (preview silently disabled, chips still function normally). The `get_music_dir_cmd` Rust command uses `std::env::current_exe()` and strips `\\?\` UNC prefix from `canonicalize()` output before returning.

---

## StepNav Breadcrumb — RETIRED (Batch H)

`StepNav.tsx` and `NavDrawer.tsx` deleted in Batch H. Replaced by `BottomTabBar` + `TopInfoBar` + `EditorShell`. Do not rebuild.

---

## Bottom Tab Bar (`BottomTabBar`)

Fixed to the bottom of the viewport on all editor screens. `src/components/BottomTabBar.tsx`.

### Container
```
fixed bottom-0 left-0 right-0 h-12 bg-[#0a0a0a] border-t border-white/10 flex items-center px-2 gap-1 z-40
```

### Tab states
```tsx
{/* Active tab — peach text + 2px bottom underline */}
"flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-md text-[#FF8A65] relative"
// underline: absolute bottom-0 left-2 right-2 h-0.5 bg-[#FF8A65]

{/* Configured tab (non-active) — primary text */}
"flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-md text-[#e5e5e5] hover:bg-white/5"

{/* Unconfigured tab — secondary text */}
"flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-md text-[#a3a3a3] hover:bg-white/5"
```

### Tab icons (lucide-react)
| Tab | Icon | data-testid |
|---|---|---|
| Home | `Home` | `tab-home` |
| Trim | `Scissors` | `tab-trim` |
| Arrange | `Layers` | `tab-arrange` |
| Sound | `Music` | `tab-sound` |
| Render | `Clapperboard` | `tab-render` |

Icons: `w-4 h-4`; labels: `text-[10px] leading-none font-medium`.

### Configuration state
- `useConfiguredTabs(projectId)` reads sessionStorage and returns `Set<"arrange" | "sound">`.
- "arrange" configured: `rc_transition_${projectId}` is non-null and !== `"none"`.
- "sound" configured: `rc_sound_${projectId}` parsed JSON has `mood` that is non-null and !== `"none"`.
- Active tab always shows peach regardless of configuration state.

### Render tab guard
If `!configured.has("arrange") && !configured.has("sound")`, show `window.confirm("You haven't set transitions or music yet. Render anyway?")` before navigating to `/render/:id`. If user cancels, stay on current screen. If either is configured, navigate directly.

### RC wordmark
Far-right of the tab bar: `text-[#FF8A65] font-bold text-sm tracking-widest ml-auto pr-2` — text `"RC"`. Batch I will replace with SVG logo.

### Layout note
`EditorShell` uses `pb-12` on the outer `h-screen` container so center content scrolls above the fixed bar without overlap.

---

## `EditorShell` Layout

Shared layout wrapper for all editor screens. `src/components/EditorShell.tsx`.

### Layout structure
```
h-screen pb-12 bg-[#0a0a0a] text-[#e5e5e5] overflow-hidden  (flex col)
├── TopInfoBar (h-7, flex-shrink-0)
├── flex flex-col flex-1 overflow-hidden min-h-0
│   ├── Main content row (flex flex-1 overflow-hidden min-h-0)
│   │   ├── Left aside (w-52, optional — Trimmer only)
│   │   │   border-r border-white/10, overflow-y-auto, bg-[#0a0a0a]
│   │   └── <main> flex flex-1 overflow-hidden min-w-0  ← children
│   │
│   └── Timeline row (flex flex-shrink-0, only rendered when timelineHud present)
│       border-t-2 border-[#99B3FF]/30  ← spans ALL columns for consistency
│       ├── Left gutter (w-52, always present — mirrors pantry width, blank on non-Trim screens)
│       │   bg-[#0a0a0a]
│       ├── StickyFilmStrip (flex-1 min-w-0 overflow-hidden)
│       └── ChosenEffects aside (w-48, flex-shrink-0)
│           border-l border-white/10, bg-[#0a0a0a], overflow-hidden
└── BottomTabBar (fixed bottom-0, placed by EditorShell, h-12)
```

### Width alignment rule
The timeline row ALWAYS has `w-52 left gutter + filmstrip + w-48 effects`, regardless of whether the left panel (MediaPantry) is visible above. This keeps the filmstrip exactly the same width on every screen — no layout shift when navigating between Trim (with pantry) and Arrange/Sound (without). The left gutter is blank on Arrange/Sound screens and reserved for future per-screen timeline controls.

**The controls column in Trimmer must be exactly `w-48`** (matching the effects aside) so the TrimBar and filmstrip share the same left/right edges.

### Per-screen column config
| Screen | leftPanel | children layout | timelineHud |
|---|---|---|---|
| Trim | MediaPantry (w-52) | `flex h-full`: video+TrimBar (`flex-1`) + controls (`w-48`) | StickyFilmStrip |
| Arrange | — | centered chip picker | StickyFilmStrip |
| Sound | — | source selector | StickyFilmStrip |
| Render | — | ready/rendering/done phases | — (no timeline, no ChosenEffects) |

### Video container responsive sizing (Trimmer)
Use `flex-1 min-h-0` on the video container div, NOT `flex-shrink-0 + aspectRatio + maxHeight`. With `flex-1 min-h-0`, the container fills available vertical space; the `<video>` inside uses `w-full h-full object-contain` to maintain aspect ratio with letterboxing. When the user manually resizes via the drag handle, override with `style={{ flex: "none", height: videoHeight }}`.

**`flex-shrink-0 + aspectRatio` anti-pattern:** pins height to content-derived value; the container fails to grow when the window is maximised, and surrounding space goes unused instead of going to the video.

### `TopInfoBar`
`h-7 flex items-center pl-4 bg-[#0a0a0a] border-b border-white/10 text-sm text-[#e5e5e5] flex-shrink-0`
Content: `{projectName} · {N} clip(s) · {fmtMs(totalMs)}`. Clips omit "0 clips" gracefully. Duration omit when 0.

### `ChosenEffects`
Rendered inside the timeline row's right aside (w-48), filling the same 100px height as the filmstrip. `data-testid="chosen-effects"`. Chip style: `bg-[#99B3FF]/20 border border-[#99B3FF]/50 text-[#99B3FF] text-xs px-2 py-0.5 rounded`. Header: `text-[10px] text-[#a3a3a3] uppercase tracking-widest`. Empty state: `text-xs text-[#a3a3a3] italic "None set"`. Add `h-full` to the root div so it fills the row height.

---

## Upload Flow UX Rules

1. Files appear in the list **immediately** when selected — before upload starts.
2. Counter shows `X of Y clips uploaded` while in progress.
3. Pending clips show a green progress bar (0–100%).
4. Completed clips show a drag handle + order number — drag to reorder.
5. "Continue" button (not "Make my edit") — peach CTA, disabled until all uploaded + no errors.
6. Order note appears when 2+ clips: *"Clips will edit in this order. Drag to rearrange."*
7. Drop zone highlights in peach on drag-over.

---

## Toast / Snackbar

Used for transient feedback (e.g. duplicate-cut guard). Not a modal — no blocking, no close button.

- **Position:** `fixed bottom-6 left-1/2 -translate-x-1/2 z-50`
- **Background:** `bg-[#1a1a1a] border border-white/15`
- **Warning accent:** `border-l-2 border-l-[#FF8A65]` (left border only)
- **Text:** `text-sm text-[#e5e5e5]`
- **Auto-dismiss:** 2500ms via `setTimeout(() => setToast(null), 2500)`
- **Pointer events:** `pointer-events-none` — never blocks clicks underneath

```tsx
{toast && (
  <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 bg-[#1a1a1a] border border-white/15 border-l-2 border-l-[#FF8A65] rounded-md shadow-lg pointer-events-none">
    <p className="text-sm text-[#e5e5e5] whitespace-nowrap">{toast}</p>
  </div>
)}
```

---

## Persistent Timeline HUD (`StickyFilmStrip`)

A read-only proportional timeline rendered inside EditorShell's timeline row (Trim, Arrange, Sound). Hidden on Render. Clip tile widths scale with trimmed duration; a ruler shows time ticks above the tiles. Supports Ctrl+scroll zoom and middle/left-drag pan.

### Layout contract

- **Height:** `style={{ height: 100 }}` — fixed 100px, fills the timeline row height.
- **Placement:** Passed as `timelineHud` prop to EditorShell. EditorShell wraps it in a `flex-1 min-w-0 overflow-hidden` div inside the timeline row. The component itself must NOT own the `border-t` — EditorShell's timeline row container owns the `border-t-2 border-[#99B3FF]/30`.
- **Background:** `bg-[#0a0a0a]` only (no border-t on root div).
- **Root testid:** `data-testid="sticky-filmstrip"`.

### Proportional timeline track

- Clip tile widths: `Math.max(40, Math.round(trimmedMs * pxPerMs))` — proportional to trimmed duration, min 40px.
- Scroll container: `overflow-x-auto overflow-y-hidden`, scrollbar hidden (`[&::-webkit-scrollbar]:hidden`, `scrollbarWidth: none`).
- Initial auto-fit: `ResizeObserver` sets `pxPerMs = containerWidth / totalMs` on first render only (`hasInitialized` ref prevents reset on clip changes).
- Auto-scroll to end when a clip is added: compare `inFilm.length` to `prevFilmLengthRef.current` in a `useEffect`; call `requestAnimationFrame(() => el.scrollLeft = el.scrollWidth)`.
- Zoom: Ctrl+scroll via non-passive `addEventListener("wheel", handler, {passive: false})`. Zoom range: `MIN_PX_PER_MS = 0.008` to `MAX_PX_PER_MS = 2.0`. Zoom-to-cursor: `scrollLeft = cursorX * ratio - (clientX - rectLeft)`.
- Pan: middle mouse button OR left-drag on track background. Cursor state via direct `trackRef.current.style.cursor` mutation — no `useState` (prevents re-render jank).

### Ruler row

- Height: `RULER_HEIGHT = 20px` — fixed, sits above the clip row.
- Dual-array system: separate `minorTicks` (every interval ≥ 20px) and `labelTicks` (every interval ≥ 50px). Candidates: minor `[500ms…300s]`, label `[5s…300s]`.
- Tick direction: top→down. `top: 0` on tick `<div>` (NOT `bottom: 0`). Major tick: 8px tall, `bg-white`; minor: 4px, `bg-white/60`.
- Label: `text-[10px] font-mono text-white/70 whitespace-nowrap`, `top: 8` (below ticks). Never use opacity variants on label text — they become illegible.
- Ruler x-positions use `filmTimeToPx(ms)` which walks actual clip pixel widths, NOT naive `ms/totalMs * totalTrackPx`. The naive approach drifts when short clips are min-width-clamped to 40px.

### Clip tiles

- Height: `CLIP_HEIGHT = 56px`, gap between tiles: `GAP_PX = 2px`.
- Clip row wrapper: `border-2 border-[#99B3FF]/30 rounded-sm overflow-hidden` — blue frame.
- Each tile: `group relative flex-shrink-0 overflow-hidden border-2 transition-colors`. Active tile: `border-[#FF8A65]`; inactive: `border-[#99B3FF]/25`.
- **Thumbnail tiling (DaVinci-style):** CSS `backgroundImage`, `backgroundSize: auto 100%`, `backgroundRepeat: repeat-x`. Do NOT use `<video>` elements in the HUD.
- Sequence number badge: `text-[9px] text-[#0a0a0a] font-bold` on `bg-[#99B3FF]` pill (top-left `absolute top-0.5 left-0.5`).
- Duration overlay: `text-[10px] text-white font-mono drop-shadow-sm` gradient footer (`bg-gradient-to-t from-black/80`).
- Empty state: filmstrip SVG icon + `"No clips yet"` in `text-sm text-[#e5e5e5]/30`.

### Bin icon (hover-reveal delete)

Only rendered when `onDeleteClip?: (clipId: string) => void` is provided. Trimmer passes this; Arrange/Sound/Render do not — bin never shows on those screens.

```tsx
{onDeleteClip && (
  <button
    className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center rounded bg-black/60 text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity z-10"
    onClick={(e) => { e.stopPropagation(); onDeleteClip(clip.id); }}
    title="Remove from film"
    tabIndex={-1}
  >
    {/* trash SVG w-3 h-3, stroke currentColor strokeWidth 2.5 */}
  </button>
)}
```

Requires `group` class on the tile's root div. `e.stopPropagation()` prevents the click from bubbling to any tile-level click handler.

### Data flow

- Props: `clips: Clip[]`, `projectId`, `activeId?`, `onDeleteClip?`
- **No sessionStorage reads inside StickyFilmStrip** — all values come via props.
- `transitionValue` and `soundMood` props REMOVED in Batch H — those live in `ChosenEffects` (EditorShell timeline row aside).

---

## Key Copy Decisions

| Old                                 | New                                              | Reason                                        |
| ----------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| "Make my edit"                      | "Continue"                                       | Clearer next action                           |
| "Export full quality"               | "Export final edit"                              | Matches user mental model                     |
| "Edit settings"                     | "Adjust settings"                                | More descriptive                              |
| "Re-render with changes"            | "Re-render with changes" (disabled if no change) | Lean — avoids wasted Lambda invocations       |
| "processing…" in clip duration      | "—"                                              | "processing" confused users; no ETA available |
| "Saved to your library for 30 days" | "Saved for 30 days"                              | Concise; no auth in Phase 1                   |

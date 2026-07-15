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
| `--rc-purple`         | `#B794F4`                | Per-clip volume override badge dot (StickyFilmStrip)               |
| `--rc-red`            | red-400 Tailwind         | Errors, probe failures                                             |

### Text colour rules

- **Never use `#555555` (`--rc-text-muted`) for visible readable content** — it is too dim on dark backgrounds. Use only for purely decorative / placeholder text.
- **Never use grey (`text-gray-*`, `text-[#808080]` etc.) anywhere** — use `#e5e5e5` (primary) or `#a3a3a3` (secondary) only.
- Minimum readable text colour: `#a3a3a3`.

---

## Typography

**Minimum readable text: `text-xs` (12px).** Never go below this for any interactive or readable element — buttons, hints, labels, chips. `text-sm` (14px) remains the floor for body content. The only permitted sub-12px text is purely decorative timeline overlay data (ruler ticks, clip sequence badges, duration labels inside StickyFilmStrip clip tiles) — those are visual data embedded in a dense graphic context, not readable running text.

| Role                      | Class                                   | Size                                                   |
| ------------------------- | --------------------------------------- | ------------------------------------------------------ |
| Page heading              | `text-3xl font-semibold text-[#FF8A65]` | 30px, peach                                            |
| Section heading           | `text-xl font-medium text-[#e5e5e5]`    | 20px                                                   |
| Body / labels             | `text-base text-[#e5e5e5]`              | 16px                                                   |
| Secondary text            | `text-base text-[#a3a3a3]`              | 16px                                                   |
| Small label               | `text-sm text-[#a3a3a3]`                | 14px                                                   |
| Muted / hint              | `text-sm text-[#555555]`                | 14px                                                   |
| Micro-control / UI chrome | `text-xs text-[#a3a3a3]`                | 12px — minimum floor for interactive/readable elements |

---

## Screen title (h1) — always the screen name

Every screen's `h1` is the **screen name**, unchanged by state. It is never replaced by status copy ("Your film", "Render Your Film", "Ready", etc.).

```tsx
<h1 className="text-3xl font-semibold text-[#FF8A65]">Render</h1>
// NOT: "Your film" / "Render Your Film" / "Rendering..." etc.
```

Current screen names: **Trim**, **Arrange**, **Sound**, **Render**. Library and Upload are full-page views, not editor screens, and may use different heading styles. Status information (done, error, rendering) lives inside the content area below the h1, not in the h1 itself.

---

## Buttons

### Primary CTA (peach)

```tsx
className="inline-flex items-center gap-2 px-6 py-3 bg-[#FF8A65] text-[#0a0a0a] font-semibold rounded-md hover:bg-[#ff9e7a] transition-all duration-200 text-base disabled:opacity-40 disabled:cursor-not-allowed"
```

### Destructive CTA (red — cancel / irreversible action)

Used when paired with a Primary CTA to offer a cancel/destroy action of equal visual weight. Colour (red) is the primary signal — the label change is secondary. Same dimensions as Primary CTA to prevent layout shift on swap.

```tsx
className="px-6 py-3 border border-red-400/60 text-red-400 hover:bg-red-400/10 hover:border-red-400 font-semibold rounded-md text-base transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
```

**200ms debounce guard** — set `disabled` for 200ms on every phase transition (idle→rendering, rendering→idle). Prevents double-clicks firing both render and cancel simultaneously. Pattern:

```tsx
const [debounced, setDebounced] = useState(false);
// on button click:
setDebounced(true);
setTimeout(() => setDebounced(false), 200);
```

### Secondary (outlined)

```tsx
className="px-5 py-2.5 border border-white/30 text-[#e5e5e5] text-base rounded-md hover:border-white/60 hover:bg-white/5 transition-all duration-200"
```

### Micro-control pill (contextual UI chrome)

Used for transient controls that appear conditionally inside a dense graphic component (e.g. the filmstrip "fit view" button). Single bordered pill containing an icon + label. Solid `bg-[#0a0a0a]` ensures it punches cleanly over any ruler or thumbnail content behind it. Uses `group` + `group-hover:` so the entire pill (icon + text) brightens as one unit.

```tsx
<button
  onClick={handler}
  className="absolute flex items-center gap-1.5 z-30 select-none group"
  style={{ top: 4, right: 6 }}
  title="Tooltip text"
>
  <span className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-white/30 bg-[#0a0a0a] text-[#a3a3a3] group-hover:text-[#e5e5e5] group-hover:border-white/55 transition-colors">
    {/* icon */}
    <span className="text-xs">label</span>
  </span>
</button>
```

Rules: `text-xs` (12px minimum), `text-[#a3a3a3]` resting, `text-[#e5e5e5]` on hover. Only render when relevant (`{!condition && <button>}`). `position: absolute` on a `relative` parent that does NOT scroll — keeps the button pinned regardless of inner scroll.

### Media play button (canonical — use everywhere)

Filled peach circle, **white** filled icon. Used in Trimmer scrubber bar and Arrange clip preview. `w-10 h-10` (40×40px). Button has `text-white` so `fill="currentColor"` resolves to white. Icon is `size={22}`. Always use lucide `<Play>` / `<Pause>` — do not hand-code SVG paths.

```tsx
<button
  onClick={togglePlay}
  className="w-10 h-10 rounded-full bg-[#FF8A65] text-white flex items-center justify-center hover:bg-[#ff9e7a] transition-all duration-200 flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
>
  {isPlaying
    ? <Pause size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />
    : <Play  size={22} fill="currentColor" stroke="#0a0a0a" strokeWidth={1.5} />}
</button>
```

`fill="currentColor"` fills the symbol white; `stroke="#0a0a0a" strokeWidth={1.5}` adds a dark border on the symbol itself for contrast. No outer circle border. Disabled state: `opacity-30`.

---

## StickyFilmStrip patterns

### Vertical clip rail (Arrange screen left panel)

Stack of 16:9 thumbnail buttons, `w-40`, `overflow-y-auto bg-[#0a0a0a] border-r border-white/10`. Each tile: `border-2 rounded-md overflow-hidden aspect-ratio:16/9`. Active tile: `border-[#FF8A65]`. Inactive: `border-[#99B3FF]/25 hover:border-[#99B3FF]/50`.

### Inline clip play + scrubber

Single row below the preview: `[filled-peach play btn] [range input accent-[#FF8A65]] [0:00 / 0:07 monospace label]`. Range step: 100ms. On `onLoadedMetadata` capture `durationMs`; on `onTimeUpdate` update `currentMs`; `onChange` sets `video.currentTime`.

### Timeline state badges

Stacked in `flex gap-0.5`, `absolute bottom-1 right-1 z-10 pointer-events-none`:

- **Zoom "Z" badge** — `w-3.5 h-3.5 rounded-sm bg-[#22c55e] flex items-center justify-center` with inner `<span className="text-[8px] font-bold text-[#0a0a0a] leading-none">Z</span>`. Shown when `clip.zoom_mode != null`.
- **Volume dot** — `w-1.5 h-1.5 rounded-full bg-[#B794F4]` (`--rc-purple`). Shown when `clip.clip_volume !== 1.0`.

### Focal-point interaction (Arrange zoom tab video preview)

**Cursor:** `pointer` on all interactive states. No `crosshair` — the hint text explains the drag gesture.

**Gesture split (4px threshold):** Mousedown records start position. Window `mousemove` past 4px movement (`Math.hypot(dx,dy) < DRAG_THRESHOLD_PX`) promotes to focal drag; window `mouseup` with no movement fires `togglePlay()` instead. This means: click = play/pause, drag = set focal point.

**No overlay indicator on the big preview.** The pointer cursor + hint text (`"Drag preview to set focal point"`, `text-xs text-[#a3a3a3] italic text-right`, below the scrubber) are the affordance. The right-panel picker shows the actual focal point position.

**Right-panel focal picker:** Static neutral background `bg-[#1a1a1a]` with faint centre crosshairs (`bg-white/10` 1px lines). Indicator: `w-4 h-4 rounded-full border-2 border-[#FF8A65] bg-[#FF8A65]/30 -translate-x-1/2 -translate-y-1/2`, no pulse animation. Click anywhere in the picker to set exact focal coordinate.

**Destination crop box (zoom-in only, paused only):** When `kbDir === "in"` and not playing, a thin peach rectangle shows the final crop destination. Drawn at `videoBox` level (outside the CSS-animated `videoWrapRef`) so it is NOT scaled by the zoom animation. Box math uses current paused progress (`approxKenBurnsProgress(t_raw)`) to project the source-frame crop into screen coordinates — box grows toward full-screen as zoom completes, then disappears when `t_raw >= 1` (animation done). Style: `border-2 border-[#FF8A65] rounded-sm pointer-events-none`, `boxShadow: "0 0 0 1px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(0,0,0,0.6)"` (dark halo for visibility on bright footage).

### Drag-left delete + DEL key

Tile gets `tabIndex={0}`. On `mousedown`, window-level `mousemove` tracks `deltaX = Math.min(0, currentX - startX)`. Tile translates `translateX(deltaX)`. Past `deltaX < -40`: red overlay (`bg-red-400/30`). On `mouseup` with `deltaX < -40`: fire `onDeleteClip`. DEL / Backspace key on focused tile: fire `onDeleteClip` immediately. `rc-delete-flash` keyframe in `globals.css` for the removal animation.

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

**Chip text size: minimum `text-sm`.** Chips are readable interactive content — `text-sm` (14px) minimum, not `text-xs`. Note: `SettingsPanel.tsx` currently uses `text-xs` on its chips (pre-15e deviation); new screens must use `text-sm`. Micro-controls that are not chips (e.g. the filmstrip "fit view" button) may use `text-xs` (12px, the global minimum).

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

### Proxy prep panel (`awaiting-proxies` phase — Render screen)

When a 4K cold render is triggered (0/N proxies ready), the Render screen enters `awaiting-proxies` phase instead of starting the pipeline immediately. This panel shows progress and blocks the render until proxies are ready.

**Trigger:** Gate fires on `submitJob` when `has4K === true` AND `status.ready < status.total`. This includes the fully cold case (ready = 0) — do NOT bypass on ready = 0 for 4K projects (pre-Batch-S2 bug: `ready === 0` was used as a bypass condition).

**Panel layout (centred, `space-y-4`):**

```tsx
{phase === "awaiting-proxies" && (
  <div className="space-y-4">
    {/* Status line + elapsed */}
    <div className="flex items-center justify-between text-sm">
      <span className="text-[#e5e5e5]">Preparing proxies -- {ready} / {total} ready</span>
      <span className="text-[#a3a3a3] font-mono" data-testid="proxy-elapsed">{elapsedLabel} elapsed</span>
    </div>

    {/* Progress bar — green, always #22c55e */}
    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
      <div className="h-full bg-[#22c55e] rounded-full transition-all duration-500"
           style={{ width: `${total > 0 ? (ready / total) * 100 : 0}%` }} />
    </div>

    {/* Helper text */}
    <p className="text-sm text-[#a3a3a3]">
      Render starts automatically when proxies finish.{" "}
      <span className="text-[#FF8A65]">Skipping makes this render much slower.</span>
    </p>

    {/* Clip tile grid */}
    {includedClips.length > 0 && (
      <div className="flex flex-wrap gap-2">
        {includedClips.map((c) => {
          const encoding = blockingIds.has(c.id);
          return (
            <div key={c.id} data-testid={`proxy-tile-${c.id}`}
              data-encoding={encoding ? "true" : "false"}
              className={`relative w-16 aspect-video rounded border border-white/15 bg-black bg-cover bg-center flex-shrink-0 overflow-hidden${encoding ? " rc-proxy-pulse" : ""}`}
              style={c.thumbnail_data ? { backgroundImage: `url(${c.thumbnail_data})` } : {}}>
              {!encoding && (
                <div className="absolute top-0.5 right-0.5 w-4 h-4 rounded-sm bg-[#22c55e] flex items-center justify-center">
                  <Check size={10} strokeWidth={3} className="text-[#0a0a0a]" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    )}

    {/* Escape hatch */}
    <button onClick={startRenderNow}
      className="text-sm px-4 py-2 rounded-md border border-white/30 text-[#e5e5e5] hover:bg-white/5 transition-colors">
      Start anyway (slower)
    </button>
  </div>
)}
```

**Clip tile states:**

- **Encoding (pulsing):** `rc-proxy-pulse` class — `box-shadow` blue ring at `rgba(153, 179, 255, 0.2–0.85)`, 1.4s ease-in-out infinite (defined in `globals.css`). Thumbnail visible in background.
- **Done (green check):** No pulse class. Green `#22c55e` badge `w-4 h-4 rounded-sm` top-right with `<Check size={10} strokeWidth={3} text-[#0a0a0a]>`.
- **Tile base:** `w-16 aspect-video rounded border border-white/15 bg-black bg-cover bg-center`.

**Elapsed timer:** Count-up from gate entry, ticks every 1s via `setInterval`. Format: `Xs` for <60s, `Xm Ys` for ≥60s. `font-mono text-[#a3a3a3]`. Initialise `waitStartRef.current = Date.now()` when phase enters `awaiting-proxies`.

**Auto-advance:** When polling returns `ready >= total`, call `startRenderNow()` directly (no user action needed).

**`includedClips` state** must be populated BEFORE `submitJob` is called (to prevent a flash of empty tiles). Set `includedClips` from the cached clip list in the mount `useEffect`, before `await submitJob(projectId)`.

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

### Transition preview card-chip

Vertical card button with an animated thumbnail on top and a label below. Used on the Transitions tab of the Arrange screen. The animation plays on hover and while the chip is selected; other chips are static.

- **Card:** `flex flex-col rounded-lg overflow-hidden border-2 min-w-[100px] focus:outline-none`
- **Selected:** `rc-trans-card--selected border-[#99B3FF]` — add `rc-trans-card--selected` class alongside Tailwind classes
- **Inactive:** `border-white/20 hover:border-white/50`
- **Card must also carry the `rc-trans-card` class** — the CSS selectors in `globals.css` key off this to control `animation-play-state`
- **Preview area:** `relative h-12 bg-black overflow-hidden` — `bg-black` is required so the mid-dip frame shows pure black for the Dip to Black transition
  - Two `absolute inset-0` divs with classes `rc-trans-preview-a` (clip A, `bg-[#1e3a4c]`) and `rc-trans-preview-b` (clip B, `bg-[#2d1a2f]`)
  - Each gets `style={{ animation: ANIM_KEYS[value].a/b }}` — the inline animation shorthand includes name, duration, iteration count, and timing function
  - Default `animation-play-state: paused` set via `.rc-trans-preview-a/b` rule in `globals.css`
  - Running state triggered via `.rc-trans-card:hover` and `.rc-trans-card--selected` CSS selectors (no JS needed)
- **Label row:** `px-3 py-2 text-sm font-medium text-center text-[#e5e5e5] bg-white/5`
- **`data-testid="chip-transition-{value}"`** preserved on the `<button>` for E2E

**Keyframe naming convention** (`src/globals.css`):

- `rc-trans-{type}-a` / `rc-trans-{type}-b` — type is `none`, `cf` (crossfade), `dip`, `wipe`, `zoom`
- None: `steps(1, end)` timing; Crossfade + Dip: `ease-in-out`; Wipe: `clip-path: inset()` animation; Zoom: `transform: scale()` + opacity — all 3s duration
- Clip colours: A = `#1e3a4c` (dark teal), B = `#2d1a2f` (dark purple), container bg = `#000000`
- Wipe: A clips out left (`clip-path: inset(0 0 0 0)` → `inset(0 100% 0 0)`), B wipes in from right (`inset(0 100% 0 0)` → `inset(0 0 0 0)`)
- Zoom: A scales+fades out (`scale(1) opacity:1` → `scale(1.35) opacity:0`), B scales+fades in (`scale(1.35) opacity:0` → `scale(1) opacity:1`)

### Zoom controls (Arrange Zoom tab)

The Zoom tab right panel offers two zoom styles via a **Style** chip row
(`Off` / `Fixed` / `Ken Burns`). All chips use the standard chip pattern
(`zoomChipClass` helper): active `border-[#99B3FF] text-[#99B3FF] bg-[#99B3FF]/10`,
inactive `border-white/35 text-[#e5e5e5]`.

- **Fixed** reveals one **Amount** group: `1.3×` / `1.5×` / `2×`.
- **Ken Burns** reveals three groups: **Direction** (`Zoom in` / `Zoom out`),
  **Amount** (`1.3×` / `1.5×` / `2×`), **Speed** (`Slow` / `Medium` / `Fast`).
- Each group is `<div className="space-y-2">` with a `text-sm font-medium
  text-[#e5e5e5]` label; groups stack within the parent `space-y-5`.
- The focal-point picker shows whenever the style is not `Off`; under Ken Burns
  it carries the helper line *"RushCut zooms toward this point."*
  (`text-sm text-[#a3a3a3]`).

The full state is encoded into the single `zoom_mode` string by `@/utils/zoom`
(`parseZoom` / `buildZoomMode`); `zoomLabel()` from the same module produces the
human-readable badge tooltip used on every screen — no screen renders the raw
`kb_*` string.

**Ken Burns preview animation** — the centre preview animates the zoom on a
wrapper `<div>` (`videoWrapRef`, never the `<video>` itself) via the **Web
Animations API** (`wrap.animate([{transform:"scale(from)"},{transform:"scale(to)"}],
{ duration, easing: "ease-in-out", fill: "both", iterations: 1 })`). WAAPI with
literal scale endpoints is compositor-accelerated in WebView2; the old
`rc-kenburns` CSS keyframe read `var(--kb-*)` custom properties, which forced the
animation onto the main thread and made playback choppy (U3d). The single
`syncZoomToPlayhead(elapsedSec, playing)` helper is the only sync point: it
positions the clock with `anim.currentTime` (precise seek, no reflow-restart) and
freezes/continues with `anim.pause()` / `anim.play()`, called on discrete events
only (select / play / pause / seek / clip-end) — never per `timeupdate` tick.
Switching the zoom style away from Gradual (to Fixed/Off) calls `anim.cancel()`
then nulls the ref so the `fill:"both"` end-state is cleared before React's inline
`transform` takes over. Duration is trimmed-duration × speed-fraction (matches the
render); `transformOrigin` carries the focal point.

### Left-rail + centre-preview layout (Batch M2 — Transitions tab)

For transition pickers with 5+ options, use a left rail + centre preview split rather than a horizontal chip row (chip rows don't scale past 5 with full card-chips).

- **Container:** `flex gap-6` — `aside w-52` (rail) + `flex-1` (preview)
- **Rail:** `flex flex-col gap-2` inside `aside w-52` — 6 vertical card-chips stretching to full width
- **Centre preview:** bordered card (`border border-white/15 rounded-lg p-4 flex-1 flex flex-col`), `h-40` animation area with real thumbnails, label below (`text-xl font-medium text-[#e5e5e5]` + `text-sm text-[#a3a3a3]`)
- Rail cards use `w-full` (stretch to aside width); preview area `h-40 max-w-md`
- The "Surprise me" card is the 6th card in the rail with a `<Shuffle size={14}>` icon inline with the label

### Opening/closing cut pickers (Batch M2)

Horizontal card-chip rows rendered below the main between-clips block (separate bordered `<section>` each). Each section:

- Heading `text-base font-medium text-[#e5e5e5]` + `text-sm text-[#a3a3a3]` description
- 6-card horizontal flex (same 5 types + Surprise button): `flex flex-wrap gap-2`
- Surprise button: resolves immediately on click — draws a random concrete value from `[crossfade, dip_to_black, wipe, zoom]` and stores it; never stores the string `"shuffle"` in config
- `data-testid="chip-opening-{value}"` / `data-testid="chip-closing-{value}"` for E2E
- Default: both `"none"` (None card selected/blue)

### TransitionConfig storage shape (Batch M2)

`rc_transition_${projectId}` in sessionStorage stores JSON: `{ between, opening, closing, shuffleBetween }`.
A compat reader `readTransitionConfig(projectId)` handles the old plain-string format (pre-M2) and returns the struct.
The pipeline never receives `"shuffle"` — `shuffleBetween: true` causes `transitions.py` to draw a random per-cut xfade name from `["fade","fadeblack","wipeleft","zoomin"]`.

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
  Film: {fmtMs(filmDurationMs)} · Track: {fmtMs(selectedTrackMs)}{loopNote}
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

## Form text input (Arrange Cards tab pattern)

First introduced in Batch L for the Cards tab title/subtitle inputs. Use this pattern for any free-text input on editor screens.

```tsx
<input
  type="text"
  maxLength={60}
  value={value}
  onChange={...}
  placeholder="Your film title"
  className="w-full border border-white/15 rounded-md px-3 py-2 text-sm text-[#e5e5e5] bg-white/5 focus:border-white/40 focus:outline-none"
/>
<p className="text-xs text-[#a3a3a3] text-right">{value.length}/60</p>
```

Rules:

- Surface: `bg-white/5` (subtle dark fill)
- Border: `border-white/15` idle, `border-white/40` on focus — no colour ring
- Text: `text-sm text-[#e5e5e5]`
- Char counter: `text-xs text-[#a3a3a3] text-right` below the input — shows `current/max`
- Debounce saves: **300ms debounce** on `onChange` for text inputs; instant save for toggles and swatches
- `maxLength` attribute enforces the limit at the DOM level; counter is visual feedback only

---

## Card background swatch picker

Three circular swatches in a row — peach `#FF8A65`, black `#0a0a0a`, white `#ffffff`. Selected swatch gets a peach `#FF8A65` ring (`ring-2 ring-[#FF8A65] ring-offset-2 ring-offset-[#0a0a0a]`). The ring colour is peach **only** for card background pickers — all other chip/chip-group active states use `#99B3FF` blue.

```tsx
const CARD_COLORS = [
  { id: "peach", hex: "#FF8A65" },
  { id: "black", hex: "#0a0a0a" },
  { id: "white", hex: "#ffffff" },
];

{CARD_COLORS.map(({ id, hex }) => (
  <button
    key={id}
    type="button"
    onClick={() => handleColorSelect(id)}
    style={{ background: hex }}
    className={`w-8 h-8 rounded-full transition-all focus:outline-none ${
      id === "black" ? "border border-white/30" : ""
    } ${
      color === id ? "ring-2 ring-[#FF8A65] ring-offset-2 ring-offset-[#0a0a0a]" : ""
    }`}
    aria-label={id}
  />
))}
```

Black swatch gets an extra `border border-white/30` for visibility against the dark background — the other two colours are self-evident.

### CSS preview card

Right-aligned `w-40 aspect-video rounded-md` rectangle showing the selected background colour and the current text. Text colour mirrors Pillow's `_luminance()` logic: luminance > 0.179 → black text, else white. Subtitle renders at `~60%` opacity via inline style.

```tsx
function cardTextColor(hex: string): string {
  if (hex.startsWith("#") && hex.length === 7) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return lum > 0.179 ? "#000000" : "#ffffff";
  }
  return "#ffffff";
}
```

`cardTextColor` is exported from `StickyFilmStrip.tsx` and imported wherever card text must contrast against the card background (Trimmer card-hold overlay). Two-tone return values: `"#0a0a0a"` (dark) for lum > 0.179, `"#e5e5e5"` (light) for lum ≤ 0.179. Note: the function in DESIGN.md above uses `"#000000"` / `"#ffffff"` — the live implementation uses the near-black/near-white tokens from the design system (`#0a0a0a` / `#e5e5e5`). Use the live version.

### Card-hold colour overlay (Trimmer film mode)

Full-screen overlay over the video player when the playhead parks inside a card region (open/close card). Pattern: `position:absolute inset-0`, bg = card hex (inline style), `zIndex` above video, centred flex column with title + subtitle.

```tsx
{cardHold && (
  <div className="absolute inset-0 flex items-center justify-center z-10" style={{ background: cardHold.color }}>
    {(cardHold.text || cardHold.subtitle) && (
      <div className="flex flex-col items-center gap-2 px-8 select-none">
        {cardHold.text && (
          <p className="text-center font-semibold" style={{ color: cardTextColor(cardHold.color), fontSize: "clamp(1.25rem, 3vw, 2.5rem)" }}>
            {cardHold.text}
          </p>
        )}
        {cardHold.subtitle && (
          <p className="text-center font-normal" style={{ color: cardTextColor(cardHold.color), fontSize: "clamp(0.875rem, 1.8vw, 1.5rem)", opacity: 0.75 }}>
            {cardHold.subtitle}
          </p>
        )}
      </div>
    )}
  </div>
)}
```

Title: `font-semibold`, `clamp(1.25rem, 3vw, 2.5rem)`. Subtitle: `font-normal`, `clamp(0.875rem, 1.8vw, 1.5rem)`, `opacity: 0.75`. Both use `cardTextColor(hex)` for auto-contrast. Gap between title and subtitle: `gap-2`. Padding: `px-8`. Text is `select-none`.

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

| Tab     | Icon           | data-testid   |
| ------- | -------------- | ------------- |
| Home    | `Home`         | `tab-home`    |
| Trim    | `Scissors`     | `tab-trim`    |
| Arrange | `Layers`       | `tab-arrange` |
| Sound   | `Music`        | `tab-sound`   |
| Render  | `Clapperboard` | `tab-render`  |

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

| Screen  | leftPanel          | children layout                                             | timelineHud                       |
| ------- | ------------------ | ----------------------------------------------------------- | --------------------------------- |
| Trim    | MediaPantry (w-52) | `flex h-full`: video+TrimBar (`flex-1`) + controls (`w-48`) | StickyFilmStrip                   |
| Arrange | —                  | centered chip picker                                        | StickyFilmStrip                   |
| Sound   | —                  | source selector                                             | StickyFilmStrip                   |
| Render  | —                  | ready/rendering/done phases                                 | — (no timeline, no ChosenEffects) |

### Video container responsive sizing (Trimmer)

Use `flex-1 min-h-0` on the video container div, NOT `flex-shrink-0 + aspectRatio + maxHeight`. With `flex-1 min-h-0`, the container fills available vertical space; the `<video>` inside uses `w-full h-full object-contain` to maintain aspect ratio with letterboxing. When the user manually resizes via the drag handle, override with `style={{ flex: "none", height: videoHeight }}`.

**`flex-shrink-0 + aspectRatio` anti-pattern:** pins height to content-derived value; the container fails to grow when the window is maximised, and surrounding space goes unused instead of going to the video.

### Flanking Prev/Next nav around video preview

Used on Trimmer and Arrange screens to navigate between clips without leaving the video area. Buttons flank the `videoContainerRef` div in a flex row, visible in both clip mode and film mode (handlers differ per mode).

```tsx
<div className="flex gap-4 flex-1 min-h-0 items-stretch">
  <button
    type="button"
    onClick={() => handlePrev()}
    disabled={isFirst}
    className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
  >
    <ChevronLeft size={14} /> Prev
  </button>
  {/* videoContainerRef div here — flex-1 min-h-0 */}
  <button
    type="button"
    onClick={() => handleNext()}
    disabled={isLast}
    className="self-center flex-shrink-0 flex items-center gap-1 border border-white/30 text-[#e5e5e5] rounded-md hover:border-white/60 hover:bg-white/5 px-3 py-2 text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
  >
    Next <ChevronRight size={14} />
  </button>
</div>
```

- Buttons are outlined secondary (not peach — they are navigation, not a CTA).
- `self-center flex-shrink-0` keeps buttons vertically centred without growing.
- `disabled:opacity-40 disabled:cursor-not-allowed` — first/last clip states.
- Source counter overlay (top-left of video): `absolute top-2 left-2 bg-black/60 text-[#e5e5e5] text-xs px-2 py-0.5 rounded pointer-events-none z-10` — shows `"N / M"`.
- `data-testid` on each button includes mode: `trim-clip-prev`/`trim-film-prev`, `trim-clip-next`/`trim-film-next`.

### Clip cover div (repaint window)

Imperatively-controlled overlay inside `videoContainerRef` to hide a `<video>` during the play/pause/seek repaint window (prevents poster flash and frame-0 flash on clip change in clip mode). React never manages this element's `display` property.

```tsx
{/* Cover during clip repaint window — shown/hidden imperatively by paintAndPlay */}
<div ref={clipCoverRef} className="absolute inset-0 bg-black" style={{ display: "none", zIndex: 50 }} />
```

Show with `clipCoverRef.current.style.display = "block"` in `useLayoutEffect` (fires before paint). Hide with `style.display = "none"` in the `seeked` event listener after the right frame is decoded. Never toggle via React state — the whole point is to bypass React's render cycle.

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

### Inline Warning Panel (non-toast variant)

When a warning has an interactive action (e.g. "Try Again") or persists until a condition clears, use an inline panel in the page flow instead of the floating toast. Same colour tokens, but interactive and position-relative.

- **Position:** inline (not fixed), below its anchor element in the normal flow
- **Container:** `bg-white/5 border border-white/10 border-l-2 border-l-[#FF8A65] rounded-md p-3 flex items-center justify-between gap-4`
- **Text:** `text-sm text-[#e5e5e5]` — same as toast
- **Action:** inline `text-sm text-[#FF8A65] font-medium hover:underline` button (NOT `pointer-events-none`)
- **No auto-dismiss:** persists until the underlying condition clears (clear via state reset)
- **No red:** `#FF8A65` peach is the warning signal; red (`text-red-*`) is reserved for the hard error phase

---

## Right-click context menu (Batch V3, #40 — first use)

Small floating menu triggered by `onContextMenu` on a tile/row (e.g. MediaPantry pantry tiles). Same dark surface as Toast, positioned at the cursor rather than fixed to a screen edge.

- **Container:** `fixed z-50 bg-[#1a1a1a] border border-white/15 rounded-md shadow-lg py-1 min-w-[180px]`, positioned via inline `style={{ left: e.clientX, top: e.clientY }}` captured from the triggering `onContextMenu` event
- **Item (destructive):** `w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-red-400/10 transition-colors` — matches the existing Destructive CTA red token, no border needed at this scale
- **Item (non-destructive):** would use `text-sm text-[#e5e5e5] hover:bg-white/5` — not yet built, follow this convention when one is needed
- **Dismiss:** a `window` `click`/`blur` listener registered only while the menu is open (`useEffect` keyed on menu state) — clicking anywhere (including the menu's own container, which calls `stopPropagation`) or losing window focus closes it
- **`e.preventDefault()`** on the triggering `onContextMenu` is required to suppress the native OS context menu
- Menu items that trigger a destructive action should still go through a `confirm()` step (see Toast/dialog patterns) — the context menu itself is not the confirmation

```tsx
onContextMenu={(e) => {
  e.preventDefault();
  setMenu({ x: e.clientX, y: e.clientY, target: someItem });
}}

{menu && (
  <div
    className="fixed z-50 bg-[#1a1a1a] border border-white/15 rounded-md shadow-lg py-1 min-w-[180px]"
    style={{ left: menu.x, top: menu.y }}
    onClick={(e) => e.stopPropagation()}
  >
    <button
      type="button"
      onClick={() => { onAction(menu.target); setMenu(null); }}
      className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-red-400/10 transition-colors"
    >
      Destructive action label
    </button>
  </div>
)}
```

```tsx
{stalled && (
  <div className="mt-3 flex items-center justify-between gap-4 rounded-md border border-white/10 border-l-2 border-l-[#FF8A65] bg-white/5 p-3">
    <p className="text-sm text-[#e5e5e5]">Warning message here.</p>
    <button className="flex-shrink-0 text-sm text-[#FF8A65] font-medium hover:underline">
      Action
    </button>
  </div>
)}
```

---

## TrimBar — Already-Included Region Overlay

When a source clip has been cut into the film one or more times already, those regions are marked on the TrimBar with a subtle green tint. Helps users avoid accidentally duplicating a segment.

### Visual spec

| Property      | Value                                                                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fill          | `rgba(153, 179, 255, 0.26)` — `#99B3FF` (badge blue) at 26% opacity                                                                                                                                            |
| Edges         | Bracket gradient: edges 52%, fill 26%. `background: linear-gradient(to right, rgba(153,179,255,0.52) 0px, rgba(153,179,255,0.26) 10px, rgba(153,179,255,0.26) calc(100% - 10px), rgba(153,179,255,0.52) 100%)` |
| Z-index       | 2 — same tier as the waveform overlay; below selected region (z-3)                                                                                                                                             |
| Interactivity | `pointer-events-none` — purely decorative                                                                                                                                                                      |

### Micro-cut guard

When the region is narrower than 2% of track width (`widthPct > 2`), use a flat fill (`rgba(153,179,255,0.30)`) instead of the bracket gradient — at very small widths the 10px bracket edges would consume the entire region.

### Self-exclusion rule

The filter in `Trimmer.tsx` excludes the *currently selected cut* (`c.id !== selectedClip.id`) so the cut being actively edited is never marked as "already included".

### Malformed row guard

`.filter(r => r.outMs > r.inMs)` — drops rows where `out_ms` or `duration_ms` is null/0, preventing zero-width ghost divs at position 0.

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

Only rendered when `onDeleteClip?: (clipId: string) => void` is provided. Trimmer passes this; Arrange/Sound/Render do not — bin never shows on those screens. **This is the sole delete affordance on the filmstrip** (the old swipe-left-to-delete gesture was removed in Batch U2 so the horizontal drag could be used for reorder).

```tsx
{onDeleteClip && (
  <button
    className="absolute top-0.5 right-0.5 w-5 h-5 flex items-center justify-center rounded bg-black/60 text-red-400 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity z-20"
    onPointerDown={(e) => e.stopPropagation()}
    onClick={(e) => { e.stopPropagation(); onDeleteClip(clip.id); }}
    title="Remove from film"
    tabIndex={-1}
  >
    <Trash2 size={12} strokeWidth={2.5} />   {/* lucide-react */}
  </button>
)}
```

Requires `group` class on the tile's root div. `e.stopPropagation()` on click prevents bubbling to any tile-level click handler; `onPointerDown` stopPropagation stops a tile drag from starting when the bin is pressed.

### Drag-to-reorder (Batch U2)

Press-drag a film tile to reorder it; sibling tiles shift live to show the drop target. Enabled only when `onReorder?: (orderedInFilmIds: string[]) => void` is provided (Trimmer + Arrange pass it; Sound does not).

- **Library:** `@dnd-kit` (already a dep, same as `ClipNavStrip`/`ClipList`). `DndContext` + `SortableContext` with `horizontalListSortingStrategy`; each tile is a `SortableFilmTile` calling `useSortable({ id, disabled: !reorderable })`.
- **Activation:** `PointerSensor` with `activationConstraint: { distance: 5 }` — the proven codebase value. A no-move click never crosses 5px, so click-to-select (Arrange) still works; a real drag suppresses the trailing click.
- **Transform:** apply `CSS.Translate.toString(transform)` — **NOT** `CSS.Transform.toString` (the latter adds a scale component that stretches our variable-width tiles).
- **Dragged tile:** `opacity: 0.4`, raised `zIndex`. Active border `#FF8A65`, inactive `#99B3FF/25` (unchanged).
- **Gesture separation:** dnd listeners live only on tiles; the track-background pan (middle-mouse / left-drag on background) and click-to-seek are untouched.
- **Persistence gotcha:** the parent `onReorder` handler must renumber `sort_order` locally (= full-array index) in its optimistic `setClips`, because StickyFilmStrip sorts `inFilm` by `sort_order`, not array order. It also passes the **full** clip id list to `reorder_clips_cmd` (not just film ids) to avoid pantry/film `sort_order` collisions.

### Data flow

- Props: `clips: Clip[]`, `projectId`, `activeId?`, `onDeleteClip?`, `onSelectClip?`, `onReorder?`, `playheadMs?`, `onSeek?`
- **No sessionStorage reads inside StickyFilmStrip** — all values come via props.
- `transitionValue` and `soundMood` props REMOVED in Batch H — those live in `ChosenEffects` (EditorShell timeline row aside).

---

## Master Tab — Full-Screen Film Preview

The Master tab on the Sound screen is a full-screen film playback layout. It replaces the card-based settings layout used on other tabs. The film is primary; controls are secondary.

### Layout

```
┌──────────────────────────────────────────────┬──────────┐
│                                              │  Music   │
│              <video> (black bg)              │  (label) │
│           max-h-full max-w-full              │  Volume  │
│           object-contain cursor-pointer      │  chips   │
│                                              │  (footer)│
├──────────────────────────────────────────────┴──────────┤
│ [●play] ────────────────── ↑fade ─────────── 0:12/1:23 │
└─────────────────────────────────────────────────────────┘
```

- **Outer container:** `flex flex-1 min-h-0` (fills editor shell content area)
- **Center column:** `flex flex-col flex-1 min-h-0 min-w-0` (video + controls)
- **Video area:** `flex-1 bg-black flex items-center justify-center min-h-0 relative`
- **Video element:** `max-h-full max-w-full object-contain` — never `display:none` (use className toggling)
- **Right sidebar:** `w-52 flex-shrink-0 border-l border-white/10 overflow-y-auto`

### Controls bar

`flex items-center gap-3 px-4 py-3 border-t border-white/10 flex-shrink-0`

| Element             | Pattern                                                             |
| ------------------- | ------------------------------------------------------------------- |
| Play/Pause button   | `w-8 h-8 rounded-full bg-[#FF8A65] text-[#0a0a0a]` — circular peach |
| Progress bar track  | `flex-1 h-1.5 bg-white/20 rounded-full cursor-pointer relative`     |
| Progress fill       | `h-full bg-[#FF8A65] rounded-full pointer-events-none` — peach fill |
| Elapsed/total timer | `text-sm text-[#a3a3a3] flex-shrink-0 tabular-nums font-mono`       |

### Fade-out marker on progress bar

When music fade-out is enabled, a vertical tick marks where the fade starts. Positioned inside the progress bar track div.

```tsx
<div
  className="absolute pointer-events-none"
  style={{ left: `${pct}%`, top: "50%", transform: "translate(-50%, -50%)" }}
>
  <span className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 text-[9px] text-white/50 whitespace-nowrap leading-none">
    fade {fadeLabel}
  </span>
  <div className="h-3 w-0.5 bg-white/70 mx-auto" />
</div>
```

### Idle placeholder overlay

Shown ONLY before the first play (`hasPlayedRef.current === false`) when not playing and not paused. After any play event, the overlay stays hidden permanently (last frame shown after film ends).

`absolute inset-0 flex items-center justify-center pointer-events-none` — `text-sm text-[#a3a3a3]`

### Idle click-catcher overlay (first-entry click-to-play)

Both dual-buffer slot `<video>` elements start with `pointer-events: none` (set by the mount `useEffect` and by `setSlotVisible`). This prevents the inactive slot from capturing clicks, but also means the video area receives NO clicks while idle — the first-entry "click anywhere to play" affordance is dead.

Fix: add a transparent `absolute inset-0 z-10 cursor-pointer` overlay div that is rendered ONLY while idle (not playing and not paused and `inFilm.length > 0`). Its `onClick` calls `startFilmPlayback`. The overlay unmounts the instant playback starts, so it never intercepts subsequent click-to-toggle interactions (those go to the active video slot, whose `pointer-events` were restored by `setSlotVisible`).

**Z-index rules for the video area stack:**

- Slot `<video>` elements: no explicit z-index (stacked by DOM order)
- Idle click-catcher overlay: `z-10` — above the slots, catches the click
- Controls bar (scrubber + play button): must live in a SEPARATE sibling div BELOW the video area container, or use `relative z-20` if nested — must always win the stacking order over the overlay

```tsx
{!isFilmPlaying && !isFilmPaused && inFilm.length > 0 && (
  <div className="absolute inset-0 z-10 cursor-pointer" onClick={startFilmPlayback} />
)}
```

**Do NOT** restore `pointer-events: auto` on the idle active slot as the fix — that risks re-introducing the poster-image flash that the `pointer-events: none` guard was added to prevent.

### Dual-buffer model (black-flash fix)

Two `<video>` elements (slot A + slot B) are stacked `absolute inset-0 w-full h-full object-contain` inside the video area div. Only the active slot has `opacity: 1; pointer-events: default`; the inactive slot has `opacity: 0; pointer-events: none` (set imperatively via `setSlotVisible`, never via React state). On clip advance the inactive slot is pre-loaded and seeked to `in_ms` while the current clip is still playing; the swap is instantaneous with no decode wait. For cross-clip seeks during playback, `crossSeekToClip` loads into the opposite slot and uses `requestVideoFrameCallback` with a `metadata.mediaTime` gate (`TOLERANCE_SEC = 0.05`, `MAX_WAITS = 30` safety cap) to defer visibility until the GPU compositor has presented the seek-target frame — preventing frame-0 flash on WebView2. `slotGenRef` invalidates stale rVFC callbacks from rapid overlapping seeks.

### Performance rules

- Progress bar fill and elapsed label updated via `ref.current.style.width` / `ref.current.textContent` — NEVER via `setState` in `onTimeUpdate` (4–66 Hz re-render flood)
- Music sync and fade-out volume handled imperatively in `handleFilmTimeUpdate`
- `slotGenRef.current[slot]++` only inside `loadIntoSlot` / `crossSeekToClip` — never in a `useEffect` to avoid music-state re-renders polluting film refs

### Dual-buffer `onError` — proxy fallback per slot (U6a)

Both slot `<video>` elements must have `onError` handlers. `onError` does NOT bubble — attach directly to each element.

**Dual-buffer aware logic:** check `slot === activeFilmSlotRef.current` to decide recovery path:

- **Inactive (preloaded) slot:** retry silently — swap src to `convertFileSrc(local_path)` and re-`load()`. No toast. If this also fails, leave the slot unplayable (it will be skipped when promoted).
- **Active (playing) slot:** swap src + resume `play()` mid-playback; show a persistent, non-blocking note in the timeline gutter (see below). If local_path also fails, advance past the clip.

Stamp each slot's `<video>` element with `dataset.clipId` and `dataset.usingSource` ("0"=proxy, "1"=source) at every src-set site (`loadIntoSlot`, `preloadIntoSlot`, `crossSeekToClip`). The handler reads these to resolve which clip failed and whether it has already retried the source — preventing infinite retry loops.

**Inline gutter pattern for proxy-prep note (#97, replaces the old floating toast):** rendered via `EditorShell`'s `timelineGutter` prop, inside the blank `w-52` gutter left of the filmstrip — never overlapping it. Uses the Inline Warning Panel tokens: `bg-white/5 border border-white/10 border-l-2 border-l-[#FF8A65] rounded-md p-3`, body `text-sm text-[#e5e5e5]`. Copy is reassurance-framed around what the user experiences, not internal process state: `"Video may look choppy right now -- it'll smooth out on its own."` (no "proxy"/"optimised preview"/"preparing" jargon — see #97's JTBD re-evaluation: "preparing" still described the system's internal state, not the user's actual concern). **No auto-dismiss timer** — persists until the clip's `proxy-progress` event fires (tracked by clip id, not a boolean) or the user clicks the X. Both Trimmer and Sound implement this identically (`proxyFallbackClipId` state + ref, cleared in the `proxy-progress` listener).

---

## Render done-state — V3 split card (U4g)

The render done state uses a split card with a vertical divider: metadata left, actions right. A separate video preview panel appears below only for 1080p output; 4K has no in-app `<video>` element.

### Main card

```tsx
<div className="rounded-[14px] border border-white/[0.07] bg-[#1a1a1a] overflow-hidden grid"
     style={{ gridTemplateColumns: "1fr 1px 220px" }}>
  {/* LEFT — metadata */}
  <div className="p-7">
    {/* Export status pill */}
    <div className="inline-flex items-center gap-1.5 text-[13px] font-semibold px-3 py-[5px]
                    rounded-full bg-green-500/10 text-green-400 border border-green-500/20">
      <Check size={14} strokeWidth={2.5} /> Export finished
    </div>
    {/* Film name */}
    <div data-testid="output-filename"
         className="mt-4 text-[26px] font-bold text-white tracking-tight leading-tight">
      {displayName}
    </div>
    {/* Stats 2x2 grid */}
    <div className="mt-5 grid grid-cols-2 gap-x-4">
      {/* Each stat: label text-[11px] uppercase tracking-widest text-[#4a4946] font-medium
                    value text-[15px] font-semibold text-[#e5e5e5] */}
    </div>
    {/* Saved-to row */}
    <div className="mt-[18px] flex items-center gap-2 text-[13px] text-[#5a5956]">
      <Folder size={14} className="text-[#4a4946] flex-shrink-0" />
      <span>Saved to</span>
      <button className="text-[#7a7874] font-medium hover:text-[#c8c5c0] truncate max-w-[200px]">
        {pathDirname(outputPath)}
      </button>
    </div>
  </div>
  {/* Vertical divider */}
  <div className="bg-white/[0.07]" />
  {/* RIGHT — actions */}
  <div className="px-5 py-6 flex flex-col justify-center gap-2.5">
    {/* Primary (peach): Open film */}
    <button className="w-full flex items-center gap-1.5 px-[18px] py-[10px]
                       bg-[#FF8A65] text-[#0a0a0a] font-semibold text-[14px] rounded-lg
                       hover:bg-[#ffA07a] transition-colors duration-150">
      <Play size={15} fill="currentColor" stroke="none" /> Open film
    </button>
    {/* Secondary: Open folder / Render another version */}
    <button className="w-full flex items-center gap-1.5 px-[18px] py-[10px]
                       border border-white/20 text-[#e5e5e5] font-medium text-[14px] rounded-lg
                       hover:border-white/40 hover:bg-white/5 transition-colors duration-150">
      <Folder size={15} /> Open folder
    </button>
    <button className="w-full flex items-center gap-1.5 px-[18px] py-[10px]
                       border border-white/20 text-[#e5e5e5] font-medium text-[14px] rounded-lg
                       hover:border-white/40 hover:bg-white/5 transition-colors duration-150">
      <RotateCcw size={15} /> Render another version
    </button>
  </div>
</div>
```

**Stats grid tokens:**

- Label: `text-[11px] uppercase tracking-widest text-[#4a4946] font-medium`
- Value: `text-[15px] font-semibold text-[#e5e5e5] mt-0.5`
- Each stat is a `<div>` with a `pb-4 border-b border-white/[0.06]` bottom rule (last two skip the rule)

**`pathDirname(p)`** — extracts directory from a Windows path (splits on `\\`, pops last segment, rejoins). Defined in `src/pages/Render.tsx`.

**`shortDateTime(iso)`** — returns compact `"13 Jun · 16:10"` format for the Rendered stat. Use `absoluteDateTime()` (longer format) for anything requiring the full year.

### 1080p preview panel

Appears BELOW the main card, only when `outputRes !== "4k" && !videoMissing`:

```tsx
<div className="rounded-[14px] border border-white/[0.07] bg-[#1a1a1a] overflow-hidden">
  <div ref={videoContainerRef} style={{ height: `${videoHeight}px` }} className="relative">
    <video data-testid="video-player" src={assetUrl ?? undefined} controls
           className="w-full h-full object-contain bg-black" />
  </div>
  {/* Resize handle */}
  <div onMouseDown={startResize} className="h-1 bg-white/10 hover:bg-white/20 cursor-ns-resize" />
  {/* Footer: filename · duration · 1080p + "In-app preview" badge */}
</div>
```

**Critical:** The `<video>` element must be entirely absent from JSX on the 4K path (not CSS-hidden). A hidden `<video src>` still loads and can fire spurious `onError` → `videoMissing` state flip.

### Action button column — alignment rule

All buttons in the right-column action panel must be **left-aligned** — icon and label flush left, never centered. Apply `justify-start text-left` to every button in the column. Add `flex-shrink-0` to the icon to prevent it collapsing when label text wraps.

```tsx
className="w-full flex items-center justify-start gap-1.5 px-[18px] py-[10px] ... text-left"
// Icon:
className="flex-shrink-0"
```

This rule applies to any vertical list of icon+label buttons regardless of the card width. Without `justify-start`, the default flex `justify-content: normal` can appear centered when text wraps to a second line in a narrow column.

### Cancel render button (rendering phase)

Appears only during `phase === "rendering"`. Destructive secondary style (NOT peach):

```tsx
<button data-testid="btn-cancel-render"
        className="border border-white/30 text-[#e5e5e5] px-5 py-2.5 rounded-lg text-base
                   font-medium hover:border-white/60 hover:bg-white/5 transition-colors duration-150">
  Cancel render
</button>
```

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

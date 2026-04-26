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

---

## StepNav Breadcrumb

Five steps: Upload · Trim · Transitions · Sound · Render. `src/components/StepNav.tsx`.

```tsx
{/* Active step */}
"text-[#FF8A65] bg-[#FF8A65]/10 border border-[#FF8A65]/40"

{/* Past step (completed, clickable) */}
"text-[#e5e5e5] hover:text-[#e5e5e5] cursor-pointer"

{/* Future step (not yet reachable, disabled button) */}
"text-[#a3a3a3] cursor-default"

{/* Separator "/" between steps */}
"text-[#555555]"  {/* decorative only — muted token */}
```

Rules:
- **No opacity tricks** — do not use `text-[#e5e5e5]/70`, `text-[#e5e5e5]/20` etc. Use flat hex values only.
- Future/disabled steps: `#a3a3a3` is the minimum (readable, secondary). `#555555` is reserved for the decorative `/` separators only, not step labels.
- The `disabled` prop blocks clicks on future steps; `handleStepClick` also guards `idx >= activeIdx`.

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

## Key Copy Decisions

| Old                                 | New                                              | Reason                                        |
| ----------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| "Make my edit"                      | "Continue"                                       | Clearer next action                           |
| "Export full quality"               | "Export final edit"                              | Matches user mental model                     |
| "Edit settings"                     | "Adjust settings"                                | More descriptive                              |
| "Re-render with changes"            | "Re-render with changes" (disabled if no change) | Lean — avoids wasted Lambda invocations       |
| "processing…" in clip duration      | "—"                                              | "processing" confused users; no ETA available |
| "Saved to your library for 30 days" | "Saved for 30 days"                              | Concise; no auth in Phase 1                   |

# RushCut — Competitor Research

> Observations from testing competing products. Use these as inspiration for UX and feature decisions — what to copy, what to avoid, what gaps RushCut can exploit.

---

## Clipchamp (desktop app, Windows)

**Category:** Free consumer video editor, built into Windows 11. Targets casual creators.

### Entry point — two modes at launch

1. **Create a new video from scratch** — opens the full manual editor with complete customisation options
2. **Create a video with AI** — quick auto-compose using the user's own media

### Upload speed

- Manual editor: under 10 seconds for a full demo set (~110 MB)
- AI flow: under 5 seconds
- Drag & drop or click-to-browse supported

### Manual editor

- Extremely comprehensive — many text styles, titles, captions, fade effects, colour adjustments, etc.
- Multiple layers of titles / headers / text overlays
- Add logo to cards (premium option)
- Resolution / aspect ratio selector early in flow: 16:9 wide, vertical, square, classic 4:3, etc.
- Timeline is drag-and-drop — clips dragged directly onto the timeline from the media panel
- No separate upload vs editor page — media management and editing are unified in one screen

### AI flow (step by step)

1. **Upload** — "Click to add media or drag & drop / Your media will be reviewed by AI to compose your video"
   - "Learn more" helper button explains the steps
   - User provides a video title
2. **Style** — AI processes in background (progress bar + animated visualisation); user browses style templates in parallel
   - Each style shows: name, descriptive tags (e.g. *simple, clean*), and a colour palette swatch (e.g. black/yellow/grey)
   - User can up/downvote styles or tap "Choose for me"
3. **Length** — select target duration
4. **Export** — render and download

> **Status:** AI processing in step 2 ran for an extended time without completing during testing — appears slow or buggy. The final composed output has not been seen yet; notes to be updated once it completes.

### Standout UX details worth copying

| Feature                                           | Notes                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Hover-to-preview on thumbnails                    | Hovering a clip thumbnail in the upload screen plays a preview inline — no click needed         |
| Hover-to-preview on text styles                   | Hovering a style shows an animated effect preview before selecting                              |
| Early resolution / aspect-ratio picker            | User sets output shape before editing, not as an afterthought                                   |
| Unified upload + editor screen                    | Clips drag straight onto the timeline; no context switch between "upload" and "edit" pages      |
| Autosave / backup prompt                          | If user leaves mid-project, Clipchamp asks whether to save or discard — safety net users expect |
| AI processes in background during style selection | User isn't blocked waiting; they do useful work while processing runs                           |

### Questions this raises for RushCut

- Could the upload + editor steps collapse into one screen? Currently RushCut has a hard split between `/upload` and `/editor`.
- Hover-preview on clip thumbnails is a high-value QoL feature — worth prioritising.
- Style / transition preview on hover would reduce trial-and-error.
- Autosave / recovery prompt is table-stakes for a desktop app.
- The "AI processes while you browse styles" pattern is a good way to hide latency — applicable to RushCut's render queue.

# Music Tracks

## Phase 1 (current)

Place MP3 files here named by mood:

| `music_mood` value | filename required |
|--------------------|-------------------|
| `none`             | skip (no music mixed) |
| `cinematic`        | `cinematic.mp3`   |
| `upbeat`           | `upbeat.mp3`      |
| `chill`            | `chill.mp3`       |
| `electronic`       | `electronic.mp3`  |

Source royalty-free tracks from Pixabay or ccMixter.
Rebuild Lambda image after adding files (see MEMORY.md for WSL2 build commands).

If a file is missing, the pipeline skips music silently (no-op path in `pipeline/music.py`).

## Phase 2 (planned)

`music_mood` will be passed to the Loudly or Soundraw commercial API.
The API generates a unique, copyright-cleared track at render time.
No MP3s in the repo will be needed. No schema migration required — same `music_mood` field.

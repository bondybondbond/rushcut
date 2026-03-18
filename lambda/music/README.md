# Music Tracks

Place 5 royalty-free .mp3 tracks here before Batch 4 deploy.

Filenames must match `JobConfig.music_track` values in `src/types/project.ts`.

Suggested naming convention: `track_01.mp3`, `track_02.mp3`, etc.

Until tracks are added, `music_track: null` in the job config will skip music mixing (no-op path in `pipeline/music.py`).

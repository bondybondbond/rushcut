// Local schema types — matches SQLite tables in src-tauri/src/db.rs
// No R2, no Supabase, no cloud refs.

export interface Project {
  id: string;
  name: string;
  created_at: string;
}

export interface ClipMeta {
  filename: string;
  local_path: string; // Windows path e.g. C:\clips\DJI_01.MP4
  size_bytes: number;
  duration_ms: number;
  width: number;
  height: number;
  has_audio: boolean;
  thumbnail_data?: string | null; // base64 data URI
  codec_name?: string | null;     // e.g. "hevc", "h264"
}

export interface Clip extends ClipMeta {
  id: string;
  project_id: string;
  sort_order: number;
  thumbnail_data: string | null; // base64 JPEG data URL
  created_at: string;
  // Review fields (Batch 14c)
  in_ms: number | null;
  out_ms: number | null;
  focal_x: number | null;       // 0.0-1.0, null = centre
  focal_y: number | null;       // 0.0-1.0, null = centre
  zoom_mode: string | null;     // static "gentle"|"medium"|"tight" OR gradual "kb_<dir>_<ratio>_slow"
  include: number;              // 1 = include, 0 = skip
  proxy_path: string | null;
  waveform_data: string | null;
  clip_volume: number;          // per-clip audio multiplier, 0.0-2.0, default 1.0 (Batch J)
  proxy_status: "queued" | "done" | null; // background proxy gen state (Batch N)
}

export interface ProjectWithClips {
  project: Project;
  clips: Clip[];
}

export interface Job {
  id: string;
  project_id: string;
  status: "pending" | "processing" | "done" | "failed";
  progress_pct: number;
  local_output_path: string | null;
  settings_json: string | null;
  error_message: string | null;
  analysis_summary: string | null; // "clips_used=N,clips_total=M,clips_excluded=X" from Batch 13
  created_at: string;
  updated_at: string;
}

export type TransitionValue = "none" | "crossfade" | "dip_to_black" | "wipe" | "wipe_down" | "zoom" | "dissolve" | "barn_door" | "band_wipe";

export interface JobConfig {
  music_mood: "none" | "cinematic" | "upbeat" | "chill" | "electronic" | "custom";
  transition: TransitionValue;
  opening_transition: TransitionValue;
  closing_transition: TransitionValue;
  shuffle_between: boolean;
  intro_text: string;
  intro_subtitle?: string;
  intro_color: string; // #rrggbb background colour for intro card
  outro_text: string;
  outro_color: string; // #rrggbb background colour for outro card
  zoom: boolean;
  filter_boring: boolean;
  music_volume: "subtle" | "balanced" | "prominent";
  output_resolution?: "1080p" | "4k";
  custom_music_path?: string;
  music_fade_out?: "none" | "2s" | "5s";
  use_amf?: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  created_at: string;
  clip_count: number;
  last_job_id: string | null;
  last_job_status: "pending" | "processing" | "done" | "failed" | null;
  first_clip_thumbnail: string | null;
}

// Tauri event payloads
export interface PipelineProgressEvent {
  jobId: string;
  stage: string;
  progress: number;
  message: string;
  outputPath: string | null;
}

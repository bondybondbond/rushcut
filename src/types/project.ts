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
}

export interface Clip extends ClipMeta {
  id: string;
  project_id: string;
  sort_order: number;
  thumbnail_data: string | null; // base64 JPEG data URL
  created_at: string;
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
  created_at: string;
  updated_at: string;
}

export interface JobConfig {
  music_mood: "none" | "cinematic" | "upbeat" | "chill" | "electronic";
  intro_text: string;
  outro_text: string;
  zoom: boolean;
}

// Tauri event payloads
export interface PipelineProgressEvent {
  jobId: string;
  stage: string;
  progress: number;
  message: string;
  outputPath: string | null;
}

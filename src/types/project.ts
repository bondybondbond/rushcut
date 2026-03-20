export interface Project {
  id: string;
  user_id: string | null;
  status: "uploading" | "ready" | "processing" | "done";
  created_at: string;
}

export interface Clip {
  id: string;
  project_id: string;
  filename: string;
  r2_key: string;
  order: number;
  duration_ms: number | null;
  size_bytes: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  created_at: string;
}

export interface Job {
  id: string;
  project_id: string;
  status: "queued" | "processing" | "draft_ready" | "final_ready" | "failed";
  mode: "draft" | "final";
  config: JobConfig;
  draft_r2_key: string | null;
  final_r2_key: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobStatusResponse extends Job {
  draftUrl?: string;
  finalUrl?: string;
}

export interface JobConfig {
  transition: "crossfade" | "dip_to_black";
  music_track: string | null;
  silence_removal: boolean;
  zoom: boolean;
  intro_card: { enabled: boolean; text: string; color: string } | null;
  end_card: { enabled: boolean; text: string; color: string } | null;
}

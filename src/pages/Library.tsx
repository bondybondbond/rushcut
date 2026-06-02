import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProjectSummary, Job } from "@/types/project";
import { timeAgo } from "@/utils/timeAgo";
import { resLabel, renderStateFromStatus } from "@/utils/jobMeta";

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

interface PendingDelete {
  id: string;
  name: string;
  hasRenders: boolean;
}

interface RenamingState {
  id: string;
  value: string;
}

export default function Library() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  // Latest job per project (keyed by projectId) -- drives the T4 state machine.
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  // Live render progress per project (keyed by projectId), seeded from job.progress_pct.
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Inline confirmation state -- replaces window.confirm which Tauri WebView2 swallows silently.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [renaming, setRenaming] = useState<RenamingState | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Ref mirror of `jobs` so the (mount-once) event listeners can map an
  // incoming jobId -> projectId without going stale.
  const jobsRef = useRef<Record<string, Job>>({});
  useEffect(() => { jobsRef.current = jobs; }, [jobs]);

  useEffect(() => {
    let cancelled = false;
    invoke<ProjectSummary[]>("list_projects_cmd")
      .then(async (projs) => {
        if (cancelled) return;
        setProjects(projs);
        setLoading(false);
        // Prefetch the latest job for every project that has one. Small N
        // (project count), no Rust change -- get_job_cmd already exists.
        const withJobs = projs.filter((p) => p.last_job_id);
        const results = await Promise.all(
          withJobs.map((p) =>
            invoke<Job>("get_job_cmd", { jobId: p.last_job_id })
              .then((j) => [p.id, j] as const)
              .catch(() => null),
          ),
        );
        if (cancelled) return;
        const map: Record<string, Job> = {};
        const prog: Record<string, number> = {};
        for (const r of results) {
          if (!r) continue;
          map[r[0]] = r[1];
          prog[r[0]] = r[1].progress_pct;
        }
        setJobs(map);
        setProgress(prog);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(`Failed to load projects: ${e}`);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Live render feedback: map jobId -> projectId via the prefetched jobs map
  // and update card state in place. On done we trust the event payload (which
  // already carries outputPath + analysis) -- no re-fetch.
  useEffect(() => {
    const findProject = (jobId: string): string | undefined =>
      Object.values(jobsRef.current).find((j) => j.id === jobId)?.project_id;

    const unlistenProgress = listen<{ jobId: string; progress: number }>("pipeline-progress", (event) => {
      const pid = findProject(event.payload.jobId);
      if (!pid) return;
      setProgress((prev) => ({ ...prev, [pid]: event.payload.progress }));
    });

    const unlistenDone = listen<{ jobId: string; outputPath: string | null; analysis?: string | null }>(
      "pipeline-done",
      (event) => {
        const pid = findProject(event.payload.jobId);
        if (!pid) return;
        setJobs((prev) => {
          const j = prev[pid];
          if (!j) return prev;
          return {
            ...prev,
            [pid]: {
              ...j,
              status: "done",
              local_output_path: event.payload.outputPath ?? j.local_output_path,
              analysis_summary: event.payload.analysis ?? j.analysis_summary,
              updated_at: new Date().toISOString(),
            },
          };
        });
        setProgress((prev) => ({ ...prev, [pid]: 100 }));
      },
    );

    const unlistenError = listen<{ jobId: string; message: string }>("pipeline-error", (event) => {
      const pid = findProject(event.payload.jobId);
      if (!pid) return;
      setJobs((prev) => {
        const j = prev[pid];
        if (!j) return prev;
        return { ...prev, [pid]: { ...j, status: "failed", error_message: event.payload.message || j.error_message } };
      });
    });

    return () => {
      unlistenProgress.then((f) => f());
      unlistenDone.then((f) => f());
      unlistenError.then((f) => f());
    };
  }, []);

  useEffect(() => {
    if (renaming) renameInputRef.current?.focus();
  }, [renaming]);

  // Smart Open routing: a project with an active/finished/failed job opens the
  // Render screen (which self-detects what to show via get_render_status_cmd);
  // everything else opens the Trimmer. No location state needed (T5).
  function handleOpen(p: ProjectSummary) {
    const job = jobs[p.id];
    const state = renderStateFromStatus(job?.status ?? p.last_job_status);
    navigate(state === "idle" ? `/trimmer/${p.id}` : `/render/${p.id}`);
  }

  async function commitRename(projectId: string, newName: string) {
    const trimmed = newName.trim();
    const original = projects.find((p) => p.id === projectId)?.name ?? "";
    setRenaming(null);
    if (!trimmed || trimmed === original) return;
    setProjects((prev) => prev.map((p) => p.id === projectId ? { ...p, name: trimmed } : p));
    try {
      await invoke("rename_project_cmd", { projectId, name: trimmed });
    } catch {
      // revert on failure
      setProjects((prev) => prev.map((p) => p.id === projectId ? { ...p, name: original } : p));
    }
  }

  async function confirmDelete(projectId: string) {
    setDeletingId(projectId);
    setPendingDelete(null);
    try {
      await invoke("delete_project_cmd", { projectId });
      setProjects((prev) => prev.filter((p) => p.id !== projectId));
    } catch (e) {
      setError(`Failed to delete project: ${e}`);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-[#e5e5e5]">My Projects</h1>
            <p className="text-[#a3a3a3] text-sm mt-1">Past editing sessions.</p>
          </div>
          <button
            onClick={() => navigate("/upload")}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-[#C5FFF9]/40 text-[#C5FFF9] text-sm font-medium rounded-md hover:bg-[#C5FFF9]/10 transition-colors"
          >
            &#8592; Back
          </button>
        </div>

        {loading && <p className="text-[#a3a3a3] text-sm">Loading...</p>}
        {error && <p className="text-red-400 text-sm">{error}</p>}

        {!loading && projects.length === 0 && (
          <div className="text-center py-16 border border-white/10 rounded-lg">
            <p className="text-[#a3a3a3]">No projects yet.</p>
            <button
              onClick={() => navigate("/upload")}
              className="mt-4 text-sm text-[#FF8A65] hover:text-[#ff9e7a] transition-colors"
            >
              Start your first project
            </button>
          </div>
        )}

        {projects.length > 0 && (
          <div className="space-y-2">
            {projects.map((p) => {
              const job = jobs[p.id];
              const state = renderStateFromStatus(job?.status ?? p.last_job_status);
              const pct = progress[p.id] ?? job?.progress_pct ?? 0;
              const res = job ? resLabel(job) : null;
              return (
              <div key={p.id} data-testid="project-card" className="group">
                {/* Project row */}
                <div className="flex items-center justify-between px-4 py-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/8 transition-colors">
                  <div className="min-w-0 flex-1">
                    {renaming?.id === p.id ? (
                      <input
                        ref={renameInputRef}
                        data-testid="input-project-name"
                        value={renaming.value}
                        onChange={(e) => setRenaming({ id: p.id, value: e.target.value })}
                        onBlur={() => commitRename(p.id, renaming.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename(p.id, renaming.value);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        className="text-base font-medium bg-transparent border-b border-[#C9A96E] text-[#e5e5e5] focus:outline-none w-64"
                      />
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <p className="text-[#e5e5e5] font-medium truncate">{p.name}</p>
                        <button
                          data-testid="btn-rename-project"
                          onClick={() => setRenaming({ id: p.id, value: p.name })}
                          className="opacity-0 group-hover:opacity-100 p-0.5 text-[#a3a3a3] hover:text-[#e5e5e5] transition-all"
                          aria-label="Rename project"
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M15.232 5.232l3.536 3.536M9 13l-4 1 1-4L14.586 2.414a2 2 0 012.828 0l1.172 1.172a2 2 0 010 2.828L9 13z" />
                          </svg>
                        </button>
                      </div>
                    )}
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[#a3a3a3] text-xs">{formatDate(p.created_at)}</span>
                      <span className="text-[#a3a3a3] text-xs">{p.file_count} file{p.file_count !== 1 ? "s" : ""} &middot; {p.cut_count} cut{p.cut_count !== 1 ? "s" : ""}</span>
                      {/* T4 render-state line */}
                      {state === "rendering" && (
                        <span data-testid="project-status" className="text-[#C9A96E] text-xs font-medium">Rendering &mdash; {pct}%</span>
                      )}
                      {state === "done" && (
                        <span data-testid="project-status" className="text-[#a3a3a3] text-xs">
                          Last render: {timeAgo(job?.updated_at)}{res ? <> &middot; {res}</> : null}
                        </span>
                      )}
                      {state === "error" && (
                        <span data-testid="project-status" className="text-red-400 text-xs font-medium">Render failed</span>
                      )}
                      {state === "idle" && (
                        <span data-testid="project-status" className="text-[#a3a3a3] text-xs">No renders</span>
                      )}
                    </div>
                    {/* Live progress bar (green), only while rendering */}
                    {state === "rendering" && (
                      <div className="h-1 bg-white/10 rounded-full overflow-hidden mt-1.5 max-w-xs">
                        <div
                          data-testid="project-progress-bar"
                          className="h-full bg-[#22c55e] rounded-full transition-all duration-500"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                    <button
                      data-testid="btn-open-project"
                      onClick={() => handleOpen(p)}
                      className="px-3 py-1.5 text-xs text-[#a3a3a3] border border-white/20 rounded-md hover:text-[#e5e5e5] hover:border-white/40 transition-colors"
                    >
                      Open
                    </button>
                    <button
                      data-testid="btn-delete-project"
                      onClick={() => setPendingDelete({ id: p.id, name: p.name, hasRenders: state === "done" })}
                      disabled={deletingId === p.id}
                      className="p-1.5 text-red-400/60 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors disabled:opacity-40"
                      aria-label="Delete project"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                        <path d="M10 11v6M14 11v6"/>
                        <path d="M9 6V4h6v2"/>
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Inline confirmation panel -- appears below the row when trash clicked */}
                {pendingDelete?.id === p.id && (
                  <div className="mx-1 mb-1 px-4 py-3 rounded-b-lg border border-t-0 border-red-400/30 bg-red-950/30 flex items-center justify-between gap-4">
                    <p className="text-xs text-[#e5e5e5]/80 leading-snug">
                      {pendingDelete.hasRenders
                        ? <>Delete <span className="font-medium text-[#e5e5e5]">{p.name}</span>? The rendered video file on disk will also be removed.</>
                        : <>Delete <span className="font-medium text-[#e5e5e5]">{p.name}</span>? Only the project record will be removed (no renders exist).</>
                      }
                    </p>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => setPendingDelete(null)}
                        className="px-3 py-1 text-xs text-[#a3a3a3] border border-white/20 rounded hover:text-[#e5e5e5] hover:border-white/40 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => confirmDelete(p.id)}
                        className="px-3 py-1 text-xs text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectSummary } from "@/types/project";

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span data-testid="project-status" className="text-[#a3a3a3] text-xs">No renders</span>;
  const map: Record<string, { label: string; color: string }> = {
    done:       { label: "Done",       color: "text-[#22c55e]" },
    processing: { label: "Processing", color: "text-[#C9A96E]" },
    pending:    { label: "Pending",    color: "text-[#a3a3a3]" },
    failed:     { label: "Failed",     color: "text-red-400"   },
  };
  const { label, color } = map[status] ?? { label: status, color: "text-[#a3a3a3]" };
  return <span data-testid="project-status" className={`text-xs font-medium ${color}`}>{label}</span>;
}

interface PendingDelete {
  id: string;
  name: string;
  hasRenders: boolean;
}

export default function Library() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // Inline confirmation state -- replaces window.confirm which Tauri WebView2 swallows silently.
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  useEffect(() => {
    invoke<ProjectSummary[]>("list_projects_cmd")
      .then(setProjects)
      .catch((e) => setError(`Failed to load projects: ${e}`))
      .finally(() => setLoading(false));
  }, []);

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
            {projects.map((p) => (
              <div key={p.id} data-testid="project-card">
                {/* Project row */}
                <div className="flex items-center justify-between px-4 py-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/8 transition-colors">
                  <div className="min-w-0 flex-1">
                    <p className="text-[#e5e5e5] font-medium truncate">{p.name}</p>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-[#a3a3a3] text-xs">{formatDate(p.created_at)}</span>
                      <span className="text-[#a3a3a3] text-xs">{p.clip_count} clip{p.clip_count !== 1 ? "s" : ""}</span>
                      <StatusBadge status={p.last_job_status} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                    {p.last_job_id && p.last_job_status === "done" && (
                      <button
                        onClick={() => navigate(`/output/${p.last_job_id}`)}
                        className="px-3 py-1.5 text-xs text-[#22c55e] border border-[#22c55e]/30 rounded-md hover:bg-[#22c55e]/10 transition-colors"
                      >
                        Watch
                      </button>
                    )}
                    <button
                      data-testid="btn-open-project"
                      onClick={() => p.last_job_id && p.last_job_status === "processing"
                        ? navigate(`/output/${p.last_job_id}`)
                        : navigate(`/trimmer/${p.id}`)}
                      className="px-3 py-1.5 text-xs text-[#a3a3a3] border border-white/20 rounded-md hover:text-[#e5e5e5] hover:border-white/40 transition-colors"
                    >
                      Open
                    </button>
                    <button
                      data-testid="btn-delete-project"
                      onClick={() => setPendingDelete({ id: p.id, name: p.name, hasRenders: p.last_job_status === "done" })}
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
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

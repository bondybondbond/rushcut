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
  if (!status) return <span className="text-[#a3a3a3] text-xs">No renders</span>;
  const map: Record<string, { label: string; color: string }> = {
    done:       { label: "Done",       color: "text-[#22c55e]" },
    processing: { label: "Processing", color: "text-[#C9A96E]" },
    pending:    { label: "Pending",    color: "text-[#a3a3a3]" },
    failed:     { label: "Failed",     color: "text-red-400"   },
  };
  const { label, color } = map[status] ?? { label: status, color: "text-[#a3a3a3]" };
  return <span className={`text-xs font-medium ${color}`}>{label}</span>;
}

export default function Library() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<ProjectSummary[]>("list_projects_cmd")
      .then(setProjects)
      .catch((e) => setError(`Failed to load projects: ${e}`))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5] p-8">
      <div className="max-w-3xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-[#e5e5e5]">My Projects</h1>
              <p className="text-[#a3a3a3] text-sm mt-1">Past editing sessions.</p>
            </div>
          </div>
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
              <div
                key={p.id}
                className="flex items-center justify-between px-4 py-3 rounded-lg border border-white/10 bg-white/5 hover:bg-white/8 transition-colors"
              >
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
                    onClick={() => navigate(`/editor/${p.id}`)}
                    className="px-3 py-1.5 text-xs text-[#a3a3a3] border border-white/20 rounded-md hover:text-[#e5e5e5] hover:border-white/40 transition-colors"
                  >
                    Open
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

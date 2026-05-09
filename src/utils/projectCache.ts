import type { Clip } from "@/types/project";

interface CachedProject {
  name: string;
  clips: Clip[];
}

// Module-level cache — persists across React Router navigations within the same session.
// Used to show previous data immediately while get_project resolves, eliminating screen-change flicker.
const _cache = new Map<string, CachedProject>();

export const projectCache = {
  get: (projectId: string): CachedProject | null => _cache.get(projectId) ?? null,
  set: (projectId: string, data: CachedProject): void => { _cache.set(projectId, data); },
};

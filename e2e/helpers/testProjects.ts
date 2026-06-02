// Batch T7: registry of project ids created during a WDIO run.
// Specs call trackTestProject(projectId) right after creating their project.
// wdio.conf.ts after() reads trackedTestProjects() to reset each project's stale
// 'encoding' proxy claims before its binary is SIGTERM'd, leaving the shared DB clean.
// Scoped per-project so the user's real projects in the shared DB are never touched.

const ids: string[] = [];

export function trackTestProject(id: string | null | undefined): void {
  if (id && !ids.includes(id)) ids.push(id);
}

export function trackedTestProjects(): string[] {
  return [...ids];
}

export function clearTrackedTestProjects(): void {
  ids.length = 0;
}

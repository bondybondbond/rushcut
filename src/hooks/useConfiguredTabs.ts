export type ConfigurableTab = "arrange" | "sound" | "render";

export function useConfiguredTabs(projectId: string): Set<ConfigurableTab> {
  const configured = new Set<ConfigurableTab>();

  const transitionVal = sessionStorage.getItem(`rc_transition_${projectId}`);
  if (transitionVal && transitionVal !== "none") {
    configured.add("arrange");
  }

  const soundRaw = sessionStorage.getItem(`rc_sound_${projectId}`);
  if (soundRaw) {
    try {
      const parsed = JSON.parse(soundRaw) as { mood?: string };
      if (parsed?.mood && parsed.mood !== "none") {
        configured.add("sound");
      }
    } catch {
      // malformed — treat as unconfigured
    }
  }

  return configured;
}

import { readTransitionConfig } from "@/utils/buildJobConfig";

export type ConfigurableTab = "arrange" | "sound" | "render";

export function useConfiguredTabs(projectId: string): Set<ConfigurableTab> {
  const configured = new Set<ConfigurableTab>();

  // M2: rc_transition_ stores JSON {between, opening, closing, shuffleBetween}.
  // Treat "arrange" as configured when any of the three slots is non-none, or shuffle is on.
  const tc = readTransitionConfig(projectId);
  if (tc.between !== "none" || tc.opening !== "none" || tc.closing !== "none" || tc.shuffleBetween) {
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

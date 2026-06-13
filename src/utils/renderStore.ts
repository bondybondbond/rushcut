// Render-setting persistence (U1b).
//
// Render settings (transition, music, cards, output resolution, fast-render)
// must survive a binary relaunch. WebView2 CLEARS sessionStorage on process
// restart but PERSISTS localStorage to its user-data folder -- so these prefs
// live in localStorage, matching the robustness of DB-backed per-clip volume.
//
// Scope: ONLY the rc_* render-setting keys go through here. Any other
// sessionStorage usage in the app is unrelated and intentionally untouched.

/**
 * Read an rc_* render-setting pref. Returns `null` for a missing/never-set key
 * (NOT ""), so existing callers' `if (raw)` / `?? default` guards fall back to
 * their defaults exactly as before. Never throws.
 */
export function getRenderPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write an rc_* render-setting pref. Never throws. */
export function setRenderPref(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* ignore */
  }
}

/** Remove a single rc_* pref. Never throws. */
export function removeRenderPref(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Remove all rc_* prefs for a project (call on project delete to avoid orphaned keys). */
export function clearRenderPrefs(projectId: string): void {
  const keys = [
    `rc_transition_${projectId}`,
    `rc_sound_${projectId}`,
    `rc_cards_${projectId}`,
    `rc_render_res_${projectId}`,
    `rc_render_pending_${projectId}`,
  ];
  try {
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

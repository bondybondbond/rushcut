// Render-setting persistence (#188 — supersedes the original localStorage wrapper).
//
// Render/editor settings (transition, music, cards, output resolution, tab config)
// are EDIT DECISIONS — the user must not lose them. They used to live directly in
// WebView2 localStorage, which is not a durable persistence boundary: it is keyed
// by (renderer origin + WebView2 User-Data-Folder), flushes lazily, and is dropped
// on an unclean process kill — all routine in this project's dev workflow. Cards
// silently vanished after a close/reopen three times (#188).
//
// Fix: SQLite (`settings` KV table, reached via Tauri commands) is now the source
// of truth. This module is a SYNCHRONOUS in-memory write-through cache over it:
//   - hydrated once, before first React render (see main.tsx), so reads stay sync
//   - every write updates the cache immediately AND commits to SQLite (the command
//     commits before it resolves, so a hard kill moments later can't lose it)
//   - localStorage is read exactly once, as a one-time migration salvage, then dead
//
// Fallback rule (deliberately environment-split, not "never fail loudly"):
//   - Real Tauri app: SQLite is authoritative. If hydrate throws, that is a GENUINE
//     persistence failure — logged loudly, `persistenceDegraded` set — and only then
//     do we fall back to a localStorage-seeded cache as a last-resort read.
//   - Vite/dev (non-Tauri): localStorage-backed cache is expected and silent.

import { invoke } from "@tauri-apps/api/core";

const MIGRATION_MARKER = "rc_prefs_migrated_v1";
const RC_KEY = /^rc_/;

const cache = new Map<string, string>();

/** True once SQLite hydration has been attempted (success or fallback). */
let hydrated = false;
/** True when SQLite is the live backing store. False in dev / on a hydrate failure. */
let dbBacked = false;
/** True only in a real Tauri context where SQLite hydration FAILED — a real bug, not dev. */
let persistenceDegraded = false;
/** Singleton so a double-invoke (StrictMode, HMR) shares one hydration, not two. */
let hydratePromise: Promise<void> | null = null;

function inTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ((window as unknown as { isTauri?: boolean }).isTauri === true ||
      "__TAURI_INTERNALS__" in window)
  );
}

/**
 * Wait (briefly) for Tauri's IPC bridge to be injected. On a cold WebView2 boot
 * the init script can race deferred module execution, so `invoke` fired too early
 * throws "not ready" rather than reaching Rust (tauri#12990). Without this guard
 * that transient throw would silently strand the whole session on the localStorage
 * fallback. Returns false only in a genuine non-Tauri context (pure `vite` browser).
 */
async function waitForTauriInternals(capMs = 800): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const start = performance.now();
  while (performance.now() - start < capMs) {
    if ("__TAURI_INTERNALS__" in window) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return "__TAURI_INTERNALS__" in window;
}

function seedCacheFromLocalStorage(): void {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && RC_KEY.test(k)) {
        const v = localStorage.getItem(k);
        if (v !== null) cache.set(k, v);
      }
    }
  } catch {
    /* localStorage unavailable — cache stays empty, callers fall back to defaults */
  }
}

/**
 * Hydrate the cache from SQLite and run the one-time localStorage -> SQLite
 * migration. Call once, before the first component render. Never throws.
 * Idempotent: subsequent calls return the same promise.
 */
export function hydrateRenderPrefs(): Promise<void> {
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    if (!(await waitForTauriInternals())) {
      // Genuine non-Tauri context (bare `vite` in a browser) — expected, silent.
      seedCacheFromLocalStorage();
      hydrated = true;
      return;
    }
    try {
      const rows = await invoke<Record<string, string>>("get_all_settings_cmd");
      for (const [k, v] of Object.entries(rows)) cache.set(k, v);
      dbBacked = true;

      let migratedCount = 0;
      if (!cache.has(MIGRATION_MARKER)) {
        const entries: [string, string][] = [];
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || !RC_KEY.test(k) || cache.has(k)) continue;
            const v = localStorage.getItem(k);
            if (v !== null) entries.push([k, v]);
          }
        } catch {
          /* no localStorage to salvage — migration is just the marker write */
        }
        await invoke("migrate_render_prefs_cmd", {
          entries,
          markerKey: MIGRATION_MARKER,
        });
        for (const [k, v] of entries) if (!cache.has(k)) cache.set(k, v);
        cache.set(MIGRATION_MARKER, "done");
        migratedCount = entries.length;
      }

      // eslint-disable-next-line no-console
      console.info(
        `[renderStore] hydrated from SQLite: ${cache.size} keys, ${migratedCount} migrated from localStorage`
      );
    } catch (err) {
      dbBacked = false;
      if (inTauri()) {
        persistenceDegraded = true;
        // eslint-disable-next-line no-console
        console.error(
          "[renderStore] SQLite hydrate FAILED in a Tauri context — render prefs are DEGRADED " +
            "(writes will only reach localStorage; cards/transitions may not survive a restart)",
          err
        );
        invoke("diag_log_cmd", {
          line: `renderStore hydrate FAILED (Tauri): ${String(err)}`,
        }).catch(() => {});
      }
      // Last-resort read so the current session still has whatever localStorage holds.
      seedCacheFromLocalStorage();
    } finally {
      hydrated = true;
    }
  })();
  return hydratePromise;
}

/** True if render-pref persistence is running in its degraded (SQLite-down) mode. */
export function isPersistenceDegraded(): boolean {
  return persistenceDegraded;
}

// #188: DEV-only test hook. E2E specs used to seed `rc_*` state with
// `localStorage.setItem`; now that SQLite is the backing store they seed via
// `set_setting_cmd` and then call this to force the in-memory cache to re-read
// from the DB without a full page reload (reloads fight Vite's HMR socket in
// WebView2 — see e2e.md). Absent from production (`tauri build`) bundles.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as { __rcRehydrateRenderPrefs?: () => Promise<void> }).__rcRehydrateRenderPrefs =
    () => {
      hydrated = false;
      dbBacked = false;
      persistenceDegraded = false;
      hydratePromise = null;
      cache.clear();
      return hydrateRenderPrefs();
    };
}

/**
 * Read an rc_* render-setting pref from the hydrated cache. Returns `null` for a
 * missing/never-set key (NOT ""), so existing `if (raw)` / `?? default` guards
 * fall back exactly as before. Sync, never throws.
 */
export function getRenderPref(key: string): string | null {
  if (!hydrated && !hydratePromise) {
    // Defensive: a read before hydrate was kicked off (shouldn't happen — main.tsx
    // awaits it pre-render). Seed synchronously from localStorage so we don't
    // silently return defaults for real data.
    seedCacheFromLocalStorage();
  }
  return cache.get(key) ?? null;
}

/** Write an rc_* render-setting pref. Cache updates synchronously; SQLite commit is fire-and-forget. Never throws. */
export function setRenderPref(key: string, val: string): void {
  cache.set(key, val);
  if (dbBacked) {
    invoke("set_setting_cmd", { key, value: val }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[renderStore] failed to persist "${key}" to SQLite`, err);
    });
  } else {
    // Dev, or degraded Tauri: localStorage is the only available sink.
    try {
      localStorage.setItem(key, val);
    } catch {
      /* ignore */
    }
  }
}

/** Remove a single rc_* pref. Never throws. */
export function removeRenderPref(key: string): void {
  cache.delete(key);
  if (dbBacked) {
    invoke("delete_setting_cmd", { key }).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(`[renderStore] failed to delete "${key}" from SQLite`, err);
    });
  } else {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

/** Remove all rc_* prefs for a project (call on project delete to avoid orphaned keys). */
export function clearRenderPrefs(projectId: string): void {
  const keys = [
    `rc_transition_${projectId}`,
    `rc_sound_${projectId}`,
    `rc_cards_${projectId}`, // legacy fixed start/end shape (pre-#149)
    `rc_cards_v2_${projectId}`, // #188: current placed-cards store — was missing here (orphan-on-delete bug)
    `rc_cards_last_color_${projectId}`,
    `rc_render_res_${projectId}`,
    `rc_render_pending_${projectId}`,
  ];
  keys.forEach((k) => removeRenderPref(k));
}

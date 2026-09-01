// #188: render prefs (rc_transition_* / rc_cards_v2_* / rc_sound_* / rc_render_res_*)
// moved from WebView2 localStorage to the SQLite `settings` table. Specs must seed
// and read them through Tauri commands, not `localStorage.setItem` / `.getItem`
// (which no longer reach the app's read path).
//
// Usage:
//   await seedRenderPrefs(projectId, { transition: {...}, cards: [...], sound: {...} });
//   const raw = await readRenderPref(projectId, "cards");   // JSON string or null

type SeedInput = {
  transition?: unknown;
  cards?: unknown;
  sound?: unknown;
  renderRes?: string;
};

const keyFor = (which: "transition" | "cards" | "sound" | "renderRes", id: string): string => {
  switch (which) {
    case "transition":
      return `rc_transition_${id}`;
    case "cards":
      return `rc_cards_v2_${id}`;
    case "sound":
      return `rc_sound_${id}`;
    case "renderRes":
      return `rc_render_res_${id}`;
  }
};

/**
 * Write one or more render prefs into SQLite via `set_setting_cmd`, then force the
 * running app's in-memory cache to re-read from the DB (`__rcRehydrateRenderPrefs`,
 * a DEV-only hook). After this resolves, `readPlacedCards` / `readTransitionConfig`
 * / `getRenderPref` in the app see the seeded values on the next screen mount.
 *
 * NOTE: everything crossing `browser.execute` must be JSON — build the string
 * key/value pairs HERE (Node), pass a plain `Record<string,string>`.
 */
export async function seedRenderPrefs(projectId: string, input: SeedInput): Promise<void> {
  const pairs: Record<string, string> = {};
  if (input.transition !== undefined)
    pairs[keyFor("transition", projectId)] = JSON.stringify(input.transition);
  if (input.cards !== undefined) pairs[keyFor("cards", projectId)] = JSON.stringify(input.cards);
  if (input.sound !== undefined) pairs[keyFor("sound", projectId)] = JSON.stringify(input.sound);
  if (input.renderRes !== undefined) pairs[keyFor("renderRes", projectId)] = String(input.renderRes);

  await browser.execute(async (kv: Record<string, string>) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
      __rcRehydrateRenderPrefs?: () => Promise<void>;
    };
    for (const [key, value] of Object.entries(kv)) {
      await w.__TAURI_INTERNALS__.invoke("set_setting_cmd", { key, value });
    }
    if (w.__rcRehydrateRenderPrefs) await w.__rcRehydrateRenderPrefs();
  }, pairs);
}

/** Read one render pref back from SQLite (raw stored string, or null if unset). */
export async function readRenderPref(
  projectId: string,
  which: "transition" | "cards" | "sound" | "renderRes",
): Promise<string | null> {
  const key = keyFor(which, projectId);
  return browser.execute(async (k: string) => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
    };
    const all = (await w.__TAURI_INTERNALS__.invoke("get_all_settings_cmd")) as Record<
      string,
      string
    >;
    return all[k] ?? null;
  }, key);
}

/** The whole settings table as a plain object (for migration / key-presence assertions). */
export async function readAllSettings(): Promise<Record<string, string>> {
  return browser.execute(async () => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
    };
    return (await w.__TAURI_INTERNALS__.invoke("get_all_settings_cmd")) as Record<string, string>;
  });
}

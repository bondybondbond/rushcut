/**
 * #188 -- render/editor prefs persist in SQLite, not WebView2 localStorage.
 *
 * Cards, transition choice and music mood used to live in localStorage, which is
 * not durable across an app restart or an unclean kill -- they vanished three
 * times on the user's own launches. renderStore.ts is now a synchronous
 * write-through cache over the SQLite `settings` table (get_all_settings_cmd /
 * set_setting_cmd / delete_setting_cmd / migrate_render_prefs_cmd).
 *
 * This spec verifies, at the layer WDIO can reach, that writes/deletes actually
 * land in SQLite and that the one-time localStorage->SQLite migration is
 * DB-wins + version-guarded. The real "survives a full close/reopen" check is
 * a manual user step (only their own binary exercises the real rushcut.db path).
 *
 *   pnpm exec wdio run wdio.qa.conf.ts --spec e2e/qa-isolation.spec.ts --spec e2e/settings-persistence.spec.ts
 */
import { trackTestProject } from "./helpers/testProjects";
import { readAllSettings } from "./helpers/renderPrefs";

const MIGRATION_MARKER = "rc_prefs_migrated_v1";

async function reachAppRoute() {
  await browser.waitUntil(
    async () => {
      try {
        return /\/(upload|library|editor|trimmer|arrange|sound)\b/.test(await browser.getUrl());
      } catch {
        return false;
      }
    },
    { timeout: 25_000, interval: 300, timeoutMsg: "React never redirected to an app route" },
  );
  await browser.pause(400);
}

/** Seed a project + add 2 clips to the film. */
async function seedProject(): Promise<string | null> {
  const projectId = await browser.execute(async () => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const metas = (await invoke("scan_folder", { folderPath: "C:\\clips" })) as Array<Record<string, unknown>>;
    if (!metas || metas.length < 2) return null;
    const clips = metas.slice(0, 2).map((m) => ({
      filename: m.filename,
      local_path: m.local_path,
      size_bytes: m.size_bytes,
      duration_ms: m.duration_ms,
      width: m.width,
      height: m.height,
      has_audio: m.has_audio,
      thumbnail_data: m.thumbnail_data ?? null,
    }));
    return (await invoke("create_project", { name: "Settings-persistence E2E", clips })) as string;
  });
  if (!projectId) return null;

  await browser.execute(async (id: string) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const data = (await invoke("get_project", { projectId: id })) as { clips: Array<{ id: string; include: number; sort_order: number }> };
    const sources = data.clips.filter((c) => c.include === 0).sort((a, b) => a.sort_order - b.sort_order);
    for (const src of sources.slice(0, 2)) {
      await invoke("add_clip_cut_cmd", { projectId: id, sourceClipId: src.id, inMs: 0, outMs: 4000 });
    }
  }, projectId);

  return projectId;
}

async function invokeInApp<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return browser.execute(
    async (c: string, a: Record<string, unknown> | undefined) => {
      const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      return invoke(c, a) as Promise<unknown>;
    },
    cmd,
    args,
  ) as Promise<T>;
}

describe("#188 -- render prefs persist in SQLite, not localStorage", () => {
  let projectId: string | null = null;

  before(async () => {
    await reachAppRoute();
    projectId = await seedProject();
    if (projectId) trackTestProject(projectId);
  });

  it("set_setting_cmd write is visible in get_all_settings_cmd", async () => {
    if (!projectId) return;
    const key = `rc_probe_${projectId}`;
    await invokeInApp("set_setting_cmd", { key, value: "hello-188" });
    const all = await readAllSettings();
    expect(all[key]).toBe("hello-188");
    await invokeInApp("delete_setting_cmd", { key });
  });

  it("delete_setting_cmd drops the row from settings", async () => {
    if (!projectId) return;
    const key = `rc_probe_del_${projectId}`;
    await invokeInApp("set_setting_cmd", { key, value: "x" });
    let all = await readAllSettings();
    expect(all[key]).toBe("x");
    await invokeInApp("delete_setting_cmd", { key });
    all = await readAllSettings();
    expect(all[key]).toBeUndefined();
  });

  it("placing a card writes an rc_cards_v2_<projectId> row to settings", async () => {
    if (!projectId) return;
    await browser.execute((id: string) => {
      (window as unknown as { history: History }).history.pushState({}, "", `/arrange/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    }, projectId);
    await browser.waitUntil(async () => (await browser.getUrl()).includes("/arrange/"), {
      timeout: 10_000,
      interval: 200,
      timeoutMsg: "Never reached /arrange/",
    });
    await browser.pause(1200);
    const cardsTab = await $('[data-testid="arrange-tab-cards"]');
    await cardsTab.waitForExist({ timeout: 5_000 });
    await cardsTab.click();
    await browser.pause(500);

    const input = await $('[data-testid="input-card-title"]');
    await input.waitForExist({ timeout: 8_000 });
    await input.click();
    await input.setValue("PERSIST ME");
    await browser.pause(450); // debounced setNewCardDraft
    const btn = await $('[data-testid="btn-add-card-to-film"]');
    await btn.waitForExist({ timeout: 5_000 });
    await btn.click();
    await browser.pause(600);

    const all = await readAllSettings();
    const raw = all[`rc_cards_v2_${projectId}`];
    expect(raw).toBeDefined();
    const cards = JSON.parse(raw) as Array<{ text: string }>;
    expect(cards.some((c) => c.text === "PERSIST ME")).toBe(true);
  });

  it("migration is DB-wins and version-guarded on re-hydrate", async () => {
    if (!projectId) return;
    const conflictKey = `rc_mig_conflict_${projectId}`;
    const freshKey = `rc_mig_fresh_${projectId}`;

    // DB already has a value for conflictKey; localStorage has a DIFFERENT (stale) one.
    await invokeInApp("set_setting_cmd", { key: conflictKey, value: "from-db" });
    // freshKey exists ONLY in localStorage (no DB row) -> should be salvaged.
    // Drop the migration marker so the next hydrate actually runs the migration.
    await browser.execute(
      (marker: string, ck: string, fk: string) => {
        localStorage.setItem(ck, "from-localstorage-stale");
        localStorage.setItem(fk, "from-localstorage-fresh");
        const w = window as unknown as {
          __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
        };
        return w.__TAURI_INTERNALS__.invoke("delete_setting_cmd", { key: marker });
      },
      MIGRATION_MARKER,
      conflictKey,
      freshKey,
    );

    await browser.execute(async () => {
      const w = window as unknown as { __rcRehydrateRenderPrefs?: () => Promise<void> };
      if (w.__rcRehydrateRenderPrefs) await w.__rcRehydrateRenderPrefs();
    });

    const all = await readAllSettings();
    expect(all[conflictKey]).toBe("from-db"); // existing DB row wins
    expect(all[freshKey]).toBe("from-localstorage-fresh"); // localStorage-only key salvaged
    expect(all[MIGRATION_MARKER]).toBe("done"); // marker re-committed

    // cleanup
    await invokeInApp("delete_setting_cmd", { key: conflictKey });
    await invokeInApp("delete_setting_cmd", { key: freshKey });
    await browser.execute(
      (ck: string, fk: string) => {
        localStorage.removeItem(ck);
        localStorage.removeItem(fk);
      },
      conflictKey,
      freshKey,
    );
  });
});

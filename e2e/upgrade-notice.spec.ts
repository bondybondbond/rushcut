/**
 * #236 -- Render-screen notice when clip quality improvement was skipped for lack of space.
 *
 * Real app, isolated QA instance. What this proves:
 *   1. the new command is registered and answers with a list (real IPC);
 *   2. negative case: nothing skipped -> NO panel on the pre-render screen (real command);
 *
 * The positive case (panel text with clips listed) cannot be driven here: Tauri locks down
 * `window.__TAURI_INTERNALS__` (non-writable, non-configurable), so the IPC answer cannot be
 * faked from the page, and a genuine low-disk + stale-copy state cannot be produced safely.
 * It is covered by `upgradeNotice.selftest.ts` (wording), the Rust tests (decision logic:
 * `upgrade_space_short_table`, `space_notice_real_files`) and a visual check of the panel.
 *
 *   pnpm exec wdio run wdio.qa.conf.ts --spec e2e/qa-isolation.spec.ts --spec e2e/upgrade-notice.spec.ts
 */
import { trackTestProject } from "./helpers/testProjects";

const PANEL = '[data-testid="upgrade-space-notice"]';
type Internals = { invoke: (c: string, a?: unknown) => Promise<unknown> };

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

async function seedProject(): Promise<string | null> {
  const projectId = await browser.execute(async () => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
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
    return (await invoke("create_project", { name: "Upgrade-notice E2E", clips })) as string;
  });
  if (!projectId) return null;
  await browser.execute(async (id: string) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
    const data = (await invoke("get_project", { projectId: id })) as { clips: Array<{ id: string; include: number; sort_order: number }> };
    const sources = data.clips.filter((c) => c.include === 0).sort((a, b) => a.sort_order - b.sort_order);
    for (const src of sources.slice(0, 2)) {
      await invoke("add_clip_cut_cmd", { projectId: id, sourceClipId: src.id, inMs: 0, outMs: 4000 });
    }
  }, projectId);
  return projectId;
}

async function goto(path: string, urlPart: string) {
  await browser.execute((p: string) => {
    (window as unknown as { history: History }).history.pushState({}, "", p);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await browser.waitUntil(async () => (await browser.getUrl()).includes(urlPart), {
    timeout: 10_000,
    interval: 200,
    timeoutMsg: `Never reached ${urlPart}`,
  });
}

describe("#236 -- skipped-quality-improvement notice on the Render screen", () => {
  let projectId: string | null = null;

  before(async () => {
    await reachAppRoute();
    projectId = await seedProject();
    trackTestProject(projectId);
  });

  it("the command is registered and returns a list", async () => {
    expect(projectId).not.toBeNull(); // a silent early return would be a false pass (needs >= 2 clips in C:\clips)
    const res = await browser.execute(async (id: string) => {
      const { invoke } = (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__;
      return (await invoke("get_upgrade_space_notice_cmd", { projectId: id })) as unknown;
    }, projectId);
    expect(Array.isArray(res)).toBe(true);
  });

  it("negative: nothing skipped -> no panel on the pre-render screen", async () => {
    expect(projectId).not.toBeNull(); // a silent early return would be a false pass (needs >= 2 clips in C:\clips)
    await goto(`/render/${projectId}`, "/render/");
    await (await $('[data-testid="btn-render-film"]')).waitForExist({ timeout: 15_000 });
    await browser.pause(800); // let the notice query settle
    expect((await $$(PANEL)).length).toBe(0);
  });
});

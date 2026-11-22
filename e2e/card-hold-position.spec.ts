/**
 * #181 -- adding a clip must not move a card that sits at the end of the film.
 * Seeds [clip1, clip2] + one end card (beforeClipId null), clicks the real
 * "+ Add to Film" button, and asserts the card was re-anchored before the new cut,
 * so the film reads [clip1, clip2, card, clip3]. Isolated run:
 *
 *   pnpm exec wdio run wdio.qa.conf.ts --spec e2e/qa-isolation.spec.ts --spec e2e/card-hold-position.spec.ts
 */
import { trackTestProject } from "./helpers/testProjects";
import { readRenderPref, seedRenderPrefs } from "./helpers/renderPrefs";

type Inv = { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } };

describe("#181 -- end card holds its position when a clip is added", () => {
  let projectId: string | null = null;
  let inFilmIds: string[] = [];

  before(async () => {
    await browser.waitUntil(
      async () => /\/(upload|library|editor|trimmer|arrange|sound)\b/.test(await browser.getUrl()),
      { timeout: 25_000, interval: 300, timeoutMsg: "no app route" },
    );
    projectId = (await browser.execute(async () => {
      const { invoke } = (window as unknown as Inv).__TAURI_INTERNALS__;
      const metas = (await invoke("scan_folder", { folderPath: "C:\clips" })) as Array<Record<string, unknown>>;
      if (!metas || metas.length < 1) return null;
      const m = metas[0];
      const clips = [{
        filename: m.filename, local_path: m.local_path, size_bytes: m.size_bytes,
        duration_ms: m.duration_ms, width: m.width, height: m.height,
        has_audio: m.has_audio, thumbnail_data: m.thumbnail_data ?? null,
      }];
      return (await invoke("create_project", { name: "Card-hold E2E", clips })) as string;
    })) as string | null;
    trackTestProject(projectId);
    if (!projectId) return;

    inFilmIds = (await browser.execute(async (id: string) => {
      const { invoke } = (window as unknown as Inv).__TAURI_INTERNALS__;
      let d = (await invoke("get_project", { projectId: id })) as { clips: Array<{ id: string; include: number; sort_order: number }> };
      const src = d.clips.find((c) => c.include === 0)!;
      await invoke("add_clip_cut_cmd", { projectId: id, sourceClipId: src.id, inMs: 0, outMs: 2000 });
      await invoke("add_clip_cut_cmd", { projectId: id, sourceClipId: src.id, inMs: 2000, outMs: 4000 });
      d = (await invoke("get_project", { projectId: id })) as typeof d;
      return d.clips.filter((c) => c.include === 1).sort((a, b) => a.sort_order - b.sort_order).map((c) => c.id);
    }, projectId)) as string[];

    await seedRenderPrefs(projectId, {
      cards: [{ id: "card-end", text: "The End", subtitle: "", color: "#000000", animation: "none", beforeClipId: null }],
    });

    await browser.execute((id: string) => {
      window.history.pushState({}, "", `/trimmer/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, projectId);
    await browser.pause(2000);
  });

  it("adding a cut re-anchors the end card before the new cut", async () => {
    if (!projectId) return;
    expect(inFilmIds.length).toBe(2);
    const add = await $('[data-testid="btn-add-to-film"]');
    await add.waitForClickable({ timeout: 10_000 });
    await add.click();
    await browser.pause(1200);

    const after = (await browser.execute(async (id: string) => {
      const { invoke } = (window as unknown as Inv).__TAURI_INTERNALS__;
      const d = (await invoke("get_project", { projectId: id })) as { clips: Array<{ id: string; include: number; sort_order: number }> };
      return d.clips.filter((c) => c.include === 1).sort((a, b) => a.sort_order - b.sort_order).map((c) => c.id);
    }, projectId)) as string[];
    expect(after.length).toBe(3);
    const newId = after[2];
    expect(inFilmIds.includes(newId)).toBe(false);

    const cards = JSON.parse((await readRenderPref(projectId, "cards")) ?? "[]");
    expect(cards.length).toBe(1);
    expect(cards[0].beforeClipId).toBe(newId); // card sits before clip3, not after it
  });
});

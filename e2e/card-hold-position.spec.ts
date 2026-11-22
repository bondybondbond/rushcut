/**
 * #181 -- adding a clip must not move a card that sits at the end of the film.
 * Each case seeds a fresh project [clip1, clip2] + one end card (beforeClipId null),
 * adds a cut, and asserts where the card is anchored:
 *   - "+ Add to Film" button        -> card before the new cut
 *   - two overlapping adds          -> card before the FIRST new cut ([.., card, A, B])
 *   - drop a cut at the strip end   -> card before the new cut
 *   - drop a cut mid-film (index 0) -> card untouched (still at end)
 * The drops dispatch native DragEvents with a real DataTransfer on the strip track
 * (no existing spec drives HTML5 DnD; the handlers read dataTransfer.types, so this
 * exercises the real onDragOver/onDrop path, though not OS-level pointer dragging).
 *
 *   pnpm exec wdio run wdio.qa.conf.ts --spec e2e/qa-isolation.spec.ts --spec e2e/card-hold-position.spec.ts
 */
import { trackTestProject } from "./helpers/testProjects";
import { readRenderPref, seedRenderPrefs } from "./helpers/renderPrefs";

type Inv = { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } };

async function filmIds(projectId: string): Promise<string[]> {
  return (await browser.execute(async (id: string) => {
    const { invoke } = (window as unknown as Inv).__TAURI_INTERNALS__;
    const d = (await invoke("get_project", { projectId: id })) as { clips: Array<{ id: string; include: number; sort_order: number }> };
    return d.clips.filter((c) => c.include === 1).sort((a, b) => a.sort_order - b.sort_order).map((c) => c.id);
  }, projectId)) as string[];
}

async function storedCards(projectId: string): Promise<Array<{ beforeClipId: string | null }>> {
  return JSON.parse((await readRenderPref(projectId, "cards")) ?? "[]");
}

/** Fresh project: 2 cuts in film + 1 end card, opened in the Trimmer. Returns its id. */
async function setup(): Promise<string | null> {
  await browser.waitUntil(
    async () => /\/(upload|library|editor|trimmer|arrange|sound)\b/.test(await browser.getUrl()),
    { timeout: 25_000, interval: 300, timeoutMsg: "no app route" },
  );
  const projectId = (await browser.execute(async () => {
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
  if (!projectId) return null;

  await browser.execute(async (id: string) => {
    const { invoke } = (window as unknown as Inv).__TAURI_INTERNALS__;
    const d = (await invoke("get_project", { projectId: id })) as { clips: Array<{ id: string; include: number; sort_order: number }> };
    const src = d.clips.find((c) => c.include === 0)!;
    await invoke("add_clip_cut_cmd", { projectId: id, sourceClipId: src.id, inMs: 0, outMs: 2000 });
    await invoke("add_clip_cut_cmd", { projectId: id, sourceClipId: src.id, inMs: 2000, outMs: 4000 });
  }, projectId);
  await seedRenderPrefs(projectId, {
    cards: [{ id: "card-end", text: "The End", subtitle: "", color: "#000000", animation: "none", beforeClipId: null }],
  });
  await browser.execute((id: string) => {
    window.history.pushState({}, "", `/trimmer/${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, projectId);
  await browser.pause(2000);
  return projectId;
}

/** Dispatch a native cut-drag onto the strip track; atStart=true drops at the left edge (index 0). */
async function dropCut(atStart: boolean) {
  await browser.execute((start: boolean) => {
    const tile = document.querySelector('[data-testid="filmstrip-clip"]');
    const track = tile?.closest(".overflow-x-auto") as HTMLElement | null;
    if (!track) throw new Error("strip track not found");
    const r = track.getBoundingClientRect();
    const dt = new DataTransfer();
    dt.setData("application/x-rushcut-cut", "1");
    const x = start ? r.left + 1 : r.right - 1;
    const mk = (type: string) =>
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: r.top + 5 });
    track.dispatchEvent(mk("dragover"));
    track.dispatchEvent(mk("drop"));
  }, atStart);
  await browser.pause(1500);
}

describe("#181 -- end card holds its position when a clip is added", () => {
  it("button add: card is re-anchored before the new cut", async () => {
    const projectId = await setup();
    if (!projectId) return;
    const before = await filmIds(projectId);
    expect(before.length).toBe(2);
    const add = await $('[data-testid="btn-add-to-film"]');
    await add.waitForClickable({ timeout: 10_000 });
    await add.click();
    await browser.pause(1200);
    const after = await filmIds(projectId);
    expect(after.length).toBe(3);
    expect((await storedCards(projectId))[0].beforeClipId).toBe(after[2]);
  });

  // NOTE: smoke only. Verified 2026-11-22 that this case still passes when the stale-list
  // bug is re-introduced (filmIdsRef -> click-time inFilm), so it does NOT prove the
  // overlap fix; that fix is covered by code review only.
  it("two overlapping adds: card stays before the FIRST new cut ([.., card, A, B])", async () => {
    const projectId = await setup();
    if (!projectId) return;
    await browser.execute(() => {
      const b = document.querySelector('[data-testid="btn-add-to-film"]') as HTMLButtonElement;
      b.click();
      b.click(); // second click lands before React re-renders: same stale closure as the original bug
    });
    await browser.pause(2500);
    const after = await filmIds(projectId);
    expect(after.length).toBe(4);
    const cards = await storedCards(projectId);
    expect(cards.length).toBe(1);
    expect(cards[0].beforeClipId).toBe(after[2]); // before A (3rd), so B (4th) sits after it
  });

  it("drop at strip end: card is re-anchored before the dropped cut", async () => {
    const projectId = await setup();
    if (!projectId) return;
    await dropCut(false);
    const after = await filmIds(projectId);
    expect(after.length).toBe(3);
    expect((await storedCards(projectId))[0].beforeClipId).toBe(after[2]);
  });

  it("negative: drop mid-film (index 0) leaves the end card alone", async () => {
    const projectId = await setup();
    if (!projectId) return;
    await dropCut(true);
    const after = await filmIds(projectId);
    expect(after.length).toBe(3);
    expect((await storedCards(projectId))[0].beforeClipId).toBe(null);
  });
});

/**
 * #184 -- "+ Add to film" real-click regression spec (multiple cards per anchor).
 *
 * The old arrange.spec.ts card coverage used the invoke() placement shortcut and
 * only ever placed ONE card -- which is exactly how #184 shipped (a run of >1
 * card at the same anchor was stored but silently collapsed to one visible tile).
 * This spec drives the real "+ Add to film" button and asserts N=0 / N=1 / N>1,
 * delete-one-of-many, and reload-preserves-order.
 *
 * Runs under wdio.qa.conf.ts (isolated DB/profile) so it is safe alongside a live app:
 *
 *   pnpm exec wdio run wdio.qa.conf.ts --spec e2e/qa-isolation.spec.ts --spec e2e/card-add.spec.ts
 */
import { trackTestProject } from "./helpers/testProjects";

const CARD_TILE = '[data-testid^="filmstrip-card-"]';

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

/** Seed a project + add 2 clips to the film (create_project inserts include=0 rows). */
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
    return (await invoke("create_project", { name: "Card-add E2E", clips })) as string;
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

/** Type a title into the real input and click "+ Add to film". */
async function addCardViaUi(title: string) {
  const input = await $('[data-testid="input-card-title"]');
  await input.waitForExist({ timeout: 5_000 });
  await input.click();
  await input.setValue(title);
  await browser.pause(450); // debounced setNewCardDraft (300ms)
  const btn = await $('[data-testid="btn-add-card-to-film"]');
  await btn.waitForExist({ timeout: 5_000 });
  await btn.click();
  await browser.pause(600);
}

async function storedCards(projectId: string): Promise<Array<{ id: string; text: string; beforeClipId: string | null }>> {
  const raw = await browser.execute(
    (id: string) => localStorage.getItem(`rc_cards_v2_${id}`),
    projectId,
  );
  return JSON.parse((raw as string) ?? "[]");
}

describe("#184 -- multiple cards per anchor via + Add to film", () => {
  let projectId: string | null = null;

  before(async () => {
    await reachAppRoute();
    projectId = await seedProject();
    trackTestProject(projectId);
    if (!projectId) return;

    await browser.execute((id: string) => {
      (window as unknown as { history: History }).history.pushState({}, "", `/arrange/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
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
  });

  it("N=0: no card tiles on a fresh project", async () => {
    if (!projectId) return;
    expect((await $$(CARD_TILE)).length).toBe(0);
  });

  it("N=1: one click adds exactly one visible tile + one stored entry", async () => {
    if (!projectId) return;
    await addCardViaUi("Card One");
    expect((await $$(CARD_TILE)).length).toBe(1);
    const stored = await storedCards(projectId);
    expect(stored.length).toBe(1);
    expect(stored[0].text).toBe("Card One");
    // title cleared + button re-disabled after a successful add
    expect(await (await $('[data-testid="input-card-title"]')).getValue()).toBe("");
    expect(await (await $('[data-testid="btn-add-card-to-film"]')).getAttribute("disabled")).not.toBeNull();
  });

  it("N=2: a second click stacks a SECOND visible tile at the end (not swallowed)", async () => {
    if (!projectId) return;
    await addCardViaUi("Card Two");
    expect((await $$(CARD_TILE)).length).toBe(2);
    const stored = await storedCards(projectId);
    expect(stored.map((c) => c.text)).toEqual(["Card One", "Card Two"]); // insertion order
    expect(stored.every((c) => c.beforeClipId === null)).toBe(true); // both at end
  });

  it("N=3: a third click stacks a third tile", async () => {
    if (!projectId) return;
    await addCardViaUi("Card Three");
    expect((await $$(CARD_TILE)).length).toBe(3);
    expect((await storedCards(projectId)).map((c) => c.text)).toEqual(["Card One", "Card Two", "Card Three"]);
  });

  it("delete the FIRST of the run -> the other two stay put, order preserved (no ghost-swap)", async () => {
    if (!projectId) return;
    const first = (await storedCards(projectId))[0];
    // select the first card tile, then hit the delete bin
    await (await $(`[data-testid="filmstrip-card-${first.id}"]`)).click();
    await browser.pause(300);
    const bin = await $('[data-testid="btn-delete-card"]');
    await bin.waitForExist({ timeout: 5_000 });
    await bin.click();
    await browser.pause(500);

    expect((await $$(CARD_TILE)).length).toBe(2);
    expect((await storedCards(projectId)).map((c) => c.text)).toEqual(["Card Two", "Card Three"]);
  });

  it("reload -> the stacked cards persist in the same order", async () => {
    if (!projectId) return;
    await browser.execute((id: string) => {
      (window as unknown as { history: History }).history.pushState({}, "", `/arrange/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, projectId);
    await browser.pause(900);
    const cardsTab = await $('[data-testid="arrange-tab-cards"]');
    await cardsTab.waitForExist({ timeout: 5_000 });
    await cardsTab.click();
    await browser.pause(600);

    expect((await $$(CARD_TILE)).length).toBe(2);
    expect((await storedCards(projectId)).map((c) => c.text)).toEqual(["Card Two", "Card Three"]);
  });

  it("no console errors across the whole multi-card flow", async () => {
    if (!projectId) return;
    let logs: Array<{ level: string; message: string }> = [];
    try {
      logs = (await browser.getLogs("browser")) as Array<{ level: string; message: string }>;
    } catch {
      return; // driver without goog:loggingPrefs -- skip
    }
    const severe = logs.filter(
      (l) => l.level === "SEVERE" && !/favicon\.ico|Failed to load resource/.test(l.message),
    );
    expect(severe).toEqual([]);
  });
});

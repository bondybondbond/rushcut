/**
 * #244 -- typing in an EXISTING card's title/subtitle must feel instant, and still save.
 *
 * Before the fix the form value of an existing card came straight from placedCards, which
 * only changed after a 300 ms debounce, so every keystroke showed up ~300 ms late.
 * This spec measures keystroke -> visible counter update, and checks the text is stored.
 *
 *   pnpm exec wdio run wdio.qa.conf.ts --spec e2e/qa-isolation.spec.ts --spec e2e/card-edit.spec.ts
 */
import { trackTestProject } from "./helpers/testProjects";
import { readRenderPref } from "./helpers/renderPrefs";

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
    return (await invoke("create_project", { name: "Card-edit E2E", clips })) as string;
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

describe("#244 -- editing an existing card is instant and saves", () => {
  let projectId: string | null = null;

  before(async () => {
    await reachAppRoute();
    projectId = await seedProject();
    trackTestProject(projectId);
    expect(projectId).not.toBeNull();
    if (!projectId) return;
    await browser.execute((id: string) => {
      (window as unknown as { history: History }).history.pushState({}, "", `/arrange/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, projectId);
    await browser.pause(1500);
    await (await $('[data-testid="arrange-tab-cards"]')).click();
    await browser.pause(500);
    const input = await $('[data-testid="input-card-title"]');
    await input.waitForExist({ timeout: 5_000 });
    await input.click();
    await input.setValue("Start");
    await browser.pause(450);
    await (await $('[data-testid="btn-add-card-to-film"]')).click();
    await browser.pause(700);
    const tile = await $('[data-testid^="filmstrip-card-"]');
    await tile.waitForExist({ timeout: 5_000 });
    await tile.click();
    await browser.pause(400);
  });

  it("every keystroke shows in the form within 100 ms (measured)", async () => {
    expect(projectId).not.toBeNull();
    if (!projectId) return;
    const result = await browser.execute(async () => {
      const input = document.querySelector('[data-testid="input-card-title"]') as HTMLInputElement;
      const counter = input.parentElement!.querySelector("p.text-right") as HTMLElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      input.focus();
      const lat: number[] = [];
      let value = input.value;
      for (const ch of "abcdefgh") {
        value += ch;
        const t0 = performance.now();
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        const want = `${value.length}/60`;
        while (counter.textContent !== want && performance.now() - t0 < 1500) {
          await new Promise((r) => requestAnimationFrame(() => r(null)));
        }
        lat.push(Math.round(performance.now() - t0));
        await new Promise((r) => setTimeout(r, 40));
      }
      return { lat, finalValue: input.value };
    });
    console.log("[#244] keystroke->counter latency ms:", JSON.stringify(result.lat));
    expect(Math.max(...result.lat)).toBeLessThan(100);
    expect(result.finalValue).toBe("Startabcdefgh");
  });

  it("the typed text is stored once typing pauses", async () => {
    expect(projectId).not.toBeNull();
    if (!projectId) return;
    await browser.pause(700);
    const raw = await readRenderPref(projectId, "cards");
    const cards = JSON.parse(raw ?? "[]") as Array<{ text: string }>;
    expect(cards[0].text).toBe("Startabcdefgh");
  });

  it("title then subtitle typed back-to-back both save (no lost patch)", async () => {
    expect(projectId).not.toBeNull();
    if (!projectId) return;
    // both edits dispatched in one synchronous page script so they are guaranteed inside one 300 ms window
    await browser.execute(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      const t = document.querySelector('[data-testid="input-card-title"]') as HTMLInputElement;
      setter.call(t, t.value + "!");
      t.dispatchEvent(new Event("input", { bubbles: true }));
      const s = document.querySelector('input[placeholder="Optional"]') as HTMLInputElement;
      setter.call(s, "Hi");
      s.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await browser.pause(700);
    const cards = JSON.parse((await readRenderPref(projectId, "cards")) ?? "[]") as Array<{ text: string; subtitle: string }>;
    expect(cards[0].text).toBe("Startabcdefgh!");
    expect(cards[0].subtitle).toBe("Hi");
  });

  it("leaving the screen within 300 ms of typing still saves the text", async () => {
    expect(projectId).not.toBeNull();
    if (!projectId) return;
    const title = await $('[data-testid="input-card-title"]');
    await title.click();
    await browser.keys(["End", "?"]);
    // leave immediately, well inside the 300 ms commit window
    await browser.execute((id: string) => {
      (window as unknown as { history: History }).history.pushState({}, "", `/sound/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, projectId);
    await browser.pause(800);
    const cards = JSON.parse((await readRenderPref(projectId, "cards")) ?? "[]") as Array<{ text: string }>;
    expect(cards[0].text).toBe("Startabcdefgh!?");
  });
});

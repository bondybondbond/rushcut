/**
 * #245 -- on the film strip, what a tile READS must match the space it occupies.
 *
 * Every clip / card tile carries `data-stamp-ms` (the time its stamp shows). This spec checks,
 * for first / middle / last cards and first / middle / last clips, with a crossfade, with no
 * transition and with open/close fades:
 *   1. each tile's stamp equals its on-ruler length (full length minus the crossfade into the
 *      next item; none for the last item),
 *   2. tile width is proportional to the stamp (so the stamps add up to the ruler total),
 *   3. the visible stamp text is that value to one decimal (0:02.5),
 *   4. the stamps add up to the known film length.
 *
 *   pnpm exec wdio run wdio.qa.conf.ts --spec e2e/qa-isolation.spec.ts --spec e2e/strip-stamps.spec.ts
 *
 * Needs >= 3 clips in C:\clips (same as film-mode.spec.ts). Set STRIP_SHOT_DIR to also save one
 * strip screenshot per scenario.
 */
import { trackTestProject } from "./helpers/testProjects";
import { seedRenderPrefs } from "./helpers/renderPrefs";

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

async function gotoRoute(id: string, screen: "arrange" | "sound") {
  await browser.execute(
    (path: string) => {
      (window as unknown as { history: History }).history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    },
    `/${screen}/${id}`,
  );
  await browser.pause(1500);
}

async function seedProject(count = 3): Promise<{ projectId: string; cutIds: string[] } | null> {
  const projectId = await browser.execute(async () => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const metas = (await invoke("scan_folder", { folderPath: "C:\\clips" })) as Array<Record<string, unknown>>;
    if (!metas || metas.length < 3) return null;
    const clips = metas.slice(0, 3).map((m) => ({
      filename: m.filename,
      local_path: m.local_path,
      size_bytes: m.size_bytes,
      duration_ms: m.duration_ms,
      width: m.width,
      height: m.height,
      has_audio: m.has_audio,
      thumbnail_data: m.thumbnail_data ?? null,
    }));
    return (await invoke("create_project", { name: "Strip-stamps E2E", clips })) as string;
  });
  if (!projectId) return null;
  const cutIds = await browser.execute(async (id: string, n: number) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const data = (await invoke("get_project", { projectId: id })) as { clips: Array<{ id: string; include: number; sort_order: number }> };
    const sources = data.clips.filter((c) => c.include === 0).sort((a, b) => a.sort_order - b.sort_order);
    const out: Array<{ id: string; sort_order: number }> = [];
    for (const src of sources.slice(0, n)) {
      const cut = (await invoke("add_clip_cut_cmd", { projectId: id, sourceClipId: src.id, inMs: 0, outMs: 4000 })) as { id: string };
      out.push({ id: cut.id, sort_order: 0 });
    }
    // stable order (tied sort_order trap, see e2e.md)
    const ids = out.map((c) => c.id);
    await invoke("reorder_clips_cmd", { clipIds: ids });
    return ids;
  }, projectId, count);
  return { projectId, cutIds };
}

type Tile = { kind: "clip" | "card"; stampMs: number; width: number; text: string };

async function readTiles(): Promise<Tile[]> {
  return browser.execute(() => {
    const strip = document.querySelector('[data-testid="sticky-filmstrip"]')!;
    const tiles = Array.from(strip.querySelectorAll('[data-testid="filmstrip-clip"], [data-testid^="filmstrip-card-"]')) as HTMLElement[];
    return tiles.map((t) => ({
      kind: (t.dataset.testid === "filmstrip-clip" ? "clip" : "card") as "clip" | "card",
      stampMs: Number(t.dataset.stampMs),
      width: t.getBoundingClientRect().width,
      text: (t.querySelector("span.font-mono") as HTMLElement | null)?.textContent ?? "",
    }));
  });
}

const fmt = (ms: number) => {
  const t = Math.round(ms / 100);
  return `${Math.floor(t / 600)}:${String(Math.floor((t % 600) / 10)).padStart(2, "0")}.${t % 10}`;
};

const X = 1500; // crossfade (min clip 4 s / 2 = 2 s, so the 1.5 s cap applies)
const card = (id: string, text: string, beforeClipId: string | null) => ({ id, text, subtitle: "", color: "#1a1a2e", animation: "none", beforeClipId });

describe("#245 -- strip stamps equal on-ruler length", () => {
  let projectId = "";
  let cutIds: string[] = [];

  before(async () => {
    await reachAppRoute();
    const seeded = await seedProject();
    expect(seeded).not.toBeNull();
    if (!seeded) return;
    projectId = seeded.projectId;
    cutIds = seeded.cutIds;
    trackTestProject(projectId);
  });

  async function runScenario(
    name: string,
    transition: unknown,
    cards: unknown[],
    expected: Array<{ kind: "clip" | "card"; ms: number }>,
  ) {
    await seedRenderPrefs(projectId, { transition, cards });
    await gotoRoute(projectId, "sound"); // bounce so Arrange genuinely remounts
    await gotoRoute(projectId, "arrange");
    await (await $('[data-testid="sticky-filmstrip"]')).waitForExist({ timeout: 8_000 });
    await browser.pause(600);
    const tiles = await readTiles();
    console.log(`[#245] ${name}: ${JSON.stringify(tiles.map((t) => [t.kind[0], t.stampMs, Math.round(t.width), t.text]))}`);

    expect(tiles.map((t) => t.kind)).toEqual(expected.map((e) => e.kind));
    // 1 + 4: stamps are the on-ruler lengths and add up to the film length
    tiles.forEach((t, i) => expect(Math.abs(t.stampMs - expected[i].ms)).toBeLessThanOrEqual(1));
    const total = tiles.reduce((s, t) => s + t.stampMs, 0);
    expect(Math.abs(total - expected.reduce((s, e) => s + e.ms, 0))).toBeLessThanOrEqual(tiles.length);
    // 2: width proportional to stamp (px per ms is one constant for the whole strip)
    const k = tiles.reduce((s, t) => s + t.width, 0) / total;
    tiles.forEach((t) => expect(Math.abs(t.width - t.stampMs * k)).toBeLessThanOrEqual(4)); // borders + rounding
    // 3: visible text = stamp to one decimal
    tiles.forEach((t) => expect(t.text).toBe(fmt(t.stampMs)));

    const dir = process.env.STRIP_SHOT_DIR;
    if (dir) await (await $('[data-testid="sticky-filmstrip"]')).saveScreenshot(`${dir}\\strip-${name}.png`);
  }

  it("crossfade: first/middle/last card + first/middle clip + last card at end", async () => {
    expect(cutIds.length).toBe(3);
    await runScenario(
      "crossfade-3cards",
      { between: "crossfade", opening: "none", closing: "none", shuffleBetween: false },
      [card("c-first", "FIRST", cutIds[0]), card("c-mid", "MID", cutIds[2]), card("c-last", "LAST", null)],
      [
        { kind: "card", ms: 3000 - X }, // first element: 1.5 + 1 crossfade = 3.0, minus the cut into clip 1
        { kind: "clip", ms: 4000 - X },
        { kind: "clip", ms: 4000 - X },
        { kind: "card", ms: 4500 - X }, // middle: 1.5 + 2 crossfades
        { kind: "clip", ms: 4000 - X },
        { kind: "card", ms: 3000 }, // last element: no cut after it
      ],
    );
  });

  it("crossfade: the film ends on a clip (last clip is not shortened)", async () => {
    await runScenario(
      "crossfade-endclip",
      { between: "crossfade", opening: "none", closing: "none", shuffleBetween: false },
      [card("c-mid", "MID", cutIds[2])],
      [
        { kind: "clip", ms: 4000 - X },
        { kind: "clip", ms: 4000 - X },
        { kind: "card", ms: 4500 - X },
        { kind: "clip", ms: 4000 },
      ],
    );
  });

  it("no transition: every tile reads its full length", async () => {
    await runScenario(
      "none",
      { between: "none", opening: "none", closing: "none", shuffleBetween: false },
      [card("c-first", "FIRST", cutIds[0]), card("c-mid", "MID", cutIds[2]), card("c-last", "LAST", null)],
      [
        { kind: "card", ms: 3000 },
        { kind: "clip", ms: 4000 },
        { kind: "clip", ms: 4000 },
        { kind: "card", ms: 3000 },
        { kind: "clip", ms: 4000 },
        { kind: "card", ms: 3000 },
      ],
    );
  });

  it("open/close fades: the edge cards count the fade as a neighbouring cut", async () => {
    await runScenario(
      "openclose",
      { between: "crossfade", opening: "crossfade", closing: "crossfade", shuffleBetween: false },
      [card("c-first", "FIRST", cutIds[0]), card("c-mid", "MID", cutIds[2]), card("c-last", "LAST", null)],
      [
        { kind: "card", ms: 4500 - X },
        { kind: "clip", ms: 4000 - X },
        { kind: "clip", ms: 4000 - X },
        { kind: "card", ms: 4500 - X },
        { kind: "clip", ms: 4000 - X },
        { kind: "card", ms: 4500 },
      ],
    );
  });
  // #243: with ONE clip, a card is still an element of the crossfade chain, so the strip
  // overlaps it with the clip exactly like the render does. Old behaviour: clip 4000 + card 3000
  // with no overlap (the editor showed a film 1.5 s longer than the export).
  it("#243 one clip + opening card, crossfade: overlap applied; one clip alone: unchanged", async () => {
    const seeded = await seedProject(1);
    expect(seeded).not.toBeNull();
    if (!seeded) return;
    projectId = seeded.projectId;
    cutIds = seeded.cutIds;
    trackTestProject(projectId);
    const xf = { between: "crossfade", opening: "none", closing: "none", shuffleBetween: false };
    await runScenario("one-clip-open-card", xf, [card("o1", "OPEN", cutIds[0])], [
      { kind: "card", ms: 3000 - X }, // 1.5 visible + 1 crossfade, minus the cut into the clip
      { kind: "clip", ms: 4000 },
    ]);
    await runScenario("one-clip-close-card", xf, [card("o2", "END", null)], [
      { kind: "clip", ms: 4000 - X },
      { kind: "card", ms: 3000 },
    ]);
    await runScenario("one-clip-no-card", xf, [], [{ kind: "clip", ms: 4000 }]); // negative case
  });
});

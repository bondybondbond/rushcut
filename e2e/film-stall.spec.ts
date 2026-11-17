/**
 * #197 -- the needle must not stand still at clip / card boundaries during natural playback.
 *
 * Scenario (same seed as film-mode.spec.ts): clip A --crossfade--> clip B --> [mid-roll card]
 * --> clip C, each clip cut to 4 s. With a crossfade the ruler gives every item one overlap
 * (1.5 s) less than its played length; before the #197 fix the needle was parked for that 1.5 s
 * at every cut and at the end of the card.
 *
 * Measures the LONGEST interval in which `data-film-ms` did not advance while playing (the
 * trailing plateau after the film ends is excluded), plus how long the run took from first
 * movement to the end, and compares it to the film length on the ruler.
 *
 * Run: pnpm test:e2e:qa:stall
 */
import { trackTestProject } from "./helpers/testProjects";
import { seedRenderPrefs } from "./helpers/renderPrefs";

// #197: the stall being fixed was 1.8-2.0 s (the transition overlap parked the needle). What is
// left is the video decoder starting the next clip; on the Sound Master screen the FIRST cut of a
// run measured 65-280 ms normally and up to ~550 ms on a cold decoder (the pre-fix code showed the
// same 0.5-0.7 s there with no transition). 700 ms catches any return of the old multi-second
// standstill with room for that cold start; sampling itself adds ~50-100 ms of WebDriver latency.
const STALL_MAX_MS = 700;
// Needle movement smaller than this between two samples counts as "standing still".
const MOVE_EPS_MS = 4;
// Played wall-clock time may differ from the film length on the ruler by at most this.
const RUN_VS_FILM_MAX_MS = 900;

interface Sample { t: number; filmMs: number }

async function reachAppRoute() {
  await browser.waitUntil(
    async () => {
      try { return /\/(upload|library|editor|trimmer|arrange|sound)\b/.test(await browser.getUrl()); } catch { return false; }
    },
    { timeout: 25_000, interval: 300, timeoutMsg: "React never redirected to an app route" },
  );
  await browser.pause(400);
}

async function seedProject(transition: "crossfade" | "dip_to_black" | "none"): Promise<string | null> {
  const projectId = await browser.execute(async (name: string) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const metas = (await invoke("scan_folder", { folderPath: "C:\\clips" })) as Array<Record<string, unknown>>;
    if (!metas || metas.length < 3) return null;
    const clips = metas.slice(0, 3).map((m) => ({
      filename: m.filename, local_path: m.local_path, size_bytes: m.size_bytes, duration_ms: m.duration_ms,
      width: m.width, height: m.height, has_audio: m.has_audio, thumbnail_data: m.thumbnail_data ?? null,
    }));
    return (await invoke("create_project", { name, clips })) as string;
  }, `Stall E2E ${transition}`);
  if (!projectId) return null;

  const cutIds = await browser.execute(async (id: string) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const data = (await invoke("get_project", { projectId: id })) as { clips: Array<{ id: string; include: number; sort_order: number }> };
    const sources = data.clips.filter((c) => c.include === 0).sort((a, b) => a.sort_order - b.sort_order);
    const ids: string[] = [];
    for (const src of sources.slice(0, 3)) {
      const cut = (await invoke("add_clip_cut_cmd", { projectId: id, sourceClipId: src.id, inMs: 0, outMs: 4000 })) as { id: string };
      ids.push(cut.id);
    }
    // stable order (see e2e.md: tied sort_order after add_clip_cut_cmd)
    await invoke("reorder_clips_cmd", { clipIds: ids });
    return ids;
  }, projectId);

  await seedRenderPrefs(projectId, {
    transition: { between: transition, opening: "none", closing: "none", shuffleBetween: false },
    cards: [{ id: "e2e-mid-card", text: "MID ROLL", subtitle: "", color: "#1a1a2e", animation: "none", beforeClipId: cutIds[2] ?? null }],
    sound: { mood: "none", volume: "balanced", musicFadeOut: "2s", musicLoop: false },
  });
  // Warm proxies (best effort) so clip playback is steady.
  await browser.execute(async (id: string) => {
    try {
      const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      await invoke("generate_proxies_cmd", { projectId: id, lowPriority: false });
    } catch { /* non-fatal */ }
  }, projectId);
  await browser.pause(3000);
  return projectId;
}

async function gotoRoute(projectId: string, route: "trimmer" | "sound") {
  await browser.execute((id: string, r: string) => {
    window.history.pushState({}, "", `/${r}/${id}`);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  }, projectId, route);
  await browser.waitUntil(async () => (await browser.getUrl()).includes(`/${route}/`), { timeout: 10_000, interval: 200 });
  await browser.pause(1200);
}

/** Sample the needle until it has stopped for 2.5 s after moving, or `maxMs` elapses. */
async function sampleUntilEnd(maxMs: number): Promise<Sample[]> {
  const out: Sample[] = [];
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const s = await browser.execute(() => {
      const raw = document.querySelector('[data-testid="filmstrip-playhead"]')?.getAttribute("data-film-ms");
      return { t: performance.now(), filmMs: raw == null ? NaN : Number(raw) };
    });
    if (!Number.isNaN(s.filmMs)) out.push(s);
    await browser.pause(30);
  }
  return out;
}

/** Longest standing-still interval (ms) between first movement and the film's end. */
function analyse(label: string, s: Sample[]) {
  // Measure from steady state: the first ~1 s is clip load + the clock's initial re-sync to the
  // video, which has nothing to do with boundaries.
  const first = s.findIndex((x) => x.filmMs >= 1200);
  expect(first).toBeGreaterThan(0);
  // drop the trailing plateau after the film ended
  let last = s.length - 1;
  while (last > first && Math.abs(s[last].filmMs - s[last - 1].filmMs) <= MOVE_EPS_MS) last--;
  let longest = 0, longestAt = 0, stillSince = s[first].t, ref = s[first].filmMs;
  for (let i = first + 1; i <= last; i++) {
    if (Math.abs(s[i].filmMs - ref) > MOVE_EPS_MS) { ref = s[i].filmMs; stillSince = s[i].t; continue; }
    const d = s[i].t - stillSince;
    if (d > longest) { longest = d; longestAt = s[i].filmMs; }
  }
  if (process.env.STALL_TIMELINE) {
    const rows: string[] = [];
    for (let i = first; i <= Math.min(s.length - 1, last + 3); i += 12) rows.push(`${((s[i].t - s[first].t) / 1000).toFixed(1)}s:${s[i].filmMs.toFixed(0)}`);
    console.log(`[film-stall] timeline ${label}: ${rows.join(" ")}`);
  }
  const runMs = s[last].t - s[first].t;
  if (process.env.STALL_TIMELINE) console.log(`[film-stall] tail ${label}: lastFilm=${s[s.length - 1].filmMs.toFixed(0)} lastIdx=${last}/${s.length - 1}`);
  const filmSpan = s[last].filmMs - s[first].filmMs;
  console.log(`[film-stall] ${label}: longestStill=${longest.toFixed(0)}ms at film=${longestAt.toFixed(0)}ms run=${runMs.toFixed(0)}ms filmSpan=${filmSpan.toFixed(0)}ms samples=${s.length}`);
  return { longest, runMs, filmSpan };
}

for (const transition of ["crossfade", "dip_to_black", "none"] as const) {
  describe(`#197 needle stalls at clip/card boundaries (${transition})`, () => {
    let projectId: string | null = null;

    before(async () => {
      await reachAppRoute();
      projectId = await seedProject(transition);
      trackTestProject(projectId);
      if (!projectId) throw new Error("C:\\clips needs >=3 video files to run this spec");
    });

    it(`Trimmer film mode: no needle stall > ${STALL_MAX_MS}ms, run length matches the film`, async () => {
      // Genuine remount (same-route pushState inherits the previous test's live state).
      await gotoRoute(projectId!, "sound");
      await gotoRoute(projectId!, "trimmer");
      const filmBtn = await $('[data-testid="trim-viewmode-film"]');
      await filmBtn.waitForExist({ timeout: 15_000 });
      await filmBtn.click();
      await browser.pause(1500);
      await (await $('[data-testid="trim-playpause"]')).click();
      const r = analyse(`Trimmer/${transition}`, await sampleUntilEnd(22_000));
      expect(r.longest).toBeLessThanOrEqual(STALL_MAX_MS);
      expect(Math.abs(r.runMs - r.filmSpan)).toBeLessThanOrEqual(RUN_VS_FILM_MAX_MS);
    });

    it(`Sound Master: no needle stall > ${STALL_MAX_MS}ms, run length matches the film`, async () => {
      await gotoRoute(projectId!, "trimmer");
      await gotoRoute(projectId!, "sound");
      const masterTab = await $('[data-testid="music-tab-mixer"]');
      await masterTab.waitForExist({ timeout: 10_000 });
      await masterTab.click();
      await browser.pause(800);
      const playBtn = await $('[data-testid="master-playpause"]');
      await playBtn.waitForExist({ timeout: 10_000 });
      await playBtn.click();
      const r = analyse(`Sound/${transition}`, await sampleUntilEnd(22_000));
      if (process.env.STALL_TIMELINE) {
        const st = await browser.execute(() => ({
          card: !!document.body.textContent?.includes("MID ROLL"),
          errs: ((window as unknown as { __errs?: string[] }).__errs ?? []).slice(0, 5),
        }));
        console.log(`[film-stall] state after run: ${JSON.stringify(st)}`);
      }
      expect(r.longest).toBeLessThanOrEqual(STALL_MAX_MS);
      expect(Math.abs(r.runMs - r.filmSpan)).toBeLessThanOrEqual(RUN_VS_FILM_MAX_MS);
    });

    if (transition === "crossfade") {
      // Reviewer finding (#197): pausing in the middle of a crossfade must stop EVERYTHING -- both
      // slots paused, the surviving clip fully visible, at audible volume, no stray stacking.
      for (const where of ["trimmer", "sound"] as const) {
        it(`${where}: pausing mid-crossfade leaves one visible, audible, paused clip`, async () => {
          if (where === "trimmer") {
            await gotoRoute(projectId!, "sound");
            await gotoRoute(projectId!, "trimmer");
            const filmBtn = await $('[data-testid="trim-viewmode-film"]');
            await filmBtn.waitForExist({ timeout: 15_000 });
            await filmBtn.click();
            await browser.pause(1500);
            await (await $('[data-testid="trim-playpause"]')).click();
          } else {
            await gotoRoute(projectId!, "trimmer");
            await gotoRoute(projectId!, "sound");
            const masterTab = await $('[data-testid="music-tab-mixer"]');
            await masterTab.waitForExist({ timeout: 10_000 });
            await masterTab.click();
            await browser.pause(800);
            await (await $('[data-testid="master-playpause"]')).click();
          }
          // First crossfade runs on the ruler from ~2.5 s to ~4.0 s: wait until the needle is inside it.
          await browser.waitUntil(async () => {
            const ms = await browser.execute(() => Number(document.querySelector('[data-testid="filmstrip-playhead"]')?.getAttribute("data-film-ms") ?? "NaN"));
            return ms >= 2800 && ms <= 3600;
          }, { timeout: 15_000, interval: 40, timeoutMsg: "needle never entered the first crossfade window" });
          await (await $(where === "trimmer" ? '[data-testid="trim-playpause"]' : '[data-testid="master-playpause"]')).click();
          await browser.pause(400);
          const st = await browser.execute((w: string) => {
            const vids = Array.from(document.querySelectorAll(w === "trimmer" ? '[data-testid^="trim-film-video-"]' : "video")) as HTMLVideoElement[];
            const film = w === "trimmer" ? vids : vids.filter((v) => v.dataset.clipId);
            return film.map((v) => ({ paused: v.paused, opacity: Number(v.style.opacity || "1"), z: v.style.zIndex, vol: v.volume }));
          }, where);
          console.log(`[film-stall] pause-mid-fade ${where}: ${JSON.stringify(st)}`);
          expect(st.length).toBeGreaterThanOrEqual(2);
          expect(st.every((v) => v.paused)).toBe(true);
          expect(st.every((v) => v.z === "")).toBe(true);
          // exactly one slot visible (opacity 1) and it is audible
          const visible = st.filter((v) => v.opacity > 0.99);
          expect(visible.length).toBe(1);
          expect(visible[0].vol).toBeGreaterThan(0.15);
        });
      }
    }
  });
}

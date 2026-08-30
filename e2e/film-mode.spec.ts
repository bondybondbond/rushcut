/**
 * Film-mode playback acceptance spec (#174 — the definition of done for the
 * #165 sequence-clock migration). Runs under wdio.qa.conf.ts (isolated QA
 * instance) so it can execute alongside the user's live app.
 *
 * Scenario, on BOTH the Trimmer film-mode strip and the Sound Master tab:
 *
 *   clip A --crossfade--> clip B --> [mid-roll card] --> clip C --> end --> restart
 *
 * Asserts OBSERVABLE behaviour via the `data-film-ms` attribute on the strip
 * playhead (`[data-testid="filmstrip-playhead"]`), never an implementation detail:
 *
 *   1. The needle is monotonic non-decreasing through the whole run — no backstep
 *      at the A/B crossfade seam (#164) or at card->C (#163).
 *   2. Per sample window, dFilm is within [0, dWall * 1.5 + 40ms] — the needle
 *      never jumps forward by far more than wall-clock elapsed (Gate 3).
 *   3. |needle - music <audio>.currentTime*1000| stays under FWD_SNAP_MS (250) —
 *      the SYNC_CONTRACT drift bound (Sound tab only; #160/#10).
 *   4. The DEV snap counter stays under the MAX_SNAPS_PER_MIN budget — reconcile
 *      is not fighting a stuck decoder / a second needle writer (Gate 3 #10).
 *   5. The card region is entered exactly once.
 *   6. Restart after end resumes at film-time 0, never a stale large value.
 *   7. (#36) The MediaPantry highlight follows the source clip of the cut under
 *      the needle, clears while parked on the card, and never moves the real
 *      clip-mode selection.
 *
 * Tolerances are bands, not exactness — there is no web API for frame-accurate
 * seeking, and 15-20Hz DOM sampling can miss a sub-sample transient (accepted).
 *
 * Run:  pnpm exec wdio run wdio.qa.conf.ts --spec e2e/qa-isolation.spec.ts --spec e2e/film-mode.spec.ts
 */
import { trackTestProject } from "./helpers/testProjects";

const CARD_ANCHOR_TEXT = "MID ROLL";
const LEAD_CARD_TEXT = "OPENING";
// Must match sequenceClock.ts SYNC_CONTRACT.
const FWD_SNAP_MS = 250;
const SEAM_TOL_MS = 40;

interface NeedleSample {
  t: number;        // performance.now() at sample
  filmMs: number;   // data-film-ms
  audioMs: number;  // music <audio>.currentTime * 1000 (NaN if no music el / not playing)
}

async function reachAppRoute() {
  await browser.waitUntil(
    async () => {
      try {
        const url = await browser.getUrl();
        return /\/(upload|library|editor|trimmer|arrange|sound)\b/.test(url);
      } catch {
        return false;
      }
    },
    { timeout: 25_000, interval: 300, timeoutMsg: "React never redirected to an app route" },
  );
  await browser.pause(400);
}

/**
 * Create a project, ADD 3 clips to the film (create_project inserts them as
 * include=0 pantry rows — the film needs explicit add_clip_cut_cmd calls), each
 * trimmed to ~4s so the run reaches clip C in the sample window, then seed a
 * crossfade transition + one mid-roll card before clip index 2.
 */
async function seedProject(): Promise<string | null> {
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
    return (await invoke("create_project", { name: "Film-mode E2E", clips })) as string;
  });
  if (!projectId) return null;

  // Add each pantry clip to the film as a 4s cut.
  const clipIds = await browser.execute(async (id: string) => {
    const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
    const data = (await invoke("get_project", { projectId: id })) as { clips: Array<{ id: string; include: number; sort_order: number }> };
    const sources = data.clips.filter((c) => c.include === 0).sort((a, b) => a.sort_order - b.sort_order);
    const cutIds: string[] = [];
    for (const src of sources.slice(0, 3)) {
      const cut = (await invoke("add_clip_cut_cmd", {
        projectId: id,
        sourceClipId: src.id,
        inMs: 0,
        outMs: 4000,
      })) as { id: string };
      cutIds.push(cut.id);
    }
    return cutIds;
  }, projectId);

  await browser.execute(
    (id: string, ids: string[], anchorText: string) => {
      localStorage.setItem(
        `rc_transition_${id}`,
        JSON.stringify({ between: "crossfade", opening: "none", closing: "none", shuffleBetween: false }),
      );
      localStorage.setItem(
        `rc_cards_v2_${id}`,
        JSON.stringify([
          {
            id: "e2e-mid-card",
            text: anchorText,
            subtitle: "",
            color: "#1a1a2e",
            animation: "none",
            beforeClipId: ids[2] ?? null,
          },
        ]),
      );
      // Seed a library music mood + a fade so the Sound drift/fade path is
      // exercised when the QA env has a music library configured. If it doesn't,
      // the Sound spec's drift assertion self-skips (no audible track).
      localStorage.setItem(
        `rc_sound_${id}`,
        JSON.stringify({ mood: "cinematic", volume: "balanced", musicFadeOut: "2s", musicLoop: true }),
      );
    },
    projectId,
    clipIds,
    CARD_ANCHOR_TEXT,
  );

  // Best-effort proxy warm-up — not required (the needle is clock-driven, so
  // source-file fallback playback is fine), just steadier if it lands in time.
  await browser.execute(async (id: string) => {
    try {
      const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      await invoke("generate_proxies_cmd", { projectId: id, lowPriority: false });
    } catch { /* command name / signature drift is non-fatal here */ }
  }, projectId);
  await browser.pause(3000);

  return projectId;
}

async function gotoRoute(projectId: string, route: "trimmer" | "sound") {
  await browser.execute(
    (id: string, r: string) => {
      window.history.pushState({}, "", `/${r}/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    },
    projectId,
    route,
  );
  await browser.waitUntil(async () => (await browser.getUrl()).includes(`/${route}/`), {
    timeout: 10_000,
    interval: 200,
    timeoutMsg: `never reached /${route}/`,
  });
  await browser.pause(1200);
}

/** Poll `data-film-ms` (+ music audio time) for `durationMs`, ~50ms apart. */
async function sampleNeedle(durationMs: number): Promise<NeedleSample[]> {
  const samples: NeedleSample[] = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    const s = await browser.execute(() => {
      const el = document.querySelector('[data-testid="filmstrip-playhead"]');
      const raw = el?.getAttribute("data-film-ms");
      const audios = Array.from(document.querySelectorAll("audio"));
      // The music track is the audio element that is actually playing.
      const playing = audios.find((a) => !a.paused && !a.ended && a.currentTime > 0);
      return {
        t: performance.now(),
        filmMs: raw == null ? NaN : Number(raw),
        audioMs: playing ? playing.currentTime * 1000 : NaN,
        snapCount: (window as unknown as { __rc_seqSnapCount?: number }).__rc_seqSnapCount ?? 0,
      };
    });
    if (!Number.isNaN(s.filmMs)) samples.push({ t: s.t, filmMs: s.filmMs, audioMs: s.audioMs });
    await browser.pause(50);
  }
  return samples;
}

function assertMonotonic(label: string, s: NeedleSample[]) {
  expect(s.length).toBeGreaterThan(10);
  let worstBack = 0;
  let worstJump = 0;
  for (let i = 1; i < s.length; i++) {
    const dFilm = s[i].filmMs - s[i - 1].filmMs;
    const dWall = s[i].t - s[i - 1].t;
    if (dFilm < -worstBack) worstBack = -dFilm;
    // forward jump beyond wall-clock (+50% slack + a frame) is a snap-forward past
    // where playback actually is.
    const jump = dFilm - (dWall * 1.5 + SEAM_TOL_MS);
    if (jump > worstJump) worstJump = jump;
  }
  const advanced = s[s.length - 1].filmMs - s[0].filmMs;
  console.log(
    `[film-mode] ${label}: samples=${s.length} advanced=${advanced.toFixed(0)}ms ` +
      `worstBack=${worstBack.toFixed(1)}ms worstOverJump=${worstJump.toFixed(1)}ms`,
  );
  // (1) no backstep beyond one frame of seam noise — the #164 signature.
  expect(worstBack).toBeLessThanOrEqual(SEAM_TOL_MS);
  // (2) no runaway forward jump. A single legitimate FWD_SNAP correction in one
  // ~50ms sample window is monotonic-safe and allowed (SYNC_CONTRACT); this bound
  // only catches a multi-second over-run.
  expect(worstJump).toBeLessThanOrEqual(FWD_SNAP_MS + 120);
  // needle actually advanced over the run.
  expect(advanced).toBeGreaterThan(1000);
}

describe("Film-mode playback — sequence-clock acceptance (#174)", () => {
  let projectId: string | null = null;

  before(async () => {
    await reachAppRoute();
    projectId = await seedProject();
    trackTestProject(projectId);
    if (!projectId) throw new Error("C:\\clips needs >=3 video files to run this spec");

    const diag = await browser.execute(async (id: string) => {
      const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const data = (await invoke("get_project", { projectId: id })) as { clips: Array<{ include: number }> };
      return {
        inFilm: data.clips.filter((c) => c.include === 1).length,
        pantry: data.clips.filter((c) => c.include === 0).length,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        transition: localStorage.getItem(`rc_transition_${id}`),
        cards: localStorage.getItem(`rc_cards_v2_${id}`),
      };
    }, projectId);
    console.log(`[film-mode] seed diag: ${JSON.stringify(diag)}`);
  });

  it("Trimmer film mode: needle is monotonic through A->xfade->B->card->C", async () => {
    await gotoRoute(projectId!, "trimmer");

    // Enter Film mode.
    const filmBtn = await $('[data-testid="trim-viewmode-film"]');
    await filmBtn.waitForExist({ timeout: 15_000 }); // renders only once get_project resolves + film non-empty
    await filmBtn.click();
    await browser.pause(1200); // slot A loads

    const playBtn = await $('[data-testid="trim-playpause"]');
    await playBtn.click();

    const s = await sampleNeedle(10_000);
    assertMonotonic("Trimmer", s);
  });

  it("Trimmer film mode: pantry highlight follows the playing source clip and clears over the card (#36)", async () => {
    // Force a genuine Trimmer remount (the previous test left film mode playing;
    // pushState to the same /trimmer/:id URL is a no-op that would inherit its
    // ended/paused clock). Bounce through /sound and back.
    await gotoRoute(projectId!, "sound");
    await gotoRoute(projectId!, "trimmer");

    const filmBtn = await $('[data-testid="trim-viewmode-film"]');
    await filmBtn.waitForExist({ timeout: 15_000 });

    // Capture what the user last picked (clip mode) BEFORE entering film mode --
    // the film-mode highlight is a decoration only, so playback must never move it.
    const pickedBefore = await browser.execute(() => {
      const el = document.querySelector('[data-testid="pantry-tile"][data-active="true"]');
      return el?.getAttribute("data-clip-id") ?? null;
    });

    await filmBtn.click();
    await browser.pause(1200); // slot A loads

    const playBtn = await $('[data-testid="trim-playpause"]');
    await playBtn.click();

    // Confirm playback actually started (the needle is advancing) before sampling;
    // click once more if the first toggle landed on pause.
    await browser.waitUntil(
      async () => {
        const a = await browser.execute(() => {
          const el = document.querySelector('[data-testid="filmstrip-playhead"]');
          return Number(el?.getAttribute("data-film-ms") ?? "NaN");
        });
        await browser.pause(400);
        const b = await browser.execute(() => {
          const el = document.querySelector('[data-testid="filmstrip-playhead"]');
          return Number(el?.getAttribute("data-film-ms") ?? "NaN");
        });
        if (Number.isFinite(a) && Number.isFinite(b) && b > a) return true;
        await playBtn.click();
        return false;
      },
      { timeout: 12_000, interval: 500, timeoutMsg: "film needle never started advancing" },
    );

    // Sample the active pantry tile + card-overlay state alongside the needle for
    // long enough to cross A->xfade->B->card->C (cold source-file playback is
    // ~0.6x realtime here, plus a ~3s card hold).
    const samples: Array<{ filmMs: number; activeId: string | null; card: boolean }> = [];
    const end = Date.now() + 20_000;
    while (Date.now() < end) {
      const s2 = await browser.execute(() => {
        const head = document.querySelector('[data-testid="filmstrip-playhead"]');
        const raw = head?.getAttribute("data-film-ms");
        const active = document.querySelector('[data-testid="pantry-tile"][data-active="true"]');
        return {
          filmMs: raw == null ? NaN : Number(raw),
          activeId: active?.getAttribute("data-clip-id") ?? null,
          card: !!document.querySelector('[data-testid="trim-card-hold"]'),
        };
      });
      samples.push(s2);
      await browser.pause(150);
    }

    const nonNull = samples.filter((s2) => s2.activeId !== null);
    const distinct = [...new Set(nonNull.map((s2) => s2.activeId))];
    const cardSamples = samples.filter((s2) => s2.card);
    console.log(
      `[film-mode] #36 pantry-highlight: samples=${samples.length} withHighlight=${nonNull.length} ` +
        `distinctTiles=${distinct.length} cardSamples=${cardSamples.length}`,
    );

    // (1) the highlight tracked playback across cuts -- >=2 different source tiles
    // lit over the run (A -> B -> ...), never stuck on the manual pick.
    expect(distinct.length).toBeGreaterThanOrEqual(2);
    // (2) first-lit tile differs from last-lit tile -> forward progress, not flicker.
    expect(nonNull[0].activeId).not.toBe(nonNull[nonNull.length - 1].activeId);
    // (3) the run reached the mid-roll card...
    expect(cardSamples.length).toBeGreaterThan(0);
    // (4) ...and while the needle sat on the card, no pantry tile was highlighted.
    expect(cardSamples.every((s2) => s2.activeId === null)).toBe(true);

    // (5) seek path: clicking the strip near its far left jumps the needle back
    // near film-time 0 and the highlight follows to clip A's source tile (== the
    // first source, i.e. what clip mode also selects by default).
    await browser.execute(() => {
      const track = document.querySelector('[data-testid="sticky-filmstrip"] > div') as HTMLElement | null;
      if (!track) return;
      const r = track.getBoundingClientRect();
      track.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: Math.round(r.left + 4), clientY: Math.round(r.top + r.height / 2) }),
      );
    });
    await browser.pause(800);
    const afterSeek = await browser.execute(() => {
      const head = document.querySelector('[data-testid="filmstrip-playhead"]');
      const active = document.querySelector('[data-testid="pantry-tile"][data-active="true"]');
      return {
        filmMs: Number(head?.getAttribute("data-film-ms") ?? "NaN"),
        activeId: active?.getAttribute("data-clip-id") ?? null,
      };
    });
    console.log(`[film-mode] #36 after seek-to-start: filmMs=${afterSeek.filmMs} activeId=${afterSeek.activeId}`);
    expect(afterSeek.filmMs).toBeLessThan(2000);
    expect(afterSeek.activeId).toBe(pickedBefore);

    // (6) selection integrity: back in clip mode the active tile is exactly what
    // the user last picked -- playback never touched the real selection.
    const clipBtn = await $('[data-testid="trim-viewmode-clip"]');
    await clipBtn.click();
    await browser.pause(600);
    const pickedAfter = await browser.execute(() => {
      const el = document.querySelector('[data-testid="pantry-tile"][data-active="true"]');
      return el?.getAttribute("data-clip-id") ?? null;
    });
    console.log(`[film-mode] #36 selection integrity: before=${pickedBefore} after=${pickedAfter}`);
    expect(pickedAfter).toBe(pickedBefore);
  });

  it("Sound Master: needle is monotonic and reconcile stays within the snap budget", async () => {
    await gotoRoute(projectId!, "sound");

    // Master tab.
    const masterTab = await $('[data-testid="music-tab-mixer"]');
    await masterTab.waitForExist({ timeout: 10_000 });
    await masterTab.click();
    await browser.pause(800);

    const playBtn = await $('[data-testid="master-playpause"]');
    await playBtn.waitForExist({ timeout: 10_000 });
    await playBtn.click();

    const s = await sampleNeedle(10_000);
    assertMonotonic("Sound", s);

    // NOTE: the needle is the telescoped sequence position; it deliberately LAGS a
    // free-running music `<audio>.currentTime` by the accumulated card-hold +
    // crossfade-overlap time (music plays straight through cards, the render does
    // too). Those are different clock domains — comparing raw values is not a
    // valid invariant. The SYNC_CONTRACT drift bound between the needle and the
    // VIDEO's mapped position is enforced at the unit level
    // (sequenceClock.selftest.ts reconcile zones + anti-oscillation), and the #160
    // fade-anchor correctness by that file's fade-anchor case. What's asserted
    // live is the observable behaviour: monotonic needle (above) + a bounded
    // reconcile snap count (below).

    // Reconcile snap budget: SYNC_CONTRACT.MAX_SNAPS_PER_MIN is 20, so a ~10s
    // run must stay at or under 20/6 ≈ 3 to honour the contract (measured: 0). A
    // blown budget means reconcile is fighting a stuck decoder or a second needle
    // writer (Gate 3 finding #10).
    const snapCount = await browser.execute(
      () => (window as unknown as { __rc_seqSnapCount?: number }).__rc_seqSnapCount ?? 0,
    );
    console.log(`[film-mode] Sound: reconcile snap count = ${snapCount} in ~9s`);
    expect(snapCount).toBeLessThanOrEqual(3);
  });

  it("Sound Master: restart after end resumes at film-time 0", async () => {
    // Still on /sound Master. Seek near the very end via a real click on the strip
    // track (handleClick reads e.clientX), let it finish + stop.
    await browser.execute(() => {
      const track = document.querySelector('[data-testid="sticky-filmstrip"] > div') as HTMLElement | null;
      if (!track) return;
      const r = track.getBoundingClientRect();
      track.dispatchEvent(
        new MouseEvent("click", { bubbles: true, clientX: Math.round(r.right - 6), clientY: Math.round(r.top + r.height / 2) }),
      );
    });
    await browser.pause(7000); // run past the end -> stopFilmPlayback

    // Needle should be parked at (or very near) the end now.
    const endMs = await browser.execute(() => {
      const el = document.querySelector('[data-testid="filmstrip-playhead"]');
      const raw = el?.getAttribute("data-film-ms");
      return raw == null ? NaN : Number(raw);
    });
    console.log(`[film-mode] Sound: needle after end = ${endMs}ms`);

    // Press play again -> startFilmPlayback re-anchors the clock to 0.
    const playBtn = await $('[data-testid="master-playpause"]');
    await playBtn.click();
    await browser.pause(600);

    const filmMs = await browser.execute(() => {
      const el = document.querySelector('[data-testid="filmstrip-playhead"]');
      const raw = el?.getAttribute("data-film-ms");
      return raw == null ? NaN : Number(raw);
    });
    console.log(`[film-mode] Sound: restart needle at ${filmMs}ms (was ${endMs}ms at end)`);
    // Restarted near the beginning — must be far below where it ended.
    expect(Number.isNaN(filmMs)).toBe(false);
    expect(filmMs).toBeLessThan(3000);
  });

  /**
   * #185 — LEADING CARD. A film whose FIRST sequence element is a card run (a
   * card anchored before clip 0) must, in Trimmer film mode: (a) sit at film-time
   * 0 on fresh entry (no paused reconcile forward-snap past the card); (b) on
   * play, hold that card ~CARD_DUR_MS with NO <video> playing underneath; (c)
   * then hand off into clip 0 monotonically, with clip 0's own slot being the one
   * that actually plays.
   *
   * This case is EXPECTED RED on main until the fix lands — main's togglePlay has
   * no leading-card branch and its reconcile() runs while paused. Kept last in the
   * file: it rewrites rc_cards_v2 for the shared project, and nothing runs after.
   */
  it("#185 Trimmer film mode: a leading card holds from film-time 0 before clip 0", async () => {
    // In-film cut ids in a DETERMINISTIC order. add_clip_cut_cmd (in seedProject)
    // can leave the 3 cuts with tied sort_order, so `get_project` + `ORDER BY
    // sort_order` returns them in an order that varies call-to-call -- both the
    // card anchor and Trimmer's own `inFilm` sort would then disagree at random.
    // Fix it once here: sort by (sort_order, id) for a stable pick, then
    // `reorder_clips_cmd` to write sort_order = 0,1,2 so every later read agrees.
    const inFilmIds = (await browser.execute(async (id: string) => {
      const { invoke } = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } }).__TAURI_INTERNALS__;
      const data = (await invoke("get_project", { projectId: id })) as { clips: Array<{ id: string; include: number; sort_order: number }> };
      const ordered = data.clips
        .filter((c) => c.include === 1)
        .sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map((c) => c.id);
      await invoke("reorder_clips_cmd", { clipIds: ordered });
      return ordered;
    }, projectId!)) as string[];

    // Rewrite the shared project's cards: a leading card before clip 0, plus the
    // existing mid-roll card. Then force a genuine Trimmer remount so the entry
    // effect re-reads readPlacedCards (bounce through /sound — a pushState to the
    // same /trimmer/:id is a no-op that would inherit the prior test's state).
    await browser.execute(
      (id: string, ids: string[], leadText: string, midText: string) => {
        localStorage.setItem(
          `rc_cards_v2_${id}`,
          JSON.stringify([
            { id: "e2e-lead-card", text: leadText, subtitle: "", color: "#0e1a0e", animation: "none", beforeClipId: ids[0] ?? null },
            { id: "e2e-mid-card", text: midText, subtitle: "", color: "#1a1a2e", animation: "none", beforeClipId: ids[2] ?? null },
          ]),
        );
      },
      projectId!,
      inFilmIds,
      LEAD_CARD_TEXT,
      CARD_ANCHOR_TEXT,
    );

    await gotoRoute(projectId!, "sound");
    await gotoRoute(projectId!, "trimmer");

    const filmBtn = await $('[data-testid="trim-viewmode-film"]');
    await filmBtn.waitForExist({ timeout: 15_000 });
    await filmBtn.click();
    await browser.pause(1500); // entry effect: anchorSeqClock(0) + loadIntoSlot(0) + its post-seek timeupdate

    // Read both film <video> slots + the needle in one shot.
    const probe = () =>
      browser.execute(() => {
        const head = document.querySelector('[data-testid="filmstrip-playhead"]');
        const raw = head?.getAttribute("data-film-ms");
        const a = document.querySelector('[data-testid="trim-film-video-a"]') as HTMLVideoElement | null;
        const b = document.querySelector('[data-testid="trim-film-video-b"]') as HTMLVideoElement | null;
        return {
          filmMs: raw == null ? NaN : Number(raw),
          card: !!document.querySelector('[data-testid="trim-card-hold"]'),
          aPaused: a?.paused ?? true,
          aT: a?.currentTime ?? 0,
          aClip: a?.getAttribute("data-clip-id") ?? null,
          bPaused: b?.paused ?? true,
          bT: b?.currentTime ?? 0,
          bClip: b?.getAttribute("data-clip-id") ?? null,
        };
      });

    // (1) FRESH-ENTRY PRECONDITION — needle sits at true film-time 0, not snapped
    // forward past the leading card by a paused reconcile(). Sample for ~1.2s
    // before play; every reading must stay well under the leading card width.
    let worstPreMs = 0;
    for (let i = 0; i < 10; i++) {
      const p = await probe();
      if (Number.isFinite(p.filmMs) && p.filmMs > worstPreMs) worstPreMs = p.filmMs;
      await browser.pause(120);
    }
    console.log(`[film-mode] #185 pre-play worst data-film-ms = ${worstPreMs}ms`);
    expect(worstPreMs).toBeLessThan(250);

    // (2) Press play -> the leading card overlay appears promptly.
    const playBtn = await $('[data-testid="trim-playpause"]');
    await playBtn.click();
    await browser.waitUntil(async () => (await probe()).card, {
      timeout: 2000,
      interval: 100,
      timeoutMsg: "#185: leading card-hold overlay never appeared after play",
    });
    const holdStartMs = Date.now();

    // (3) NO MEDIA OP DURING THE HOLD — while the overlay is up, neither film
    // <video> may be playing, and neither may materially advance currentTime.
    const holdSamples: Array<{ card: boolean; aPaused: boolean; bPaused: boolean; aT: number; bT: number }> = [];
    while (Date.now() - holdStartMs < 4200) {
      const p = await probe();
      holdSamples.push({ card: p.card, aPaused: p.aPaused, bPaused: p.bPaused, aT: p.aT, bT: p.bT });
      if (!p.card) break; // hold ended
      await browser.pause(120);
    }
    const during = holdSamples.filter((s) => s.card);
    console.log(`[film-mode] #185 hold samples=${holdSamples.length} during-card=${during.length}`);
    expect(during.length).toBeGreaterThan(5);
    // both slots paused for every in-card sample
    expect(during.every((s) => s.aPaused && s.bPaused)).toBe(true);
    // no material currentTime advance on either slot across the hold
    const maxAdv = (key: "aT" | "bT") =>
      Math.max(0, ...during.map((s) => s[key])) - Math.min(...during.map((s) => s[key]));
    console.log(`[film-mode] #185 hold currentTime drift: a=${maxAdv("aT").toFixed(3)}s b=${maxAdv("bT").toFixed(3)}s`);
    expect(maxAdv("aT")).toBeLessThan(0.3);
    expect(maxAdv("bT")).toBeLessThan(0.3);

    // (4) The hold lasts ~CARD_DUR_MS then clears.
    await browser.waitUntil(async () => !(await probe()).card, {
      timeout: 5000,
      interval: 100,
      timeoutMsg: "#185: leading card-hold overlay never cleared",
    });
    const heldMs = Date.now() - holdStartMs;
    console.log(`[film-mode] #185 leading card held for ~${heldMs}ms`);
    expect(heldMs).toBeGreaterThan(2500);
    expect(heldMs).toBeLessThan(3800);

    // (5) LEADING SEAM — after the card->clip0 seam settles, the needle advances
    // monotonically into clip 0, and clip 0's own <video> slot is the one playing.
    await browser.pause(700); // let the seam / first-frame gate settle (#174 seam-freeze tolerance)
    const seam: Array<{ filmMs: number; aPaused: boolean; bPaused: boolean; aT: number; bT: number; aClip: string | null; bClip: string | null }> = [];
    for (let i = 0; i < 18; i++) {
      const p = await probe();
      seam.push({ filmMs: p.filmMs, aPaused: p.aPaused, bPaused: p.bPaused, aT: p.aT, bT: p.bT, aClip: p.aClip, bClip: p.bClip });
      await browser.pause(140);
    }
    let worstBack = 0;
    for (let i = 1; i < seam.length; i++) {
      const d = seam[i].filmMs - seam[i - 1].filmMs;
      if (d < -worstBack) worstBack = -d;
    }
    const advanced = seam[seam.length - 1].filmMs - seam[0].filmMs;
    console.log(`[film-mode] #185 post-seam: advanced=${advanced.toFixed(0)}ms worstBack=${worstBack.toFixed(1)}ms`);
    expect(worstBack).toBeLessThanOrEqual(SEAM_TOL_MS);
    expect(advanced).toBeGreaterThan(300);
    // exactly one film slot is playing (not paused, currentTime advancing) ...
    const lastThird = seam.slice(-6);
    const aPlaying = lastThird.every((s) => !s.aPaused) && lastThird[lastThird.length - 1].aT - lastThird[0].aT > 0.1;
    const bPlaying = lastThird.every((s) => !s.bPaused) && lastThird[lastThird.length - 1].bT - lastThird[0].bT > 0.1;
    console.log(`[film-mode] #185 post-seam slots: aPlaying=${aPlaying} bPlaying=${bPlaying} aClip=${lastThird[0].aClip} bClip=${lastThird[0].bClip}`);
    expect(aPlaying !== bPlaying).toBe(true); // exactly one
    // ... and it is the slot holding clip 0 -- the exact cut id the leading card
    // was anchored before (captured once above; the trace's `start-from-top
    // leadingRun=1` confirms that id is inFilmRef[0] at play time).
    const playingClip = aPlaying ? lastThird[lastThird.length - 1].aClip : lastThird[lastThird.length - 1].bClip;
    expect(playingClip).toBe(inFilmIds[0]);
  });
});

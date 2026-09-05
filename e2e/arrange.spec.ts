/**
 * Arrange spec -- /arrange/:projectId screen assertions.
 * Covers: zoom tab layout (left rail, Prev/Next, play button, zoom chips),
 * transition chip rendering and persistence, bottom tab bar active state.
 * Run: pnpm test:e2e:arrange
 *
 * Requires C:\clips\ to contain at least 2 video files.
 */

import path from "path";
import fs from "fs";
import { trackTestProject } from "./helpers/testProjects";
import { readRenderPref } from "./helpers/renderPrefs";

const SCREENSHOTS = path.resolve(__dirname, "screenshots");

function ensureScreenshotsDir() {
  if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS, { recursive: true });
}

/** Create a project via Tauri invoke (bypasses native file dialog). */
async function createArrangeProject(): Promise<string | null> {
  return browser.execute(async () => {
    const { invoke } = (window as any).__TAURI_INTERNALS__;
    const metas: any[] = await invoke("scan_folder", { folderPath: "C:\\clips" });
    if (!metas || metas.length === 0) return null;
    const clips = metas.slice(0, 3).map((m: any) => ({
      filename: m.filename,
      local_path: m.local_path,
      size_bytes: m.size_bytes,
      duration_ms: m.duration_ms,
      width: m.width,
      height: m.height,
      has_audio: m.has_audio,
      thumbnail_data: m.thumbnail_data ?? null,
    }));
    return invoke("create_project", { name: "Arrange E2E Test", clips });
  });
}

describe("Arrange screen", () => {
  let projectId: string | null = null;

  before(async () => {
    // Wait for React Router to reach any app route
    await browser.waitUntil(
      async () => {
        try {
          const url = await browser.getUrl();
          return (
            url.includes("/upload") ||
            url.includes("/library") ||
            url.includes("/editor/") ||
            url.includes("/trimmer/") ||
            url.includes("/arrange/")
          );
        } catch {
          return false;
        }
      },
      { timeout: 25_000, interval: 300, timeoutMsg: "React never redirected to an app route" }
    );
    await browser.pause(500);

    // Create project and navigate to trimmer via permitted invoke shortcut
    projectId = await createArrangeProject();
    trackTestProject(projectId);
    if (!projectId) return;

    // TODO: replace pushState with UI navigation once create_project triggers React routing
    // (scan_folder + create_project via invoke() bypass Upload.tsx React state — no auto-nav fires).
    // Permitted exception per .claude/rules/e2e.md: OS file dialogs can't be automated.
    await browser.execute((id: string) => {
      (window as any).history.pushState({}, "", `/trimmer/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, projectId);

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/trimmer/"),
      { timeout: 10_000, interval: 200, timeoutMsg: "Never reached /trimmer/" }
    );
    await browser.pause(1500); // let Trimmer render

    // Add first clip to film so Arrange has content to display
    const btns = await $$("button");
    for (const btn of btns) {
      const txt = await btn.getText();
      if (txt.includes("Add to Film")) {
        await btn.click();
        break;
      }
    }
    await browser.pause(500);

    // Navigate to Arrange via the bottom tab bar
    const arrangeTabBtn = await $('[data-testid="tab-arrange"]');
    await arrangeTabBtn.waitForExist({ timeout: 5_000 });
    await arrangeTabBtn.click();

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/arrange/"),
      { timeout: 10_000, interval: 200, timeoutMsg: "Never reached /arrange/" }
    );
    await browser.pause(1000); // let Arrange render
  });

  // ── Basic load ────────────────────────────────────────────────────────────

  it("loads without JS error (page has content)", async () => {
    if (!projectId) return;
    const text = await browser.execute(() => document.body.textContent ?? "");
    expect(text.length).toBeGreaterThan(0);
  });

  it("URL is /arrange/:projectId", async () => {
    if (!projectId) return;
    const url = await browser.getUrl();
    expect(url).toContain("/arrange/");
    expect(url).toContain(projectId);
  });

  it("heading contains 'Arrange'", async () => {
    if (!projectId) return;
    const text = await browser.execute(() => document.body.textContent ?? "");
    expect(text).toContain("Arrange");
  });

  it("shows bottom tab bar with Arrange tab active (peach)", async () => {
    if (!projectId) return;
    const arrangeTab = await $('[data-testid="tab-arrange"]');
    await arrangeTab.waitForExist({ timeout: 5_000 });
    const className = await arrangeTab.getAttribute("class");
    expect(className).toContain("FF8A65");
  });

  // ── Zoom tab (in-screen tabs) ─────────────────────────────────────────────

  it("in-screen tabs read zoom | Transitions | Cards", async () => {
    if (!projectId) return;
    const zoomTab = await $('[data-testid="arrange-tab-zoom"]');
    await zoomTab.waitForExist({ timeout: 5_000 });
    expect(await zoomTab.isDisplayed()).toBe(true);

    const transitionsTab = await $('[data-testid="arrange-tab-transitions"]');
    expect(await transitionsTab.isDisplayed()).toBe(true);

    const cardsTab = await $('[data-testid="arrange-tab-cards"]');
    expect(await cardsTab.isDisplayed()).toBe(true);
  });

  it("zoom tab is active by default (blue border)", async () => {
    if (!projectId) return;
    const zoomTab = await $('[data-testid="arrange-tab-zoom"]');
    await zoomTab.waitForExist({ timeout: 5_000 });
    const className = await zoomTab.getAttribute("class");
    expect(className).toContain("99B3FF");
  });

  it("left rail renders at least one clip tile", async () => {
    if (!projectId) return;
    // At least one rail clip should exist (we added 1 clip in before())
    const rail = await $('[data-testid^="arrange-rail-clip-"]');
    await rail.waitForExist({ timeout: 5_000 });
    expect(await rail.isDisplayed()).toBe(true);
  });

  it("Prev button is disabled when no clip is selected", async () => {
    if (!projectId) return;
    const prevBtn = await $('[data-testid="arrange-prev"]');
    await prevBtn.waitForExist({ timeout: 5_000 });
    expect(await prevBtn.getAttribute("disabled")).not.toBeNull();
  });

  it("clicking a rail tile selects it and updates filename", async () => {
    if (!projectId) return;
    const railTile = await $('[data-testid^="arrange-rail-clip-"]');
    await railTile.waitForExist({ timeout: 5_000 });
    await railTile.click();
    await browser.pause(300);

    const filename = await $('[data-testid="arrange-selected-filename"]');
    await filename.waitForExist({ timeout: 5_000 });
    const text = await filename.getText();
    expect(text.length).toBeGreaterThan(0);
  });

  it("Prev button is disabled at index 0 (first clip selected)", async () => {
    if (!projectId) return;
    const prevBtn = await $('[data-testid="arrange-prev"]');
    await prevBtn.waitForExist({ timeout: 5_000 });
    expect(await prevBtn.getAttribute("disabled")).not.toBeNull();
  });

  it("play button is present when a clip is selected", async () => {
    if (!projectId) return;
    const playBtn = await $('[data-testid="arrange-play-btn"]');
    await playBtn.waitForExist({ timeout: 5_000 });
    expect(await playBtn.isDisplayed()).toBe(true);
  });

  it("zoom style chips: Off, Fixed, Gradual are all visible", async () => {
    if (!projectId) return;
    for (const style of ["off", "fixed", "gradual"]) {
      const chip = await $(`[data-testid="chip-zoom-style-${style}"]`);
      await chip.waitForExist({ timeout: 5_000 });
      expect(await chip.isDisplayed()).toBe(true);
    }
  });

  it("Off zoom style is active by default (blue border)", async () => {
    if (!projectId) return;
    const offChip = await $('[data-testid="chip-zoom-style-off"]');
    await offChip.waitForExist({ timeout: 5_000 });
    const className = await offChip.getAttribute("class");
    expect(className).toContain("99B3FF");
  });

  it("selecting Fixed reveals the amount chips", async () => {
    if (!projectId) return;
    await (await $('[data-testid="chip-zoom-style-fixed"]')).click();
    await browser.pause(300);
    for (const amount of ["gentle", "medium", "tight"]) {
      const chip = await $(`[data-testid="chip-zoom-amount-${amount}"]`);
      await chip.waitForExist({ timeout: 5_000 });
      expect(await chip.isDisplayed()).toBe(true);
    }
  });

  it("selecting Gradual reveals Direction, Amount and Speed chips", async () => {
    if (!projectId) return;
    await (await $('[data-testid="chip-zoom-style-gradual"]')).click();
    await browser.pause(300);
    const ids = [
      "chip-zoom-dir-in", "chip-zoom-dir-out",
      "chip-zoom-kb-1.3", "chip-zoom-kb-1.5", "chip-zoom-kb-2.0",
      "chip-zoom-speed-slow", "chip-zoom-speed-med", "chip-zoom-speed-fast",
    ];
    for (const id of ids) {
      const chip = await $(`[data-testid="${id}"]`);
      await chip.waitForExist({ timeout: 5_000 });
      expect(await chip.isDisplayed()).toBe(true);
    }
  });

  it("Gradual chip selection persists across a tab switch", async () => {
    if (!projectId) return;
    // Pick a non-default Gradual config.
    await (await $('[data-testid="chip-zoom-dir-out"]')).click();
    await (await $('[data-testid="chip-zoom-kb-2.0"]')).click();
    await (await $('[data-testid="chip-zoom-speed-fast"]')).click();
    await browser.pause(300);

    // Leave the Zoom tab and return.
    await (await $('[data-testid="arrange-tab-transitions"]')).click();
    await browser.pause(300);
    await (await $('[data-testid="arrange-tab-zoom"]')).click();
    await browser.pause(300);

    for (const id of ["chip-zoom-dir-out", "chip-zoom-kb-2.0", "chip-zoom-speed-fast"]) {
      const chip = await $(`[data-testid="${id}"]`);
      await chip.waitForExist({ timeout: 5_000 });
      expect(await chip.getAttribute("class")).toContain("99B3FF");
    }
  });

  it("selecting a zoom preset persists to the DB via update_clip_review_cmd", async () => {
    if (!projectId) return;
    // Switch to Fixed + medium — a clean value distinct from the Gradual state
    // left by the prior test, so a stale DB value can't accidentally pass this check.
    await (await $('[data-testid="chip-zoom-style-fixed"]')).click();
    await browser.pause(200);
    await (await $('[data-testid="chip-zoom-amount-medium"]')).click();
    await browser.pause(500); // let the update_clip_review_cmd invoke resolve

    const clip = await browser.execute(async (id: string) => {
      const { invoke } = (window as any).__TAURI_INTERNALS__;
      const project: any = await invoke("get_project", { projectId: id });
      return project.clips.find((c: any) => c.include === 1);
    }, projectId);

    expect(clip.zoom_mode).toBe("medium");
  });

  it("volume chips are NOT present in the Arrange screen", async () => {
    if (!projectId) return;
    const volumeChip = await $('[data-testid="chip-volume-100%"]');
    // Should not exist at all
    expect(await volumeChip.isExisting()).toBe(false);
  });

  it("screenshot A: Arrange zoom tab layout", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "arrange-A-zoom-layout.png"));
  });

  // ── Transitions tab ───────────────────────────────────────────────────────

  it("clicking Transitions tab shows all 9 between-clips cards (8 types + Shuffle)", async () => {
    if (!projectId) return;
    const transitionsTab = await $('[data-testid="arrange-tab-transitions"]');
    await transitionsTab.waitForExist({ timeout: 5_000 });
    await transitionsTab.click();
    await browser.pause(300);

    for (const val of [
      "none", "crossfade", "dip_to_black", "wipe", "wipe_down",
      "zoom", "barn_door", "band_wipe", "shuffle",
    ]) {
      const chip = await $(`[data-testid="chip-transition-${val}"]`);
      await chip.waitForExist({ timeout: 5_000 });
      expect(await chip.isDisplayed()).toBe(true);
    }
  });

  it("'None' between-clips card is active by default (blue border)", async () => {
    if (!projectId) return;
    const noneChip = await $('[data-testid="chip-transition-none"]');
    const className = await noneChip.getAttribute("class");
    expect(className).toContain("99B3FF");
  });

  it("clicking 'Crossfade' card makes it active", async () => {
    if (!projectId) return;
    const crossfadeChip = await $('[data-testid="chip-transition-crossfade"]');
    await crossfadeChip.click();
    await browser.pause(200);

    const className = await crossfadeChip.getAttribute("class");
    expect(className).toContain("99B3FF");

    const noneChip = await $('[data-testid="chip-transition-none"]');
    const noneClass = await noneChip.getAttribute("class");
    expect(noneClass).not.toContain("99B3FF");
  });

  it("right column shows chosen-effects chip after selecting Crossfade", async () => {
    if (!projectId) return;
    const effects = await $('[data-testid="chosen-effects"]');
    await effects.waitForExist({ timeout: 3_000 });
    const text = await effects.getText();
    expect(text.toLowerCase()).toContain("crossfade");
  });

  it("SQLite persists transition config as JSON with between=crossfade", async () => {
    if (!projectId) return;
    // #188: rc_* render-setting keys now persist in the SQLite `settings` table
    // (renderStore.ts write-through cache) so they survive a binary relaunch and
    // an unclean kill -- WebView2 localStorage did neither reliably.
    const stored = await readRenderPref(projectId, "transition");
    // M2: stored as JSON {between, opening, closing, shuffleBetween}
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.between).toBe("crossfade");
    expect(parsed.opening).toBe("none");
    expect(parsed.closing).toBe("none");
    expect(parsed.shuffleBetween).toBe(false);
  });

  it("screenshot B: after selecting Crossfade transition", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "arrange-B-crossfade.png"));
  });

  it("reloading restores sessionStorage value (Crossfade still active)", async () => {
    if (!projectId) return;
    await browser.execute((id: string) => {
      (window as any).history.pushState({}, "", `/arrange/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, projectId);
    await browser.pause(800);

    // Re-navigation resets to the zoom tab — re-open the Transitions tab
    const transitionsTab = await $('[data-testid="arrange-tab-transitions"]');
    await transitionsTab.waitForExist({ timeout: 5_000 });
    await transitionsTab.click();
    await browser.pause(300);

    const crossfadeChip = await $('[data-testid="chip-transition-crossfade"]');
    await crossfadeChip.waitForExist({ timeout: 5_000 });
    const className = await crossfadeChip.getAttribute("class");
    expect(className).toContain("99B3FF");
  });

  it("screenshot C: after reload — sessionStorage restored", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "arrange-C-restored.png"));
  });

  // ── #192: transition preview animates AND completes (not just "is running") ──
  it("centre transition preview starts, reaches its completed state, and keeps progressing after a real→real swap", async () => {
    if (!projectId) return;

    const transitionsTab = await $('[data-testid="arrange-tab-transitions"]');
    await transitionsTab.waitForExist({ timeout: 5_000 });
    await transitionsTab.click();
    await browser.pause(300);

    // Select a real (non-"none") transition — the centre preview must now animate.
    await (await $('[data-testid="chip-transition-wipe"]')).click();
    await browser.pause(300);

    // Sample the centre preview's B layer by seeking its WAAPI animation deterministically
    // (matched by animationName, never getAnimations()[0]) to the end-hold window and to t=0.
    const wipe = await browser.execute(() => {
      const el = document.querySelector(".rc-trans-centre-preview .rc-trans-preview-b") as HTMLElement | null;
      if (!el) return { found: false };
      const cs = getComputedStyle(el);
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const anim = el.getAnimations().find(
        (a) => (a as any).animationName === "rc-trans-wipe-b",
      ) as Animation | undefined;
      if (!anim) return { found: true, reducedMotion, animationName: cs.animationName, hasAnim: false };
      const durMs = parseFloat(cs.animationDuration) * 1000 || 2000;
      anim.pause();
      anim.currentTime = durMs * 0.75; // inside the 60–90% B-arrived hold
      const holdClip = getComputedStyle(el).clipPath;
      anim.currentTime = 0; // start of the loop (clip A shown, B hidden)
      const startClip = getComputedStyle(el).clipPath;
      return {
        found: true,
        reducedMotion,
        hasAnim: true,
        animationName: cs.animationName,
        playState: cs.animationPlayState,
        holdClip,
        startClip,
      };
    });

    expect(wipe.found).toBe(true);
    if (wipe.reducedMotion) return; // static-frame fallback is correct under reduced motion
    expect(wipe.hasAnim).toBe(true);
    expect(wipe.animationName).toContain("rc-trans-wipe-b");
    expect(wipe.playState).toBe("running");
    // Completed state: B fully revealed in the end-hold window → clip-path collapsed to inset(0…).
    expect(wipe.holdClip.replace(/\s/g, "")).toMatch(/^inset\(0px\)$|^inset\(0px0px0px0(px|%)?\)$/);
    // Not frozen at frame 0: the start frame is a different clip-path than the arrived hold.
    expect(wipe.startClip).not.toBe(wipe.holdClip);

    // Real→real swap: the exact case that used to leave the preview stuck because the inline
    // `animation` shorthand reset animation-play-state. New preview must run AND progress.
    await (await $('[data-testid="chip-transition-zoom"]')).click();
    await browser.pause(300);

    const zoom = await browser.execute(() => {
      const el = document.querySelector(".rc-trans-centre-preview .rc-trans-preview-b") as HTMLElement | null;
      if (!el) return { found: false };
      const cs = getComputedStyle(el);
      const anim = el.getAnimations().find(
        (a) => (a as any).animationName === "rc-trans-zoom-b",
      ) as Animation | undefined;
      if (!anim) return { found: true, hasAnim: false, animationName: cs.animationName };
      const durMs = parseFloat(cs.animationDuration) * 1000 || 2000;
      anim.pause();
      anim.currentTime = durMs * 0.2;
      const early = getComputedStyle(el).transform;
      anim.currentTime = durMs * 0.7;
      const late = getComputedStyle(el).transform;
      return { found: true, hasAnim: true, animationName: cs.animationName, playState: cs.animationPlayState, early, late };
    });

    expect(zoom.found).toBe(true);
    expect(zoom.hasAnim).toBe(true);
    expect(zoom.animationName).toContain("rc-trans-zoom-b");
    expect(zoom.playState).toBe("running");
    expect(zoom.early).not.toBe(zoom.late); // progressing after the swap, not stuck

    // Leave state as the surrounding suite expects it.
    await (await $('[data-testid="chip-transition-crossfade"]')).click();
    await browser.pause(200);
  });
});

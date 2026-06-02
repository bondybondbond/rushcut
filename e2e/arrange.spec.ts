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

  it("clicking Transitions tab shows all 10 between-clips cards (9 types + Shuffle)", async () => {
    if (!projectId) return;
    const transitionsTab = await $('[data-testid="arrange-tab-transitions"]');
    await transitionsTab.waitForExist({ timeout: 5_000 });
    await transitionsTab.click();
    await browser.pause(300);

    for (const val of [
      "none", "crossfade", "dip_to_black", "wipe", "wipe_down",
      "zoom", "dissolve", "barn_door", "band_wipe", "shuffle",
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

  it("sessionStorage persists transition config as JSON with between=crossfade", async () => {
    if (!projectId) return;
    const stored = await browser.execute((id: string) => {
      return sessionStorage.getItem(`rc_transition_${id}`);
    }, projectId);
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
});

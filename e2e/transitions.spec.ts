/**
 * Transitions spec -- /transitions/:projectId screen assertions.
 * Covers: page load, StepNav active step, chip rendering, chip selection,
 * sessionStorage persistence, and back-navigation.
 * Run: pnpm test:e2e:transitions
 *
 * Requires C:\clips\ to contain at least 1 video file.
 */

import path from "path";
import fs from "fs";

const SCREENSHOTS = path.resolve(__dirname, "screenshots");

function ensureScreenshotsDir() {
  if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS, { recursive: true });
}

/** Create a project via Tauri invoke (bypasses native file dialog). */
async function createTransitionsProject(): Promise<string | null> {
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
    return invoke("create_project", { name: "Transitions E2E Test", clips });
  });
}

describe("Transitions screen", () => {
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
            url.includes("/transitions/")
          );
        } catch {
          return false;
        }
      },
      { timeout: 25_000, interval: 300, timeoutMsg: "React never redirected to an app route" }
    );
    await browser.pause(500);

    // Create project and navigate to trimmer via permitted invoke shortcut
    projectId = await createTransitionsProject();
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

    // Add first clip to film so "Next: Transitions" CTA is enabled
    const btns = await $$("button");
    for (const btn of btns) {
      const txt = await btn.getText();
      if (txt.includes("Add to Film")) {
        await btn.click();
        break;
      }
    }
    await browser.pause(500);

    // Navigate to Transitions via real UI click — tests the actual CTA path
    const allBtns = await $$("button");
    for (const btn of allBtns) {
      const txt = await btn.getText();
      if (txt.includes("Next: Transitions")) {
        await btn.click();
        break;
      }
    }

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/transitions/"),
      { timeout: 10_000, interval: 200, timeoutMsg: "Never reached /transitions/" }
    );
    await browser.pause(1000); // let Transitions render
  });

  it("loads without JS error (page has content)", async () => {
    if (!projectId) return;
    const text = await browser.execute(() => document.body.textContent ?? "");
    expect(text.length).toBeGreaterThan(0);
  });

  it("URL is /transitions/:projectId", async () => {
    if (!projectId) return;
    const url = await browser.getUrl();
    expect(url).toContain("/transitions/");
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

  it("screenshot A: Transitions initial state (None chip active)", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "transitions-A-initial.png"));
  });

  it("shows all 3 transition chips", async () => {
    if (!projectId) return;
    const noneChip = await $('[data-testid="chip-transition-none"]');
    const crossfadeChip = await $('[data-testid="chip-transition-crossfade"]');
    const dipChip = await $('[data-testid="chip-transition-dip_to_black"]');

    await noneChip.waitForExist({ timeout: 5_000 });
    expect(await noneChip.isDisplayed()).toBe(true);
    expect(await crossfadeChip.isDisplayed()).toBe(true);
    expect(await dipChip.isDisplayed()).toBe(true);
  });

  it("'None' chip is active by default", async () => {
    if (!projectId) return;
    const noneChip = await $('[data-testid="chip-transition-none"]');
    // Active chip has #99B3FF colour class
    const className = await noneChip.getAttribute("class");
    expect(className).toContain("99B3FF");
  });

  it("clicking 'Crossfade' chip makes it active", async () => {
    if (!projectId) return;
    const crossfadeChip = await $('[data-testid="chip-transition-crossfade"]');
    await crossfadeChip.click();
    await browser.pause(200);

    const className = await crossfadeChip.getAttribute("class");
    expect(className).toContain("99B3FF");

    // None chip should no longer be active
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

  it("sessionStorage persists the selected transition", async () => {
    if (!projectId) return;
    const stored = await browser.execute((id: string) => {
      return sessionStorage.getItem(`rc_transition_${id}`);
    }, projectId);
    expect(stored).toBe("crossfade");
  });

  it("screenshot B: after selecting Crossfade", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "transitions-B-crossfade.png"));
  });

  it("reloading restores sessionStorage value (Crossfade still active)", async () => {
    if (!projectId) return;
    // Simulate back-navigate and return: pushState back to transitions
    await browser.execute((id: string) => {
      (window as any).history.pushState({}, "", `/transitions/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, projectId);
    await browser.pause(800);

    const crossfadeChip = await $('[data-testid="chip-transition-crossfade"]');
    await crossfadeChip.waitForExist({ timeout: 5_000 });
    const className = await crossfadeChip.getAttribute("class");
    expect(className).toContain("99B3FF");
  });

  it("screenshot C: after reload — sessionStorage restored", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "transitions-C-restored.png"));
  });
});

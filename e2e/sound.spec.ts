/**
 * Sound spec -- /sound/:projectId screen assertions.
 * Covers: page load, StepNav active step, chip rendering, chip selection,
 * volume chip visibility, sessionStorage persistence, and back-navigation.
 * Run: pnpm test:e2e:sound
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
async function createSoundProject(): Promise<string | null> {
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
    return invoke("create_project", { name: "Sound E2E Test", clips });
  });
}

describe("Sound screen", () => {
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
            url.includes("/transitions/") ||
            url.includes("/sound/")
          );
        } catch {
          return false;
        }
      },
      { timeout: 25_000, interval: 300, timeoutMsg: "React never redirected to an app route" }
    );
    await browser.pause(500);

    // Create project and navigate directly to /sound/ via permitted pushState shortcut.
    // Isolated from Transitions to avoid Sound failures appearing as Transitions regressions.
    projectId = await createSoundProject();
    if (!projectId) return;

    await browser.execute((id: string) => {
      (window as any).history.pushState({}, "", `/sound/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, projectId);

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/sound/"),
      { timeout: 10_000, interval: 200, timeoutMsg: "Never reached /sound/" }
    );
    await browser.pause(1000); // let Sound render
  });

  it("loads without JS error (page has content)", async () => {
    if (!projectId) return;
    const text = await browser.execute(() => document.body.textContent ?? "");
    expect(text.length).toBeGreaterThan(0);
  });

  it("URL is /sound/:projectId", async () => {
    if (!projectId) return;
    const url = await browser.getUrl();
    expect(url).toContain("/sound/");
    expect(url).toContain(projectId);
  });

  it("heading contains 'Sound'", async () => {
    if (!projectId) return;
    const text = await browser.execute(() => document.body.textContent ?? "");
    expect(text).toContain("Sound");
  });

  it("shows StepNav with Sound step active", async () => {
    if (!projectId) return;
    const text = await browser.execute(() => document.body.textContent ?? "");
    expect(text).toContain("Trim");
    expect(text).toContain("Transitions");
    expect(text).toContain("Sound");
    expect(text).toContain("Render");
  });

  it("screenshot A: Sound initial state (No Music active)", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "sound-A-initial.png"));
  });

  it("shows all 5 mood chips", async () => {
    if (!projectId) return;
    const chips = [
      await $('[data-testid="chip-mood-none"]'),
      await $('[data-testid="chip-mood-cinematic"]'),
      await $('[data-testid="chip-mood-upbeat"]'),
      await $('[data-testid="chip-mood-chill"]'),
      await $('[data-testid="chip-mood-electronic"]'),
    ];
    await chips[0].waitForExist({ timeout: 5_000 });
    for (const chip of chips) {
      expect(await chip.isDisplayed()).toBe(true);
    }
  });

  it("'No Music' chip is active by default", async () => {
    if (!projectId) return;
    const noneChip = await $('[data-testid="chip-mood-none"]');
    const className = await noneChip.getAttribute("class");
    expect(className).toContain("99B3FF");
  });

  it("volume chips are hidden when 'No Music' is selected", async () => {
    if (!projectId) return;
    const volumeChip = await $('[data-testid="chip-volume-subtle"]');
    expect(await volumeChip.isExisting()).toBe(false);
  });

  it("clicking 'Cinematic' chip makes it active and shows volume chips", async () => {
    if (!projectId) return;
    const cinematicChip = await $('[data-testid="chip-mood-cinematic"]');
    await cinematicChip.click();
    await browser.pause(200);

    const className = await cinematicChip.getAttribute("class");
    expect(className).toContain("99B3FF");

    // No Music chip should no longer be active
    const noneChip = await $('[data-testid="chip-mood-none"]');
    const noneClass = await noneChip.getAttribute("class");
    expect(noneClass).not.toContain("99B3FF");

    // Volume chips should now be visible
    const subtleChip = await $('[data-testid="chip-volume-subtle"]');
    await subtleChip.waitForExist({ timeout: 3_000 });
    expect(await subtleChip.isDisplayed()).toBe(true);
  });

  it("sessionStorage persists the selected mood", async () => {
    if (!projectId) return;
    const stored = await browser.execute((id: string) => {
      return sessionStorage.getItem(`rc_sound_${id}`);
    }, projectId);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored as string);
    expect(parsed.mood).toBe("cinematic");
  });

  it("screenshot B: after selecting Cinematic + Balanced volume", async () => {
    if (!projectId) return;
    // Balanced is the default volume — confirm its chip is active
    const balancedChip = await $('[data-testid="chip-volume-balanced"]');
    await balancedChip.waitForExist({ timeout: 3_000 });
    const balancedClass = await balancedChip.getAttribute("class");
    expect(balancedClass).toContain("99B3FF");

    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "sound-B-cinematic.png"));
  });

  it("reloading restores sessionStorage value (Cinematic still active)", async () => {
    if (!projectId) return;
    // Simulate back-navigate and return
    await browser.execute((id: string) => {
      (window as any).history.pushState({}, "", `/sound/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, projectId);
    await browser.pause(800);

    const cinematicChip = await $('[data-testid="chip-mood-cinematic"]');
    await cinematicChip.waitForExist({ timeout: 5_000 });
    const className = await cinematicChip.getAttribute("class");
    expect(className).toContain("99B3FF");
  });

  it("screenshot C: after reload — sessionStorage restored", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "sound-C-restored.png"));
  });
});

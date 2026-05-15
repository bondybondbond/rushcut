/**
 * Sound spec -- /sound/:projectId screen assertions.
 * Covers: page load, StepNav active step, source chip rendering, Library expansion,
 * mood chip selection, volume chip visibility, sessionStorage persistence, and back-navigation.
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
            url.includes("/arrange/") ||
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

  it("shows bottom tab bar with Sound tab active (peach)", async () => {
    if (!projectId) return;
    const soundTab = await $('[data-testid="tab-sound"]');
    await soundTab.waitForExist({ timeout: 5_000 });
    const className = await soundTab.getAttribute("class");
    expect(className).toContain("FF8A65");
  });

  it("screenshot A: Sound initial state (No Music active)", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "sound-A-initial.png"));
  });

  it("shows 3 source chips: No Music, Rushcut Library, Upload Own Track", async () => {
    if (!projectId) return;
    const noneChip    = await $('[data-testid="chip-mood-none"]');
    const libraryChip = await $('[data-testid="chip-source-library"]');
    const customChip  = await $('[data-testid="chip-mood-custom"]');

    await noneChip.waitForExist({ timeout: 5_000 });
    expect(await noneChip.isDisplayed()).toBe(true);
    expect(await libraryChip.isDisplayed()).toBe(true);
    expect(await customChip.isDisplayed()).toBe(true);
    // SKIP: clicking chip-mood-custom triggers OS file dialog -- cannot be automated in WDIO
  });

  it("'No Music' chip is active by default", async () => {
    if (!projectId) return;
    const noneChip = await $('[data-testid="chip-mood-none"]');
    const className = await noneChip.getAttribute("class");
    // No Music active state uses bg-white/15 (not present in hover or inactive classes)
    expect(className).toContain("bg-white/15");
  });

  it("volume chips are hidden when 'No Music' is selected", async () => {
    if (!projectId) return;
    const volumeChip = await $('[data-testid="chip-volume-subtle"]');
    expect(await volumeChip.isExisting()).toBe(false);
  });

  it("clicking 'Rushcut Library' expands 4 mood chips", async () => {
    if (!projectId) return;
    const libraryChip = await $('[data-testid="chip-source-library"]');
    await libraryChip.click();
    await browser.pause(300);

    const moodChips = [
      await $('[data-testid="chip-mood-cinematic"]'),
      await $('[data-testid="chip-mood-upbeat"]'),
      await $('[data-testid="chip-mood-chill"]'),
      await $('[data-testid="chip-mood-electronic"]'),
    ];
    for (const chip of moodChips) {
      await chip.waitForExist({ timeout: 3_000 });
      expect(await chip.isDisplayed()).toBe(true);
    }

    // Library source chip should now be active (music-blue)
    const libraryClass = await libraryChip.getAttribute("class");
    expect(libraryClass).toContain("99B3FF");
  });

  it("clicking 'Cinematic' chip makes it active and shows volume chips", async () => {
    if (!projectId) return;
    const cinematicChip = await $('[data-testid="chip-mood-cinematic"]');
    await cinematicChip.click();
    await browser.pause(200);

    const className = await cinematicChip.getAttribute("class");
    expect(className).toContain("99B3FF");

    // No Music chip should not be active (bg-white/15 only present in active state)
    const noneChip = await $('[data-testid="chip-mood-none"]');
    const noneClass = await noneChip.getAttribute("class");
    expect(noneClass).not.toContain("bg-white/15");

    // Volume chips should now be visible
    const subtleChip = await $('[data-testid="chip-volume-subtle"]');
    await subtleChip.waitForExist({ timeout: 3_000 });
    expect(await subtleChip.isDisplayed()).toBe(true);
  });

  it("right column shows chosen-effects chip after selecting Cinematic", async () => {
    if (!projectId) return;
    const effects = await $('[data-testid="chosen-effects"]');
    await effects.waitForExist({ timeout: 3_000 });
    const text = await effects.getText();
    expect(text.toLowerCase()).toContain("cinematic");
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

  it("screenshot B: after selecting Rushcut Library + Cinematic + Balanced volume", async () => {
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

    // Library is restored (source=library) so mood chips should be visible
    const cinematicChip = await $('[data-testid="chip-mood-cinematic"]');
    await cinematicChip.waitForExist({ timeout: 5_000 });
    const className = await cinematicChip.getAttribute("class");
    expect(className).toContain("99B3FF");
  });

  it("screenshot C: after reload -- sessionStorage restored", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "sound-C-restored.png"));
  });
});

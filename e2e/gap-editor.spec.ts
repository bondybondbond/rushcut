/**
 * Trimmer via real navigation — navigates Library -> "Open project" -> /trimmer/.
 * Validates the full navigation flow, not just the Trimmer component in isolation.
 * (trimmer.spec.ts covers the component via pushState shortcut; this spec tests the journey.)
 * Requires C:\clips\ to contain at least 1 video file.
 * Run: pnpm test:e2e:editor
 */

async function createEvalProject(): Promise<string | null> {
  return browser.execute(async () => {
    const { invoke } = (window as any).__TAURI_INTERNALS__;
    const metas: any[] = await invoke("scan_folder", { folderPath: "C:\\clips" });
    if (!metas || metas.length === 0) return null;
    // Limit to first 3 clips — keeps test setup time bounded regardless of folder size
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
    return invoke("create_project", { name: "Eval Test Film", clips });
  });
}

describe("Trimmer via real navigation", () => {
  let hasClips = true;

  before(async () => {
    // Wait for React Router to reach any app route (proves React mounted)
    await browser.waitUntil(
      async () => {
        try {
          const url = await browser.getUrl();
          return (
            url.includes("/upload") ||
            url.includes("/library") ||
            url.includes("/editor/") ||
            url.includes("/trimmer/")
          );
        } catch {
          return false;
        }
      },
      { timeout: 25_000, interval: 300, timeoutMsg: "React never redirected to an app route" }
    );
    await browser.pause(500);

    const result = await createEvalProject();
    if (!result) { hasClips = false; return; }

    // Navigate to library via hamburger — no pushState, real UI flow
    const hamburger = await $('[data-testid="btn-nav-open"]');
    await hamburger.waitForExist({ timeout: 5_000 });
    await hamburger.click();
    const myProjects = await $('[data-testid="nav-item-my-projects"]');
    await myProjects.waitForDisplayed({ timeout: 3_000 });
    await myProjects.click();
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/library"),
      { timeout: 5_000, interval: 200 }
    );

    // Open the project — should now route to /trimmer/ (since Batch 15a)
    const openBtn = await $('[data-testid="btn-open-project"]');
    await openBtn.waitForExist({ timeout: 5_000 });
    await openBtn.click();
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/trimmer/"),
      { timeout: 8_000, interval: 300 }
    );
    await browser.pause(300);
  });

  // ---------------------------------------------------------------------------
  // Navigation flow assertions
  // ---------------------------------------------------------------------------

  it("lands on /trimmer/ after clicking Open Project", async () => {
    if (!hasClips) return;
    expect(await browser.getUrl()).toContain("/trimmer/");
  });

  it("shows MediaPantry sidebar with clip buttons", async () => {
    if (!hasClips) return;
    const pantry = await $("aside");
    await pantry.waitForExist({ timeout: 5_000 });
    expect(await pantry.isDisplayed()).toBe(true);
    const clips = await $$("aside button");
    expect(clips.length).toBeGreaterThan(0);
  });

  it("TrimBar is visible after real navigation", async () => {
    if (!hasClips) return;
    const trimBar = await $('[data-testid="trim-bar"]');
    await trimBar.waitForExist({ timeout: 5_000 });
    expect(await trimBar.isDisplayed()).toBe(true);
  });

  it("StepNav shows Trim step via real navigation", async () => {
    if (!hasClips) return;
    const text = await browser.execute(() => document.body.textContent ?? "");
    expect(text).toContain("Trim");
  });

  it("NavDrawer opens and closes from Trimmer screen", async () => {
    if (!hasClips) return;
    const hamburger = await $('[data-testid="btn-nav-open"]');
    await hamburger.waitForExist({ timeout: 5_000 });
    await hamburger.click();

    const navItem = await $('[data-testid="nav-item-new-project"]');
    await navItem.waitForDisplayed({ timeout: 3_000 });
    expect(await navItem.isDisplayed()).toBe(true);

    // Close
    await hamburger.click();
    await navItem.waitForDisplayed({ timeout: 3_000, reverse: true });
    expect(await navItem.isDisplayed()).toBe(false);
  });
});

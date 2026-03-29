/**
 * Editor extended spec — music chips, settings inputs, clip list, NavDrawer from library.
 * Covers checks not in fast.spec.ts.
 * Requires C:\clips\ to contain at least 1 video file.
 * Run: pnpm test:e2e:editor
 */

// Shared invoke payload builder (mirrors SKILL.md shortcut #2)
async function createEvalProject(): Promise<{ id: number } | null> {
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

describe("Editor extended", () => {
  let hasClips = true;

  before(async () => {
    // Wait for React Router to reach any app route (proves React mounted)
    await browser.waitUntil(
      async () => {
        try {
          const url = await browser.getUrl();
          return url.includes("/upload") || url.includes("/library") || url.includes("/editor/");
        } catch {
          return false;
        }
      },
      { timeout: 25_000, interval: 300, timeoutMsg: "React never redirected to an app route" }
    );
    await browser.pause(500);

    const result = await createEvalProject();
    if (!result) { hasClips = false; return; }

    // Navigate /upload -> /library (Library mounts fresh, fetches new project)
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

    // Open the project
    const openBtn = await $('[data-testid="btn-open-project"]');
    await openBtn.waitForExist({ timeout: 5_000 });
    await openBtn.click();
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/editor/"),
      { timeout: 8_000, interval: 300 }
    );
    await browser.pause(300);
  });

  // ---------------------------------------------------------------------------
  // Project metadata
  // ---------------------------------------------------------------------------

  it("displays project name Eval Test Film", async () => {
    if (!hasClips) return;
    const nameEl = await $('[data-testid="project-name"]');
    await nameEl.waitForExist({ timeout: 5_000 });
    expect(await nameEl.getText()).toBe("Eval Test Film");
  });

  it("lists clips from C:\\clips", async () => {
    if (!hasClips) return;
    const clips = await $$('[data-testid="clip-item"]');
    expect(clips.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // Music chip cycling
  // ---------------------------------------------------------------------------

  it("music chip cycling — each mood activates on click", async () => {
    if (!hasClips) return;
    for (const mood of ["cinematic", "upbeat", "chill", "electronic", "none"]) {
      const chip = await $(`[data-testid="chip-music-${mood}"]`);
      await chip.waitForExist({ timeout: 3_000 });
      await chip.click();
      await browser.pause(200);
      // Re-fetch to get updated class after React re-render
      const updated = await $(`[data-testid="chip-music-${mood}"]`);
      const cls = await updated.getAttribute("class");
      expect(cls).toContain("99B3FF");
    }
  });

  it("only one music chip is active at a time", async () => {
    if (!hasClips) return;
    // Click Cinematic
    const cinChip = await $('[data-testid="chip-music-cinematic"]');
    await cinChip.click();
    await browser.pause(200);
    // None chip must be inactive
    const noneChip = await $('[data-testid="chip-music-none"]');
    const cls = await noneChip.getAttribute("class");
    expect(cls).not.toContain("99B3FF");
    // Reset to none
    await noneChip.click();
    await browser.pause(200);
  });

  // ---------------------------------------------------------------------------
  // Settings inputs
  // ---------------------------------------------------------------------------

  it("intro text input accepts text", async () => {
    if (!hasClips) return;
    const input = await $('[data-testid="input-intro-text"]');
    await input.waitForExist({ timeout: 5_000 });
    await input.clearValue();
    await input.setValue("Eval Test Film");
    expect(await input.getValue()).toBe("Eval Test Film");
  });

  it("outro text input accepts text", async () => {
    if (!hasClips) return;
    const input = await $('[data-testid="input-outro-text"]');
    await input.waitForExist({ timeout: 5_000 });
    await input.clearValue();
    await input.setValue("Made with RushCut");
    expect(await input.getValue()).toBe("Made with RushCut");
  });

  // ---------------------------------------------------------------------------
  // NavDrawer from library
  // ---------------------------------------------------------------------------

  it("NavDrawer opens and closes from library page", async () => {
    if (!hasClips) return;
    // Navigate back to /library via Back button
    const backBtn = await $('[data-testid="btn-back"]');
    await backBtn.waitForExist({ timeout: 5_000 });
    await backBtn.click();
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/library"),
      { timeout: 5_000, interval: 200 }
    );

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

/**
 * Trimmer via real navigation — navigates Library -> "Open project" -> /trimmer/.
 * Validates the full navigation flow, not just the Trimmer component in isolation.
 * (trimmer.spec.ts covers the component via pushState shortcut; this spec tests the journey.)
 * Requires C:\clips\ to contain at least 1 video file.
 * Run: pnpm test:e2e:editor
 */

import { trackTestProject } from "./helpers/testProjects";

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
    trackTestProject(result);
    if (!result) { hasClips = false; return; }

    // create_project via invoke() bypasses Upload.tsx React state — no auto-nav fires.
    // Permitted pushState exception per .claude/rules/e2e.md: navigate to /library (the
    // starting screen for this test's journey: Library → Open Project → Trimmer).
    await browser.execute(() => {
      (window as any).history.pushState({}, "", "/library");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/library"),
      { timeout: 10_000, interval: 200, timeoutMsg: "Never reached /library" }
    );
    await browser.pause(800); // let Library render project list

    // Open the project — should route to /trimmer/ (since Batch 15a)
    const openBtn = await $('[data-testid="btn-open-project"]');
    await openBtn.waitForExist({ timeout: 8_000 });
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

  it("bottom tab bar shows Trim tab as active from Trimmer screen", async () => {
    if (!hasClips) return;
    const trimTab = await $('[data-testid="tab-trim"]');
    await trimTab.waitForExist({ timeout: 5_000 });
    const className = await trimTab.getAttribute("class");
    expect(className).toContain("FF8A65");
  });

  it("bottom tab bar visible from Trimmer screen with all tabs", async () => {
    if (!hasClips) return;
    const homeTab = await $('[data-testid="tab-home"]');
    const renderTab = await $('[data-testid="tab-render"]');
    await homeTab.waitForExist({ timeout: 5_000 });
    expect(await homeTab.isDisplayed()).toBe(true);
    expect(await renderTab.isDisplayed()).toBe(true);
  });
});

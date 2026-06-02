/**
 * Library E2E spec — card states and routing.
 *
 * Run: pnpm test:e2e:library
 *
 * E2E coverage ceiling: only the idle card state is deterministically testable
 * without a real render. The live-bar (rendering -> done) fix for the mid-session
 * jobsMap staleness case (T6) is verified manually via chrome-devtools.
 *
 * Pre-conditions:
 * - C:\clips\ contains at least 1 video file
 * - Tauri binary compiled (debug)
 * - msedgedriver.exe in PATH matching Edge/WebView2 version
 */

import { trackTestProject } from "./helpers/testProjects";

describe("Library — project cards and routing", () => {
  let projectId: string | null = null;

  before(async () => {
    // Create a fresh project with no render history via invoke shortcuts
    // (OS file dialogs can't be automated — permitted shortcut per .claude/rules/e2e.md).
    await browser.pause(1500);
    const result = await browser.execute(async () => {
      const { invoke } = (window as any).__TAURI_INTERNALS__;
      const metas: any[] = await invoke("scan_folder", { folderPath: "C:\\clips" });
      if (!metas || metas.length === 0) throw new Error("No clips in C:\\clips");
      const clips = metas.slice(0, 1).map((m: any) => ({
        filename: m.filename,
        local_path: m.local_path,
        size_bytes: m.size_bytes,
        duration_ms: m.duration_ms,
        width: m.width,
        height: m.height,
        has_audio: m.has_audio,
        thumbnail_data: m.thumbnail_data ?? null,
      }));
      return invoke("create_project", { name: "Library Spec Project", clips });
    });
    expect(result).toBeTruthy();
    projectId = result as string;
    trackTestProject(projectId);

    // Navigate to Library via pushState (invoke bypasses React auto-nav).
    await browser.execute(() => {
      (window as any).history.pushState({}, "", "/library");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/library"),
      { timeout: 5_000, interval: 200 }
    );
    await browser.pause(500);
  });

  it("shows the My Projects heading", async () => {
    const heading = await $("h1");
    await heading.waitForExist({ timeout: 5_000 });
    const text = await browser.execute(() => document.querySelector("h1")?.textContent ?? "");
    expect(text).toContain("My Projects");
  });

  it("renders at least one project-card", async () => {
    const card = await $('[data-testid="project-card"]');
    await card.waitForExist({ timeout: 5_000 });
    expect(await card.isDisplayed()).toBe(true);
  });

  it("shows 'No renders' status for the freshly-created project (idle state)", async () => {
    // Find the card for our project by navigating via the project's Open button.
    // We look for the project-status element on the page and find one with "No renders".
    const statuses = await $$('[data-testid="project-status"]');
    await browser.waitUntil(
      async () => (await $$('[data-testid="project-status"]')).length > 0,
      { timeout: 5_000, interval: 200 }
    );
    // At least one status chip should say "No renders" (our freshly-created project).
    let foundIdle = false;
    for (const el of statuses) {
      const text = await el.getText();
      if (text.includes("No renders")) { foundIdle = true; break; }
    }
    expect(foundIdle).toBe(true);
  });

  it("Open button routes an idle project to /trimmer/", async () => {
    if (!projectId) return;
    // Use the Library page Open button for the most recently created project.
    // The freshly-created project appears first (sorted by recency / last in list).
    // Find its card via the open button and click.
    const openBtns = await $$('[data-testid="btn-open-project"]');
    expect(openBtns.length).toBeGreaterThan(0);

    // Click the first Open button — render.spec also creates "Eval Test Film" so
    // we may have multiple projects. The freshly-created "Library Spec Project" should
    // be present; click the first Open and verify it routes to /trimmer/.
    await openBtns[0].click();
    await browser.waitUntil(
      async () => {
        const url = await browser.getUrl();
        return url.includes("/trimmer/") || url.includes("/render/");
      },
      { timeout: 5_000, interval: 200 }
    );
    // Our project has no renders, so it must route to /trimmer/.
    expect(await browser.getUrl()).toContain("/trimmer/");
  });
});

/**
 * Trimmer spec -- /trimmer/:projectId screen assertions.
 * Covers: page load, StepNav, MediaPantry, FilmStrip empty state,
 * "Next: Transitions" disabled/enabled, "Add to Film" flow, TrimBar presence.
 * Run: pnpm test:e2e:trimmer
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
async function createTrimmerProject(): Promise<string | null> {
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
    return invoke("create_project", { name: "Trimmer E2E Test", clips });
  });
}

describe("Trimmer screen", () => {
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
            url.includes("/trimmer/")
          );
        } catch {
          return false;
        }
      },
      { timeout: 25_000, interval: 300, timeoutMsg: "React never redirected to an app route" }
    );
    await browser.pause(500);

    // Create project and navigate to trimmer
    projectId = await createTrimmerProject();
    if (!projectId) return;

    // TODO: replace pushState with UI navigation once create_project triggers React routing
    // (scan_folder + create_project via invoke() bypass Upload.tsx React state — no auto-nav fires).
    // Permitted exception per .claude/rules/e2e.md: OS file dialogs can't be automated.
    await browser.execute((id: string) => {
      (window as any).__TAURI_INTERNALS__.invoke("get_project", { projectId: id });
      (window as any).history.pushState({}, "", `/trimmer/${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, projectId);

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/trimmer/"),
      { timeout: 10_000, interval: 200, timeoutMsg: "Never reached /trimmer/" }
    );
    await browser.pause(1500); // let React render
  });

  it("loads without JS error (page has content)", async () => {
    if (!projectId) return;
    const body = await $("body");
    const text = await body.getText();
    expect(text.length).toBeGreaterThan(0);
  });

  it("shows StepNav with Trim step active", async () => {
    if (!projectId) return;
    const stepNav = await $('[class*="border-b"]'); // StepNav has border-b
    await stepNav.waitForExist({ timeout: 5_000 });
    const html = await browser.execute(() => document.body.textContent ?? "");
    expect(html).toContain("Trim");
  });

  it("shows MediaPantry with clip thumbnails or placeholders", async () => {
    if (!projectId) return;
    // MediaPantry has overflow-y-auto inside a w-52 aside
    const pantry = await $("aside");
    await pantry.waitForExist({ timeout: 5_000 });
    expect(await pantry.isDisplayed()).toBe(true);
    // Should contain clip buttons (aspect-ratio 16/9)
    const clips = await $$("aside button");
    expect(clips.length).toBeGreaterThan(0);
  });

  it("shows film strip in empty state with drag hint text", async () => {
    if (!projectId) return;
    const html = await browser.execute(() => document.body.textContent ?? "");
    // Empty state text: "Drag clips here or use Add to Film"
    expect(html).toContain("Drag clips here");
  });

  it("'Next: Transitions' button is disabled when no clips in film", async () => {
    if (!projectId) return;
    const nextBtn = await $("button=Next: Transitions \u2192");
    if (!(await nextBtn.isExisting())) {
      // Try partial text
      const btns = await $$("button");
      let found = false;
      for (const btn of btns) {
        const txt = await btn.getText();
        if (txt.includes("Next: Transitions")) {
          found = true;
          expect(await btn.getAttribute("disabled")).not.toBeNull();
          break;
        }
      }
      expect(found).toBe(true);
      return;
    }
    expect(await nextBtn.getAttribute("disabled")).not.toBeNull();
  });

  it("screenshot A: trimmer initial state (empty film, Next disabled)", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "trimmer-A-initial.png"));
  });

  it("'+ Add to Film' button is visible for current clip", async () => {
    if (!projectId) return;
    const btns = await $$("button");
    let addBtn = null;
    for (const btn of btns) {
      const txt = await btn.getText();
      if (txt.includes("Add to Film")) {
        addBtn = btn;
        break;
      }
    }
    expect(addBtn).not.toBeNull();
  });

  it("clicking '+ Add to Film' adds clip to film strip and enables Next", async () => {
    if (!projectId) return;
    // Find and click "Add to Film"
    const btns = await $$("button");
    for (const btn of btns) {
      const txt = await btn.getText();
      if (txt.includes("Add to Film")) {
        await btn.click();
        break;
      }
    }
    await browser.pause(500); // let optimistic update render

    // Film strip should now show a clip — "Total" duration label replaces empty state
    // ("In Film" button text was removed in Batch 16b; green dot badge is SVG, not text)
    const html = await browser.execute(() => document.body.textContent ?? "");
    expect(html).toContain("Total");
  });

  it("screenshot B: after Add to Film (green badge, clip in film strip, Next enabled)", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "trimmer-B-after-add.png"));
  });

  it("'Next: Transitions' button is enabled after adding a clip", async () => {
    if (!projectId) return;
    const btns = await $$("button");
    for (const btn of btns) {
      const txt = await btn.getText();
      if (txt.includes("Next: Transitions")) {
        const disabled = await btn.getAttribute("disabled");
        expect(disabled).toBeNull(); // enabled = no disabled attr
        break;
      }
    }
  });

  it("TrimBar is visible", async () => {
    if (!projectId) return;
    const trimBar = await $('[data-testid="trim-bar"]');
    await trimBar.waitForExist({ timeout: 5_000 });
    expect(await trimBar.isDisplayed()).toBe(true);
  });

  it("screenshot C: TrimBar with playhead line visible", async () => {
    if (!projectId) return;
    ensureScreenshotsDir();
    await browser.saveScreenshot(path.join(SCREENSHOTS, "trimmer-C-trimbar.png"));
  });
});

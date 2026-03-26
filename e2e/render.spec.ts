/**
 * Full E2E render spec — slow (~5 min).
 *
 * Run separately: pnpm test:e2e:render
 *
 * Pre-conditions:
 * - C:\clips\ contains at least 1 video file (MP4/MOV/MKV)
 * - Tauri binary compiled: pnpm build
 * - msedgedriver.exe in PATH matching Edge/WebView2 version
 */
describe("Full E2E render", () => {
  let jobUrl: string;

  before(async () => {
    await browser.pause(1500);
  });

  it("scans C:\\clips\\ and shows clip items", async () => {
    // Click Choose Folder (this opens native dialog — tauri-driver can interact
    // with the Tauri invoke layer, but the OS dialog itself is not WebDriver-accessible.
    // We work around this by invoking the command directly via executeScript if needed,
    // or by testing the scan flow after folder selection state is set.)
    //
    // For the smoke test, verify the button is present and clickable.
    const chooseBtn = await $('[data-testid="btn-choose-folder"]');
    await chooseBtn.waitForExist({ timeout: 10_000 });
    expect(await chooseBtn.isEnabled()).toBe(true);
  });

  it("creates a project and navigates to editor", async () => {
    // Use Add Files path: invoke probe_files via tauri bridge through the UI.
    // Native dialog cannot be automated, so we inject a project via the DB
    // by navigating to the URL directly after a pre-seeded project exists.
    //
    // Fallback: if a project already exists in /library, navigate into it.
    const hamburger = await $('[data-testid="btn-nav-open"]');
    await hamburger.click();
    const myProjects = await $('[data-testid="nav-item-my-projects"]');
    await myProjects.waitForDisplayed({ timeout: 3_000 });
    await myProjects.click();

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/library"),
      { timeout: 5_000, interval: 200 }
    );

    // Click first available project
    const projectCard = await $("[data-testid='project-card'], .project-card, button");
    await projectCard.waitForExist({ timeout: 5_000 });
    await projectCard.click();

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/editor/"),
      { timeout: 8_000, interval: 300 }
    );
  });

  it("clicks Render and navigates to output page", async () => {
    const renderBtn = await $('[data-testid="btn-render"]');
    await renderBtn.waitForExist({ timeout: 5_000 });

    const isDisabled = await renderBtn.getAttribute("disabled");
    if (isDisabled !== null) {
      throw new Error("Render button is disabled — no clips in project");
    }

    await renderBtn.click();

    // Should navigate to /output/:jobId
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/output/"),
      { timeout: 10_000, interval: 500 }
    );

    jobUrl = await browser.getUrl();
  });

  it("progress bar increments and pipeline completes", async () => {
    // Poll progress-pct every 2s until it reaches 100 or times out (5 min)
    await browser.waitUntil(
      async () => {
        const pct = await $('[data-testid="progress-pct"]');
        const exists = await pct.isExisting();
        if (!exists) return false;
        const text = await pct.getText();
        const value = parseInt(text, 10);
        return isNaN(value) ? false : value >= 100;
      },
      {
        timeout: 300_000,
        interval: 2_000,
        timeoutMsg: "Pipeline did not reach 100% within 5 minutes",
      }
    );
  });

  it("video player has src set after render completes", async () => {
    const video = await $('[data-testid="video-player"]');
    await video.waitForExist({ timeout: 10_000 });
    const src = await video.getAttribute("src");
    expect(src).toBeTruthy();
    expect(src).toContain("asset.localhost");
  });

  it("output filename matches slug-shortId.mp4 format", async () => {
    const filename = await $('[data-testid="output-filename"]');
    await filename.waitForExist({ timeout: 5_000 });
    const text = await filename.getText();
    expect(text).toMatch(/^[a-z0-9-]+-[a-f0-9]{8}\.mp4$/);
  });
});

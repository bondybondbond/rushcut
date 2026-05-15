/**
 * Fast spec — upload + editor flows (~30s).
 * Run: pnpm test:e2e
 *
 * Both suites run in a single session (one Tauri instance) to avoid the
 * two-workers-one-binary crash.
 */

// ---------------------------------------------------------------------------
// Upload page
// ---------------------------------------------------------------------------
describe("Upload page", () => {
  before(async () => {
    // Wait for React Router to redirect from / to an app route (proves React mounted).
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
    await browser.pause(500); // let React finish rendering
  });

  it("shows the Choose Folder button", async () => {
    const btn = await $('[data-testid="btn-choose-folder"]');
    await btn.waitForExist({ timeout: 10_000 });
    expect(await btn.isDisplayed()).toBe(true);
  });

  it("shows the Add Files button", async () => {
    const btn = await $('[data-testid="btn-add-files"]');
    await btn.waitForExist({ timeout: 5_000 });
    expect(await btn.isDisplayed()).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// Editor page
// ---------------------------------------------------------------------------
describe("Editor page", () => {
  it("opens project to /trimmer/ and sticky filmstrip is visible", async () => {
    // Navigate to library — tab bar only exists on editor pages, so use pushState
    await browser.execute(() => window.history.pushState({}, "", "/library"));
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/library"),
      { timeout: 5_000, interval: 200 }
    );
    await browser.pause(300);

    const firstProject = await $('[data-testid="btn-open-project"]');
    if (!(await firstProject.isExisting())) return;

    await firstProject.click();
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/trimmer/"),
      { timeout: 5_000, interval: 200 }
    );

    const strip = await $('[data-testid="sticky-filmstrip"]');
    await strip.waitForExist({ timeout: 5_000 });
    expect(await strip.isDisplayed()).toBe(true);
  });

  it("bottom tab bar is visible on Trimmer with tab-trim active (peach)", async () => {
    if (!(await browser.getUrl()).includes("/trimmer/")) return;
    const trimTab = await $('[data-testid="tab-trim"]');
    await trimTab.waitForExist({ timeout: 5_000 });
    expect(await trimTab.isDisplayed()).toBe(true);
    const className = await trimTab.getAttribute("class");
    expect(className).toContain("FF8A65");
  });

  it("navigates to My Projects via Home tab", async () => {
    if (!(await browser.getUrl()).includes("/trimmer/")) return;
    const homeTab = await $('[data-testid="tab-home"]');
    await homeTab.waitForExist({ timeout: 5_000 });
    await homeTab.click();

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/upload"),
      { timeout: 5_000, interval: 200 }
    );

    // Navigate to library to re-open project for subsequent filmstrip tests
    await browser.execute(() => window.history.pushState({}, "", "/library"));
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/library"),
      { timeout: 3_000, interval: 200 }
    );
    await browser.pause(300);

    // Re-open project for subsequent filmstrip tests
    const firstProject = await $('[data-testid="btn-open-project"]');
    if (!(await firstProject.isExisting())) return;
    await firstProject.click();
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/trimmer/"),
      { timeout: 5_000, interval: 200 }
    );
  });

  it("sticky filmstrip visible on Arrange screen", async () => {
    const url = await browser.getUrl();
    if (!url.includes("/trimmer/")) return;
    const projectId = url.split("/trimmer/")[1];

    await browser.execute(
      (pid: string) => window.history.pushState({}, "", `/arrange/${pid}`),
      projectId
    );
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/arrange/"),
      { timeout: 3_000, interval: 200 }
    );

    const strip = await $('[data-testid="sticky-filmstrip"]');
    await strip.waitForExist({ timeout: 5_000 });
    expect(await strip.isDisplayed()).toBe(true);
  });

  it("sticky filmstrip visible on Sound screen", async () => {
    const url = await browser.getUrl();
    if (!url.includes("/arrange/")) return;
    const projectId = url.split("/arrange/")[1];

    await browser.execute(
      (pid: string) => window.history.pushState({}, "", `/sound/${pid}`),
      projectId
    );
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/sound/"),
      { timeout: 3_000, interval: 200 }
    );

    const strip = await $('[data-testid="sticky-filmstrip"]');
    await strip.waitForExist({ timeout: 5_000 });
    expect(await strip.isDisplayed()).toBe(true);
  });

  it("sticky filmstrip absent on Render screen", async () => {
    const url = await browser.getUrl();
    if (!url.includes("/sound/")) return;
    const projectId = url.split("/sound/")[1];

    await browser.execute(
      (pid: string) => window.history.pushState({}, "", `/render/${pid}`),
      projectId
    );
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/render/"),
      { timeout: 3_000, interval: 200 }
    );

    const strip = await $('[data-testid="sticky-filmstrip"]');
    expect(await strip.isExisting()).toBe(false);
  });

  it("Back button navigates to /library", async () => {
    const backBtn = await $('[data-testid="btn-back"]');
    if (!(await backBtn.isExisting())) return;

    await backBtn.click();
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/library"),
      { timeout: 5_000, interval: 200 }
    );
  });
});

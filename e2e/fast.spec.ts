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

  it("opens NavDrawer and shows nav items on hamburger click", async () => {
    const hamburger = await $('[data-testid="btn-nav-open"]');
    await hamburger.waitForExist({ timeout: 5_000 });
    await hamburger.click();

    const newProject = await $('[data-testid="nav-item-new-project"]');
    await newProject.waitForDisplayed({ timeout: 3_000 });
    expect(await newProject.isDisplayed()).toBe(true);

    const myProjects = await $('[data-testid="nav-item-my-projects"]');
    expect(await myProjects.isDisplayed()).toBe(true);

    // Close drawer
    await hamburger.click();
    await newProject.waitForDisplayed({ timeout: 3_000, reverse: true });
  });
});

// ---------------------------------------------------------------------------
// Editor page
// ---------------------------------------------------------------------------
describe("Editor page", () => {
  it("navigates to My Projects via NavDrawer", async () => {
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
  });

  it("shows Settings panel music chips with No Music active by default", async () => {
    // Navigate into first project if one exists
    const firstProject = await $('[data-testid="btn-open-project"]');
    if (!(await firstProject.isExisting())) return;

    await firstProject.click();
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/editor/"),
      { timeout: 5_000, interval: 200 }
    );

    const noneChip = await $('[data-testid="chip-music-none"]');
    await noneChip.waitForExist({ timeout: 5_000 });
    const classes = await noneChip.getAttribute("class");
    expect(classes).toContain("99B3FF");
  });

  it("inline project name edit: click -> input appears -> Escape cancels", async () => {
    const nameBtn = await $('[data-testid="project-name"]');
    if (!(await nameBtn.isExisting())) return;

    const originalText = await nameBtn.getText();
    await nameBtn.click();

    const nameInput = await $('[data-testid="input-project-name"]');
    await nameInput.waitForDisplayed({ timeout: 3_000 });
    expect(await nameInput.isDisplayed()).toBe(true);

    await browser.keys(["Escape"]);
    await nameBtn.waitForDisplayed({ timeout: 3_000 });
    expect(await nameBtn.getText()).toBe(originalText);
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

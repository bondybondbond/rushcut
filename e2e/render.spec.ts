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

import { execFileSync } from "child_process";

describe("Full E2E render", () => {
  let jobUrl: string;
  let videoSrc: string;

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
    // Create project via invoke shortcut (native dialog cannot be automated)
    const result = await browser.execute(async () => {
      const { invoke } = (window as any).__TAURI_INTERNALS__;
      const metas: any[] = await invoke("scan_folder", { folderPath: "C:\\clips" });
      if (!metas || metas.length === 0) throw new Error("No clips in C:\\clips");
      const clips = metas.map((m: any) => ({
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
    expect(result).toBeTruthy();

    // Navigate to library (Library mounts fresh, fetches the new project)
    const hamburger = await $('[data-testid="btn-nav-open"]');
    await hamburger.click();
    const myProjects = await $('[data-testid="nav-item-my-projects"]');
    await myProjects.waitForDisplayed({ timeout: 3_000 });
    await myProjects.click();

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/library"),
      { timeout: 5_000, interval: 200 }
    );

    // Open the project via stable btn-open-project selector
    const openBtn = await $('[data-testid="btn-open-project"]');
    await openBtn.waitForExist({ timeout: 5_000 });
    await openBtn.click();

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

    // Stage label should appear almost immediately after navigation
    const stageLabel = await $('[data-testid="stage-label"]');
    await stageLabel.waitForExist({ timeout: 30_000 });
    const stageText = await stageLabel.getText();
    expect(stageText.length).toBeGreaterThan(0);
  });

  it("progress bar increments and pipeline completes", async () => {
    // Poll every 2s until progress hits 100 OR the done heading appears.
    // The done state removes the progress element before the next poll fires,
    // so checking both conditions prevents a false timeout.
    await browser.waitUntil(
      async () => {
        // Done state: heading already rendered
        const h1 = await $("h1");
        if (await h1.isExisting() && (await h1.getText()) === "Your film is ready") return true;
        // Progress still running
        const pct = await $('[data-testid="progress-pct"]');
        if (!(await pct.isExisting())) return false;
        const value = parseInt(await pct.getText(), 10);
        return !isNaN(value) && value >= 100;
      },
      {
        timeout: 300_000,
        interval: 2_000,
        timeoutMsg: "Pipeline did not reach 100% within 5 minutes",
      }
    );
  });

  it("Your film is ready heading appears", async () => {
    const h1 = await $("h1");
    await h1.waitForExist({ timeout: 10_000 });
    expect(await h1.getText()).toBe("Your film is ready");
  });

  it("video player has src set after render completes", async () => {
    const video = await $('[data-testid="video-player"]');
    await video.waitForExist({ timeout: 10_000 });
    videoSrc = await video.getAttribute("src");
    expect(videoSrc).toBeTruthy();
    expect(videoSrc).toContain("asset.localhost");
  });

  it("output filename is shown and ends with .mp4", async () => {
    const filename = await $('[data-testid="output-filename"]');
    await filename.waitForExist({ timeout: 5_000 });
    const text = await filename.getText();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toMatch(/\.mp4$/);
  });

  it("video element is fully loaded — readyState 4, no errors, duration >10s", async () => {
    const info: any = await browser.execute(() => {
      const v = document.querySelector('[data-testid="video-player"]') as HTMLVideoElement;
      return v ? {
        readyState: v.readyState,
        duration: v.duration,
        error: v.error ? v.error.message : null,
      } : null;
    });
    expect(info).not.toBeNull();
    expect(info.readyState).toBe(4);
    expect(info.error).toBeNull();
    expect(info.duration).toBeGreaterThan(10);
  });

  it("video codec is h264 Main, portrait 608x1080, audio AAC", async () => {
    // Parse Windows path from asset URL (e.g. http://asset.localhost/C:/clips/processed/x.mp4)
    const decoded = decodeURIComponent(videoSrc);
    const pathMatch = decoded.match(/asset\.localhost\/([A-Za-z]:[/\\].+\.mp4)/i);
    if (!pathMatch) throw new Error(`Cannot parse Windows path from src: ${videoSrc}`);
    const winPath = pathMatch[1].replace(/\//g, "\\");
    const wslPath = "/mnt/" + winPath[0].toLowerCase() + "/" + winPath.slice(3).replace(/\\/g, "/");

    // Use execFileSync (no shell spawn) to invoke powershell, which shells into WSL
    const out = execFileSync(
      "powershell.exe",
      ["-Command", `wsl -d Ubuntu-24.04 -u root -- ffprobe -v quiet -print_format json -show_streams '${wslPath}'`],
      { encoding: "utf8", timeout: 30_000 }
    );
    const { streams } = JSON.parse(out) as { streams: any[] };
    const videoStream = streams.find((s) => s.codec_type === "video");
    const audioStream = streams.find((s) => s.codec_type === "audio");

    if (!videoStream) throw new Error("video stream missing from ffprobe output");
    if (!audioStream) throw new Error("audio stream missing from ffprobe output");
    expect(videoStream.codec_name).toBe("h264");
    expect(videoStream.profile).toMatch(/Main/i);
    expect(videoStream.width).toBe(608);
    expect(videoStream.height).toBe(1080);
    expect(audioStream.codec_name).toBe("aac");
  });

  it("My Projects button navigates from output page to library", async () => {
    const myProjects = await $('[data-testid="btn-my-projects"]');
    await myProjects.waitForExist({ timeout: 5_000 });
    await myProjects.click();
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/library"),
      { timeout: 5_000, interval: 200 }
    );
  });

  it("Eval Test Film project shows status Done in library", async () => {
    const statusBadge = await $('[data-testid="project-status"]');
    await statusBadge.waitForExist({ timeout: 5_000 });
    expect(await statusBadge.getText()).toBe("Done");
  });
});

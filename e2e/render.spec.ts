/**
 * Full E2E render spec — slow (~5-8 min including pipeline).
 *
 * Run separately: pnpm test:e2e:render
 *
 * Pre-conditions:
 * - C:\clips\ contains at least 1 video file (MP4/MOV/MKV)
 * - Tauri binary compiled: pnpm build or pnpm dev (debug)
 * - msedgedriver.exe in PATH matching Edge/WebView2 version
 */

import { execFileSync } from "child_process";

describe("Full E2E render — /render/:projectId", () => {
  let videoSrc: string;

  before(async () => {
    await browser.pause(1500);
  });

  it("scans C:\\clips\\ and creates a project via invoke shortcuts", async () => {
    const result = await browser.execute(async () => {
      const { invoke } = (window as any).__TAURI_INTERNALS__;
      const metas: any[] = await invoke("scan_folder", { folderPath: "C:\\clips" });
      if (!metas || metas.length === 0) throw new Error("No clips in C:\\clips");
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
    expect(result).toBeTruthy();
  });

  it("navigates to project in Library and opens to /trimmer/", async () => {
    const hamburger = await $('[data-testid="btn-nav-open"]');
    await hamburger.click();
    const myProjects = await $('[data-testid="nav-item-my-projects"]');
    await myProjects.waitForDisplayed({ timeout: 3_000 });
    await myProjects.click();

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/library"),
      { timeout: 5_000, interval: 200 }
    );

    const openBtn = await $('[data-testid="btn-open-project"]');
    await openBtn.waitForExist({ timeout: 5_000 });
    await openBtn.click();

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/trimmer/"),
      { timeout: 8_000, interval: 300 }
    );
  });

  it("adds first clip to film in Trimmer", async () => {
    // Click first pantry tile to select it
    const firstTile = await $('[data-testid="pantry-tile"]');
    await firstTile.waitForExist({ timeout: 5_000 });
    await firstTile.click();

    // Click Add to Film
    const addBtn = await $('[data-testid="btn-add-to-film"]');
    await addBtn.waitForExist({ timeout: 3_000 });
    await addBtn.click();

    // Confirm at least 1 clip appears in film strip
    const filmClip = await $('[data-testid="filmstrip-clip"]');
    await filmClip.waitForExist({ timeout: 3_000 });
  });

  it("navigates to /transitions/ via StepNav CTA", async () => {
    const nextBtn = await $('button*=Next: Transitions');
    await nextBtn.waitForExist({ timeout: 5_000 });
    await nextBtn.click();

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/transitions/"),
      { timeout: 5_000, interval: 200 }
    );
  });

  it("selects a transition chip and navigates to /sound/", async () => {
    const noneChip = await $('[data-testid="chip-transition-none"]');
    await noneChip.waitForExist({ timeout: 3_000 });
    await noneChip.click();

    const nextBtn = await $('button*=Next: Sound');
    await nextBtn.waitForExist({ timeout: 3_000 });
    await nextBtn.click();

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/sound/"),
      { timeout: 5_000, interval: 200 }
    );
  });

  it("selects a music mood and navigates to /render/", async () => {
    const cinematicChip = await $('[data-testid="chip-mood-cinematic"]');
    await cinematicChip.waitForExist({ timeout: 3_000 });
    await cinematicChip.click();

    const nextBtn = await $('button*=Next: Render');
    await nextBtn.waitForExist({ timeout: 3_000 });
    await nextBtn.click();

    await browser.waitUntil(
      async () => (await browser.getUrl()).includes("/render/"),
      { timeout: 5_000, interval: 200 }
    );
  });

  it("pipeline starts automatically — heading and stage label appear", async () => {
    const heading = await $('h1');
    await heading.waitForExist({ timeout: 5_000 });
    expect(await heading.getText()).toBe("Render Your Film");

    // Render starts without user interaction — wait for stage label
    const stageLabel = await $('[data-testid="stage-label"]');
    await stageLabel.waitForExist({ timeout: 30_000 });
    const text = await stageLabel.getText();
    expect(text.length).toBeGreaterThan(0);
  });

  it("progress bar increments and pipeline completes", async () => {
    await browser.waitUntil(
      async () => {
        const h1 = await $("h1");
        if (await h1.isExisting() && (await h1.getText()) === "Your film is ready") return true;
        const pct = await $('[data-testid="progress-pct"]');
        if (!(await pct.isExisting())) return false;
        const value = parseInt(await pct.getText(), 10);
        return !isNaN(value) && value >= 100;
      },
      {
        timeout: 540_000,
        interval: 2_000,
        timeoutMsg: "Pipeline did not reach 100% within 9 minutes",
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

  it("video element is fully loaded — readyState 4, no errors, duration >3s", async () => {
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
    expect(info.duration).toBeGreaterThan(3);
  });

  it("video codec is h264 Main, 1080p output, audio AAC", async () => {
    const decoded = decodeURIComponent(videoSrc);
    const pathMatch = decoded.match(/asset\.localhost\/([A-Za-z]:[/\\].+\.mp4)/i);
    if (!pathMatch) throw new Error(`Cannot parse Windows path from src: ${videoSrc}`);
    const winPath = pathMatch[1].replace(/\//g, "\\");
    const wslPath = "/mnt/" + winPath[0].toLowerCase() + "/" + winPath.slice(3).replace(/\\/g, "/");

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
    expect(videoStream.height).toBe(1080);
    expect(audioStream.codec_name).toBe("aac");
  });

  it("My Projects button navigates to library", async () => {
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

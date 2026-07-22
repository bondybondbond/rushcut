/**
 * Read-only observe spec for wdio.attach.conf.ts (#97 follow-on).
 * Run: pnpm test:e2e:attach
 *
 * Deliberately does nothing but observe: screenshot + text dump of whatever route/state
 * the user's already-running rushcut.exe is currently on. No clicks, no setValue, no
 * invoke() calls, no navigation -- the point is to self-verify a real-IPC UI state without
 * disturbing what the user is looking at. Set RUSHCUT_CHECK_SELECTOR to also dump one
 * element's text/visibility (e.g. a data-testid on a specific note/chip being verified).
 */

import path from "path";
import fs from "fs";

describe("Read-only live-app observation", () => {
  it("captures the current screen without interacting", async () => {
    const url = await browser.getUrl();
    const bodyText = await browser.execute(() => document.body.textContent ?? "");

    const outDir = path.resolve(__dirname, "screenshots");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const shotPath = path.join(outDir, `readonly-check-${Date.now()}.png`);
    await browser.saveScreenshot(shotPath);

    console.log(`[readonly-check] url=${url}`);
    console.log(`[readonly-check] screenshot=${shotPath}`);
    console.log(`[readonly-check] bodyText.length=${bodyText.length}`);

    const selector = process.env.RUSHCUT_CHECK_SELECTOR;
    if (selector) {
      const el = await $(selector);
      const exists = await el.isExisting();
      console.log(`[readonly-check] selector=${selector} exists=${exists}`);
      if (exists) {
        const text = await el.getText();
        const displayed = await el.isDisplayed();
        console.log(`[readonly-check] selector text=${JSON.stringify(text)} displayed=${displayed}`);
      }
    }

    // Read-only browser console dump (added for #149 wrapup verification) -- guarded
    // since attach-mode's capabilities don't set goog:loggingPrefs; if the driver
    // doesn't support getLogs on this attach, this just no-ops instead of failing
    // the whole (otherwise passive) check.
    try {
      const logs = await browser.getLogs("browser");
      console.log(`[readonly-check] console-log-count=${logs.length}`);
      for (const entry of logs as { level: string; message: string }[]) {
        console.log(`[readonly-check] console[${entry.level}] ${entry.message}`);
      }
    } catch (e) {
      console.log(`[readonly-check] getLogs unsupported on this attach: ${(e as Error).message}`);
    }
  });
});

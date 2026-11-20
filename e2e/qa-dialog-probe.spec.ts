/**
 * qa-dialog-probe.spec.ts (#261) -- fast, render-free check of the stop-render confirmation.
 *
 * Opens the SAME native confirm through the real dialog plugin command, with the exact options
 * Render.tsx passes, then reads and presses its buttons with Windows UI Automation
 * (e2e/helpers/clickNativeDialog.ps1). Proves: copy, button names, that "Stop exporting" resolves
 * true and "Keep exporting" resolves false, and takes a screenshot of the dialog.
 * Run: pnpm exec wdio run wdio.qa.conf.ts --spec e2e/qa-isolation.spec.ts --spec e2e/qa-dialog-probe.spec.ts
 * with RC_QA_ROOT=C:\rcqa\<id>, QA_ISOLATE_RENDER=1, RC_CANCEL_OUT=<folder>.
 */
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const OUT = process.env.RC_CANCEL_OUT ?? "";
const TITLE = "Stop exporting this video?";

function ui(pid: number, button: string, shot: string): any {
  const ps1 = path.resolve(__dirname, "helpers", "clickNativeDialog.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-ProcId", String(pid), "-Title", TITLE, "-TimeoutSec", "25", "-Button", button];
  if (shot) args.push("-ShotPath", shot);
  const r = spawnSync("powershell", args, { encoding: "utf8" });
  const line = (r.stdout ?? "").trim().split(/\r?\n/).pop() ?? "{}";
  try { return JSON.parse(line); } catch { return { found: false, error: `unparseable: ${line} ${r.stderr}` }; }
}

// Same call shape @tauri-apps/plugin-dialog's confirm() makes; options mirror Render.tsx cancelRender().
const openConfirm = () => browser.execute(() => {
  (window as any).__rcProbe = undefined;
  (window as any).__TAURI_INTERNALS__.invoke("plugin:dialog|confirm", {
    message: "You can export it again any time.", title: "Stop exporting this video?", kind: "warning",
    okButtonLabel: "Stop exporting", cancelButtonLabel: "Keep exporting",
  }).then((v: boolean) => { (window as any).__rcProbe = v; }, (e: unknown) => { (window as any).__rcProbe = "error:" + String(e); });
});
const probeValue = () => browser.execute(() => (window as any).__rcProbe);

describe("#261 native stop-render dialog (render-free probe)", function () {
  this.timeout(300_000);
  it("shows the approved copy and resolves true / false for the two buttons", async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const pid = Number(JSON.parse(fs.readFileSync(path.resolve(__dirname, ".qa-lock.json"), "utf8")).appPid);
    const ev: Record<string, unknown> = {};
    try {
      await openConfirm();
      const keep = ui(pid, "Keep exporting", path.join(OUT, "cancel-dialog.png"));
      ev.keep = keep;
      expect(keep.found).toBe(true);
      expect(keep.texts.join(" | ")).toContain("You can export it again any time.");
      expect(keep.buttons).toEqual(expect.arrayContaining(["Stop exporting", "Keep exporting"]));
      expect(keep.clicked).toBe("Keep exporting");
      await browser.waitUntil(async () => (await probeValue()) !== undefined && (await probeValue()) !== null, { timeout: 15_000, interval: 300 });
      ev.keepResult = await probeValue();
      expect(await probeValue()).toBe(false);

      await openConfirm();
      const stop = ui(pid, "Stop exporting", "");
      ev.stop = stop;
      expect(stop.clicked).toBe("Stop exporting");
      await browser.waitUntil(async () => (await probeValue()) !== undefined && (await probeValue()) !== null, { timeout: 15_000, interval: 300 });
      ev.stopResult = await probeValue();
      expect(await probeValue()).toBe(true);
    } finally {
      fs.writeFileSync(path.join(OUT, "dialog-probe-evidence.json"), JSON.stringify(ev, null, 2));
    }
  });
});

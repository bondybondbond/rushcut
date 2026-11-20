import fs from "fs";
import os from "os";
import path from "path";

// #237: snapshot of the user's REAL RushCut folders, used as the negative half of the
// isolation proof ("nothing new landed in the real locations"). The BEFORE snapshot is taken
// by wdio.qa.conf.ts in beforeSession, BEFORE the QA app is spawned, so a startup-time leak
// into a real folder cannot hide in the baseline.

function walk(dir: string, depth: number, out: Map<string, number>) {
  let ents: fs.Dirent[] = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    try { out.set(p, fs.statSync(p).mtimeMs); } catch { /* raced */ }
    if (e.isDirectory() && depth > 1) walk(p, depth - 1, out);
  }
}

/** The real folders as THIS process sees them, plus the MSIX-container copy of Roaming (an
 *  in-session launch is redirected there; see docs/LEARNINGS.md MSIX trap). */
export function realRoots(): string[] {
  const roots = [
    path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "rushcut"),
    path.join(os.tmpdir(), "rushcut"),
  ];
  const pk = path.join(os.homedir(), "AppData", "Local", "Packages");
  try {
    for (const n of fs.readdirSync(pk)) if (n.startsWith("Claude_")) roots.push(path.join(pk, n, "LocalCache", "Roaming", "rushcut"));
  } catch { /* none */ }
  return roots;
}

/** mtime map of everything under the real roots (depth 4), minus anything under `excludeRoot`
 *  (the default QA root lives under the real %TEMP%\rushcut\qa-e2e; never count our own). */
export function snapshotReal(excludeRoot: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of realRoots()) walk(r, 4, m);
  const ex = excludeRoot.toLowerCase();
  if (ex) for (const k of [...m.keys()]) if (k.toLowerCase().startsWith(ex)) m.delete(k);
  return m;
}

export function saveSnapshot(file: string, m: Map<string, number>): void {
  fs.writeFileSync(file, JSON.stringify([...m.entries()]));
}

export function loadSnapshot(file: string): Map<string, number> | null {
  try { return new Map(JSON.parse(fs.readFileSync(file, "utf8")) as Array<[string, number]>); } catch { return null; }
}

/** Paths that are new, or whose mtime changed, since `before`. */
export function changedSince(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after.keys()].filter((p) => !before.has(p) || after.get(p) !== before.get(p));
}

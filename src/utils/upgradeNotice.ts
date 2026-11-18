/**
 * #236: wording for the Render-screen notice shown when the background quality
 * improvement of some clips was skipped because the drive is too full.
 * Plain words only: no "proxy" / "encode" / "upgrade" / "working copy".
 */
export function upgradeNoticeText(names: string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  const subject = names.length === 1 ? "1 clip will" : `${names.length} clips will`;
  return (
    `${subject} look lower quality than they could because there isn't enough free storage to prepare ` +
    `${names.length === 1 ? "it" : "them"} fully: ${shown}${more}. ` +
    `Free up some space, then open the editor again to fix this. You can still render now.`
  );
}

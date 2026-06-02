// Relative-time formatter for render timestamps (Batch T4).
// ASCII only. Used by Library cards and the Render done-state.
//
// Job timestamps come from db.rs now() as "YYYY-MM-DDTHH:MM:SSZ" (UTC).

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const diffMs = Date.now() - then;
  const sec = Math.floor(diffMs / 1000);

  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;

  // Older than a week: short calendar date.
  try {
    return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso.slice(0, 10);
  }
}

// Absolute date+time, e.g. "1 Jun 2026, 23:57" (Batch T5).
// Used on the Render done-state where an exact render time is wanted.
export function absoluteDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

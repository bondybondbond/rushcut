// Pure matching logic for the secret-file commit guard (PreToolUse). Kept separate from
// guard-secret-commit.js so the forbidden-pattern list is unit-testable without touching git
// state -- same split as trigger-match.js / transcript.js in this same hooks/lib directory.
// Mirrors the "never commit" list in rushcut-wrapup SKILL.md Step 6.

const FORBIDDEN_PATTERNS = [
  { name: ".env / .env.local", re: /(^|\/)\.env(\.[\w.-]+)?$/i },
  { name: "spike/tmp/", re: /(^|\/)spike\/tmp\// },
  { name: "spike/output*", re: /(^|\/)spike\/output/i },
  { name: "C:/clips/ path", re: /^[a-z]:[\\/]clips[\\/]/i },
  { name: "credential-looking file", re: /credential/i },
  { name: "private key (.pem / *key*)", re: /\.pem$|private.?key/i },
];

// Returns [{ path, pattern }] for every staged path that matches a forbidden pattern.
function forbiddenHits(paths) {
  const hits = [];
  for (const p of paths) {
    for (const pat of FORBIDDEN_PATTERNS) {
      if (pat.re.test(p)) {
        hits.push({ path: p, pattern: pat.name });
        break;
      }
    }
  }
  return hits;
}

module.exports = { FORBIDDEN_PATTERNS, forbiddenHits };

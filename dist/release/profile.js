// Which site this copy of the workspace runs as: production. Everything else in this directory is
// copied from dist/test-server/ by scripts/promote_release.mjs; this file is kept by hand and must
// offer the same fields as dist/test-server/profile.js.
export const PROFILE = Object.freeze({
  // Also the profile name collectors report for monitoring schedules.
  name: 'production',
  // Pages of this site, relative to this module: the sign-in page and the workspace itself.
  pages: Object.freeze({entry: '../login.html', workspace: '../'}),
  // Documents on the status branch. The test server has its own; the two sites never share a file.
  files: Object.freeze({research: 'dashboard/research.json', monitoring: 'dashboard/monitoring.json', usage: 'dashboard/openrouter-usage.json'}),
  // Prefixes of the commit messages written with those documents.
  commits: Object.freeze({research: 'research', monitoring: 'monitoring', usage: 'usage charts'}),
  // The research view that holds the real records when this site keeps only a practice copy.
  // Production holds the real ones itself.
  practiceOf: '',
});

// Which site this copy of the workspace runs as. The test server and the production release run
// the same modules; everything that differs between the two is named here and nowhere else. A
// production release copies every other module from dist/test-server/ to dist/release/ unchanged
// (scripts/promote_release.mjs), so dist/release/profile.js is the one production file kept by hand.
export const PROFILE = Object.freeze({
  // 'test' or 'production'. Also the profile name collectors report for monitoring schedules.
  name: 'test',
  // Pages of this site, relative to this module: the sign-in page and the workspace itself.
  pages: Object.freeze({entry: './', workspace: './preview.html'}),
  // Documents on the status branch. The two sites never share a file, so trying something on the
  // test server cannot change what production shows.
  files: Object.freeze({research: 'dashboard/research-test.json', monitoring: 'dashboard/monitoring-test.json', usage: 'dashboard/openrouter-usage-test.json'}),
  // Prefixes of the commit messages written with those documents.
  commits: Object.freeze({research: 'research-test', monitoring: 'monitoring-test', usage: 'test usage charts'}),
  // Since the v3.0 release the lab's real research records are kept on production and the test
  // server holds a practice copy. This is the address of the research view that holds the real
  // ones, relative to this module; '' on the site that holds them itself.
  practiceOf: '../#research',
  // The document that holds those real records, which the practice copy can be refreshed from
  // (연구과제 → 정식 기록 가져오기). It is only ever read here. '' on the site that holds the
  // real records itself: that site's document is never replaced as a whole.
  practiceSource: 'dashboard/research.json',
});

'use strict';
/**
 * Best-effort Playwright Chromium install, run by `npm install` (postinstall).
 *
 * It must never break the build: hosts without network access, without
 * enough disk, or with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set simply skip it,
 * and the "Render JavaScript" option in the app then reports itself as
 * unavailable (honestly) instead of the whole deploy failing.
 *
 * Set PLAYWRIGHT_BROWSERS_PATH to a directory inside the project (e.g.
 * ./.playwright) on hosts like Render, so the downloaded browser persists
 * from the build step into the running service.
 */
const { spawnSync } = require('child_process');

if (process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD) {
  console.log('[install-browser] PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD set — skipping Chromium download.');
  process.exit(0);
}
if (process.env.SKIP_BROWSER_INSTALL) {
  console.log('[install-browser] SKIP_BROWSER_INSTALL set — skipping Chromium download.');
  process.exit(0);
}

// --only-shell: the headless shell is what headless launches use, and it is
// one ~100MB download instead of three (full Chromium stalled on Render).
const args = ['playwright', 'install', '--only-shell', 'chromium'];
console.log(`[install-browser] Running: npx ${args.join(' ')} (PLAYWRIGHT_BROWSERS_PATH=${process.env.PLAYWRIGHT_BROWSERS_PATH || 'default'})`);
const res = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { stdio: 'inherit', timeout: 10 * 60 * 1000 });
if (res.status === 0) {
  console.log('[install-browser] Chromium installed — "Render JavaScript" mode is available.');
} else {
  console.warn(`[install-browser] Chromium install did not complete (exit ${res.status}${res.error ? ', ' + res.error.message : ''}). The app will still run; "Render JavaScript" will report as unavailable.`);
}
process.exit(0);

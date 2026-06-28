#!/usr/bin/env node
/**
 * Manual trigger for the backlink profile → astro sameAs sync.
 *
 *   node server/scripts/backlink-profile-sync.js          # DRY RUN (default) — never writes
 *   node server/scripts/backlink-profile-sync.js --live   # open a PR (needs the gate ON + changes)
 *
 * Dry run prints the verifier-confirmed (status='live') directory/citation/social
 * profile URLs that WOULD be synced into the marketing site's Organization sameAs.
 * Needs DATABASE_URL (to read seo_link_prospects) and GITHUB_TOKEN (to diff the
 * current astro file); a missing token just degrades the diff, it won't write.
 */
const { syncProfilesToAstro } = require('../services/backlink-profile-astro-sync');

(async () => {
  const dryRun = !process.argv.includes('--live');
  try {
    const result = await syncProfilesToAstro({ dryRun });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`[backlink-sync] error: ${err.message}`);
    process.exit(1);
  }
})();

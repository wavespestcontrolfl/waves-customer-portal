// The Google Ads daily sync: campaigns, 7 days of performance, 30 days of search
// terms, then the owner's negative word list. The 6 AM cron and the admin
// POST /api/admin/ads/sync both run it under runExclusive('google-ads-sync'), so
// the two never overlap (ad_campaigns has no unique (platform,
// platform_campaign_id); overlapping first-time syncs could insert one campaign
// twice), and a cron tick that finds a manual run holding the lock is covered by
// that run: it does the same steps and records the same job_health row.
//
// Every step runs with throwOnError, so a failed API call fails its step instead
// of being swallowed into an empty result that read as success. All steps run
// even if one fails; then the run throws (job_health records the first failure's
// message) and the error carries the per-step result for the admin route.

async function syncNegativeWords() {
  // The owner's negative word list (owner plan A, 2026-11-02; GATE_ADS_NEGATIVES): push new words, retry failed
  // ones, take removed words out of Google. Off = skipped.
  if (!require('../../config/feature-gates').adsNegativesLive()) return undefined;
  const counts = await require('./negative-keyword-actions').syncOwnerWords();
  // A word held back because a search with it converted is the rule working, not a failure; Google not
  // answering or refusing a word is, and it shows in job health like the read steps above.
  if (counts && counts.googleFailed > 0) throw new Error(`negative keywords: Google did not take ${counts.googleFailed} change(s)`);
  return counts;
}

const STEPS = [
  { key: 'campaigns', label: 'Campaigns', run: (g) => g.syncCampaigns({ throwOnError: true }) },
  { key: 'performanceRows', label: 'Performance', run: (g) => g.syncDailyPerformance(7, { throwOnError: true }) },
  { key: 'searchTerms', label: 'Search terms', run: (g) => g.syncSearchTerms(30, { throwOnError: true }) },
  { key: 'negativeWords', label: 'Negative words', run: () => syncNegativeWords() },
];

// Resolves { synced, failed: [] }. When a step failed, rejects with the first
// failure's message and err.syncResult = { synced, failed: [{ key, label, message }] }.
// synced: row counts per step (0 for a failed step); negativeWords is the word
// counts, left out while GATE_ADS_NEGATIVES is off.
async function runGoogleAdsDailySync() {
  const googleAds = require('./google-ads');
  const synced = {};
  const failed = [];
  for (const step of STEPS) {
    try {
      const out = await step.run(googleAds);
      if (out !== undefined) synced[step.key] = Array.isArray(out) ? out.length : out;
    } catch (err) {
      synced[step.key] = 0;
      failed.push({ key: step.key, label: step.label, message: err?.message || 'unknown error' });
    }
  }
  if (failed.length) {
    throw Object.assign(new Error(failed[0].message), { syncResult: { synced, failed } });
  }
  return { synced, failed };
}

module.exports = { runGoogleAdsDailySync };

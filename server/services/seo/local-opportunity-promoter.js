/**
 * Local-opportunity promoter — runs the proactive prospector end-to-end:
 * discover local link targets → exclude already-won partners → score + lane-route →
 * promote the LLM-classified, gate-passing rows onto the seo_link_prospects board.
 *
 * Shared by the weekly cron (scheduler.js, gated `localOpportunityProspector`) and the
 * CLI (scripts/backlink-local-opportunities.js) so the orchestration lives in ONE place.
 * Discovery is read-only SERP; the only writes are dedupe-guarded inserts into
 * seo_link_prospects (source=`local_opportunity_*`). Nothing is ever sent — new rows sit
 * inert until the owner arms the outreach/citation lanes (GATE_LINK_OUTREACH /
 * GATE_SIGNUP_RUNNER), exactly like deep-harvest rows.
 */

const logger = require('../logger');
const prospector = require('./local-opportunity-prospector');
const scorer = require('./prospect-scorer');
const { etDateString } = require('../../utils/datetime-et');

const HOME = 'https://wavespestcontrol.com/';
const OWN_DOMAIN = 'wavespestcontrol.com';
const todayTag = () => etDateString().replace(/-/g, ''); // America/New_York, not UTC

function normDomain(v) {
  const raw = String(v || '').trim().toLowerCase();
  if (!raw) return null;
  try { return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, ''); }
  catch { return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null; }
}

/**
 * run — discover → exclude-owned → score → promote.
 * Returns { discovered, excludedOwned, scored, promotable, heldBack, promoted, dupes, dryRun, byLane, items }.
 * Options:
 *   dryRun                compute everything, write NOTHING
 *   limit                 cap the scoring step to the top-N discovered domains
 *   perQuery              SERP results per query per market (default 10)
 *   promoteMin            composite-score floor to promote (default 35; lower than the
 *                         harvest's 50 because these queries are pre-qualified)
 *   discoveryConcurrency  parallel SERP calls (default 6)
 *   contactConcurrency    parallel contact-finds during scoring (default 10)
 *   db / discoverFn / scoreFn   injectable (tests + the CLI's own knex); default to live.
 */
async function run({
  dryRun = false, limit = null, perQuery = 10, promoteMin = 35,
  discoveryConcurrency = 6, contactConcurrency = 10,
  db, discoverFn, scoreFn, log = logger,
} = {}) {
  db = db || require('../../models/db');
  const discover = discoverFn || prospector.discoverLocalOpportunities;
  const score = scoreFn || scorer.scoreCandidates;

  // A live run needs the real LLM classifier for lane routing — without ANTHROPIC_API_KEY
  // the scorer silently falls back to the heuristic and every row is held back, so the
  // job would spend the SERP/contact work and promote nothing. Fail fast (before any
  // spend) with a clear config error — this is the cron path's only guard. Skipped when a
  // scoreFn is injected (tests) or for a --dry-run preview (which still shows held rows).
  if (!dryRun && !scoreFn && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY required for a live local-opportunity run (lane routing needs reliable LLM classification)');
  }

  // 1. discover (read-only SERP)
  let candidates = await discover({ perQuery, concurrency: discoveryConcurrency });
  const discovered = candidates.length;

  // 2. exclude domains we ALREADY have a live link from (mirrors backlink-deep-harvest):
  // active-only matches BacklinkMonitor scope (a lost/disavowed link stays eligible to
  // re-prospect); without this, an already-won partner with no board row would be
  // inserted as a fresh prospect and re-pitched by the worker.
  const ours = new Set((await db('seo_backlinks').where({ status: 'active' }).select('source_domain'))
    .map((r) => normDomain(r.source_domain)).filter(Boolean));
  ours.add(OWN_DOMAIN);
  candidates = prospector.excludeOwned(candidates, ours);
  const excludedOwned = discovered - candidates.length;
  if (limit) candidates = candidates.slice(0, limit);

  const empty = { discovered, excludedOwned, scored: 0, promotable: 0, heldBack: 0, promoted: 0, dupes: 0, dryRun, byLane: {}, items: [] };
  if (!candidates.length) return empty;

  // 3. score (LLM classify + contact-find + composite + lane gate). domain_rating null
  // (only a 10% tiebreaker, and these are pre-qualified local targets); opportunity_type
  // seeds a weak anchor hint, but the scorer classifies intent from the landed page.
  const scoreInput = candidates.map((c) => ({
    domain: c.domain, domain_rating: null, source_url: c.source_url || null,
    sample_anchors: [c.opportunity_type, c.title].filter(Boolean).slice(0, 2),
  }));
  const scored = await score(scoreInput, { concurrency: contactConcurrency });

  // 4. promote: gate-passing, at/above the floor, and LLM-classified (NEVER heuristic —
  // a heuristic chamber would coerce to 'resource' → outreach lane → cold-emailed). HARO
  // platforms are join-not-email and excluded.
  const promotable = scored.map((s, i) => ({ s, cand: candidates[i] }))
    .filter(({ s }) => s.gate.ok && s.gate.lane !== 'haro_platform' && s.score >= promoteMin);
  const writable = promotable.filter(({ s }) => prospector.isReliablyClassified(s));
  const heldBack = promotable.length - writable.length;

  // items = the full promotable set, each flagged `held` when heuristic-classified.
  // Live writes are limited to writable (below), but the preview must still list held
  // rows — otherwise a --dry-run without ANTHROPIC_API_KEY (all heuristic) shows nothing.
  const items = promotable.map(({ s, cand }) => ({
    domain: cand.domain, score: s.score, tier: s.tier, lane: s.gate.lane, intent: s.intent_class,
    opportunity_type: cand.opportunity_type, appearances: cand.appearances, markets: cand.markets.length,
    contact: s.contact?.contact_email ? 'email' : s.contact?.contact_url ? 'form' : 'none',
    held: !prospector.isReliablyClassified(s),
  }));
  const byLane = {}; writable.forEach(({ s }) => { byLane[s.gate.lane] = (byLane[s.gate.lane] || 0) + 1; });
  const summary = { discovered, excludedOwned, scored: scored.length, promotable: promotable.length, heldBack, promoted: 0, dupes: 0, dryRun, byLane, items };

  if (dryRun) return summary;

  // 5. promote survivors. Dedupe ATOMICALLY on the (target_domain, target_page) unique
  // index via ON CONFLICT DO NOTHING — a plain SELECT-then-INSERT races the weekly cron
  // against a manual CLI run (or any other prospect writer) and the second insert would
  // throw a unique violation, aborting the rest of the run. `.returning('id')` is empty
  // when the row already existed, so the dupe is counted, not crashed on.
  const tag = `local_opportunity_${todayTag()}`;
  for (const { s, cand } of writable) {
    const inserted = await db('seo_link_prospects').insert({
      target_domain: cand.domain, target_page: HOME, target_url: cand.source_url || null,
      anchor_planned: s.suggested_anchor || null, link_type: s.intent_class, priority: s.priority,
      domain_rating: null, score: s.score, tier: s.tier,
      contact_email: s.contact?.contact_email || null, contact_url: s.contact?.contact_url || null,
      contact_checked_at: s.contact ? new Date() : null,
      notes: `local opportunity (${cand.opportunity_type}); markets=${cand.markets.join('/')}; queries=${cand.queries.slice(0, 2).join(' | ')}`,
      quality_signals: JSON.stringify({
        relevance: s.relevance_0_100, lead_value_tier: s.lead_value_tier, is_local_swfl: s.is_local_swfl,
        intent_class: s.intent_class, opportunity_type: cand.opportunity_type, opportunity_types: cand.opportunity_types,
        scored_by: 'local_opportunity',
      }),
      source: tag, owner: 'strategy_agent',
    }).onConflict(['target_domain', 'target_page']).ignore().returning('id');
    if (inserted.length) summary.promoted++; else summary.dupes++;
  }
  log.info(`[local-opportunity] promoted=${summary.promoted} dupes=${summary.dupes} held=${heldBack} (discovered=${discovered}, excludedOwned=${excludedOwned}, scored=${scored.length})`);
  return summary;
}

module.exports = { run };
module.exports._internals = { normDomain, HOME };

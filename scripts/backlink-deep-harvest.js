#!/usr/bin/env node
/**
 * Backlink deep harvest + board re-score.
 *
 * WHY NOW: the DataForSEO Backlinks subscription lapses ~July 15. This is the
 * one-time, while-the-meter-runs pull of every referring domain of our local
 * competitors — classified + scored + contact-checked — so the prospect board
 * fills with contactable, locally-relevant targets we OWN after the sub ends.
 *
 *   --mode=harvest   pull competitor referring domains → score → persist intel
 *                    (seo_competitor_backlinks) + promote survivors to the board
 *                    (seo_link_prospects, source=deep_harvest_<YYYYMMDD>)
 *   --mode=rescore   re-score the EXISTING board rows; demote outreach rows with
 *                    no contact path / low relevance (national directories, HARO)
 *
 *   --dry-run        compute + print everything, write NOTHING
 *   --limit=N        cap the expensive scoring step to N domains (bounded test)
 *   --competitors=a.com,b.com   override the benchmark set
 *   --promote-min=50  composite-score floor to promote a harvested domain
 *
 * Connects via DATABASE_URL (export the Railway *public* URL). Run with NODE_ENV
 * unset so the seoIntelligence gate is dev-open; needs DATAFORSEO_LOGIN/PASSWORD
 * and ANTHROPIC_API_KEY in the environment.
 *
 *   DATABASE_URL=… DATAFORSEO_LOGIN=… DATAFORSEO_PASSWORD=… ANTHROPIC_API_KEY=… \
 *     node scripts/backlink-deep-harvest.js --mode=harvest --dry-run
 */

require('dotenv').config();
const knex = require('knex');

const { etDateString } = require('../server/utils/datetime-et');
const dataforseo = require('../server/services/seo/dataforseo');
const scorer = require('../server/services/seo/prospect-scorer');
const { DEFAULT_COMPETITOR_DOMAINS } = require('../server/services/seo/competitor-gap-miner')._internals;

const HOME = 'https://wavespestcontrol.com/';
const OWN_DOMAIN = 'wavespestcontrol.com';
const SPAM_MAX = 40;          // drop domains at/above this DataForSEO spam score
const MAX_REFERRING_PAGES = 6; // page cap per competitor (6000 ref domains) — bounds cost; logs PARTIAL if exceeded
const TOPIC_KEYWORDS = {
  pest: ['pest-control', 'pest'], lawn: ['lawn', 'turf'], termite: ['termite'],
  wdo: ['wdo', 'wood-destroying'], mosquito: ['mosquito'], rodent: ['rodent', 'wildlife'],
};

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { mode: 'harvest', dryRun: false, limit: null, competitors: null, promoteMin: 50 };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg.startsWith('--mode=')) a.mode = arg.split('=')[1];
    else if (arg.startsWith('--limit=')) a.limit = parseInt(arg.split('=')[1], 10) || null;
    else if (arg.startsWith('--promote-min=')) a.promoteMin = Number(arg.split('=')[1]) || 50;
    else if (arg.startsWith('--competitors=')) a.competitors = arg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return a;
}

function makeDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return knex({
    client: 'pg',
    connection: { connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 4 },
  });
}

function normDomain(v) {
  const raw = String(v || '').trim().toLowerCase();
  if (!raw) return null;
  try { return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.replace(/^www\./, ''); }
  catch { return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '') || null; }
}

const items = (resp) => resp?.tasks?.[0]?.result?.[0]?.items || resp?.tasks?.[0]?.result || [];
const todayTag = () => etDateString().replace(/-/g, ''); // America/New_York, not UTC

async function resolveMoneyPages(topics) {
  let urls = [];
  try { urls = await require('../server/services/seo/sitemap-manager').listUrls(); } catch { urls = []; }
  const map = {};
  for (const topic of topics) {
    if (!topic || topic === 'general') { map[topic] = HOME; continue; }
    const kws = TOPIC_KEYWORDS[topic] || [topic];
    const hit = (urls || []).find((u) => kws.some((k) => String(u).toLowerCase().includes(k)));
    map[topic] = hit || HOME;
  }
  return map;
}

// ── harvest ──────────────────────────────────────────────────────────────────
async function harvest(db, args) {
  const competitors = (args.competitors || DEFAULT_COMPETITOR_DOMAINS).map(normDomain).filter(Boolean);
  console.log(`\n[harvest] competitors (${competitors.length}): ${competitors.join(', ')}`);
  if (!dataforseo.configured) throw new Error('DATAFORSEO_LOGIN/PASSWORD not set');

  // Domains we already have a LIVE link from — exclude. Active-only (matching
  // BacklinkMonitor scope): a lost/disavowed row is NOT a link we still own, so
  // that domain stays eligible to be re-prospected.
  const ours = new Set((await db('seo_backlinks').where({ status: 'active' }).select('source_domain')).map((r) => normDomain(r.source_domain)).filter(Boolean));
  ours.add(OWN_DOMAIN);

  // 1. aggregate referring domains across competitors — PAGE through, since the
  // endpoint caps at 1000/call and big competitors have more (via offset). This
  // is the one-time full harvest, so don't silently grab only the first page.
  const agg = new Map();
  for (const comp of competitors) {
    let offset = 0, total = Infinity, fetched = 0, kept = 0;
    for (let page = 0; page < MAX_REFERRING_PAGES && offset < total; page++) {
      const result0 = (await dataforseo.getReferringDomains(comp, { limit: 1000, offset }))?.tasks?.[0]?.result?.[0];
      const rows = result0?.items || [];
      total = Number(result0?.total_count) || fetched + rows.length;
      if (!rows.length) break;
      for (const it of rows) {
        const domain = normDomain(it.domain || it.target);
        if (!domain || domain === comp || ours.has(domain)) continue;
        const rank = Number(it.rank) || 0;
        const cur = agg.get(domain) || { domain, rank: 0, backlinks: 0, competitors: new Set() };
        cur.rank = Math.max(cur.rank, rank);
        cur.backlinks = Math.max(cur.backlinks, Number(it.backlinks) || 0);
        cur.competitors.add(comp);
        agg.set(domain, cur);
        kept++;
      }
      fetched += rows.length;
      offset += 1000;
    }
    const partial = total > fetched ? ` ⚠️ PARTIAL: ${total} total, capped at ${MAX_REFERRING_PAGES * 1000}` : '';
    console.log(`  ${comp}: fetched ${fetched}/${total} referring domains, ${kept} new candidates${partial} (running unique: ${agg.size})`);
  }

  let candidates = [...agg.values()].sort((x, y) => y.rank - x.rank);
  console.log(`[harvest] ${candidates.length} unique candidate domains after exclude-existing`);
  if (args.limit) { candidates = candidates.slice(0, args.limit); console.log(`[harvest] limited to ${candidates.length} for this run`); }

  // 2. bulk spam scores → drop spam/PBN
  const spam = new Map();
  let spamChunkFails = 0;
  for (let i = 0; i < candidates.length; i += 1000) {
    const chunk = candidates.slice(i, i + 1000).map((c) => c.domain);
    const rows = items(await dataforseo.bulkSpamScore(chunk));
    if (!rows.length) { spamChunkFails += chunk.length; continue; } // null/empty = DFS hiccup
    for (const it of rows) spam.set(normDomain(it.target), Number(it.spam_score) || 0);
  }
  const preSpam = candidates.length;
  // Fail CLOSED: a domain with no returned spam score is EXCLUDED, not assumed
  // clean — a transient DataForSEO failure must not leak unscreened PBNs into LLM
  // scoring/promotion (the spam gate runs before we spend that budget). Logged,
  // not silent, so a degraded run is visible.
  const unscored = candidates.filter((c) => !spam.has(c.domain)).length;
  candidates = candidates.filter((c) => spam.has(c.domain) && spam.get(c.domain) < SPAM_MAX);
  console.log(`[harvest] dropped ${preSpam - candidates.length} (spam>=${SPAM_MAX} or unscored: ${unscored} no-score${spamChunkFails ? `, ${spamChunkFails} in failed chunks` : ''}); ${candidates.length} survive`);

  // 3. score (LLM classify + contact-find + composite)
  const scoreInput = candidates.map((c) => ({
    domain: c.domain, domain_rating: c.rank, spam_score: spam.get(c.domain) ?? null,
    source_url: null, sample_anchors: [], links_to_competitors: [...c.competitors],
  }));
  console.log(`[harvest] scoring ${scoreInput.length} domains (LLM classify + contact-find)…`);
  const scored = await scorer.scoreCandidates(scoreInput);

  const moneyPages = await resolveMoneyPages([...new Set(scored.map((s) => s.target_topic))]);
  const promotable = scored.filter((s) => s.gate.ok && s.gate.lane === 'outreach' && s.score >= args.promoteMin);

  // summary
  const byTier = {};
  scored.forEach((s) => { byTier[s.tier] = (byTier[s.tier] || 0) + 1; });
  console.log(`\n[harvest] scored ${scored.length}: tiers ${JSON.stringify(byTier)}`);
  console.log(`[harvest] ${promotable.length} promotable (contactable outreach, score >= ${args.promoteMin})`);
  console.log('[harvest] top promotable sample:');
  promotable.slice(0, 12).forEach((s) => console.log(
    `   ${String(s.score).padStart(5)}  T${s.tier}  ${s.intent_class.padEnd(10)} ${s.candidate.domain}  contact=${s.contact?.contact_email ? 'email' : s.contact?.contact_url ? 'form/url' : 'none'}`));

  if (args.dryRun) { console.log('\n[harvest] DRY-RUN — no writes.'); return; }

  // 4. persist intel (one row per competitor↔domain) + promote survivors
  let intelWrites = 0, promoted = 0;
  for (const s of scored) {
    for (const comp of s.candidate.links_to_competitors) {
      const exists = await db('seo_competitor_backlinks').where({ competitor_domain: comp, source_domain: s.candidate.domain }).first();
      if (exists) {
        // A scanCompetitorGaps row may already hold the EXACT source_url/anchor/
        // link_type (URL-level). The referring-domain harvest is only domain-level,
        // so refresh the rank/priority signals but DON'T degrade that evidence.
        await db('seo_competitor_backlinks').where({ id: exists.id }).update({
          source_domain_rating: s.candidate.domain_rating, waves_has_link: false,
          prospect_priority: s.priority, last_checked: etDateString(), updated_at: new Date(),
        });
      } else {
        await db('seo_competitor_backlinks').insert({
          competitor_domain: comp, source_domain: s.candidate.domain, source_domain_rating: s.candidate.domain_rating,
          // referring_domains is domain-level — no specific URL — but source_url is
          // NOT NULL, so record the domain root as the source page.
          source_url: `https://${s.candidate.domain}/`,
          link_type: s.intent_class, waves_has_link: false, prospect_priority: s.priority,
          first_seen: etDateString(), last_checked: etDateString(),
        });
      }
      intelWrites++;
    }
  }
  for (const s of promotable) {
    const targetPage = moneyPages[s.target_topic] || HOME;
    const dup = await db('seo_link_prospects').where({ target_domain: s.candidate.domain, target_page: targetPage }).first();
    if (dup) continue;
    await db('seo_link_prospects').insert({
      target_domain: s.candidate.domain, target_page: targetPage,
      anchor_planned: s.suggested_anchor || null, link_type: s.intent_class, priority: s.priority,
      domain_rating: s.candidate.domain_rating, score: s.score, tier: s.tier,
      contact_email: s.contact?.contact_email || null, contact_url: s.contact?.contact_url || null, contact_checked_at: new Date(),
      notes: `deep harvest; topic=${s.target_topic}; links to ${s.candidate.links_to_competitors.join(', ')}`,
      quality_signals: JSON.stringify({ relevance: s.relevance_0_100, lead_value_tier: s.lead_value_tier, is_local_swfl: s.is_local_swfl, intent_class: s.intent_class, scored_by: 'deep_harvest' }),
      source: `deep_harvest_${todayTag()}`, owner: 'strategy_agent',
    });
    promoted++;
  }
  console.log(`\n[harvest] wrote ${intelWrites} intel rows; promoted ${promoted} prospects to the board.`);
}

// ── rescore ──────────────────────────────────────────────────────────────────
async function rescore(db, args) {
  let rows = await db('seo_link_prospects').orderBy('created_at', 'asc');
  if (args.limit) rows = rows.slice(0, args.limit);
  console.log(`\n[rescore] scoring ${rows.length} existing prospects…`);

  const scored = await scorer.scoreCandidates(rows.map((r) => ({
    domain: r.target_domain, domain_rating: r.domain_rating,
    source_url: r.target_url, sample_anchors: [r.anchor_planned || r.anchor_text].filter(Boolean),
  })));

  const demotions = [];
  const updates = [];
  scored.forEach((s, i) => {
    const r = rows[i];
    // If the fresh probe found no contact but the row already has one on file,
    // re-score WITH the stored contact — otherwise a transient/blocked probe
    // zeroes the contactability component and permanently down-ranks a site with
    // a known contact path. (Demotion is already protected separately.)
    if ((r.contact_email || r.contact_url) && (!s.contact || !s.contact.has_contact_path)) {
      const stored = { has_contact_path: true, contact_email: r.contact_email, contact_url: r.contact_url };
      const re = scorer.scoreProspect({ domain_rating: r.domain_rating }, s.classification, stored);
      s.score = re.score; s.tier = re.tier; s.priority = re.priority; // priority too — patch writes s.priority
    }
    // 'haro' is one of the worker's OUTREACH_TYPES but not in the scorer's
    // OUTREACH_INTENTS set, so include it explicitly — otherwise a no-contact
    // non-platform HARO row would escape demotion and still be claimed by Hermes.
    const isOutreachIntent = scorer.OUTREACH_INTENTS.has(s.intent_class) || s.intent_class === 'haro' || s.gate.lane === 'haro_platform';
    // Demote only un-worked rows whose outreach claim fails (no contact path,
    // HARO platform, or a low composite — the national directories). NEVER touch
    // a row already in flight: status stays 'prospect' while a draft is prepared
    // or sent, with outreach_status/claimed_at carrying the real state, so demote
    // would yank prepared drafts out of the approval/reconciliation queues.
    const inFlight = (r.outreach_status && r.outreach_status !== 'none') || r.claimed_at;
    // A contact already on file counts as a contact path — a transient fetch
    // failure (probe returns nothing) must not reject an otherwise-valid row.
    // Only HARO platforms demote regardless; no-contact/low-score demotes apply
    // only when the row has no stored contact either.
    const hadContact = !!(r.contact_email || r.contact_url);
    // The scorer re-classifies from the domain alone (it isn't given r.link_type),
    // so an existing directory/citation/social row can come back unknown/resource.
    // Its STORED link_type is authoritative — never demote a signup-lane row (it's
    // worked by the signup worker, not outreach).
    const existingSignup = scorer.SIGNUP_INTENTS.has(r.link_type);
    const demote = r.status === 'prospect' && !inFlight && !existingSignup && isOutreachIntent && (
      s.gate.lane === 'haro_platform' || (!hadContact && (!s.gate.ok || s.score < 40))
    );
    updates.push({ r, s, demote });
    if (demote) demotions.push({ domain: r.target_domain, intent: s.intent_class, score: s.score, reason: s.gate.reason || (s.gate.lane === 'haro_platform' ? 'HARO platform' : 'low relevance') });
  });

  console.log(`[rescore] ${demotions.length} would be demoted:`);
  demotions.slice(0, 30).forEach((d) => console.log(`   ${String(d.score).padStart(5)}  ${d.intent.padEnd(10)} ${d.domain}  — ${d.reason}`));

  if (args.dryRun) { console.log('\n[rescore] DRY-RUN — no writes.'); return; }

  let updated = 0, demoted = 0;
  for (const { r, s, demote } of updates) {
    // MERGE scorer keys into existing quality_signals — that JSONB also holds
    // verifier/indexer state (target_indexed, omega_*, pending); don't wipe it.
    let qs = {};
    try { qs = typeof r.quality_signals === 'string' ? JSON.parse(r.quality_signals) : (r.quality_signals || {}); } catch { qs = {}; }
    Object.assign(qs, { relevance: s.relevance_0_100, lead_value_tier: s.lead_value_tier, is_local_swfl: s.is_local_swfl, intent_class: s.intent_class, scored_by: 'rescore' });

    // Persist the recomputed priority too — the admin board orders by it and
    // Hermes filters/claims by it; writing only score/tier would leave a raw-DR
    // row misordered. And make an existing missing/non-claimable link_type
    // claimable (s.intent_class is coerced), so the worker can actually claim it;
    // a row whose stored link_type is already claimable keeps it (authoritative
    // lane, incl. the protected signup lanes).
    const patch = { score: s.score, tier: s.tier, priority: s.priority, quality_signals: JSON.stringify(qs), updated_at: new Date() };
    if (!(r.link_type && scorer.CLAIMABLE_LINK_TYPES.has(r.link_type))) patch.link_type = s.intent_class;
    // Only write contact fields when this probe actually found something — never
    // null out a previously-captured contact (signup-lane rows aren't probed).
    if (s.contact && (s.contact.contact_email || s.contact.has_contact_path)) {
      patch.contact_email = s.contact.contact_email || r.contact_email || null;
      patch.contact_url = s.contact.contact_url || r.contact_url || null;
      patch.contact_checked_at = new Date();
    }
    if (demote) {
      patch.status = 'rejected';
      patch.notes = `${r.notes ? r.notes + ' | ' : ''}rescored ${todayTag()}: ${s.gate.reason || (s.gate.lane === 'haro_platform' ? 'HARO platform (join, not email)' : 'low relevance/no contact')}`;
      demoted++;
    }
    await db('seo_link_prospects').where({ id: r.id }).update(patch);
    updated++;
  }
  console.log(`\n[rescore] updated ${updated} rows; demoted ${demoted} to 'rejected'.`);
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  const args = parseArgs(process.argv);
  console.log(`backlink-deep-harvest mode=${args.mode} dryRun=${args.dryRun} limit=${args.limit ?? '∞'}`);
  const db = makeDb();
  try {
    if (args.mode === 'harvest') await harvest(db, args);
    else if (args.mode === 'rescore') await rescore(db, args);
    else throw new Error(`unknown --mode=${args.mode} (use harvest|rescore)`);
  } catch (err) {
    console.error(`\n[deep-harvest] FAILED: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();

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

const dataforseo = require('../server/services/seo/dataforseo');
const scorer = require('../server/services/seo/prospect-scorer');
const { DEFAULT_COMPETITOR_DOMAINS } = require('../server/services/seo/competitor-gap-miner')._internals;

const HOME = 'https://wavespestcontrol.com/';
const OWN_DOMAIN = 'wavespestcontrol.com';
const SPAM_MAX = 40;          // drop domains at/above this DataForSEO spam score
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
const todayTag = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

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

  // Domains we already have a link from — exclude (no point "prospecting" them).
  const ours = new Set((await db('seo_backlinks').select('source_domain')).map((r) => normDomain(r.source_domain)).filter(Boolean));
  ours.add(OWN_DOMAIN);

  // 1. aggregate referring domains across competitors
  const agg = new Map();
  for (const comp of competitors) {
    const resp = await dataforseo.getReferringDomains(comp, { limit: 1000 });
    const rows = items(resp);
    let kept = 0;
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
    console.log(`  ${comp}: ${rows.length} referring domains, ${kept} new candidates (running unique: ${agg.size})`);
  }

  let candidates = [...agg.values()].sort((x, y) => y.rank - x.rank);
  console.log(`[harvest] ${candidates.length} unique candidate domains after exclude-existing`);
  if (args.limit) { candidates = candidates.slice(0, args.limit); console.log(`[harvest] limited to ${candidates.length} for this run`); }

  // 2. bulk spam scores → drop spam/PBN
  const spam = new Map();
  for (let i = 0; i < candidates.length; i += 1000) {
    const chunk = candidates.slice(i, i + 1000).map((c) => c.domain);
    const resp = await dataforseo.bulkSpamScore(chunk);
    for (const it of items(resp)) spam.set(normDomain(it.target), Number(it.spam_score) || 0);
  }
  const preSpam = candidates.length;
  candidates = candidates.filter((c) => (spam.get(c.domain) ?? 0) < SPAM_MAX);
  console.log(`[harvest] dropped ${preSpam - candidates.length} spam/PBN (spam_score >= ${SPAM_MAX}); ${candidates.length} survive`);

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
    `   ${String(s.score).padStart(5)}  T${s.tier}  ${s.intent_class.padEnd(10)} ${s.candidate.domain}  → ${s.contact?.contact_email || s.contact?.contact_url || '(form)'}`));

  if (args.dryRun) { console.log('\n[harvest] DRY-RUN — no writes.'); return; }

  // 4. persist intel (one row per competitor↔domain) + promote survivors
  let intelWrites = 0, promoted = 0;
  for (const s of scored) {
    for (const comp of s.candidate.links_to_competitors) {
      const exists = await db('seo_competitor_backlinks').where({ competitor_domain: comp, source_domain: s.candidate.domain }).first();
      const row = {
        competitor_domain: comp, source_domain: s.candidate.domain, source_domain_rating: s.candidate.domain_rating,
        // referring_domains is domain-level — no specific URL — but source_url is
        // NOT NULL, so record the domain root as the source page.
        source_url: `https://${s.candidate.domain}/`,
        link_type: s.intent_class, waves_has_link: false, prospect_priority: s.priority, last_checked: new Date().toISOString().slice(0, 10),
      };
      if (exists) await db('seo_competitor_backlinks').where({ id: exists.id }).update({ ...row, updated_at: new Date() });
      else await db('seo_competitor_backlinks').insert({ ...row, first_seen: new Date().toISOString().slice(0, 10) });
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
    const isOutreachIntent = scorer.OUTREACH_INTENTS.has(s.intent_class) || s.gate.lane === 'haro_platform';
    // Demote only un-worked rows (status 'prospect') whose outreach claim fails:
    // no contact path, HARO platform, or a low composite — i.e. the national
    // directories. Never touch rows already in flight (contacted/placed/live/…).
    const demote = r.status === 'prospect' && isOutreachIntent && (!s.gate.ok || s.gate.lane === 'haro_platform' || s.score < 40);
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

    const patch = { score: s.score, tier: s.tier, quality_signals: JSON.stringify(qs), updated_at: new Date() };
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

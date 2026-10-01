/**
 * Backlink outreach drafter — the in-repo replacement for the (never-deployed)
 * external Hermes outreach skill. Claims outreach-type link prospects, drafts a
 * personalized 1:1 pitch with Claude, and parks it as a DRAFT (outreach_status=
 * 'drafted') for the operator's one-click approval in the Link Building UI.
 *
 * It NEVER sends — the approval-gated Gmail valve (link-prospect-outreach.js) plus
 * a human do that. It reuses the existing claim/report contract IN-PROCESS
 * (link-prospect-worker.js): no HTTP, no service token, no Hermes deployment.
 *
 * Gated by `outreachDrafter` (GATE_OUTREACH_DRAFTER) at the cron; run() itself is
 * the mechanism (the manual CLI runs it on demand). Drafting playbook adapted from
 * docs/hermes/waves-outreach-drafter-skill.md.
 */

const MODELS = require('../../config/models');
const logger = require('../logger');
const worker = require('./link-prospect-worker');
const { fetchPageText } = require('./contact-finder');
const { loadCitedPages, pageKey } = require('./cited-pages');
const { canonicalProspectDomain } = require('./prospect-domain-lock');
const entityCohort = require('../../data/aeo-entity-cohort-v1.json');
const { callAnthropic, rejectCall } = require('../llm/call');
const { etDateString, etParts } = require('../../utils/datetime-et');
const { ledgerCall, ledgerCallRejected } = require('../llm-dispatch-metrics');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const DRAFT_MODEL = process.env.MODEL_OUTREACH_DRAFTER || MODELS.WORKHORSE;

const SYSTEM_PROMPT = `You are the outreach drafter for Waves Pest Control (family-owned, SW Florida — Manatee/Sarasota/Charlotte counties). Write ONE short, personalized, one-to-one backlink-outreach email for a single prospect. A human reviews every draft before any send.

RULES (mandatory):
- One-to-one, never templated. Reference the specific site/page/audience by name. The email sends from the PRIMARY Waves inbox, so anything templated or spammy risks real-inbox reputation.
- Value-first and SHORT (~120–180 words). Lead with why it helps THEIR readers/clients, not us. Propose the given Waves money page (LINK TO EARN) as a genuine resource.
- Subject: specific, honest, non-spammy. No "RE:" tricks, no ALL CAPS, no clickbait.
- Identify clearly as Waves Pest Control. End EXACTLY with two lines: "— The Waves Pest Control Team" then "{brand} · {city}, FL · {phone}" using the SIGN-OFF DETAILS provided.
- No pricing, no incentives-for-links, no fabricated statistics. If you cite local pest data, attribute it to "Waves' Pest Pressure tracking" (a real local pest-activity dataset).
- Do NOT write a recipient address or a "From:" line — the portal handles those.

ANGLE by tier / link_type:
- Tier 1 (resource/editorial, local partners — realtors/brokerages, property & HOA management, home inspectors, complementary non-competing home services): wedge = WDO/termite inspections are transaction-critical for FL home sales; offer to be the reliable vendor for their "preferred vendors / resources" page. Mutual-referral framing for inspectors & complementary services.
- Tier 2 (editorial/haro, local media): offer a seasonal hook (spring termite swarm, summer mosquito + hurricane surge, fall rodents) backed by Waves' Pest Pressure local data as a citable resource for an upcoming piece.
- link_type resource: ask to be added to their resources/links/preferred-vendors page.
- link_type guest_post: offer one specific, genuinely useful local guest-article idea.

CITED-PAGE ANGLE — when the prompt has a CITED PAGE block, use this angle instead of the tier/link_type one:
- Their page is one that AI assistants (ChatGPT, Perplexity, Gemini, Claude, Google's AI answers) cite when people ask the question listed. Say so plainly and name the question in your own words: it is a real compliment and the reason you are writing.
- The ask: when they next update that page, consider adding Waves Pest Control for the city and service it covers. Give one or two reasons Waves fits, using ONLY the WAVES FACTS block (an editor can check the FDACS license number). Never invent reviews, ratings, awards, years in business or customer counts.
- Never claim Waves ranks anywhere, that an AI recommends Waves, or that adding Waves does anything for their page. No payment, no reciprocal link, no exclusivity.
- Offer to send anything they need to check (license lookup, service area, contact details).

Return ONLY JSON: {"subject": "...", "body": "..."}. The body is plain text with \\n line breaks and ends with the two-line signature.`;

// The ONE follow-up (plan §6.4): ten days of silence after the pitch. Shorter than the pitch, no new ask, the same
// mandate (no reciprocal promise, payment, discount, guarantee or commitment — the classifier and the owner read it).
const FOLLOW_UP_SYSTEM_PROMPT = `You are the outreach drafter for Waves Pest Control (family-owned, SW Florida). A while ago we sent the ONE-TO-ONE backlink-outreach email below and heard nothing — the SENT line says exactly when. Write ONE short, courteous follow-up (~50–90 words) in the SAME thread. A human reviews it before any send.

RULES (mandatory):
- Reply in the thread: the subject is "Re: " followed by the original subject, verbatim.
- One gentle nudge, no new ask, no pressure, no guilt. Restate the one useful thing in a sentence and offer to send anything that helps.
- Timing: refer to the earlier email loosely ("a little while ago", "recently", "last month") consistent with the SENT line — never state a number of days or weeks, and never a date the SENT line does not support.
- No pricing, no incentives-for-links, no "we'll link back", no discounts, no guarantees, no fabricated facts.
- Identify clearly as Waves Pest Control. End EXACTLY with two lines: "— The Waves Pest Control Team" then "{brand} · {city}, FL · {phone}" using the SIGN-OFF DETAILS provided.
- Do NOT write a recipient address or a "From:" line.

Return ONLY JSON: {"subject": "...", "body": "..."}. The body is plain text with \\n line breaks and ends with the two-line signature.`;

// the pitch's real send date for the follow-up prompt: the lease can run days or weeks after the ten-day mark (a
// batch cap, a dark drafter gate, provider downtime, drafting failures), so the model is told WHEN, never "ten days ago"
function sentLine(prospect, now = new Date()) {
  const sentAt = prospect.outreach_sent_at ? new Date(prospect.outreach_sent_at) : null;
  if (!sentAt || Number.isNaN(sentAt.getTime())) return '- sent: (date unknown — refer to it only as "a little while ago")';
  // ET CALENDAR days (the dates shown are ET dates): an elapsed-hours count reads 9 across the spring seam beside dates ten apart
  const etDay = (d) => { const p = etParts(d); return Date.UTC(p.year, p.month - 1, p.day) / 86400000; };
  const days = Math.max(0, Math.round(etDay(now) - etDay(sentAt)));
  return `- sent: ${etDateString(sentAt)} (${days} day${days === 1 ? '' : 's'} ago, as of ${etDateString(now)})`;
}

function buildFollowUpPrompt(prospect, profile, loc, now = new Date()) {
  const city = loc ? String(loc.name || '').replace(/,.*$/, '').trim() : 'Bradenton';
  return [
    'ORIGINAL EMAIL (sent, unanswered)',
    `- site: ${prospect.target_domain}`,
    sentLine(prospect, now),
    `- subject: ${prospect.outreach_subject || ''}`,
    '- body:',
    String(prospect.outreach_body || ''),
    '',
    'SIGN-OFF DETAILS (use verbatim):',
    `- brand: ${profile.brand}`,
    `- city: ${city}`,
    `- phone: ${loc ? loc.phone : ''}`,
  ].join('\n');
}

// through the shared Anthropic caller (services/llm/call.js): thinking-safe text read, loose-JSON parse, provider
// error normalization — the injected client keeps the drafter's per-site config and the test seam
async function draftFollowUp(prospect, { profile, anthropic }) {
  const loc = pickLocation(prospect, profile);
  const r = await callAnthropic({ laneId: 'outreach_drafter', model: DRAFT_MODEL, maxTokens: 800, system: FOLLOW_UP_SYSTEM_PROMPT, text: buildFollowUpPrompt(prospect, profile, loc), jsonMode: false, anthropicClient: anthropic });
  if (!r.ok) return null;
  const draft = parseDraft(r.text);
  if (!draft) rejectCall(r, 'invalid_json');
  return draft;
}

/**
 * The follow-up pass (§6.4): lease every due follow-up (worker.claim followUp), draft it in the pitch's thread, park it
 * as follow_up_status 'drafted' for the bridge's decision. A failure releases the lease back to due (retried next
 * run); nothing here sends. Returns { claimed, drafted, failed }.
 */
async function draftFollowUps({ batchSize, dryRun, client, profile }) {
  const claimed = await worker.claim({ n: batchSize, type: 'outreach', followUp: true, ...(dryRun ? { preview: true } : {}) });
  let drafted = 0, failed = 0;
  const samples = [];
  for (const p of claimed) {
    try {
      const draft = await draftFollowUp(p, { profile, anthropic: client });
      if (!draft) {
        if (!dryRun) await worker.report({ prospect_id: p.id, outcome: 'failed', lease_token: p.lease_token, notes: 'drafter produced no usable follow-up' }).catch(() => {});
        failed++; continue;
      }
      if (dryRun) { samples.push({ domain: p.target_domain, follow_up: true, to_email: p.outreach_to_email, subject: draft.subject, body: draft.body }); drafted++; continue; }
      const res = await worker.report({ prospect_id: p.id, outcome: 'drafted', lease_token: p.lease_token, outreach_subject: draft.subject, outreach_body: draft.body, notes: 'auto-drafted follow-up' });
      if (res && res.ok) drafted++; else { failed++; logger.warn(`[outreach-drafter] follow-up report rejected for ${p.target_domain}: ${res && res.code}`); }
    } catch (err) {
      logger.error(`[outreach-drafter] follow-up error on ${p.target_domain}: ${err.message}`);
      if (!dryRun) await worker.report({ prospect_id: p.id, outcome: 'failed', lease_token: p.lease_token, notes: `drafter error: ${String(err.message).slice(0, 160)}` }).catch(() => {});
      failed++;
    }
  }
  return { claimed: claimed.length, drafted, failed, samples };
}

// Pick the office location whose city the prospect targets (so the sign-off phone
// matches the market); else the default location.
function pickLocation(prospect, profile) {
  const hay = `${prospect.target_page || ''} ${prospect.notes || ''} ${prospect.target_domain || ''}`.toLowerCase();
  const locs = profile.locations || [];
  const byCity = locs.find((l) => {
    const city = String(l.name || '').toLowerCase().replace(/,.*$/, '').trim();
    return (city && hay.includes(city)) || (l.id && hay.includes(String(l.id).toLowerCase()));
  });
  return byCity || locs.find((l) => l.id === profile.default_location_id) || locs[0] || null;
}

function parseDraft(text) {
  if (!text) return null;
  const clean = String(text).replace(/```json|```/g, '').trim();
  const m = clean.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    // Both must be real strings that are non-blank after trimming: "   " used
    // to pass the truthiness check and park an empty draft as 'drafted', and
    // a number/object was String()-coerced into a meaningless one — the call
    // then read as a success on both legs (Codex r13 on #4884).
    const subject = o && typeof o.subject === 'string' ? o.subject.trim() : '';
    const body = o && typeof o.body === 'string' ? o.body.trim() : '';
    if (subject && body) return { subject, body };
  } catch { /* fall through */ }
  return null;
}

// The owner-approved entity answers (aeo-entity-cohort-v1.json) a cited-page
// pitch may state: license, footprint, services, ownership. Nothing else.
const WAVES_FACT_IDS = Object.freeze(['E3', 'E5', 'E6', 'E8']);
const WAVES_FACTS = Object.freeze(WAVES_FACT_IDS
  .map((id) => (entityCohort.questions.find((q) => q.id === id) || {}).approved_answer)
  .filter(Boolean));
// A cited page that already names Waves needs no pitch.
// fetchPageText decodes entities, so an encoded space reads as a space here.
const WAVES_LISTED_RE = /\bwaves\s+pest\s+control\b/i;
const MAX_CITED_QUESTIONS = 3;

/**
 * citedPagesByHost(pages) → Map host → ranked pages for that host, best first.
 * `pages` is cited-pages.js's ranked list (already ordered). Only a page that
 * is itself a provider list (`listPage`) AND was cited for a provider question
 * ("who should I hire") is kept: the angle asks to add Waves to a list, which
 * a cost guide or an informational page is not, whatever question cited it.
 */
function citedPagesByHost(pages) {
  const byHost = new Map();
  for (const p of pages || []) {
    if (!p.listPage || !(p.questions || []).some((q) => q.provider)) continue;
    const host = canonicalProspectDomain(p.host);
    if (!host) continue;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(p);
  }
  return byHost;
}

/**
 * citedPagesFor(prospect, byHost) → the cited pages to try, in order: the
 * prospect's own page first when an engine cites it, then the host's other
 * cited lists by rank (at most MAX_CITED_PAGES_TRIED). A subdomain prospect
 * matches only its own host.
 */
const MAX_CITED_PAGES_TRIED = 3;
function citedPagesFor(prospect, byHost) {
  const pages = (byHost && byHost.get(canonicalProspectDomain(prospect.target_domain))) || [];
  const own = prospect.target_url ? pageKey(prospect.target_url) : null;
  const first = own ? pages.filter((p) => p.key === own) : [];
  return [...first, ...pages.filter((p) => !first.includes(p))].slice(0, MAX_CITED_PAGES_TRIED);
}

/**
 * pickCitedPage(candidates, fetchPageFn) → { cited, page } for the first
 * readable candidate that does not already name Waves; otherwise a verdict
 * for the prospect: { fail } when any candidate could not be read (whether
 * Waves is on it is unknown — retry), else { skip } with every reason (each
 * already names Waves or moved). One article naming Waves never rules out
 * the publisher's other cited lists.
 */
async function pickCitedPage(candidates, fetchPageFn) {
  const fails = [];
  const skips = [];
  for (const cited of candidates) {
    let page = null;
    try { page = await fetchPageFn(cited.url, { withText: true }); } catch { page = null; }
    const verdict = citedPageVerdict(page, cited);
    if (!verdict) return { cited, page };
    (verdict.fail ? fails : skips).push(verdict.fail || verdict.skip);
  }
  return fails.length ? { verdict: { fail: fails.join('; ') } } : { verdict: { skip: skips.join('; ') } };
}

function citedPageBlock(cited) {
  if (!cited) return [];
  const questions = (cited.questions || []).slice(0, MAX_CITED_QUESTIONS)
    .map((q) => `  - "${q.query}" (${(q.engines || []).join(', ')})${q.miss ? ' — the current answer does not name Waves' : ''}`);
  return [
    '',
    "CITED PAGE (from Waves' daily answer-engine tracking — use the CITED-PAGE ANGLE)",
    `- their page: ${cited.url}`,
    '- AI assistants cite it when people ask:',
    ...questions,
    '',
    'WAVES FACTS (the only claims about Waves you may make):',
    ...WAVES_FACTS.map((f) => `- ${f}`),
  ];
}

function buildUserPrompt(prospect, profile, loc, page, cited = null) {
  const city = loc ? String(loc.name || '').replace(/,.*$/, '').trim() : 'Bradenton';
  return [
    'PROSPECT',
    `- site: ${prospect.target_domain}`,
    `- their page (if known): ${prospect.target_url || '(unknown)'}`,
    `- link_type: ${prospect.link_type} | tier: ${prospect.tier ?? '?'} | priority: ${prospect.priority || '?'}`,
    `- strategist notes: ${prospect.notes || '(none)'}`,
    prospect.anchor_planned ? `- suggested anchor: ${prospect.anchor_planned}` : '',
    page && (page.title || page.snippet) ? `- what their page actually says: ${[page.title, page.snippet].filter(Boolean).join(' — ').slice(0, 500)}` : '',
    ...citedPageBlock(cited),
    '',
    `LINK TO EARN (propose as the resource): ${prospect.target_page}`,
    '',
    'SIGN-OFF DETAILS (use verbatim):',
    `- brand: ${profile.brand}`,
    `- city: ${city}`,
    `- phone: ${loc ? loc.phone : ''}`,
    `- website: ${profile.website}`,
  ].filter(Boolean).join('\n');
}

/**
 * citedPageVerdict(page, cited) → null (pitch it) | { fail } | { skip }.
 * Unreadable, cut short, empty, title-only (a script-rendered shell) or a bot
 * challenge: whether Waves is on it cannot be known, so the lease fails and
 * retries. Redirected to a
 * different page (the article is gone, often to the homepage): skipped. A
 * page that already names Waves: skipped.
 */
// A body this short once the title is taken out is not the article. A bot
// challenge or "turn on JavaScript" interstitial is judged only on a SHORT
// body: a full article that merely mentions JavaScript (a contact-form note)
// is still the article. <noscript> text is already stripped by fetchPageText.
const MIN_ARTICLE_CHARS = 400;
const INTERSTITIAL_MAX_CHARS = 2000;
const UNREADABLE_PAGE_RE = /\b(verify you are (a )?human|just a moment\.\.\.|checking your browser|enable javascript|access denied|are you a robot|captcha)\b/i;

function readableArticle(page) {
  if (!page || typeof page.text !== 'string') return false;
  const body = (page.title ? page.text.split(page.title).join(' ') : page.text).trim();
  if (body.length < MIN_ARTICLE_CHARS) return false;
  return !(body.length < INTERSTITIAL_MAX_CHARS && UNREADABLE_PAGE_RE.test(body));
}

function citedPageVerdict(page, cited) {
  if (!readableArticle(page)) return { fail: `cited page could not be read in full: ${cited.url}` };
  if (page.finalUrl && pageKey(page.finalUrl) !== cited.key) return { skip: `cited page ${cited.url} now redirects to ${page.finalUrl}` };
  if (WAVES_LISTED_RE.test(page.text)) return { skip: `Waves already on the cited page ${cited.url}` };
  return null;
}

/**
 * draftOne → { subject, body, cited } | { skip: reason } | { fail: reason } |
 * null (no usable draft). With cited-page candidates, the first readable one
 * that does not already name Waves is the page read and pitched (pickCitedPage);
 * `cited` is that page, or null for the usual angle.
 */
async function draftOne(prospect, { profile, anthropic, fetchPageFn = fetchPageText, candidates = [] }) {
  let page = null;
  let cited = null;
  if (candidates.length) {
    const picked = await pickCitedPage(candidates, fetchPageFn);
    if (picked.verdict) return picked.verdict;
    ({ cited, page } = picked);
  } else {
    try { page = await fetchPageFn(prospect.target_url || `https://${prospect.target_domain}/`); } catch { page = null; }
  }
  const loc = pickLocation(prospect, profile);
  const resp = await ledgerCall('anthropic', DRAFT_MODEL, () => anthropic.messages.create({
    model: DRAFT_MODEL,
    max_tokens: 1200,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(prospect, profile, loc, page, cited) }],
  }), { laneId: 'outreach_drafter' });
  const text = (resp && resp.content ? resp.content : []).map((b) => b.text || '').join('');
  const draft = parseDraft(text);
  if (!draft) ledgerCallRejected(resp, 'invalid_json');
  return draft && { ...draft, cited };
}

/**
 * run — claim a batch of outreach prospects (email-bearing only), draft each, park
 * as 'drafted'. dryRun prints without writing. Returns { claimed, drafted, skipped, failed }
 * summed over BOTH lanes (the follow-up pass + the pitches — what the cron log and the
 * CLI print), with the follow-up pass itemized under `followUps`.
 */
/**
 * The cited-page ranking, by host, for this run's pitches. Never blocks a
 * run: a failed read drafts every pitch with its usual angle.
 */
async function loadCitedByHost(citedPagesFn) {
  try {
    const r = await citedPagesFn();
    return citedPagesByHost(r && r.pages);
  } catch (err) {
    logger.warn(`[outreach-drafter] cited pages unavailable — drafting without them: ${err.message}`);
    return new Map();
  }
}

const CITED_PAGES_LIMIT = 500;
function defaultCitedPages() {
  return loadCitedPages(require('../../models/db'), { limit: CITED_PAGES_LIMIT });
}

async function run({ batchSize = 10, dryRun = false, anthropic, fetchPageFn, citedPagesFn = defaultCitedPages } = {}) {
  let client = anthropic;
  if (!client && Anthropic && process.env.ANTHROPIC_API_KEY) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  if (!client) {
    logger.warn('[outreach-drafter] no Anthropic client/key — nothing drafted');
    return { claimed: 0, drafted: 0, skipped: 0, failed: 0, note: 'no_anthropic' };
  }

  // A dry run uses the READ-ONLY preview: a live claim settles its candidates
  // (repoints, draft clears, unclassify) before leasing, and none of that may
  // happen on a preview — nothing is leased, so nothing is released either.
  const profile = worker.businessProfile();
  // the follow-up pass first: due follow-ups are few and dated; a pitch batch never starves them. ONE budget for
  // both lanes — batchSize (the nightly's, the CLI's --limit) bounds the run's leases and model calls: pitches get
  // what the follow-ups left
  const followUps = await draftFollowUps({ batchSize, dryRun, client, profile });
  const remaining = Math.max(0, batchSize - followUps.claimed);
  const claimed = remaining ? await worker.claim({ n: remaining, type: 'outreach', requireContactEmail: true, ...(dryRun ? { preview: true } : {}) }) : [];
  if (!claimed.length) {
    logger.info(remaining ? '[outreach-drafter] no claimable outreach prospects with a contact email' : `[outreach-drafter] the batch of ${batchSize} went to follow-ups — no pitch claimed`);
    return totals(followUps, { claimed: 0, drafted: 0, skipped: 0, failed: 0, samples: [] }, dryRun);
  }
  const citedByHost = await loadCitedByHost(citedPagesFn);
  const pitches = await draftPitches({ claimed, dryRun, client, profile, fetchPageFn, citedByHost });
  // (a dry run previewed without leasing — there is nothing to release)
  logger.info(`[outreach-drafter] claimed=${claimed.length} drafted=${pitches.drafted} skipped=${pitches.skipped} failed=${pitches.failed} follow-ups=${followUps.drafted}/${followUps.claimed}${dryRun ? ' (DRY-RUN)' : ''}`);
  return totals(followUps, pitches, dryRun);
}

// the two lanes summed into the totals the cron log and the CLI print, the follow-up pass itemized
function totals(followUps, pitches, dryRun) {
  return {
    claimed: pitches.claimed + followUps.claimed, drafted: pitches.drafted + followUps.drafted, skipped: pitches.skipped, failed: pitches.failed + followUps.failed,
    followUps: { claimed: followUps.claimed, drafted: followUps.drafted, failed: followUps.failed },
    ...(dryRun ? { samples: [...followUps.samples, ...pitches.samples] } : {}),
  };
}

// One pitch, decided: { outcome: drafted | skipped | failed, notes, fields?, sample? }.
// Nothing here reports — draftPitches settles every outcome in one place.
async function pitchOne(p, { client, profile, fetchPageFn, citedByHost }) {
  const email = p.contact_email;
  // defensive — claim already required a contact_email
  if (!email || !worker.isValidEmail(email)) return { outcome: 'skipped', notes: 'no emailable contact' };
  let draft;
  try {
    draft = await draftOne(p, { profile, anthropic: client, fetchPageFn, candidates: citedPagesFor(p, citedByHost) });
  } catch (err) {
    logger.error(`[outreach-drafter] error on ${p.target_domain}: ${err.message}`);
    return { outcome: 'failed', notes: `drafter error: ${String(err.message).slice(0, 160)}` };
  }
  if (draft && draft.skip) return { outcome: 'skipped', notes: draft.skip, sample: { domain: p.target_domain, skipped: draft.skip } };
  if (!draft || draft.fail) return { outcome: 'failed', notes: (draft && draft.fail) || 'drafter produced no usable draft' };
  const { cited } = draft;
  return {
    outcome: 'drafted',
    notes: `auto-drafted (tier ${p.tier ?? '?'} ${p.link_type})${cited ? ` · cited page ${cited.url}` : ''}`,
    fields: { outreach_to_email: email, outreach_subject: draft.subject, outreach_body: draft.body },
    // dry-run preview — returned to the CLI's stdout, NOT logged (email/body are PII)
    sample: { domain: p.target_domain, tier: p.tier, link_type: p.link_type, to_email: email, cited_page: cited ? cited.url : null, subject: draft.subject, body: draft.body },
  };
}

// Report one decided pitch on its lease → the outcome that counts. A drafted
// report the worker rejects (or that throws) counts as failed.
async function settlePitch(p, r) {
  const base = { prospect_id: p.id, outcome: r.outcome, lease_token: p.lease_token, notes: r.notes, ...(r.fields || {}) };
  if (r.outcome !== 'drafted') {
    await worker.report(base).catch(() => {});
    return r.outcome;
  }
  try {
    const res = await worker.report(base);
    if (res && res.ok) return 'drafted';
    logger.warn(`[outreach-drafter] report rejected for ${p.target_domain}: ${res && res.code}`);
  } catch (err) {
    logger.error(`[outreach-drafter] error on ${p.target_domain}: ${err.message}`);
    await worker.report({ prospect_id: p.id, outcome: 'failed', lease_token: p.lease_token, notes: `drafter error: ${String(err.message).slice(0, 160)}` }).catch(() => {});
  }
  return 'failed';
}

// the pitch lane: one draft per leased prospect, reported drafted / failed / skipped on its lease
async function draftPitches({ claimed, dryRun, client, profile, fetchPageFn, citedByHost = new Map() }) {
  const counts = { drafted: 0, skipped: 0, failed: 0 };
  const samples = [];
  for (const p of claimed) {
    const r = await pitchOne(p, { client, profile, fetchPageFn, citedByHost });
    if (dryRun) {
      if (r.sample) samples.push(r.sample);
      if (r.outcome === 'drafted') logger.info(`[outreach-drafter][dry] drafted ${p.target_domain} (T${p.tier ?? '?'} ${p.link_type})`);
      counts[r.outcome] += 1;
      continue;
    }
    counts[await settlePitch(p, r)] += 1;
  }
  return { claimed: claimed.length, ...counts, samples };
}

module.exports = { run };
module.exports._internals = { citedPageVerdict, citedPagesByHost, citedPagesFor, pickCitedPage, citedPageBlock, WAVES_FACTS, WAVES_LISTED_RE, parseDraft, pickLocation, buildUserPrompt, draftOne, draftFollowUp, buildFollowUpPrompt, sentLine, SYSTEM_PROMPT, FOLLOW_UP_SYSTEM_PROMPT, DRAFT_MODEL };

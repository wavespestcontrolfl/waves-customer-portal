/**
 * business-name-confirmer.js — lists every home-service COMPANY a blog draft
 * names, links or references (owner rulings 2026-09-27 D2 + 2026-09-28: an
 * unattended competitor blog may name only the owner-approved competitors
 * in competitor-facts OWNER_APPROVED_AUTOPUBLISH_IDS).
 *
 * Why a model and not a detector: whether a phrase is a company ("Bug Out
 * competes with local providers", "Lawn Doctor" used both as a company and
 * as a generic term, a /hulett-alternatives/ slug) is a language judgement
 * no word list converges on (Codex r1–r3 on #5146). The comparison-table
 * gate keeps its deterministic curated / operator / link detection for the
 * named-competitor FLAG and the audit trail; this extraction only ADDS
 * names, which namedCompetitorListVerdict holds to the owner list.
 *
 * Called at the publisher's commit chokepoint (assertOwnerListForCommit,
 * below) and by Codex remediation on a fix. One structured FAST-tier call
 * per unattended blog commit (about ten a week), on the fastStructured
 * two-provider policy, lane
 * business_name_confirm. The input is every text field of the frontmatter
 * that ships (the publisher's own normalizer) plus the writer's raw
 * frontmatter and top-level metadata, the link destinations, and the body,
 * bounded to MAX_INPUT_CHARS.
 *
 * Result: { ok: true, key, companies: [canonical name…], checked_at } or
 * { ok: false, key, reason, retryable }. `key` hashes the exact input sent;
 * a stored result with the same key is returned without a call, so the
 * merge-time poller never re-calls and a Codex fix that leaves the text
 * unchanged reuses the run's extraction. Never throws.
 */

const crypto = require('node:crypto');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');
const competitorFacts = require('./competitor-facts');

// A supporting blog runs ~10–15k characters; anything past this bound is
// not a normal draft and is not truncated (a name past the cut would be
// unseen) — it fails closed instead.
const MAX_INPUT_CHARS = 60_000;
const CALL_TIMEOUT_MS = 30_000;
const PROMPT_VERSION = 'company-extraction-v3';

// Our OWN names, matched as exact whole names (case/punctuation-insensitive)
// — never "contains the word Waves" (pre-push r4: "Making Waves Pest
// Control" is somebody else). Sources: the company name, each GBP profile
// ("Waves Pest Control <location>", config/locations.js), and every fleet
// site's brand label + domain (content-astro/spoke-sites.js).
function normalizeOwnName(value) {
  return String(value || '').toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
    .replace(/^the\s+/, '').replace(/[^a-z0-9.]+/g, ' ').trim();
}
let OWN_NAMES = null;
function ownNames() {
  if (OWN_NAMES) return OWN_NAMES;
  const names = ['Waves', 'Waves Pest Control', 'Waves Pest Control, LLC'];
  try {
    for (const loc of require('../../config/locations').WAVES_LOCATIONS || []) {
      if (loc && loc.name) names.push(`Waves Pest Control ${loc.name}`);
    }
  } catch { /* locations unavailable — the fixed names still apply */ }
  try {
    for (const site of require('../content-astro/spoke-sites').SPOKE_SITES || []) {
      names.push(site.key);
      if (site.group !== 'Hub' && site.label) names.push(site.label);
    }
  } catch { /* fleet unavailable — the fixed names still apply */ }
  OWN_NAMES = new Set(names.map(normalizeOwnName).filter(Boolean));
  return OWN_NAMES;
}

const SYSTEM_PROMPT = [
  'You review a blog draft written for Waves Pest Control, a Florida pest control and lawn care company that also publishes under local site names such as "Sarasota Pest Control" and "Bradenton Lawn Care".',
  'List every pest control, lawn care, landscaping, termite, mosquito, wildlife, or other home-service COMPANY that the draft names, links to, or refers to — in the title, slug/URL, meta description, body, or link destinations.',
  'Include a company even when it is named only once, only in a link or URL slug, or only in a heading, and include it if ANY use in the draft refers to the company (a name used generically in one sentence and as a company in another is still a company).',
  'ALSO list any business of any kind — including a retailer (e.g. Home Depot, Lowe\'s, Amazon) or a product brand — that the draft PRESENTS as a provider, an alternative, or a comparison option (for example a column or row being compared, or "instead of hiring a company, use X").',
  'Do NOT list: Waves Pest Control or its own websites; a retailer or product brand mentioned only as a source or incidentally ("buy it at Home Depot", "a Bayer product"); universities, extension services, government bodies, and laws; publications and news outlets; generic service phrases or methods ("pest control", "Biological Pest Control", "Yard Mosquito Control").',
  'Return each company once, spelled as the draft spells it. Return an empty list when the draft names no such company.',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['companies'],
  properties: {
    companies: { type: 'array', items: { type: 'string' } },
  },
};

const LINK_RE = /https?:\/\/[^\s)"'<>\]]+/gi;

// Every string (and string inside an array or object) of a frontmatter
// value, as `path: value` lines. Dates / numbers / booleans are skipped.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?$/;
function textFields(value, path, out) {
  if (typeof value === 'string') {
    if (value.trim() && !ISO_DATE_RE.test(value.trim())) out.push(`${path}: ${value.trim()}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => textFields(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) textFields(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}

// The frontmatter that SHIPS: the publisher's own normalizer
// (astro-publisher normalizeAutonomousBlogFrontmatter — the whitelist
// publishOrUpdatePage commits, including brief-derived defaults such as
// primary_keyword from the brief's target keyword), so a field added there
// is scanned without touching this module. The writer's raw frontmatter and
// top-level metadata are scanned too (pre-push r7), since the two shapes can
// disagree. Normalizer unavailable → raw fields only, still every field.
function publishedFrontmatter(draft, brief) {
  const fm = draft?.frontmatter || {};
  try {
    const { _internals } = require('../content-astro/astro-publisher');
    const slug = String(fm.slug || draft?.url || '').replace(/^\/+|\/+$/g, '');
    return _internals.normalizeAutonomousBlogFrontmatter(fm, brief || {}, String(draft?.body || ''), { slug, canonical: fm.canonical });
  } catch (_) {
    return {};
  }
}

/**
 * extractionInput(draft, brief, { final }) → the exact text sent (null when
 * over the bound). `final: true` — draft.frontmatter IS the committed
 * frontmatter (the publisher's commit chokepoint), so it is scanned as-is
 * rather than re-normalized.
 */
function extractionInput(draft, brief = null, { final = false } = {}) {
  const body = String(draft?.body || draft?.content || '');
  const links = [...new Set(body.match(LINK_RE) || [])];
  const topLevel = {
    title: draft?.title, meta_description: draft?.meta_description, url: draft?.url, slug: draft?.slug,
    metaTitle: draft?.metaTitle, metaDescription: draft?.metaDescription,
  };
  const lines = [...new Set([
    ...(final ? [] : textFields(publishedFrontmatter(draft, brief), '', [])),
    ...textFields(draft?.frontmatter || {}, '', []),
    ...textFields(topLevel, '', []),
  ])];
  const text = [
    `FRONTMATTER AND METADATA:\n${lines.join('\n')}`,
    `LINK DESTINATIONS:\n${links.join('\n')}`,
    `BODY:\n${body}`,
  ].join('\n\n');
  return text.length > MAX_INPUT_CHARS ? null : text;
}

function inputKey(text) {
  return crypto.createHash('sha256').update(`${PROMPT_VERSION}\u0000${text}`).digest('hex');
}

// Canonical curated name when the extraction names a curated competitor
// (alias spellings like "Massey" → "Massey Services", legal-name variants
// like "Orkin, LLC" → "Orkin" via findCompetitor's suffix normalization, and
// possessive mentions like "Orkin's" or "Aptive’s" — Codex r11), else the
// name as written. Own-brand mentions ("Waves", "Waves'") are dropped.
function canonicalCompanies(names) {
  const out = new Set();
  for (const raw of names) {
    const nm = String(raw || '').trim();
    const base = nm.replace(/['’]s?$/i, '').trim();
    if (!nm || ownNames().has(normalizeOwnName(nm)) || ownNames().has(normalizeOwnName(base))) continue;
    const rec = competitorFacts.findCompetitor(nm) || (base && base !== nm ? competitorFacts.findCompetitor(base) : null);
    out.add(rec?.name || nm);
  }
  return [...out].sort();
}

/**
 * extractCompanyNames(draft, { prior }) — see the module header.
 * `retryable: true` marks provider / output failures (an outage should
 * delay the post); an over-long draft is `retryable: false`.
 */
async function extractCompanyNames(draft, { prior = null, brief = null, final = false } = {}) {
  const text = extractionInput(draft, brief, { final });
  if (text === null) return { ok: false, key: null, reason: 'draft_too_long_for_extraction', retryable: false };
  const key = inputKey(text);
  if (prior && prior.ok === true && prior.key === key && Array.isArray(prior.companies)) return prior;
  try {
    const result = await dispatchWithFallback(
      MODELS.TEXT_POLICIES.fastStructured,
      {
        laneId: 'business_name_confirm',
        maxTokens: 800,
        jsonMode: true,
        jsonSchema: RESPONSE_SCHEMA,
        timeoutMs: CALL_TIMEOUT_MS,
        system: SYSTEM_PROMPT,
        text,
      },
      {
        // Split the explicit CALL_TIMEOUT_MS across both legs (mirrors the
        // other bounded fallback callers, e.g. ask-waves-intake.js /
        // property-lookup-v2.js) — without this, a stalled primary can
        // consume the whole budget and leave the fallback
        // timeout_budget_exhausted for the exact outage it exists to survive
        // (#5146 r9).
        reserveFallbackBudget: true,
        validate: (r) => (Array.isArray(r?.json?.companies) && r.json.companies.every((c) => typeof c === 'string') ? null : 'missing_companies'),
      },
    );
    const companies = result?.json?.companies;
    if (!result?.ok || !Array.isArray(companies) || !companies.every((c) => typeof c === 'string')) {
      const reason = String(result?.reason || 'invalid_json').slice(0, 200);
      logger.warn(`[business-name-confirmer] extraction failed (${reason}) — draft deferred`);
      return { ok: false, key, reason, retryable: true };
    }
    return { ok: true, key, companies: canonicalCompanies(companies), checked_at: new Date().toISOString() };
  } catch (err) {
    logger.warn(`[business-name-confirmer] extraction threw (${err.message}) — draft deferred`);
    return { ok: false, key, reason: `threw:${String(err.message).slice(0, 180)}`, retryable: true };
  }
}

// The comparison gate over a draft: body + title/meta exactly as the gate
// reads them (the runner's draft-time evaluation), then every other
// frontmatter text field as its own document (Codex r10: joined into one
// text, unrelated fields read as one sentence — a slug's
// "orkin-alternatives" beside a meta description's "Worst roach problems"
// is not disparagement). Fields come from the SAME walk the company
// extraction uses (textFields), hero alt included (Codex r8). The byline
// blocks are the only exclusion: they come from the curated author registry
// (author-service), not from the writer or an image model, and a credential
// such as "FDACS Licensed Pest Control Operator" is business-shaped by
// construction.
function gateByField(gate, { frontmatter = {}, body = '', title, meta_description: metaDescription }, gateOptions) {
  const doc = {
    frontmatter, body, title: title ?? frontmatter.title, meta_description: metaDescription ?? frontmatter.meta_description,
  };
  const fieldTexts = [...new Set(textFields(frontmatter, '', [])
    .filter((line) => !/^(?:author|technically_reviewed_by)\./.test(line)
      && !/^(?:title|meta_description|metaTitle|metaDescription): /.test(line))
    .map((line) => line.replace(/^[^:]*: /, '')))];
  const evaluations = [doc, ...fieldTexts.map((text) => ({ frontmatter: {}, body: text }))]
    .map((d) => gate.evaluate(d, gateOptions));
  return {
    findings: evaluations.flatMap((e) => e.findings || []),
    namedCompetitors: [...new Set(evaluations.flatMap((e) => (Array.isArray(e.namedCompetitors) ? e.namedCompetitors : [])))].sort(),
  };
}

// One key per company when comparing two inventories: the curated record,
// else the case- and punctuation-insensitive name.
function companyKey(name) {
  const rec = competitorFacts.findCompetitor(name);
  return rec ? `curated:${rec.id}` : String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function ownerListError(code, message, fields) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, fields);
  return err;
}

/**
 * assertOwnerListForCommit({ draft, brief, frontmatter, body, humanApproved })
 * — the owner-list check at the ONE chokepoint every unattended blog commit
 * passes: astro-publisher publishOrUpdatePage / publishRefresh, right before
 * the branch is cut, on the FINAL frontmatter + body (after hero / body-image
 * alt text and every other publisher transform — Codex r5 on #5146).
 *
 * Deterministic names (comparison gate: curated, operator, link) + the
 * whole-draft company extraction on the final text, which alone judges the
 * other companies a draft names — a comparison-table column included
 * (Codex r10: a column-casing heuristic kept reading categories such as
 * "Local SWFL Company" as providers). A stored draft.company_extraction is
 * reused when the final text hashes to the same key. Competitor content commits only on the unattended
 * named-competitor lane (namedCompetitorAutopublishEligible) with every
 * name on the owner list. The result is left on the draft
 * (draft.company_extraction, draft.final_named_competitors,
 * draft.competitors_approved_by_list) for the
 * runner to persist with the verdict the merge-time poller judges.
 *
 * Throws (no commit):
 *   BLOG_OWNER_LIST_UNVERIFIED { retryable } — extraction failed / too long
 *   BLOG_OWNER_LIST_BLOCKED    { reason, offList } — off-list name, or
 *     competitor content outside the unattended lane
 * humanApproved: a human approved the DRAFT text, not text the publisher
 * adds afterward (hero/body-image alt and similar), so the final
 * comparison-gate scan always runs (#5146 r9). The operator-approval lane
 * (a stored `draft`) merges on its approved head with no second look, so
 * the company extraction runs on its final text too, and every company must
 * be one the approved draft itself names (its own gate scan + extraction,
 * compared company by company) or be on the owner list (#5146 r10, r12). The admin lane (publishAstro, no stored draft) skips the
 * extraction: an admin merges that PR by hand after reading the final text,
 * and the returned requiresHumanMerge stamps it so pages-poll never
 * auto-merges it.
 * humanMergeFallback (the scheduler's publishAstro): competitor content
 * naming only owner-list competitors returns { requiresHumanMerge: true } for the PR's
 * human-merge stamp instead of throwing. Returns { extraction,
 * requiresHumanMerge }.
 */
async function assertOwnerListForCommit({ draft, brief = {}, frontmatter = {}, body = '', humanApproved = false, humanMergeFallback = false } = {}) {
  const gate = require('./comparison-table-gate');
  const finalDraft = {
    frontmatter, body, title: frontmatter.title, meta_description: frontmatter.meta_description,
  };
  // The FULL comparison gate on the final text (Codex r7): publisher-added
  // text (a generated / reused image alt) can carry disparagement or an
  // unsourced competitor claim the draft-time gate never saw. Evaluated
  // exactly as the runner does — same feature flag, same operator-brief
  // authorization (the brief's own bucket) — so pre-existing authorized
  // prose still passes. The scheduler lane (humanMergeFallback) keeps
  // publishAstro's advisory treatment of COMPARISON_UNCLASSIFIED_OPTION.
  // Runs even when humanApproved — see the doc comment above (#5146 r9).
  let namedCompetitorEnabled = false;
  try { namedCompetitorEnabled = require('../../config/feature-gates').isEnabled('namedCompetitorComparison') === true; } catch (_) { namedCompetitorEnabled = false; }
  const { operatorBriefTextForComparisonGate } = require('./guardrail-options');
  const gateOptions = {
    namedCompetitorEnabled,
    operatorBriefText: operatorBriefTextForComparisonGate({ bucket: brief?.gsc_signal?.bucket }, brief),
  };
  const comparison = gateByField(gate, { frontmatter, body }, gateOptions);
  const blocking = (comparison.findings || []).filter((f) => (f.severity === 'P0' || f.severity === 'P1')
    && !(humanMergeFallback && f.code === 'COMPARISON_UNCLASSIFIED_OPTION'));
  if (blocking.length) {
    throw ownerListError('BLOG_OWNER_LIST_BLOCKED',
      `final text fails the comparison gate: ${blocking.map((f) => `${f.severity} ${f.code}`).join('; ')}`,
      { reason: 'comparison_table_failed', offList: [], findings: blocking });
  }
  // The admin lane skips the extraction because an admin merges its PR by
  // hand; requiresHumanMerge makes that enforced, not assumed: publishAstro
  // stamps astro_requires_human_merge, which pages-poll's auto-merge honors.
  if (humanApproved && !draft) return { extraction: null, requiresHumanMerge: true };
  // Through module.exports so a suite exercising the publisher can stub the
  // model call alone and keep this chokepoint's real decision logic.
  const extraction = await module.exports.extractCompanyNames(finalDraft, {
    prior: draft && draft.company_extraction, brief, final: true,
  });
  if (draft && typeof draft === 'object') draft.company_extraction = extraction;
  if (extraction.ok !== true) {
    throw ownerListError('BLOG_OWNER_LIST_UNVERIFIED',
      `company-name check unavailable for the final text (${extraction.reason || 'unknown'})`,
      { retryable: extraction.retryable === true, extraction });
  }
  const names = comparison.namedCompetitors;
  if (humanApproved) {
    // The operator approved the stored draft's own companies. Its inventory
    // comes from the same two sources as the final text's (the gate scan and
    // the company extraction), so a word the draft used generically ("bug
    // out and call a pro") never vouches for a company a publisher-added alt
    // introduces ("a Bug Out technician" — Codex r12). A company only
    // publisher-added text names must be on the owner list (#5146 r10).
    // Strictly the stored draft as approved (`final: true`: its own fields,
    // never the publisher's normalizer, whose brief-derived defaults such as
    // primary_keyword the operator never saw — Codex r13).
    const reviewedExtraction = await module.exports.extractCompanyNames(draft, {
      prior: draft.reviewed_company_extraction, brief, final: true,
    });
    if (reviewedExtraction.ok !== true) {
      throw ownerListError('BLOG_OWNER_LIST_UNVERIFIED',
        `company-name check unavailable for the approved draft (${reviewedExtraction.reason || 'unknown'})`,
        { retryable: reviewedExtraction.retryable === true, extraction: reviewedExtraction });
    }
    draft.reviewed_company_extraction = reviewedExtraction;
    const reviewed = new Set([
      ...gateByField(gate, {
        frontmatter: draft.frontmatter || {}, body: String(draft.body || draft.content || ''),
        title: draft.title, meta_description: draft.meta_description,
      }, gateOptions).namedCompetitors,
      ...reviewedExtraction.companies,
    ].map(companyKey));
    const unreviewed = [...new Set([...names, ...extraction.companies])]
      .filter((nm) => !reviewed.has(companyKey(nm)) && !competitorFacts.isOwnerApprovedForAutopublish(nm));
    if (unreviewed.length) {
      throw ownerListError('BLOG_OWNER_LIST_BLOCKED',
        `publisher-added text names company(ies) the operator never reviewed: ${unreviewed.join(', ')}`,
        { reason: 'unreviewed_company_name', offList: unreviewed, extraction });
    }
    return { extraction, requiresHumanMerge: false };
  }
  // The deterministic names of the FINAL text ride along too, so the
  // merge-time recheck (kill switch included) governs a run whose
  // publisher-added text named a competitor (pre-push r11).
  if (draft && typeof draft === 'object') draft.final_named_competitors = names;
  if (!names.length && !extraction.companies.length) return { extraction, requiresHumanMerge: false };
  const verdict = gate.namedCompetitorListVerdict({ namedCompetitors: names, companyExtraction: extraction });
  if (!gate.namedCompetitorAutopublishEligible(brief)) {
    // The scheduler lane (publishAstro) keeps its human-merge stamp for
    // competitor content naming only owner-list competitors; anything off the list is
    // refused like every other unattended commit.
    if (humanMergeFallback && verdict.ok) return { extraction, requiresHumanMerge: true };
    throw ownerListError('BLOG_OWNER_LIST_BLOCKED',
      verdict.ok
        ? `final text names ${[...names, ...extraction.companies].join(', ')} outside the unattended named-competitor lane`
        : `final text names competitor(s) outside the owner-approved list: ${(verdict.offList || []).join(', ')}`,
      verdict.ok
        ? { reason: brief.action_type === 'new_supporting_blog' ? 'named_competitor_disabled' : 'named_competitor_review', offList: [], extraction }
        : { reason: verdict.reason, offList: verdict.offList || [], extraction });
  }
  if (!verdict.ok) {
    throw ownerListError('BLOG_OWNER_LIST_BLOCKED',
      `final text names competitor(s) outside the owner-approved list: ${(verdict.offList || []).join(', ')}`,
      { reason: verdict.reason, offList: verdict.offList || [], extraction });
  }
  if (draft && typeof draft === 'object') draft.competitors_approved_by_list = verdict.approved;
  return { extraction, requiresHumanMerge: false };
}

module.exports = {
  extractCompanyNames,
  assertOwnerListForCommit,
  _internals: { SYSTEM_PROMPT, MAX_INPUT_CHARS, extractionInput, inputKey, canonicalCompanies, ownNames, normalizeOwnName, textFields },
};

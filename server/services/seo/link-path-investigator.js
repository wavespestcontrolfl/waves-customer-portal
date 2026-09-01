/**
 * Backlink Manager v2 — step 3: the path investigator (plan §5, §14 step 3).
 *
 * A job, not a chat: for each due registry domain, answer "Can Waves reproduce
 * a link here, and how?" and write one or more seo_link_acquisition_paths rows.
 *
 *   fetch  — contact-finder.fetchPage() ONLY (SSRF-pinned, byte-capped),
 *            ≤ MAX_FETCHES_PER_DOMAIN pages: hint URLs from the domain's
 *            provenance touches, competitor source pages, existing submission
 *            URLs, then the fixed §5 probe list.
 *   reason — ONE WORKHORSE-tier call through llm/call.js `dispatch` with the
 *            strict link-path-investigation-schema contract; ONE repair retry
 *            feeding the ajv errors back; a second failure records the error
 *            and leaves the domain `investigating` for a later sweep.
 *   derive — money fields are NEVER the model's: the currency gate demands
 *            authoritative USD evidence (a bare `$` is NOT proof — §5), then
 *            price-scan `parsePriceTextCents()` converts the verbatim quote to
 *            integer minor units. foreign/unknown ⇒ cents stay null (step 4
 *            turns those into OWNER_MANUAL_PAYMENT / a price-entry card).
 *   write  — per-domain transaction: path upsert on the active
 *            (domain_id, path_key) identity with §3.2 per-dimension revision
 *            bumps; explicit-predecessor supersession; best_path_id + score +
 *            agent_state (`qualified` / `not_reproducible` / `watching`).
 *
 * Behind GATE_LINK_INVESTIGATOR (gated ⇒ no fetches, no LLM, `gated: true`).
 * Batch-capped by LINK_INVESTIGATOR_BATCH (default 50). Nothing here sends,
 * pays, or leases work — it turns "known domain" into "acquisition inventory".
 */

const crypto = require('crypto');
const MODELS = require('../../config/models');
const { dispatch } = require('../llm/call');
const { isEnabled } = require('../../config/feature-gates');
const logger = require('../logger');
const { fetchPage } = require('./contact-finder');
const { canonicalProspectDomain } = require('./prospect-domain-lock');
const { parsePriceTextCents } = require('../price-scan/extract');
const { WAVES_CONTEXT } = require('./prospect-scorer');
const { validateInvestigation, INVESTIGATION_SCHEMA, URL_REQUIRED_ACQUISITION_TYPES } = require('./link-path-investigation-schema');
const registry = require('./link-registry');

const LOCK_KEY = 'link-path-investigator';
const defaultExclusive = (name, fn) => require('../../utils/cron-lock').runExclusive(name, fn, { recordHealth: false });

const DEFAULT_BATCH = 50;
// Hard per-run ceiling — every caller (cron, admin route, tests) is clamped
// to it inside investigatePaths, so no request shape can order thousands of
// fetches + model calls past the pay-per-domain guardrail.
const RUN_LIMIT_MAX = 500;
const batchSize = () => {
  const n = Number(process.env.LINK_INVESTIGATOR_BATCH);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), RUN_LIMIT_MAX) : DEFAULT_BATCH;
};

// §5 cost discipline: ~8 fetches + 1 LLM call per domain, plus a small
// reserved budget for legal-terms hashing (the candidate loop always exhausts
// the page cap, and a legal path without its terms hash is INVALID in §6.3).
const MAX_FETCHES_PER_DOMAIN = 8;
const TERMS_FETCH_BUDGET = 2;
// Bodyless existence checks for model-reported submission URLs that no
// fetched page corresponds to — a hallucinated or injected same-host URL
// must not become an executable path on the model's word alone.
const SUBMISSION_VERIFY_BUDGET = 3;
// A real agreement has substantive text; a client-rendered shell canonicalizes
// to (almost) nothing and must never produce a binding legal_terms_hash.
const MIN_TERMS_TEXT_CHARS = 200;
// A fetched page COVERS its URL (stamping/disproof) only with real canonical
// text — a script shell is existence, not observation.
const MIN_COVERAGE_TEXT_CHARS = 80;
const PAGE_EXCERPT_CHARS = 6000;
const REINVESTIGATE_AFTER_DAYS = 90;
const WATCH_RECHECK_DAYS = 30;
// Failure backoff: 6h · 12h · 24h · 48h · 96h, then the ceiling parks the
// domain as `watching` — a persistently failing domain never burns two model
// calls every hour and never crowds new domains out of the batch.
const INVESTIGATE_BACKOFF_BASE_MS = 6 * 60 * 60 * 1000;
const INVESTIGATE_BACKOFF_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_INVESTIGATE_FAILURES = 6;
const LLM_TIMEOUT_MS = 60000;

// §5 fixed probe list, tried in order after the evidence-bearing candidates.
// Only explicitly textual bodies are page text — for the model prompt,
// coverage/disproof, AND the legal-terms hash (fail-closed on no header).
const TEXTUAL_MIME_RE = /^\s*(text\/|application\/(xhtml\+xml|xml)\b)/i;

const PROBE_PATHS = Object.freeze([
  '/submit', '/add-listing', '/join', '/membership', '/members', '/vendors',
  '/sponsors', '/advertise', '/directory', '/resources', '/contact', '/signup', '/register',
]);

// Domain states the investigator may claim and finish (stamp a verdict on).
// acquiring/acquired/rejected belong to other lanes; their paths are still
// refreshed (§5 path-based selector) without touching the aggregate state.
const CLAIMABLE_STATES = Object.freeze(['new', 'investigating']);

// ---------------------------------------------------------------------------
// Currency gate (§5) — deterministic, evidence-only. Never the model's word.
// ---------------------------------------------------------------------------

const USD_MARKER_RE = /\bUSD\b|US\$/i;
// Confirmed non-USD markers: symbols and ISO codes. A bare `$` matches neither
// set and stays 'unknown' (Canadian/Australian merchants use the same symbol).
// The ISO set is broad and case-insensitive; codes that double as English
// words (TRY, ALL) are matched case-SENSITIVELY so ordinary copy ("try",
// "all plans") can never mark a quote foreign.
const FOREIGN_SYMBOL_RE = /€|£|¥|₹|₩|C\$|CA\$|A\$|AU\$|NZ\$|R\$/;
// The complete active ISO-4217 set (minus USD; HRK kept for legacy copy).
// Codes that are English words or names (ALL, BOB, COP, CUP, GEL, MAD, PEN,
// RON, SOS, TOP, TRY) live in the case-SENSITIVE regex below instead, so
// ordinary lowercase copy ("try", "all plans", "pen") can never mark a
// quote foreign.
const FOREIGN_ISO_RE = /\b(AED|AFN|AMD|ANG|AOA|ARS|AUD|AWG|AZN|BAM|BBD|BDT|BGN|BHD|BIF|BMD|BND|BRL|BSD|BTN|BWP|BYN|BZD|CAD|CDF|CHF|CLP|CNY|CRC|CVE|CZK|DJF|DKK|DOP|DZD|EGP|ERN|ETB|EUR|FJD|FKP|GBP|GHS|GIP|GMD|GNF|GTQ|GYD|HKD|HNL|HRK|HTG|HUF|IDR|ILS|INR|IQD|IRR|ISK|JMD|JOD|JPY|KES|KGS|KHR|KMF|KPW|KRW|KWD|KYD|KZT|LAK|LBP|LKR|LRD|LSL|LYD|MDL|MGA|MKD|MMK|MNT|MOP|MRU|MUR|MVR|MWK|MXN|MYR|MZN|NAD|NGN|NIO|NOK|NPR|NZD|OMR|PAB|PGK|PHP|PKR|PLN|PYG|QAR|RSD|RUB|RWF|SAR|SBD|SCR|SDG|SEK|SGD|SHP|SLE|SRD|SSP|STN|SVC|SYP|SZL|THB|TJS|TMT|TND|TTD|TWD|TZS|UAH|UGX|UYU|UZS|VES|VND|VUV|WST|XAF|XCD|XCG|XOF|XPF|YER|ZAR|ZMW|ZWG)\b/i;
const FOREIGN_AMBIGUOUS_ISO_RE = /\b(ALL|BOB|COP|CUP|GEL|MAD|PEN|RON|SOS|TOP|TRY)\b/; // case-sensitive on purpose — English words in lowercase copy
const isForeignMarker = (s) => FOREIGN_SYMBOL_RE.test(s) || FOREIGN_ISO_RE.test(s) || FOREIGN_AMBIGUOUS_ISO_RE.test(s);

/**
 * deriveCurrency({ price_text, renewal_price_text, currency_evidence })
 *   → 'USD' | 'foreign' | 'unknown'
 * USD requires an AUTHORITATIVE marker: USD/US$ in a verbatim quote, or a
 * model-observed priceCurrency/processor currency equal to USD. A foreign
 * marker anywhere wins over a USD claim only when the USD evidence is absent;
 * conflicting markers fail closed to 'unknown' (price-entry card, step 4).
 */
function deriveCurrency(path) {
  const quotes = [path.price_text, path.renewal_price_text].filter(Boolean).join(' ');
  const ev = path.currency_evidence;
  const evidenceMarker = ev && typeof ev.marker === 'string' ? ev.marker.trim() : '';
  const evidenceUsd = !!evidenceMarker && USD_MARKER_RE.test(evidenceMarker);
  const evidenceForeign = !!evidenceMarker && !evidenceUsd && isForeignMarker(evidenceMarker);
  const quoteUsd = USD_MARKER_RE.test(quotes);
  const quoteForeign = isForeignMarker(quotes);
  // ANY USD/foreign conflict fails closed FIRST — a foreign evidence marker
  // beside a USD-marked quote (or vice versa) must never pick a side.
  const anyUsd = evidenceUsd || quoteUsd;
  const anyForeign = evidenceForeign || quoteForeign;
  if (anyUsd && anyForeign) return 'unknown'; // conflicting — fail closed
  if (anyForeign) return 'foreign';
  if (anyUsd) return 'USD';
  return 'unknown';
}

const centsFor = (currency, text) => (currency === 'USD' ? parsePriceTextCents(text) : null);

// ---------------------------------------------------------------------------
// Candidate pages (§5): hint, competitor page, probe list — capped.
// ---------------------------------------------------------------------------

const looksLikeUrl = (s) => /^https?:\/\//i.test(String(s || '').trim());

/**
 * A URL is bound to the investigated registry domain when its canonical host
 * IS the domain or a subdomain of it. Everything the model reports and
 * everything this job fetches is held to this — model output is derived from
 * fetched (untrusted) pages, so an unbound URL would let page-level prompt
 * injection register an unrelated site as this row's executable path.
 */
function hostBound(host, url) {
  // Real URL parsing, never the textual canonicalizer: that one truncates at
  // the first colon, so `https://example.com:pw@evil.test/` would read as
  // example.com. Credentials and non-http(s) schemes are rejected outright.
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const h = canonicalProspectDomain(u.hostname);
  return !!h && (h === host || h.endsWith(`.${host}`));
}

/** URLs worth fetching for a domain, own-host only, deduped, uncapped (the fetch loop caps). */
function candidateUrls(host, { touches = [], competitorUrls = [], existingPaths = [], probeOffset = 0 } = {}) {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const s = String(raw || '').trim();
    if (!looksLikeUrl(s)) return;
    if (!hostBound(host, s)) return; // never fetch off-domain
    const key = registry.normalizeSubmissionUrl(s);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  // Existing paths come RIGHT after the homepage — a stale/never-investigated
  // path is often WHY the domain was selected, and a hint-rich domain must
  // not exhaust the fetch cap before that path's page is ever covered (an
  // uncovered path is neither stamped nor disproven and would re-select the
  // domain every sweep).
  push(`https://${host}`);
  for (const p of existingPaths) push(p.submission_url);
  for (const u of competitorUrls) push(u);
  // provenance details can be COMPOSITE ("paste:2026-09-01 https://…/apply",
  // CSV context + resolved URL) — extract every embedded URL rather than
  // requiring the whole string to be one
  for (const t of touches) {
    for (const m of String(t.source_detail || '').match(/https?:\/\/[^\s"'<>]+/g) || []) push(m);
  }
  // The probe list is longer than what the fetch cap leaves after the
  // homepage and hints, so it ROTATES by pass (the hourly sweep advances
  // the offset): the capped tail of one pass leads a later one instead of
  // the same prefix repeating forever.
  const n = PROBE_PATHS.length;
  for (let i = 0; i < n; i++) push(`https://${host}${PROBE_PATHS[(i + (probeOffset % n) + n) % n]}`);
  return out;
}

// ---------------------------------------------------------------------------
// Prompt + LLM (one WORKHORSE call, schema-as-contract, one repair retry)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `${WAVES_CONTEXT}

You are the backlink path investigator. Given fetched pages from ONE candidate website, decide whether Waves can reproduce a backlink there and HOW — as zero or more acquisition paths. Rules:
- Report only what the pages show. Quote price and renewal text VERBATIM (never compute or convert amounts; never emit a number for a price).
- currency_evidence is only an AUTHORITATIVE marker you actually observed (USD/US$ in the quote, JSON-LD priceCurrency, a payment processor's currency). A bare "$" is NOT evidence.
- "not_reproducible" is a good answer (an editorial mention with no submission route, a private partnership); use verdict "watching" when a real path exists but is closed today (applications closed, waitlist) and say why.
- replaces_path_id ONLY when you can see an existing path's submission URL is gone/redirected/renamed to a new one you are reporting.
- Answer every required field explicitly. Output ONLY the JSON object.`;

function buildPrompt({ host, pages, existingPaths, sources }) {
  const pagesBlock = pages.map((p, i) => `--- PAGE ${i + 1}: ${p.url} (status ${p.status})\n${p.excerpt}`).join('\n\n');
  const existing = existingPaths.length
    ? `Known paths for this domain (id · type · url — use an id in replaces_path_id only per the rule above):\n${existingPaths.map((p) => `${p.id} · ${p.acquisition_type} · ${p.submission_url || '-'}`).join('\n')}`
    : 'No paths are known for this domain yet.';
  const provenance = sources.length ? `Discovery provenance: ${sources.join(', ')}` : '';
  return `Candidate domain: ${host}
${provenance}
${existing}

Fetched pages:
${pagesBlock || '(no page could be fetched — judge from the domain and provenance alone, with low confidence)'}

OUTPUT CONTRACT — respond with ONE JSON object valid against this JSON Schema (no prose, no fences):
${JSON.stringify(INVESTIGATION_SCHEMA)}`;
}

/** One call + one repair retry. Returns { ok, data } | { ok:false, reason }. */
async function investigateWithModel(llmDispatch, prompt) {
  const route = { provider: MODELS.PROVIDER.ANTHROPIC, model: MODELS.WORKHORSE };
  const payload = { system: SYSTEM_PROMPT, jsonMode: true, maxTokens: 4096, temperature: 0, timeoutMs: LLM_TIMEOUT_MS };
  let res = await llmDispatch(route, { ...payload, text: prompt });
  let calls = 1;
  let check = res.ok && res.json ? validateInvestigation(res.json) : { valid: false, errors: [res.reason || 'no_json'] };
  if (!check.valid) {
    const repair = `${prompt}\n\nYour previous answer failed validation:\n${check.errors.slice(0, 20).join('\n')}\nReturn the corrected JSON object only.`;
    res = await llmDispatch(route, { ...payload, text: repair });
    calls += 1;
    check = res.ok && res.json ? validateInvestigation(res.json) : { valid: false, errors: [res.reason || 'no_json'] };
  }
  if (!check.valid) return { ok: false, reason: `llm_invalid: ${check.errors.slice(0, 5).join('; ')}`, calls };
  return { ok: true, data: res.json, calls };
}

// ---------------------------------------------------------------------------
// §3.2 per-dimension revision bumps — the input sets, verbatim from the plan.
// ---------------------------------------------------------------------------

const PAYMENT_INPUTS = Object.freeze(['estimated_cost_cents', 'renewal_cost_cents', 'renewal_period', 'currency', 'fee_scope', 'payment_required', 'legal_attestation', 'legal_terms_hash', 'merchant_binding']);
const COMMUNICATION_INPUTS = Object.freeze(['link_type', 'expected_rel', 'legal_attestation', 'legal_terms_hash', 'terms_accepted_by_send', 'execution_after_send']);
const EXECUTION_INPUTS = Object.freeze(['submission_url', 'account_required', 'email_verification', 'agent_completable', 'legal_attestation', 'legal_terms_hash', 'execution_after_send']);

// Key-order-stable stringify so a pg jsonb round trip never fakes a change.
const stableStringify = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
};
const normVal = (v) => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string' && (v[0] === '{' || v[0] === '[')) {
    try { return stableStringify(JSON.parse(v)); } catch { return v; }
  }
  if (typeof v === 'object') return stableStringify(v);
  return v;
};
const changedInputs = (existing, next, keys) => keys.some((k) => normVal(existing[k]) !== normVal(next[k]));

// ---------------------------------------------------------------------------
// Score + best path — DOCUMENTED PLACEHOLDERS until §8 Expected Link Value
// (step 7's D30 learning loop). Deterministic, explainable, no fake dollars.
// ---------------------------------------------------------------------------

const TYPE_WEIGHT = Object.freeze({
  self_service_free: 1.0,
  business_claim: 0.95,
  self_service_account: 0.9,
  resource_outreach: 0.85,
  editorial_outreach: 0.85,
  content_submission: 0.8,
  partnership: 0.8,
  vendor_registration: 0.75,
  membership: 0.6,
  association: 0.6,
  sponsorship: 0.5,
  paid_listing: 0.5,
});

const pathValue = (p) => {
  // A legal-attestation path with no captured terms hash is INVALID under
  // §6.3 — it must never outrank a lower-confidence VALID alternative.
  if (p.legal_attestation && !p.legal_terms_hash) return 0;
  const conf = Number(p.confidence);
  const c = Number.isFinite(conf) ? conf : 0;
  return c * (TYPE_WEIGHT[p.acquisition_type] || 0.3) * (p.payment_required ? 0.8 : 1);
};

/** 0–100 registry score + human-readable reasons from enrichment × best path confidence. */
function scoreDomain(domain, bestPath) {
  // nullish first — Number(null) is 0, which would score an unenriched
  // domain as DR 0 instead of taking the unknown-DR fallback
  const dr = domain.domain_rating != null && Number.isFinite(Number(domain.domain_rating)) ? Number(domain.domain_rating) : null;
  const spam = domain.spam_score != null && Number.isFinite(Number(domain.spam_score)) ? Number(domain.spam_score) : null;
  const linked = Number.isFinite(Number(domain.competitors_linked)) ? Number(domain.competitors_linked) : 0;
  const conf = bestPath ? Number(bestPath.confidence) || 0 : 0;
  const raw = 0.6 * (dr == null ? 20 : dr) + 0.2 * Math.min(100, linked * 10) + 20 * conf - 0.4 * (spam == null ? 0 : spam);
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const reasons = [
    dr == null ? 'DR unknown' : `DR ${dr}`,
    spam == null ? null : `spam ${spam}`,
    linked ? `${linked} competitors link here` : null,
    bestPath ? `best path ${bestPath.acquisition_type} @ ${conf.toFixed(2)}` : 'no reproducible path',
  ].filter(Boolean).join(' · ');
  return { score, reasons };
}

// ---------------------------------------------------------------------------
// Selection — §5 path-based, not only domain-based.
// ---------------------------------------------------------------------------

/**
 * selectTargets(db, { domainIds, limit, now }) → [{ domain, claimState }]
 *   claimState=true  ⇒ the investigator owns this domain's verdict
 *   claimState=false ⇒ path refresh only (never touches agent_state)
 * Order: owner_seed first, then (1) new/investigating, (2) watching due,
 * (3) domains with a never-investigated active path, (4) 90-day-stale paths.
 */
async function selectTargets(db, { domainIds = null, limit, now = new Date() } = {}) {
  if (Array.isArray(domainIds)) {
    if (!domainIds.length) return [];
    const rows = await db('seo_link_domains').whereIn('id', domainIds.slice(0, limit)).select('*');
    return (rows || []).map((domain) => ({ domain, claimState: CLAIMABLE_STATES.includes(domain.agent_state) || (domain.agent_state === 'watching') }));
  }
  const seen = new Set();
  const out = [];
  const take = (rows, claimState) => {
    for (const domain of rows || []) {
      if (out.length >= limit) return;
      if (seen.has(domain.id)) continue; // already ranked by an earlier bucket
      seen.add(domain.id);
      out.push({ domain, claimState });
    }
  };
  const seedFirst = (q) => q.orderByRaw("CASE WHEN discovery_priority = 'owner_seed' THEN 0 ELSE 1 END").orderBy('created_at', 'asc').limit(limit);
  const backoffDue = (col = 'investigate_after') => (b) => b.whereNull(col).orWhere(col, '<=', now);
  // Owner seeds jump the queue ACROSS the claim-state buckets (§5): both
  // pools are read, merged, and re-ranked before truncation — an owner-seed
  // domain due for its watch recheck is never starved by a full page of
  // normal `new` rows.
  const [fresh, watchingDue] = await Promise.all([
    seedFirst(db('seo_link_domains').whereIn('agent_state', CLAIMABLE_STATES).where(backoffDue()).select('*')),
    seedFirst(db('seo_link_domains').where('agent_state', 'watching').where('watch_recheck_at', '<=', now).where(backoffDue()).select('*')),
  ]);
  const claimPool = [...(fresh || []), ...(watchingDue || [])].sort((a, b) => {
    const seed = (d) => (d.discovery_priority === 'owner_seed' ? 0 : 1);
    return seed(a) - seed(b) || (new Date(a.created_at) - new Date(b.created_at));
  });
  const notSeen = (q) => ([...seen].length ? q.whereNotIn('d.id', [...seen]) : q);
  // Refresh buckets (path-based, §5): never-investigated active paths, then
  // 90-day-stale ones — always state-less, always deferrable, and bound by
  // owner actions (rejected never re-fetches; watching waits for its recheck).
  const refreshRows = (kind, { seedOnly = false } = {}) => {
    let q = notSeen(db('seo_link_domains as d')
      .join('seo_link_acquisition_paths as p', 'p.domain_id', 'd.id')
      .whereNull('p.superseded_by')
      .where(backoffDue('d.investigate_after'))
      .whereNotIn('d.agent_state', ['rejected'])
      .where((b) => b.whereNot('d.agent_state', 'watching').orWhere('d.watch_recheck_at', '<=', now)));
    if (kind === 'never') q = q.whereNull('p.last_investigated_at');
    else q = q.where('p.last_investigated_at', '<', new Date(now.getTime() - REINVESTIGATE_AFTER_DAYS * 24 * 60 * 60 * 1000));
    if (seedOnly) q = q.where('d.discovery_priority', 'owner_seed');
    q = q.groupBy('d.id').select('d.*');
    if (kind === 'never') q = q.orderByRaw("CASE WHEN d.discovery_priority = 'owner_seed' THEN 0 ELSE 1 END").orderBy('d.created_at', 'asc');
    else q = q.orderByRaw('MIN(p.last_investigated_at) asc');
    return q.limit(limit);
  };
  // Owner seeds jump the WHOLE queue (§5), refresh work included: seed
  // claims, then seed refreshes, then everything else — a seed with a due
  // path can never be starved behind a full page of ordinary new rows.
  take(claimPool.filter((d) => d.discovery_priority === 'owner_seed'), true);
  if (out.length < limit) take(await refreshRows('never', { seedOnly: true }), false);
  if (out.length < limit) take(await refreshRows('stale', { seedOnly: true }), false);
  take(claimPool, true); // seeds already taken; dedupe skips them
  if (out.length < limit) take(await refreshRows('never'), false);
  if (out.length < limit) take(await refreshRows('stale'), false);
  return out;
}

// ---------------------------------------------------------------------------
// Path row assembly + write
// ---------------------------------------------------------------------------

/** Model path + derived fields → the seo_link_acquisition_paths column set. */
function pathRowFrom(modelPath, { legalTermsHash, now, evidence }) {
  const currency = deriveCurrency(modelPath);
  // Cents exist only on paid paths — a free path with a quoted number nearby
  // (a different tier's price, injected copy) must never persist a cost.
  const paid = modelPath.payment_required === true;
  return {
    acquisition_type: modelPath.acquisition_type,
    submission_url: modelPath.submission_url || null,
    estimated_cost_cents: paid ? centsFor(currency, modelPath.price_text) : null,
    renewal_cost_cents: paid ? centsFor(currency, modelPath.renewal_price_text) : null,
    renewal_period: modelPath.renewal_period || null,
    currency,
    fee_scope: modelPath.payment_required ? modelPath.fee_scope : null,
    merchant_binding: modelPath.merchant_binding ? JSON.stringify(modelPath.merchant_binding) : null,
    account_required: modelPath.account_required,
    email_verification: modelPath.email_verification,
    payment_required: modelPath.payment_required,
    legal_attestation: modelPath.legal_attestation,
    legal_terms_hash: legalTermsHash || null,
    terms_accepted_by_send: modelPath.terms_accepted_by_send,
    execution_after_send: modelPath.execution_after_send,
    agent_completable: modelPath.agent_completable,
    baseline: false,
    expected_rel: modelPath.expected_rel,
    expected_indexability: modelPath.expected_indexability,
    expected_persistence: modelPath.expected_persistence,
    link_type: modelPath.link_type,
    confidence: modelPath.confidence,
    investigation: JSON.stringify(evidence),
    last_investigated_at: now,
    path_key: registry.pathKey(modelPath.acquisition_type, modelPath.submission_url),
    updated_at: now,
  };
}

/**
 * Upsert one investigated path inside the domain transaction. In-place update
 * bumps `revision` plus exactly the dimension revisions whose §3.2 input set
 * changed; a new key inserts constraint-agnostically against the partial
 * unique (domain_id, path_key) WHERE superseded_by IS NULL.
 * Returns the path row id.
 */
async function upsertPath(trx, domainId, row, { replacesPathId = null, now, preserveTermsHash = false }) {
  const existing = await trx('seo_link_acquisition_paths')
    .where({ domain_id: domainId, path_key: row.path_key }).whereNull('superseded_by').first('*');
  let id;
  if (existing) {
    // An INCONCLUSIVE terms pass (budget exhausted, failed/blocked fetch,
    // off-claim redirect, truncated/non-text/empty body) carries no verdict
    // on the agreement: the previously hashed text stands, so no erase and
    // no revision bump on its account.
    if (preserveTermsHash) row = { ...row, legal_terms_hash: existing.legal_terms_hash };
    const bump = {
      revision_payment: changedInputs(existing, row, PAYMENT_INPUTS),
      revision_communication: changedInputs(existing, row, COMMUNICATION_INPUTS),
      revision_execution: changedInputs(existing, row, EXECUTION_INPUTS),
    };
    const patch = { ...row };
    delete patch.path_key; // identity never changes in place
    if (bump.revision_payment) patch.revision_payment = Number(existing.revision_payment) + 1;
    if (bump.revision_communication) patch.revision_communication = Number(existing.revision_communication) + 1;
    if (bump.revision_execution) patch.revision_execution = Number(existing.revision_execution) + 1;
    if (bump.revision_payment || bump.revision_communication || bump.revision_execution) patch.revision = Number(existing.revision) + 1;
    await trx('seo_link_acquisition_paths').where({ id: existing.id }).update(patch);
    id = existing.id;
  } else {
    await trx('seo_link_acquisition_paths')
      .insert({ domain_id: domainId, ...row })
      .onConflict(trx.raw('(domain_id, path_key) WHERE superseded_by IS NULL')).ignore();
    const inserted = await trx('seo_link_acquisition_paths')
      .where({ domain_id: domainId, path_key: row.path_key }).whereNull('superseded_by').first('id');
    id = inserted && inserted.id;
  }
  // §3.2 supersession, step-3 minimal form (nothing executes yet — no
  // purchases, approvals or authority instances exist to pin or carry):
  // mark the matched predecessor superseded and repoint its placements.
  // Runs for BOTH branches — the replacement may already exist as an active
  // row (a re-investigation reporting the same successor again), and the
  // predecessor must still retire.
  if (id && replacesPathId && replacesPathId !== id) {
    const old = await trx('seo_link_acquisition_paths')
      .where({ id: replacesPathId, domain_id: domainId }).whereNull('superseded_by').first('id');
    if (old) {
      await trx('seo_link_acquisition_paths').where({ id: old.id }).update({ superseded_by: id, superseded_at: now, updated_at: now });
      await trx('seo_link_prospects').where({ path_id: old.id }).update({ path_id: id, updated_at: now });
    }
  }
  return id;
}

// ---------------------------------------------------------------------------
// Price-evidence verification — the model's quote is a CLAIM until the exact
// text is found on the fetched page it cites. An unverified quote or marker is
// treated as absent: currency stays 'unknown' (step 4's price-entry card),
// cents stay null, and the original claim + failure reason live in the
// evidence. A page-level prompt injection or hallucination can therefore
// never mint an authoritative-looking USD price.
// ---------------------------------------------------------------------------

const normQuote = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const findPage = (pages, pageUrl) => {
  if (!pageUrl) return null;
  const key = registry.normalizeSubmissionUrl(pageUrl);
  return pages.find((pg) => registry.normalizeSubmissionUrl(pg.url) === key) || null;
};
const quoteOnPage = (pages, pageUrl, quote) => {
  const page = findPage(pages, pageUrl);
  if (!page || !quote) return false;
  // Token-boundary containment, never a plain substring: the page's "USD 950"
  // must not verify a claimed "USD 95" (the truncated claim would mint the
  // wrong cents). The match may not sit inside a longer number: no digit
  // directly before it, and no digit (or decimal continuation) after it.
  // Search ONLY the model-visible excerpt: the quote is the model's
  // attestation of what it read, so text beyond the prompt cut must not
  // verify a claim the model never saw in context (a hallucinated price
  // could otherwise match unrelated copy deep in a long page).
  const t = normQuote(page.excerpt != null ? page.excerpt : page.text);
  const q = normQuote(quote);
  if (!q) return false;
  let idx = t.indexOf(q);
  while (idx !== -1) {
    const before = idx > 0 ? t[idx - 1] : '';
    const beforePrev = idx > 1 ? t[idx - 2] : '';
    const after = t[idx + q.length] || '';
    const afterNext = t[idx + q.length + 1] || '';
    // ALPHANUMERIC continuation on either side rejects the match — "USD 95k"
    // must not verify a claimed "USD 95" (the k multiplies) — and a
    // separator flanked by a digit continues the number the same way:
    // "USD 1,950" must not verify a claimed "950", nor "USD 95" a "USD 95.50"
    const contBefore = /[a-z0-9]/.test(before) || (/[.,]/.test(before) && /\d/.test(beforePrev));
    const contAfter = /[a-z0-9]/.test(after) || (/[.,]/.test(after) && /\d/.test(afterNext));
    // …and a digit-final quote followed by a spelled-out multiplier is the
    // same truncation: "USD 95 million" never verifies "USD 95"
    const multiplierNext = /\d$/.test(q) && /^\s+(k|m|mm|bn|hundred|thousand|million|billion)\b/.test(t.slice(idx + q.length));
    if (!contBefore && !contAfter && !multiplierNext) return true;
    idx = t.indexOf(q, idx + 1);
  }
  return false;
};

// A currency marker inside a verified quote must stand as a COMPLETE token —
// "95 USDT" never proves USD.
const markerInText = (text, marker) => {
  const esc = String(marker || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return !!esc && new RegExp(`(^|[^A-Za-z0-9])${esc}($|[^A-Za-z0-9])`).test(text);
};

/** Every {priceCurrency, priceCents} pair in a page's ld+json blocks. */
function jsonLdOffers(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    let data;
    try { data = JSON.parse(m[1]); } catch { continue; }
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node.priceCurrency != null) {
        const n = Number(node.price);
        out.push({ priceCurrency: String(node.priceCurrency), priceCents: Number.isFinite(n) ? Math.round(n * 100) : null });
      }
      Object.values(node).forEach(walk);
    };
    walk(data);
  }
  return out;
}

/**
 * verifyPriceEvidence(pages, modelPath) → { price_text, renewal_price_text,
 * currency_evidence, verification } — verified fields only; failures nulled.
 * Evidence kinds: 'quote' verifies against a verified quote's own text;
 * 'jsonld_price_currency' against the cited page's RAW html (canonicalize
 * strips <script>, so JSON-LD lives only there); 'processor_currency' is
 * unverifiable from a static fetch in step 3 and never proves anything here
 * (live-checkout observation is the runner's, step 5).
 */
function verifyPriceEvidence(pages, p) {
  const verification = {};
  const priceOk = quoteOnPage(pages, p.price_page_url, p.price_text);
  const renewalOk = quoteOnPage(pages, p.renewal_price_page_url, p.renewal_price_text);
  if (p.price_text) verification.price_text = priceOk ? 'verified' : 'not_on_fetched_page';
  if (p.renewal_price_text) verification.renewal_price_text = renewalOk ? 'verified' : 'not_on_fetched_page';
  let evidence = null;
  const ev = p.currency_evidence;
  if (ev && ev.marker) {
    if (ev.kind === 'quote') {
      const verifiedQuotes = [priceOk ? p.price_text : '', renewalOk ? p.renewal_price_text : ''].join(' ');
      if (markerInText(verifiedQuotes, ev.marker)) evidence = ev;
      else verification.currency_evidence = 'marker_not_in_verified_quote';
    } else if (ev.kind === 'jsonld_price_currency') {
      // The currency must come from the SAME structured offer as a VERIFIED
      // quoted amount: an unrelated USD offer elsewhere in the page must not
      // upgrade a bare-dollar quote in another currency. The model never
      // sees script bodies (canonicalize strips them), so it cannot attest
      // the association — it is bound deterministically here by matching the
      // offer's own price to the verified quote's digits.
      const page = findPage(pages, ev.page_url);
      const marker = String(ev.marker || '').replace(/[^A-Za-z$]/g, '');
      const verifiedCents = [priceOk ? parsePriceTextCents(p.price_text) : null, renewalOk ? parsePriceTextCents(p.renewal_price_text) : null]
        .filter((c) => c != null);
      const offerMatches = page && verifiedCents.length && jsonLdOffers(page.html)
        .some((o) => o.priceCurrency === marker && o.priceCents != null && verifiedCents.includes(o.priceCents));
      if (offerMatches) evidence = ev;
      else verification.currency_evidence = page ? 'jsonld_offer_not_bound_to_verified_quote' : 'jsonld_not_on_fetched_page';
    } else {
      verification.currency_evidence = 'processor_currency_unverifiable_static';
    }
    if (evidence) verification.currency_evidence = 'verified';
  }
  return {
    price_text: priceOk ? p.price_text : null,
    renewal_price_text: renewalOk ? p.renewal_price_text : null,
    currency_evidence: evidence,
    verification,
  };
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
/** §3.2 canonicalized agreement text: tags stripped, whitespace collapsed. */
function canonicalizeTerms(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A failed claim-state investigation defers the domain with exponential
 * backoff instead of leaving it first in line for the next hourly sweep; the
 * failure ceiling parks it as `watching` on the normal recheck cadence.
 * Best-effort — a defer that itself fails only costs backoff, never data.
 */
async function deferFailedDomain(db, domain, now, { claim = true } = {}) {
  try {
    const failures = (Number(domain.investigate_failures) || 0) + 1;
    const patch = { investigate_failures: failures, updated_at: now };
    if (claim && failures >= MAX_INVESTIGATE_FAILURES) {
      patch.agent_state = 'watching';
      patch.watch_recheck_at = new Date(now.getTime() + WATCH_RECHECK_DAYS * 24 * 60 * 60 * 1000);
      patch.investigate_after = null;
      patch.score_reasons = `parked: ${failures} consecutive investigation failures`;
    } else {
      // Refresh targets (lane-owned aggregate states) never get re-parked —
      // only deferred: the backoff caps at the max interval instead.
      patch.investigate_after = new Date(now.getTime() + Math.min(INVESTIGATE_BACKOFF_BASE_MS * 2 ** (failures - 1), INVESTIGATE_BACKOFF_MAX_MS));
    }
    // Compare-and-set on the state this run observed — a claim defers only
    // while `investigating` stands; a refresh defers only while the domain
    // still holds its lane-owned state. Never overwrite a newer state.
    await db('seo_link_domains').where({ id: domain.id, agent_state: claim ? 'investigating' : domain.agent_state }).update(patch);
  } catch (err) {
    logger.error(`[link-investigator] defer failed for ${domain.domain}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

/**
 * investigatePaths(db, { limit, dryRun, domainIds, now, fetchPage, llmDispatch, exclusive })
 *   → { dryRun, gated, selected, investigated, qualified, notReproducible,
 *       watching, pathRefreshes, pathsWritten, superseded, failed, fetches,
 *       llmCalls, skipped? }
 *
 * - gated: selection only; zero fetches, zero LLM calls, zero writes.
 * - dryRun: selection + would-fetch/would-call counts; zero writes.
 * - skipped: 'lease_held' when another run holds the session lock.
 */
async function investigatePaths(db, {
  limit = batchSize(), dryRun = false, domainIds = null, now = new Date(),
  fetchPage: fetcher = fetchPage, llmDispatch = dispatch, exclusive = defaultExclusive,
} = {}) {
  const gated = !isEnabled('linkInvestigator');
  limit = Math.max(1, Math.min(Math.floor(Number(limit) || 0) || batchSize(), RUN_LIMIT_MAX));
  const targets = await selectTargets(db, { domainIds, limit, now });
  const out = {
    dryRun, gated, selected: targets.length, investigated: 0, qualified: 0,
    notReproducible: 0, watching: 0, pathRefreshes: 0, pathsWritten: 0,
    superseded: 0, staleClaims: 0, failed: [], fetches: 0, llmCalls: 0,
  };
  if (gated || dryRun || !targets.length) {
    if (dryRun && !gated) {
      // MAXIMA, not typical counts: a live run can spend the candidate cap
      // PLUS the existence-probe and terms budgets per domain, and a schema
      // failure buys one repair retry per model call — an honest cost
      // preview must show the ceiling, not the happy path.
      out.wouldFetch = targets.length * (MAX_FETCHES_PER_DOMAIN + SUBMISSION_VERIFY_BUDGET + TERMS_FETCH_BUDGET);
      out.wouldCall = targets.length * 2;
    }
    return out;
  }

  const ran = await exclusive(LOCK_KEY, async () => {
    for (const { domain, claimState } of targets) {
      try {
        const host = canonicalProspectDomain(domain.domain);
        if (!host) { out.failed.push({ id: domain.id, domain: domain.domain, reason: 'invalid_host' }); continue; }

        // Claim: stamp `investigating` so the queue and UI show the domain in
        // flight (states 1–2 only; path refreshes never touch agent_state).
        // Compare-and-set against the SELECTED state — an admin reject/watch
        // or a lane move between selection and this statement wins, and the
        // claim is abandoned before any fetch is spent.
        if (claimState && domain.agent_state !== 'investigating') {
          const claimed = await db('seo_link_domains')
            .where({ id: domain.id, agent_state: domain.agent_state })
            .update({ agent_state: 'investigating', updated_at: now });
          if (!claimed) { out.staleClaims += 1; continue; }
        }

        const [touches, existingPaths, competitorRows] = await Promise.all([
          db('seo_link_domain_sources').where({ domain_id: domain.id }).select('source', 'source_detail', 'source_ref'),
          db('seo_link_acquisition_paths').where({ domain_id: domain.id }).whereNull('superseded_by').select('*'),
          db('seo_competitor_backlinks').whereIn('source_domain', [host, `www.${host}`]).limit(2).select('source_url'),
        ]);

        // Fetch phase — hardened fetcher only, capped, failures recorded.
        // Due paths rotate to the FRONT of the fetch order (never-covered
        // first, then oldest coverage): with more paths than the cap fits, the
        // path that stays uncovered this pass leads the next one instead of
        // the same capped prefix repeating forever.
        const orderedPaths = [...existingPaths].sort((a, b) => {
          const t = (x) => (x.last_investigated_at ? new Date(x.last_investigated_at).getTime() : 0);
          return t(a) - t(b);
        });
        const urls = candidateUrls(host, { touches, competitorUrls: (competitorRows || []).map((r) => r.source_url), existingPaths: orderedPaths, probeOffset: Math.floor(now.getTime() / (60 * 60 * 1000)) });
        const pages = [];
        const fetchErrors = [];
        const redirectMap = new Map(); // normalized requested URL → normalized final URL (supersession evidence)
        let cappedTail = false;
        for (const url of urls) {
          if (pages.length + fetchErrors.length >= MAX_FETCHES_PER_DOMAIN) { cappedTail = true; break; }
          out.fetches += 1;
          const page = await fetcher(url);
          const finalUrl = (page && page.finalUrl) || url;
          if (page && page.html && !page.blocked && !page.error && !TEXTUAL_MIME_RE.test(String(page.contentType || ''))) {
            // a binary 2xx body (PDF, image) decodes into `html` but is not
            // page text: it must never become model input, coverage, or
            // disproof — same textual-MIME rule the terms branch enforces
            fetchErrors.push({ url, reason: 'non_text_body' });
          } else if (page && page.html && !page.blocked && !page.error && hostBound(host, finalUrl)) {
            const text = canonicalizeTerms(page.html);
            redirectMap.set(registry.normalizeSubmissionUrl(url), registry.normalizeSubmissionUrl(finalUrl));
            // html/text stay only for THIS domain's evidence verification —
            // never persisted, never prompted beyond the excerpt. `truncated`
            // rides along: a byte-capped page is positive evidence but never
            // COVERAGE (the model didn't see past the cut).
            pages.push({ url: finalUrl, status: page.status, excerpt: text.slice(0, PAGE_EXCERPT_CHARS), text, html: page.html, truncated: !!page.truncated });
          } else if (page && page.html && !page.blocked && !page.error) {
            // the request was host-bound but a redirect left the domain —
            // an off-site page must never become model input or evidence
            fetchErrors.push({ url, reason: 'offsite_redirect' });
          } else {
            fetchErrors.push({ url, reason: (page && (page.error || (page.blocked && 'blocked'))) || `status_${page && page.status}` });
          }
        }

        // An evidence-less pass proves nothing: when every candidate fetch
        // failed (transient DNS, timeouts, blocks) — or every page that DID
        // load is a client-rendered shell whose canonical text is empty (the
        // model would receive no substantive content and could still return
        // a terminal verdict on the domain's NAME alone) — treat it as a
        // failed investigation (backoff applies) and spend no model call.
        if (!pages.some((pg) => pg.text.length >= MIN_COVERAGE_TEXT_CHARS)) {
          out.failed.push({ id: domain.id, domain: host, reason: pages.length ? 'no_substantive_page_evidence' : 'no_page_evidence' });
          await deferFailedDomain(db, domain, now, { claim: claimState });
          continue;
        }

        // Reason phase — one WORKHORSE call, one repair retry.
        const sources = [...new Set(touches.map((t) => t.source))];
        const prompt = buildPrompt({ host, pages, existingPaths, sources });
        const res = await investigateWithModel(llmDispatch, prompt);
        out.llmCalls += res.calls || 1;
        if (!res.ok) {
          out.failed.push({ id: domain.id, domain: host, reason: res.reason });
          await deferFailedDomain(db, domain, now, { claim: claimState }); // backoff, never an hourly re-spend
          continue;
        }
        const verdict = res.data;
        const validIds = new Set(existingPaths.map((p) => p.id));
        // Paths of type not_reproducible/unknown carry no executable identity —
        // they live in the evidence, never as rows (§6.3 marks them INVALID).
        // Model-reported URLs are BOUND to the investigated domain before
        // anything is fetched or persisted: the model read untrusted pages, so
        // an off-host submission/terms URL (prompt injection, hallucination)
        // is moved into the evidence and never becomes an executable target.
        // Belt for the schema's not_reproducible rule: that verdict asserts no
        // path exists, so nothing under it is ever written as a row.
        const writable = (verdict.verdict === 'not_reproducible' ? [] : (verdict.paths || []))
          .filter((p) => p.acquisition_type !== 'not_reproducible' && p.acquisition_type !== 'unknown')
          .map((p) => {
            const clean = { ...p, offhost: {} };
            for (const key of ['submission_url', 'legal_terms_url']) {
              if (clean[key] && !hostBound(host, clean[key])) {
                clean.offhost[key] = clean[key];
                clean[key] = null;
              }
            }
            // A stripped submission URL is a REJECTED claim, not a genuinely
            // URL-less outreach path — writing it would take the `${type}:-`
            // identity and could OVERWRITE (and zero) a legitimate URL-less
            // path of the same type. Deterministic rejections are therefore
            // DISCARDED entirely (the model's claim simply does not become a
            // row); the same holds for a site-executed type with no URL at
            // all (the schema demands one; this is the belt for drift).
            if (clean.offhost.submission_url) clean.rejectedClaim = 'offhost_submission_url';
            else if (!clean.submission_url && URL_REQUIRED_ACQUISITION_TYPES.includes(clean.acquisition_type)) clean.rejectedClaim = 'missing_submission_url';
            return clean;
          })
          .filter((p) => {
            if (!p.rejectedClaim) return true;
            logger.info(`[link-investigator] ${host}: discarded model path (${p.rejectedClaim}) ${JSON.stringify(p.offhost)}`);
            return false;
          });

        // A submission URL is EXECUTABLE only when this pass observed it: the
        // page was fetched, or a bodyless resolveOnly probe (own small
        // budget) confirms it exists on the domain. Anything else keeps its
        // claim in the evidence but writes with confidence 0 — never a best
        // path, never past a §6.3 floor — until a later pass verifies it.
        // Two different questions, two sets: EXISTENCE (any successful fetch,
        // truncated included, or a resolveOnly probe — enough to make a
        // submission URL executable) vs CONTENT COVERAGE (a complete,
        // untruncated page the model fully saw — the only basis for stamping
        // a path investigated or disproving an omitted one).
        const fetchedKeys = new Set(pages.map((pg) => registry.normalizeSubmissionUrl(pg.url)));
        // Coverage additionally requires SUBSTANTIVE canonical text — a
        // client-rendered script shell proves the URL exists but the model
        // observed nothing on it, so its omissions disprove nothing.
        // …and the model must have SEEN the whole page: the prompt carries at
        // most PAGE_EXCERPT_CHARS of canonical text, so a longer page is only
        // partially observed — existence, not coverage.
        const coverageKeys = new Set(pages
          .filter((pg) => !pg.truncated && pg.text.length >= MIN_COVERAGE_TEXT_CHARS && pg.text.length <= PAGE_EXCERPT_CHARS)
          .map((pg) => registry.normalizeSubmissionUrl(pg.url)));
        let verifyAttempts = 0;
        for (const p of writable) {
          if (!p.submission_url) continue; // outreach-shaped paths have no URL to verify
          const key = registry.normalizeSubmissionUrl(p.submission_url);
          if (fetchedKeys.has(key)) continue;
          if (verifyAttempts >= SUBMISSION_VERIFY_BUDGET) { p.submissionUnverified = 'verify_budget_exhausted'; continue; }
          verifyAttempts += 1;
          out.fetches += 1;
          const probe = await fetcher(p.submission_url, { resolveOnly: true });
          const finalUrl = (probe && probe.finalUrl) || p.submission_url;
          // The probe must land on the CLAIMED URL itself (scheme-insensitive
          // — http→https and trailing-slash redirects are the same page): a
          // hallucinated path that soft-redirects to the homepage or any
          // other same-host page proves nothing about the claimed one.
          const schemeless = (u) => registry.normalizeSubmissionUrl(u).replace(/^https?:\/\//, '');
          const landedOnClaim = schemeless(finalUrl) === schemeless(p.submission_url);
          if (probe && !probe.error && !probe.blocked && probe.status >= 200 && probe.status < 400 && hostBound(host, finalUrl) && landedOnClaim) {
            fetchedKeys.add(key);
          } else {
            p.submissionUnverified = (probe && (probe.error || (probe.blocked && 'blocked') || (!landedOnClaim && 'redirected_off_claim'))) || `status_${probe && probe.status}`;
          }
        }

        // Legal terms: fetch + hash (§3.2). Terms fetches have their OWN small
        // budget — the candidate loop always exhausts the page cap (homepage +
        // probes), and a legal_attestation path with no hash is INVALID under
        // §6.3, so sharing one budget would starve every legal path.
        const termsHashByUrl = new Map();
        const termsAttempted = new Set(); // the budget caps ATTEMPTS — a failed or off-site fetch spends it too
        for (const p of writable) {
          if (!p.legal_attestation || !p.legal_terms_url || termsAttempted.has(p.legal_terms_url)) continue;
          if (termsAttempted.size >= TERMS_FETCH_BUDGET) {
            // An UNATTEMPTED hash is not a verdict on the agreement: mark the
            // path so the write phase leaves it unstamped (rotated retry) and
            // preserves any previously valid hash, instead of erasing it and
            // parking the path INVALID for 90 days on a local budget limit.
            p.termsBudgetExhausted = true;
            continue;
          }
          termsAttempted.add(p.legal_terms_url);
          out.fetches += 1;
          const t = await fetcher(p.legal_terms_url);
          // same redirect rule as candidate pages: an agreement that redirects
          // off the registry domain is never hashed as this domain's terms —
          // and neither is a TRUNCATED body (600 KB cap / cut stream) nor an
          // EMPTY shell (a client-rendered page of scripts canonicalizes to
          // nothing): the hash binds legal acceptance (§3.2), so a partial or
          // absent agreement must stay unhashed (path stays INVALID under
          // §6.3 → owner-manual) rather than freeze a snapshot of nothing.
          // …and the fetch must LAND on the claimed agreement (scheme/slash
          // redirects of the same page aside): a terms URL that soft-redirects
          // to the homepage would otherwise hash an unrelated body as the
          // agreement and clear the §6.3 legal-validity gate.
          // …and the body must BE text: fetchPage decodes any payload through
          // .text(), so a PDF/image served at the terms URL would otherwise
          // canonicalize as >200 chars of gibberish and mint a valid-looking
          // hash with no agreement text behind it. Only explicitly textual
          // MIME types may bind acceptance (fail-closed on a missing header).
          const termsFinal = (t && t.finalUrl) || p.legal_terms_url;
          const schemelessTerms = (u) => registry.normalizeSubmissionUrl(u).replace(/^https?:\/\//, '');
          const textualTerms = TEXTUAL_MIME_RE.test(String((t && t.contentType) || ''));
          if (t && t.html && !t.blocked && !t.error && !t.truncated && textualTerms
              && hostBound(host, termsFinal) && schemelessTerms(termsFinal) === schemelessTerms(p.legal_terms_url)) {
            const termsText = canonicalizeTerms(t.html);
            if (termsText.length >= MIN_TERMS_TEXT_CHARS) termsHashByUrl.set(p.legal_terms_url, sha256(termsText));
          }
        }

        // Write phase — one transaction per domain. The network phase ran
        // outside any lock, so FIRST re-read the row under a row lock and
        // verify the claim still stands: an admin reject/watch or another
        // lane moving the domain during the fetch/model window OWNS the state
        // now — abort every mutation rather than overwrite it (the domain is
        // simply re-selected by a later sweep if it comes back).
        let staleClaim = false;
        let effectiveVerdict = verdict.verdict;
        const unstampedIds = new Set();
        let uncoveredEcho = false; // an existing path echoed without coverage was skipped
        let tailDeferred = false;
        // Counters stay TRANSACTION-LOCAL until commit — a rollback must not
        // report paths written or superseded that do not exist.
        let txWritten = 0;
        let txSuperseded = 0;
        await db.transaction(async (trx) => {
          const fresh = await trx('seo_link_domains').where({ id: domain.id }).forUpdate()
            .first('agent_state', 'domain_rating', 'spam_score', 'organic_traffic', 'competitors_linked');
          // Claims must still hold `investigating`; a REFRESH must still see
          // the lane state it selected — either way, a state that moved
          // during the un-locked network window owns the row now.
          const expected = claimState ? 'investigating' : domain.agent_state;
          if (!fresh || fresh.agent_state !== expected) { staleClaim = true; return; }
          const writtenIds = [];
          for (const p of writable) {
            // The model's price claims count only when the exact quote/marker
            // is found on the fetched page it cites; failures derive as if no
            // price was seen (currency 'unknown', cents null) and the claim +
            // reason are preserved in the evidence for the owner card.
            const verified = verifyPriceEvidence(pages, p);
            const evidence = {
              investigated_at: now.toISOString(),
              price_text: p.price_text, price_page_url: p.price_page_url,
              renewal_price_text: p.renewal_price_text, renewal_price_page_url: p.renewal_price_page_url,
              currency_evidence: p.currency_evidence, legal_terms_url: p.legal_terms_url,
              reasons: p.reasons, quotes: p.quotes,
              pages_fetched: pages.map((pg) => pg.url), fetch_errors: fetchErrors.map((f) => ({ url: f.url, reason: f.reason })),
              ...(Object.keys(verified.verification).length ? { price_verification: verified.verification } : {}),
              ...(p.submissionUnverified ? { submission_verification: p.submissionUnverified } : {}),
              ...(Object.keys(p.offhost).length ? { offhost_urls: p.offhost } : {}),
            };
            // Supersession needs DETERMINISTIC predecessor evidence, never the
            // model's word alone (the ids ride the prompt, and prompt content
            // is derived from untrusted pages): the predecessor's own URL must
            // have come back 404/410 this pass, or its fetch must have
            // redirected to the reported successor URL. Anything else keeps
            // both paths and records the rejected claim in the evidence.
            let replaces = null;
            if (p.replaces_path_id && validIds.has(p.replaces_path_id)) {
              const pred = existingPaths.find((e) => e.id === p.replaces_path_id);
              const predKey = pred && pred.submission_url ? registry.normalizeSubmissionUrl(pred.submission_url) : null;
              const gone = !!predKey && fetchErrors.some((f) => registry.normalizeSubmissionUrl(f.url) === predKey && /^status_(404|410)$/.test(f.reason));
              const redirectedTo = predKey ? redirectMap.get(predKey) : null;
              const redirected = !!redirectedTo && !!p.submission_url && redirectedTo === registry.normalizeSubmissionUrl(p.submission_url) && redirectedTo !== predKey;
              // A dead predecessor alone never repoints placements onto a
              // successor nobody observed: a URL-bearing successor must have
              // passed its own existence check this pass (a redirect INTO the
              // successor is itself that observation), or the claim waits.
              const successorObserved = !p.submission_url || !p.submissionUnverified;
              if ((gone && successorObserved) || redirected) {
                replaces = p.replaces_path_id;
                evidence.replaces_evidence = gone ? 'predecessor_url_gone' : 'predecessor_redirected_to_successor';
              } else {
                evidence.replaces_rejected = { id: p.replaces_path_id, reason: gone ? 'successor_unobserved' : 'no_deterministic_predecessor_evidence' };
              }
            }
            // ANY inconclusive terms outcome — budget exhausted (never
            // attempted), fetch failed/blocked, off-host or off-claim
            // redirect, truncated, non-text, empty shell — is not a verdict
            // on the agreement: the previously hashed text stands and the
            // path stays unstamped for a rotated retry. A hash is REPLACED
            // only by a successfully observed agreement's new hash.
            // …including a legal path whose terms URL the model OMITTED (or
            // that was stripped as off-host): no URL means no observation of
            // the agreement, never a mandate to erase the hash a prior pass
            // verified and re-stamp the path on nothing.
            const termsInconclusive = !!(p.legal_attestation && (!p.legal_terms_url || !termsHashByUrl.has(p.legal_terms_url)));
            if (termsInconclusive) {
              evidence.terms_verification = !p.legal_terms_url ? 'missing_terms_url'
                : p.termsBudgetExhausted ? 'terms_budget_exhausted' : 'terms_fetch_inconclusive';
            }
            const row = pathRowFrom({ ...p, ...verified }, { legalTermsHash: p.legal_terms_url ? termsHashByUrl.get(p.legal_terms_url) : null, now, evidence });
            if (termsInconclusive) {
              row.last_investigated_at = null;
              p.unstamped = true;
            }
            // Content coverage gates STAMPING and REPLACEMENT: a path whose
            // page the model never actually read (outside the fetch budget,
            // or existence-probed only) carries no new observation. An
            // EXISTING row echoed without coverage is skipped entirely — the
            // echo must not overwrite covered fields or hide the path from
            // the due-first rotation; a NEW uncovered path is written but
            // unstamped, so the next pass reads its page before it settles.
            const contentCovered = !p.submission_url || coverageKeys.has(registry.normalizeSubmissionUrl(p.submission_url));
            if (!contentCovered) {
              const echoKey = registry.pathKey(p.acquisition_type, p.submission_url);
              if (!replaces && existingPaths.some((e) => e.path_key === echoKey)) { uncoveredEcho = true; continue; }
              row.last_investigated_at = null;
              p.unstamped = true;
            }
            if (p.submissionUnverified) {
              row.confidence = 0; // exists only as a claim until a pass observes the URL
              // A TRANSIENT verification failure (probe error/status, budget
              // exhausted) is not a verdict on the claim: leave the row
              // unstamped so a later pass retries instead of hiding it for
              // 90 days. Deterministic rejections (off-host, missing URL for
              // a site-executed type) ARE verdicts and stamp normally.
              if (!['offhost_submission_url', 'missing_submission_url'].includes(p.submissionUnverified)) {
                row.last_investigated_at = null;
                p.unstamped = true;
              }
            }
            const id = await upsertPath(trx, domain.id, row, { replacesPathId: replaces, now, preserveTermsHash: termsInconclusive });
            if (id) {
              writtenIds.push(id);
              if (p.unstamped) unstampedIds.add(id);
              txWritten += 1;
              if (replaces) txSuperseded += 1;
            }
          }
          // Stamp last_investigated_at ONLY on paths this pass actually
          // covered: the ones it wrote, the ones whose submission URL was
          // among the fetched pages, and URL-less paths (fully represented by
          // the domain-level pass — there is no page of theirs to miss). A
          // path outside the fetch budget or whose page failed to load stays
          // eligible for a later pass instead of hiding for 90 days.
          const activeAll = await trx('seo_link_acquisition_paths')
            .where({ domain_id: domain.id }).whereNull('superseded_by').select('id', 'submission_url');
          const stampIds = new Set(writtenIds.filter((id) => !unstampedIds.has(id)));
          for (const ap of activeAll) {
            if (unstampedIds.has(ap.id)) continue; // transient verification failure — retryable next pass
            if (!ap.submission_url || coverageKeys.has(registry.normalizeSubmissionUrl(ap.submission_url))) stampIds.add(ap.id);
          }
          if (stampIds.size) {
            await trx('seo_link_acquisition_paths').whereIn('id', [...stampIds]).update({ last_investigated_at: now, updated_at: now });
          }

          // A re-investigation DISPROVES only what it actually COVERED: a
          // previously active, non-baseline path absent from this verdict is
          // invalidated (confidence 0 + the reason in its evidence) ONLY when
          // it was COVERED: its submission URL was among this pass's fetched
          // pages (the model saw that page and still did not report the
          // path), or it has no URL at all — a URL-less outreach path is
          // fully represented by the domain-level pass, exactly like the
          // stamping rule below, so a negative verdict retires it too. A
          // path outside fetch coverage (budget, fetch error) is preserved
          // untouched: absence of evidence never disproves it. Baselines are
          // descriptive and stay; superseded rows were handled. Path-level
          // truth is LANE-INDEPENDENT: the same rule applies on state-less
          // refreshes (a 90-day-stale path on an acquired domain whose page
          // no longer shows it must retire, not hide freshly stamped) —
          // only the aggregate agent_state below stays claim-owned.
          {
            const stale = (await trx('seo_link_acquisition_paths')
              .where({ domain_id: domain.id, baseline: false }).whereNull('superseded_by')
              .whereNotIn('id', writtenIds.length ? writtenIds : ['00000000-0000-0000-0000-000000000000'])
              .select('id', 'investigation', 'submission_url'))
              .filter((s) => !s.submission_url || coverageKeys.has(registry.normalizeSubmissionUrl(s.submission_url)));
            for (const s of stale) {
              const prior = typeof s.investigation === 'string' ? (() => { try { return JSON.parse(s.investigation); } catch { return {}; } })() : (s.investigation || {});
              await trx('seo_link_acquisition_paths').where({ id: s.id }).update({
                confidence: 0,
                investigation: JSON.stringify({ ...prior, disproven_at: now.toISOString(), disproven_reason: `re-investigation verdict '${verdict.verdict}' did not reproduce this path` }),
                updated_at: now,
              });
            }
          }

          // Finish the domain: best path, score, verdict. Zero-value paths
          // (disproven, or confidence 0) never become the best path.
          const active = await trx('seo_link_acquisition_paths').where({ domain_id: domain.id }).whereNull('superseded_by').where({ baseline: false }).select('*');
          const ranked = active.map((p) => ({ p, v: pathValue(p) })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
          const best = ranked.length ? ranked[0].p : null;
          // Score from the LOCKED row — a concurrent enrichment (the Sunday
          // feeders can still be running at :20) must not leave a freshly
          // qualified domain scored on superseded quality inputs.
          const { score, reasons } = scoreDomain({ ...domain, ...fresh }, best);
          // qualified/not_reproducible are INVESTIGATOR-owned aggregates: a
          // refresh that disproves a qualified domain's last path, or finds a
          // real one on a not_reproducible domain, re-decides them like a
          // claim run. Only ready_to_acquire/acquiring/acquired (and admin
          // watch/reject) stay lane-/owner-owned.
          const decideState = claimState || ['qualified', 'not_reproducible'].includes(domain.agent_state);
          const watchNote = decideState && verdict.verdict === 'watching' && verdict.watch_reason ? ` · watching: ${verdict.watch_reason}` : '';
          // A pass that left paths unverified (unstamped writes, or an
          // uncovered echo it skipped) succeeded but did NOT settle the
          // domain: back its re-selection off instead of letting the
          // never-stamped path re-select it on every hourly sweep and
          // re-spend a model call each time.
          const unsettled = unstampedIds.size > 0 || uncoveredEcho;
          const patch = { best_path_id: best ? best.id : null, score, score_reasons: `${reasons}${watchNote}`, updated_at: now, investigate_failures: 0, investigate_after: unsettled ? new Date(now.getTime() + INVESTIGATE_BACKOFF_BASE_MS) : null };
          if (decideState) {
            // Defensive downgrades, both directions: a qualified verdict with
            // no executable best path parks `watching` (never a qualified
            // domain nothing can act on), and a TERMINAL not_reproducible
            // with a positive-value path still standing (an uncovered path
            // this pass could not disprove) also parks `watching` — the
            // domain is not closed until every active path has been covered,
            // and the due-first fetch rotation covers it next pass.
            effectiveVerdict = verdict.verdict;
            let downgradeNote = null;
            if (verdict.verdict === 'qualified' && !best) { effectiveVerdict = 'watching'; downgradeNote = 'qualified verdict carried no executable path'; }
            if (verdict.verdict === 'not_reproducible' && best) { effectiveVerdict = 'watching'; downgradeNote = 'terminal verdict deferred: an uncovered active path remains'; }
            // A TERMINAL close is also deferred — ONCE — while the fetch cap
            // left candidate URLs unfetched: the route may live on a page
            // this pass never requested, and the rotated probe offset covers
            // the tail on the deferred re-pass. The stored downgrade note is
            // the bound: a domain already deferred for its tail closes on
            // the next terminal verdict instead of parking forever.
            const alreadyTailDeferred = /unfetched candidate URLs remain/.test(String(domain.score_reasons || ''));
            if (verdict.verdict === 'not_reproducible' && !best && cappedTail && !alreadyTailDeferred) { effectiveVerdict = 'watching'; downgradeNote = 'terminal verdict deferred: unfetched candidate URLs remain'; tailDeferred = true; }
            patch.agent_state = effectiveVerdict === 'qualified' ? 'qualified' : effectiveVerdict === 'watching' ? 'watching' : 'not_reproducible';
            // A downgrade caused by TRANSIENT verification (an unstamped
            // path — failed probe, inconclusive terms, exhausted budget)
            // rechecks on the failure-backoff horizon, not the 30-day watch
            // cadence: the advertised rotated retry must actually be near.
            const transientDowngrade = downgradeNote && (unstampedIds.size > 0 || tailDeferred);
            patch.watch_recheck_at = effectiveVerdict === 'watching'
              ? new Date(now.getTime() + (transientDowngrade ? INVESTIGATE_BACKOFF_BASE_MS : WATCH_RECHECK_DAYS * 24 * 60 * 60 * 1000))
              : null;
            if (downgradeNote) patch.score_reasons = `${patch.score_reasons} · downgraded: ${downgradeNote}`;
          }
          await trx('seo_link_domains').where({ id: domain.id }).update(patch);
        });
        if (staleClaim) {
          out.staleClaims += 1;
          continue;
        }
        out.pathsWritten += txWritten;
        out.superseded += txSuperseded;

        out.investigated += 1;
        if (!claimState) out.pathRefreshes += 1;
        else if (effectiveVerdict === 'qualified') out.qualified += 1;
        else if (effectiveVerdict === 'watching') out.watching += 1;
        else out.notReproducible += 1;
      } catch (err) {
        logger.error(`[link-investigator] ${domain.domain}: ${err.message}`);
        out.failed.push({ id: domain.id, domain: domain.domain, reason: `error: ${err.message}` });
        await deferFailedDomain(db, domain, now, { claim: claimState });
      }
    }
    return out;
  });
  if (ran && ran.skipped) return { ...out, skipped: ran.reason || true };
  return out;
}

module.exports = {
  investigatePaths,
  LOCK_KEY,
  PROBE_PATHS,
  MAX_FETCHES_PER_DOMAIN,
  TERMS_FETCH_BUDGET,
  SUBMISSION_VERIFY_BUDGET,
  _internals: {
    deriveCurrency, centsFor, candidateUrls, hostBound, verifyPriceEvidence, buildPrompt, investigateWithModel,
    selectTargets, pathRowFrom, upsertPath, changedInputs, scoreDomain, pathValue,
    canonicalizeTerms, batchSize, SYSTEM_PROMPT, TYPE_WEIGHT,
    deferFailedDomain, MAX_INVESTIGATE_FAILURES, INVESTIGATE_BACKOFF_BASE_MS,
    PAYMENT_INPUTS, COMMUNICATION_INPUTS, EXECUTION_INPUTS, CLAIMABLE_STATES,
  },
};

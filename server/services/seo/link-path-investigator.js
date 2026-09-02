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
const psl = require('psl');
const MODELS = require('../../config/models');
const { dispatch } = require('../llm/call');
const { isEnabled } = require('../../config/feature-gates');
const logger = require('../logger');
const { fetchPage } = require('./contact-finder');
const { canonicalProspectDomain } = require('./prospect-domain-lock');
const { parsePriceTextCents, collectJsonLdOffers } = require('../price-scan/extract');
const { WAVES_CONTEXT } = require('./prospect-scorer');
const { validateInvestigation, INVESTIGATION_SCHEMA, URL_REQUIRED_ACQUISITION_TYPES, MAX_MODEL_PATHS } = require('./link-path-investigation-schema');
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
// ONE backoff curve for every retryable non-verdict — fetch/model failures
// and stalled (no-progress) probe passes alike.
const failureBackoffMs = (failures) => Math.min(INVESTIGATE_BACKOFF_BASE_MS * 2 ** (Math.max(1, failures) - 1), INVESTIGATE_BACKOFF_MAX_MS);
const LLM_TIMEOUT_MS = 60000;

// §5 fixed probe list, tried in order after the evidence-bearing candidates.
// Only explicitly textual bodies are page text — for the model prompt,
// coverage/disproof, AND the legal-terms hash (fail-closed on no header).
const TEXTUAL_MIME_RE = /^\s*(text\/|application\/(xhtml\+xml|xml)\b)/i;

const PROBE_PATHS = Object.freeze([
  '/submit', '/add-listing', '/join', '/membership', '/members', '/vendors',
  '/sponsors', '/advertise', '/directory', '/resources', '/contact', '/signup', '/register',
]);
const FULL_PROBE_MASK = (1 << PROBE_PATHS.length) - 1; // one coverage bit per probe

// Attempt outcomes that mean the executed flow DIVERGED from what the
// investigation described — the path re-investigates promptly (plan: a
// failed attempt triggers re-investigation, not a 90-day wait).
const FAILED_ATTEMPT_OUTCOMES = Object.freeze(['failed', 'blocked', 'captcha', 'price_changed', 'terms_changed', 'send_error']);
const PROBE_SLOT_RESERVE = 2; // fetch slots per pass that hints can never take from uncovered probes

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
const FOREIGN_SYMBOL_RE = /€|£|¥|₹|₩|₽|₺|₱|₪|฿|₴|₦|₨|₫|₭|₮|₲|₡|₵|₾|₸|₼|֏|﷼|C\$|CA\$|A\$|AU\$|NZ\$|R\$/;
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

// Price-text vocabulary (matched case-insensitively / on lowercased text): a
// currency marker that may repeat on a range's upper bound, and a cadence
// suffix that may follow an amount ("/year", "per year", "a month", "each
// year", "annually") — before a range separator OR a minimum-price "+".
const CURRENCY_MARKERS = '(?:usd|us\\$|ca\\$|au\\$|nz\\$|r\\$|[$€£¥₹₱₽₺₪฿])';
const CADENCE_SUFFIX = '(?:\\s*\\/\\s*[a-z]+|\\s+per\\s+[a-z]+|\\s+(?:a|an|each|every)\\s+[a-z]+|\\s+(?:annually|yearly|monthly|weekly|daily|quarterly|annual|year|yr|month|mo|week|day))?';
const MINIMUM_WORDS = '(?:and up|or more|and above|and over|or higher|and higher|minimum|at least)\\b|min\\.';
// A MINIMUM-price quote ("USD 95+", "USD 95/year +", "USD 95 per year+",
// "USD 95 and up", "minimum USD 95") is not an exact price: the charge may
// be higher, so it never derives cents — the price parser sees one numeric
// token and would otherwise accept it.
const MIN_PRICE_QUOTE_RE = new RegExp(`\\d${CADENCE_SUFFIX}\\s*\\+|\\b${MINIMUM_WORDS}`, 'i');
const centsFor = (currency, text) => (currency === 'USD' && !MIN_PRICE_QUOTE_RE.test(String(text || '')) ? parsePriceTextCents(text) : null);

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
  if (!h) return false;
  if (h === host) return true;
  // Subdomains bind ONLY under a REGISTRABLE host: a registry row whose
  // name is a public suffix (co.uk, github.io — intake admits dotted
  // suffixes) would otherwise claim every unrelated organization beneath
  // it, and a page or model response could register another company's
  // site as this row's executable path. psl (already a dependency) is the
  // authority; an unlisted/invalid host binds on exact match only.
  return !!psl.get(host) && h.endsWith(`.${host}`);
}

/** URLs worth fetching for a domain, own-host only, deduped, uncapped (the fetch loop caps). */
/** The pages a URL-less path's evidence was read from — the only pages a refresh can re-read to confirm or disprove it. */
function evidencePagesOf(path) {
  let inv = path && path.investigation;
  try { inv = typeof inv === 'string' ? JSON.parse(inv) : (inv || {}); } catch { inv = {}; }
  return Array.isArray(inv.pages_fetched) ? inv.pages_fetched.filter((u) => typeof u === 'string') : [];
}

/** Every URL embedded in a provenance touch's detail (host-boundness is enforced by the caller). */
const touchUrls = (t) => String((t && t.source_detail) || '').match(/https?:\/\/[^\s"'<>]+/g) || [];

function candidateUrls(host, { touches = [], competitorUrls = [], existingPaths = [], probeOffset = 0, probeMask = 0 } = {}) {
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
  // A URL-less path (outreach, partnership) has no page of its own: the
  // pages its evidence was read from are what a refresh must re-read
  // before its omission can mean anything — they queue right behind the
  // paths' own URLs (bounded: ≤ MAX_FETCHES_PER_DOMAIN per path).
  for (const p of existingPaths) if (!p.submission_url) for (const u of evidencePagesOf(p)) push(u);
  for (const u of competitorUrls) push(u);
  // provenance details can be COMPOSITE ("paste:2026-09-01 https://…/apply",
  // CSV context + resolved URL) — extract every embedded URL rather than
  // requiring the whole string to be one. Touches NEVER covered by a pass
  // (covered_at null — the persisted hint cursor) go first, rotated by the
  // pass offset among themselves, so a hint-rich domain cannot keep the
  // same prefix forever and starve the sixth hint that IS the route.
  const rotate = (list) => { const m = list.length || 1; const s = ((probeOffset % m) + m) % m; return [...list.slice(s), ...list.slice(0, s)]; };
  const uncoveredTouches = rotate(touches.filter((t) => !t.covered_at));
  const coveredTouches = rotate(touches.filter((t) => !!t.covered_at)); // covered ones rotate too — no fixed prefix within a generation
  for (const t of [...uncoveredTouches, ...coveredTouches]) {
    for (const m of touchUrls(t)) push(m);
  }
  // The probe list is longer than what the fetch cap leaves after the
  // homepage and hints, so probes the domain has NEVER been offered (per
  // its cumulative coverage mask) go first — guaranteed progress toward
  // full probe coverage — with the pass offset rotating within that set so
  // a failing first probe doesn't monopolize the remaining slots.
  const n = PROBE_PATHS.length;
  const uncovered = [];
  const covered = [];
  for (let i = 0; i < n; i++) ((probeMask >> i) & 1 ? covered : uncovered).push(i);
  const m = uncovered.length || 1;
  const start = ((probeOffset % m) + m) % m;
  const order = [...uncovered.slice(start), ...uncovered.slice(0, start), ...covered];
  for (const i of order) push(`https://${host}${PROBE_PATHS[i]}`);
  // RESERVED probe slots: a hint-rich domain must never spend every fetch
  // slot before any uncovered probe runs (zero probe progress would let a
  // terminal verdict close routes nothing ever fetched). The last
  // PROBE_SLOT_RESERVE pre-cap positions are given to uncovered probes;
  // displaced hints queue after them for any remaining budget.
  // classification is by NORMALIZED key, exactly like the dedup above — an
  // aliased hint ("/register/") that suppressed the canonical probe push
  // still counts as that probe (reserved slot, mask bit, coverage)
  const probeKey = (u) => registry.normalizeSubmissionUrl(u);
  const allProbeKeys = new Set(PROBE_PATHS.map((pp) => probeKey(`https://${host}${pp}`)));
  const uncoveredProbeKeys = new Set(uncovered.map((i) => probeKey(`https://${host}${PROBE_PATHS[i]}`)));
  const probeBlock = out.filter((u) => allProbeKeys.has(probeKey(u)))
    // uncovered-first even when a covered probe entered `out` EARLIER as a
    // path/hint alias — the reserved slots must inspect new routes, not
    // re-fetch covered aliases (stable sort keeps each group's order)
    .sort((a, b) => (uncoveredProbeKeys.has(probeKey(a)) ? 0 : 1) - (uncoveredProbeKeys.has(probeKey(b)) ? 0 : 1));
  if (probeBlock.some((u) => uncoveredProbeKeys.has(probeKey(u)))) {
    const others = out.filter((u) => !allProbeKeys.has(probeKey(u)));
    const head = Math.max(0, MAX_FETCHES_PER_DOMAIN - PROBE_SLOT_RESERVE);
    return [...others.slice(0, head), ...probeBlock, ...others.slice(head)];
  }
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
    // watching rows past their recheck, AND not_reproducible closes past
    // their 90-day reinvestigation date (a pathless close has no path row
    // for the refresh buckets to find — the domain carries the date)
    seedFirst(db('seo_link_domains').whereIn('agent_state', ['watching', 'not_reproducible']).where('watch_recheck_at', '<=', now).where(backoffDue()).select('*')),
  ]);
  const claimPool = [...(fresh || []), ...(watchingDue || [])].sort((a, b) => {
    const seed = (d) => (d.discovery_priority === 'owner_seed' ? 0 : 1);
    return seed(a) - seed(b) || (new Date(a.created_at) - new Date(b.created_at));
  });
  const notSeen = (q) => ([...seen].length ? q.whereNotIn('d.id', [...seen]) : q);
  const notSeen2 = (q) => ([...seen].length ? q.whereNotIn('id', [...seen]) : q); // un-aliased variant
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
  // The plan requires re-investigation after a FAILED acquisition attempt:
  // an attempt in a failure-shaped outcome NEWER than the path's last
  // investigation makes the path due now, not at the 90-day expiry.
  // Re-investigating stamps the path, so the same historical failure never
  // triggers twice; failures older than the stale horizon are covered by
  // the ordinary stale bucket. The selection is BOUNDED IN SQL: the join
  // to active paths, the newer-than-stamp test, and the per-domain limit
  // all run in the database (indexed on path_id and (outcome, created_at)),
  // so a growing attempt ledger never becomes an unbounded scan per sweep.
  const failedAttemptRows = async ({ seedOnly = false } = {}) => {
    // Domain ELIGIBILITY (backoff, not rejected, watching only when due,
    // seed-only for the seed pass) is a sub-select on the attempts query
    // itself, so the LIMIT ranks only failures the sweep can act on — a
    // prefix of newer failures on rejected / backed-off / not-yet-due
    // domains can never hide an older eligible one.
    let eligible = db('seo_link_domains').select('id')
      .where(backoffDue())
      .whereNotIn('agent_state', ['rejected'])
      .where((b) => b.whereNot('agent_state', 'watching').orWhere('watch_recheck_at', '<=', now));
    if (seedOnly) eligible = eligible.where({ discovery_priority: 'owner_seed' });
    let due = db('seo_link_attempts as a')
      .join('seo_link_acquisition_paths as p', 'p.id', 'a.path_id')
      .whereNull('p.superseded_by')
      .whereIn('a.outcome', FAILED_ATTEMPT_OUTCOMES)
      .where('a.created_at', '>', new Date(now.getTime() - REINVESTIGATE_AFTER_DAYS * 24 * 60 * 60 * 1000))
      .where((b) => b.whereNull('p.last_investigated_at').orWhere('a.created_at', '>', db.ref('p.last_investigated_at')))
      .whereIn('p.domain_id', eligible);
    if (seen.size) due = due.whereNotIn('p.domain_id', [...seen]);
    const dueRows = await due.groupBy('p.domain_id').select('p.domain_id').orderByRaw('MAX(a.created_at) DESC').limit(limit);
    const dueDomainIds = [...new Set((dueRows || []).map((r) => r.domain_id).filter(Boolean))];
    if (!dueDomainIds.length) return [];
    const rows = await notSeen2(db('seo_link_domains').whereIn('id', dueDomainIds).select('*'));
    const rank = new Map(dueDomainIds.map((id, i) => [id, i]));
    return (rows || []).sort((x, y) => rank.get(x.id) - rank.get(y.id)); // keep newest-failure-first
  };
  // Owner seeds jump the WHOLE queue (§5), refresh work included: seed
  // claims, then seed refreshes (never-investigated, failed-attempt, stale),
  // then everything else — a seed with a due path can never be starved
  // behind a full page of ordinary new rows.
  take(claimPool.filter((d) => d.discovery_priority === 'owner_seed'), true);
  if (out.length < limit) take(await refreshRows('never', { seedOnly: true }), false);
  if (out.length < limit) take(await failedAttemptRows({ seedOnly: true }), false);
  if (out.length < limit) take(await refreshRows('stale', { seedOnly: true }), false);
  take(claimPool, true); // seeds already taken; dedupe skips them
  if (out.length < limit) take(await refreshRows('never'), false);
  if (out.length < limit) take(await failedAttemptRows(), false);
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
  // …and EACH amount needs its OWN proof of USD: an authoritative marker in
  // that quote, or verified evidence bound to that quote. "USD 95" beside a
  // bare "$150" renewal persists 9,500 cents and a null renewal — the
  // initial price never vouches for the renewal's currency.
  const bound = new Set(Array.isArray(modelPath.currency_evidence_bound) ? modelPath.currency_evidence_bound : []);
  const usdProven = (text, key) => currency === 'USD' && (USD_MARKER_RE.test(String(text || '')) || bound.has(key));
  return {
    acquisition_type: modelPath.acquisition_type,
    submission_url: modelPath.submission_url || null,
    estimated_cost_cents: paid && usdProven(modelPath.price_text, 'price') ? centsFor(currency, modelPath.price_text) : null,
    renewal_cost_cents: paid && usdProven(modelPath.renewal_price_text, 'renewal') ? centsFor(currency, modelPath.renewal_price_text) : null,
    renewal_period: modelPath.renewal_period || null,
    currency,
    fee_scope: modelPath.payment_required ? modelPath.fee_scope : null,
    // NEVER the model's word: a merchant binding is the verified recipient
    // identity an OBSERVED checkout chain produces (plan §merchant binding;
    // the runner's job, step 5). A static investigation cannot observe one,
    // so a claimed binding lives in the evidence only — a hallucinated or
    // injected merchant_account_id must not become the canonical payment
    // input. upsertPath preserves any runner-written binding on the row.
    merchant_binding: null,
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
async function upsertPath(trx, domainId, row, { replacesPathId = null, now, preserveTermsHash = false, workingUrlFor = null }) {
  let existing = await trx('seo_link_acquisition_paths')
    .where({ domain_id: domainId, path_key: row.path_key }).whereNull('superseded_by').first('*');
  // The model reports the URL it SAW. When that page was reached through a
  // working fallback origin (the https apex is dead), the route's identity
  // MOVES with it: an existing row keyed on the original apex URL is this
  // same path — re-keyed in place, never duplicated — and its placements'
  // execution URL follows, or every claim would keep navigating the apex
  // this investigation just proved unusable. (A www origin normalizes to
  // the same key, so only the scheme case needs the alias lookup.)
  let rekeyed = false;
  let aliasRow = null; // an active row still keyed on the DEAD apex identity of this same route
  if (workingUrlFor && workingUrlFor.size && row.submission_url) {
    const mine = registry.normalizeSubmissionUrl(row.submission_url);
    for (const [originalKey, working] of workingUrlFor) {
      if (registry.normalizeSubmissionUrl(working) !== mine) continue;
      const aliasKey = registry.pathKey(row.acquisition_type, originalKey);
      if (aliasKey === row.path_key) continue;
      aliasRow = await trx('seo_link_acquisition_paths')
        .where({ domain_id: domainId, path_key: aliasKey }).whereNull('superseded_by').first('*');
      if (aliasRow) break;
    }
    // no row at the working key yet → the apex row IS this path: re-key it.
    // A row already at the working key (https and http rows coexisted) →
    // the apex row is MERGED: superseded into the working row below, so
    // its placements settle onto the live route instead of stranding on a
    // zero-confidence row with no successor chain.
    if (aliasRow && !existing) { existing = aliasRow; aliasRow = null; rekeyed = true; }
  }
  let id;
  if (!existing) {
    // Insert against the partial unique; a CONCURRENT winner (the boot/
    // runner board catch-up, the baseline importer) that landed between the
    // lookup and this statement is not ours to ignore — its placeholder
    // would otherwise be stamped investigated with none of this pass's
    // derived fields or evidence. Re-read it and fall through to the
    // in-place update, exactly as if the lookup had found it.
    const ins = await trx('seo_link_acquisition_paths')
      .insert({ domain_id: domainId, ...row })
      .onConflict(trx.raw('(domain_id, path_key) WHERE superseded_by IS NULL')).ignore()
      .returning(['id']);
    if (ins && ins.length) id = ins[0].id;
    else {
      existing = await trx('seo_link_acquisition_paths')
        .where({ domain_id: domainId, path_key: row.path_key }).whereNull('superseded_by').first('*');
    }
  }
  if (existing) {
    // An INCONCLUSIVE terms pass (budget exhausted, failed/blocked fetch,
    // off-claim redirect, truncated/non-text/empty body) carries no verdict
    // on the agreement: the previously hashed text stands, so no erase and
    // no revision bump on its account — but ONLY while the claimed terms
    // IDENTITY is unchanged (or unclaimed). A DIFFERENT terms URL that
    // failed verification must not ride on the old agreement's hash: the
    // hash clears (INVALID until the new agreement is fetched) and the
    // revision bumps.
    if (preserveTermsHash) {
      const evUrl = (inv) => { try { return (typeof inv === 'string' ? JSON.parse(inv) : inv || {}).legal_terms_url || null; } catch { return null; } };
      const priorUrl = evUrl(existing.investigation);
      const claimedUrl = evUrl(row.investigation);
      const sameIdentity = !claimedUrl || (!!priorUrl && registry.normalizeSubmissionUrl(claimedUrl) === registry.normalizeSubmissionUrl(priorUrl));
      if (sameIdentity) {
        row = { ...row, legal_terms_hash: existing.legal_terms_hash };
        // A retained hash keeps its IDENTITY: when this pass omitted the
        // terms URL, the evidence must still carry the URL the hash was
        // taken from — otherwise the next pass that names the original URL
        // (and fetches it inconclusively) would see no prior identity and
        // clear a valid hash of an unchanged agreement.
        if (!claimedUrl && priorUrl && existing.legal_terms_hash) {
          let inv = {};
          try { inv = typeof row.investigation === 'string' ? JSON.parse(row.investigation) : (row.investigation || {}); } catch { inv = {}; }
          row = { ...row, investigation: JSON.stringify({ ...inv, legal_terms_url: priorUrl, legal_terms_url_retained: true }) };
        }
      }
    }
    // The investigator never owns merchant_binding (an observed-checkout
    // artifact): whatever a runner verified onto the row stands.
    row = { ...row, merchant_binding: existing.merchant_binding };
    const bump = {
      revision_payment: changedInputs(existing, row, PAYMENT_INPUTS),
      revision_communication: changedInputs(existing, row, COMMUNICATION_INPUTS),
      revision_execution: changedInputs(existing, row, EXECUTION_INPUTS),
    };
    const patch = { ...row };
    if (!rekeyed) delete patch.path_key; // identity never changes in place — except when the route moved to its working origin
    if (bump.revision_payment) patch.revision_payment = Number(existing.revision_payment) + 1;
    if (bump.revision_communication) patch.revision_communication = Number(existing.revision_communication) + 1;
    if (bump.revision_execution) patch.revision_execution = Number(existing.revision_execution) + 1;
    if (bump.revision_payment || bump.revision_communication || bump.revision_execution) patch.revision = Number(existing.revision) + 1;
    await trx('seo_link_acquisition_paths').where({ id: existing.id }).update(patch);
    id = existing.id;
    // A changed path is a NEW MANDATE for its placements — the execution URL
    // moved to the working origin (a fallback vhost may be paid, gated or
    // off-target), or a §3.2 input changed in place (a route just learned
    // to be paid / account-gated / attested / lane-shifted). The SAME
    // transition a supersession applies runs on the path's own placements
    // (registry.settleRetiredPlacements, same-path mode): target_url and
    // lane refreshed, unclassified until the weekly classifier has read the
    // route, unsent drafts cleared, locked outreach refused, leased rows
    // refreshed at their next claim.
    const movedToWorkingOrigin = !!(row.submission_url && existing.submission_url && existing.submission_url !== row.submission_url
      && workingUrlFor && workingUrlFor.has(registry.normalizeSubmissionUrl(existing.submission_url)));
    if (movedToWorkingOrigin || bump.revision_payment || bump.revision_communication || bump.revision_execution) {
      await registry.settleRetiredPlacements(trx, { pathIds: [existing.id], successor: { id: existing.id, submission_url: row.submission_url, link_type: row.link_type }, now });
    }
  }
  // MERGE: an active row still keyed on the dead apex identity of this very
  // route (https and http rows coexisted; https died) is superseded into
  // this row, so its placements settle onto the live route below.
  if (id && aliasRow && aliasRow.id !== id) {
    await trx('seo_link_acquisition_paths').where({ id: aliasRow.id }).whereNull('superseded_by').update({ superseded_by: id, superseded_at: now, updated_at: now });
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
    if (old) await trx('seo_link_acquisition_paths').where({ id: old.id }).update({ superseded_by: id, superseded_at: now, updated_at: now });
  }
  // Placements follow the successor ONLY while nobody holds their lease
  // (registry.settleRetiredPlacements — the worker calls the same helper at
  // every lease release, so a placement mid-submission through the retired
  // path is settled the moment its lease clears, never left waiting for a
  // future re-investigation). This runs on EVERY upsert and covers every
  // path this one superseded, not just the one matched now.
  if (id) {
    // the whole retirement chain (old → mid → this), bounded — a placement
    // leased on a twice-superseded path still lands on the live successor
    const retired = [];
    let frontier = [id];
    for (let hop = 0; hop < 8 && frontier.length; hop++) {
      const rows = await trx('seo_link_acquisition_paths').where({ domain_id: domainId }).whereIn('superseded_by', frontier).select('id');
      frontier = rows.map((r) => r.id).filter((x) => x !== id && !retired.includes(x));
      retired.push(...frontier);
    }
    await registry.settleRetiredPlacements(trx, { pathIds: retired, successor: { ...row, id }, now });
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
    // A quote continued by a RANGE separator is a truncated range:
    // "USD 95–150", "USD 95 to USD 150", and unit-suffixed lower bounds
    // like "USD 95/year – USD 150/year" never verify the lower bound —
    // the separator may be a dash or the word "to", the upper bound may
    // repeat the currency marker/symbol, and the check runs regardless of
    // how the quote itself ends (a cadence suffix must not hide the range)
    // (a cadence suffix on the LOWER bound — "/year", "per year", "a
    // month", "annually" — may sit between the quote and the separator;
    // "between X and Y" is the same range with "and" as its separator)
    const ctxBefore = t.slice(Math.max(0, idx - 40), idx);
    const betweenBefore = new RegExp(`\\bbetween\\s+(?:${CURRENCY_MARKERS}\\s*)?$`).test(ctxBefore);
    const rangeNext = new RegExp(`^${CADENCE_SUFFIX}\\s*(?:[-–—]|to\\b${betweenBefore ? '|and\\b' : ''})\\s*(?:${CURRENCY_MARKERS}\\s*)?\\d`).test(t.slice(idx + q.length));
    // …and a quote continued by MINIMUM-price syntax is a truncated lower
    // bound the same way: "USD 95+" / "USD 95 and up" never verify "USD 95"
    // (the "+" may also sit after a cadence suffix: "USD 95/year +", "USD 95 per year+")
    const minimumNext = new RegExp(`^${CADENCE_SUFFIX}\\s*(?:\\+|${MINIMUM_WORDS})`).test(t.slice(idx + q.length));
    // …and the UPPER bound of a range is the same truncation from the
    // other side: "USD 95–USD 150" / "USD 95 to 150" / "USD 95/year – USD
    // 150/year" never verify "USD 150" — a lower amount (with an optional
    // unit suffix) followed by the separator (and an optional repeated
    // currency marker) directly precedes the match
    // ("USD 95 per year – USD 150 per year", "between USD 95 and USD 150")
    const rangeBefore = new RegExp(`\\d${CADENCE_SUFFIX}\\s*(?:[-–—]|to\\b)\\s*(?:${CURRENCY_MARKERS}\\s*)?$`).test(ctxBefore)
      || new RegExp(`\\bbetween\\s+(?:${CURRENCY_MARKERS}\\s*)?\\d[\\d,.]*${CADENCE_SUFFIX}\\s+and\\s+(?:${CURRENCY_MARKERS}\\s*)?$`).test(ctxBefore);
    // …and a quote directly preceded by a pricing qualifier is a starting/
    // promo/minimum price, not the price — the same tokens the price parser rejects
    const qualifierBefore = /\b(from|starting(?: at)?|up to|as low as|at least|minimum|min\.?|save|was|off|discount)\s*:?\s*$/.test(t.slice(Math.max(0, idx - 24), idx));
    if (!contBefore && !contAfter && !multiplierNext && !rangeNext && !rangeBefore && !minimumNext && !qualifierBefore) return true;
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

/**
 * Every {priceCurrency, priceCents} pair in a page's ld+json blocks — via
 * the price-scan collector (the one parser that already handles lowPrice,
 * priceSpecification, AggregateOffer expansion, @graph nesting, and
 * tolerant JSON). priceCurrency is null when the markup did not DECLARE a
 * currency: the collector's USD default is not evidence of anything.
 */
function jsonLdOffers(html) {
  const scripts = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) scripts.push(m[1]);
  return collectJsonLdOffers(scripts).map((o) => ({
    priceCurrency: o.explicitCurrency ? String(o.currency) : null,
    priceCents: o.price != null && Number.isFinite(Number(o.price)) ? Math.round(Number(o.price) * 100) : null,
  }));
}

/**
 * The ONE currency a page's structured offers bind to a verified amount —
 * or null. An amount alone cannot bind: an unrelated product offer at the
 * same price beside a bare-dollar membership must never lend it a currency.
 * So the binding is deterministic and fail-closed: EVERY priced offer on
 * the page carries that amount (nothing else the quote could refer to) and
 * every declared currency among them agrees. Multi-offer pages stay
 * 'unknown' (step 4's price-entry card), never a guess.
 */
function boundOfferCurrency(html, cents) {
  if (cents == null) return null;
  const priced = jsonLdOffers(html).filter((o) => o.priceCents != null);
  if (!priced.length || priced.some((o) => o.priceCents !== cents)) return null;
  // every offer must DECLARE its currency — an undeclared one at the same
  // amount could be the quoted item itself, and silently dropping it would
  // let the declared neighbour lend it a currency
  if (priced.some((o) => !o.priceCurrency)) return null;
  const currencies = new Set(priced.map((o) => o.priceCurrency));
  return currencies.size === 1 ? [...currencies][0] : null;
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
  // which AMOUNT the evidence binds to — each cents field is persisted only
  // when its own quote (or evidence bound to that quote) proves USD; the
  // initial price's marker never vouches for a bare-dollar renewal
  const boundTo = new Set();
  const ev = p.currency_evidence;
  if (ev && ev.marker) {
    if (ev.kind === 'quote') {
      if (priceOk && markerInText(p.price_text, ev.marker)) boundTo.add('price');
      if (renewalOk && markerInText(p.renewal_price_text, ev.marker)) boundTo.add('renewal');
      if (boundTo.size) evidence = ev;
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
      // …and the verified quote must sit on the SAME page as the offer: a
      // matching amount in an unrelated /store offer must not validate a
      // /join membership quote it never occurs with.
      const samePage = (u) => !!u && !!ev.page_url && registry.normalizeSubmissionUrl(u) === registry.normalizeSubmissionUrl(ev.page_url);
      // …and bound the same fail-closed way as the derived path, PER
      // AMOUNT: the page's priced offers must ALL carry that verified amount
      // and agree on the claimed currency (an unrelated same-price offer
      // binds nothing)
      if (page && priceOk && samePage(p.price_page_url) && boundOfferCurrency(page.html, parsePriceTextCents(p.price_text)) === marker) boundTo.add('price');
      if (page && renewalOk && samePage(p.renewal_price_page_url) && boundOfferCurrency(page.html, parsePriceTextCents(p.renewal_price_text)) === marker) boundTo.add('renewal');
      const offerMatches = boundTo.size > 0;
      if (offerMatches) evidence = ev;
      else verification.currency_evidence = page ? 'jsonld_offer_not_bound_to_verified_quote' : 'jsonld_not_on_fetched_page';
    } else {
      verification.currency_evidence = 'processor_currency_unverifiable_static';
    }
    if (evidence) verification.currency_evidence = 'verified';
  }
  // The model NEVER sees script bodies (canonicalize strips them), so a page
  // whose only currency declaration lives in JSON-LD cannot yield a model
  // evidence claim at all. Derive it DETERMINISTICALLY instead: when no
  // model evidence verified, and a cited page's structured offers declare
  // exactly one currency whose price matches a verified quote's amount,
  // that declaration is the evidence — page truth, not model attestation.
  if (!evidence) {
    const derived = new Map(); // currency → page_url
    const derivedFor = [];
    for (const [key, ok, text, pageUrl] of [['price', priceOk, p.price_text, p.price_page_url], ['renewal', renewalOk, p.renewal_price_text, p.renewal_price_page_url]]) {
      if (!ok) continue;
      const page = findPage(pages, pageUrl);
      if (!page) continue;
      const bound = boundOfferCurrency(page.html, parsePriceTextCents(text));
      if (bound) { derived.set(bound, pageUrl); derivedFor.push(key); }
    }
    if (derived.size === 1) {
      const [[marker, pageUrl]] = [...derived.entries()];
      evidence = { marker, kind: 'jsonld_price_currency', page_url: pageUrl, derived: true };
      verification.currency_evidence = 'derived_from_structured_offer';
      for (const key of derivedFor) boundTo.add(key);
    }
  }
  return {
    price_text: priceOk ? p.price_text : null,
    renewal_price_text: renewalOk ? p.renewal_price_text : null,
    currency_evidence: evidence,
    currency_evidence_bound: evidence ? [...boundTo] : [],
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
 * Deterministic disproof that needs no model verdict: active non-baseline
 * paths whose own URL came back 404/410 or redirected off the domain this
 * pass are retired (confidence 0, stamped, reason in the evidence) and the
 * domain's best_path_id is cleared if it pointed at one. Used by the
 * no-evidence defer path — a pass where EVERY route is dead is exactly the
 * pass that must not leave those routes claimable.
 */
async function disproveGonePaths(trx, domain, goneKeys, now) {
  if (!goneKeys.size) return 0;
  const active = await trx('seo_link_acquisition_paths')
    .where({ domain_id: domain.id, baseline: false }).whereNull('superseded_by').select('id', 'submission_url', 'investigation');
  const dead = active.filter((p) => p.submission_url && goneKeys.has(registry.normalizeSubmissionUrl(p.submission_url)));
  for (const p of dead) {
    let prior = {};
    try { prior = typeof p.investigation === 'string' ? JSON.parse(p.investigation) : (p.investigation || {}); } catch { prior = {}; }
    await trx('seo_link_acquisition_paths').where({ id: p.id }).update({
      confidence: 0, last_investigated_at: now, updated_at: now,
      investigation: JSON.stringify({ ...prior, disproven_at: now.toISOString(), disproven_reason: 'submission URL is gone (404/410) or redirects off the registry domain' }),
    });
  }
  if (dead.some((p) => p.id === domain.best_path_id)) {
    await trx('seo_link_domains').where({ id: domain.id, best_path_id: domain.best_path_id }).update({ best_path_id: null, updated_at: now });
  }
  return dead.length;
}

/**
 * A failed claim-state investigation defers the domain with exponential
 * backoff instead of leaving it first in line for the next hourly sweep; the
 * failure ceiling parks it as `watching` on the normal recheck cadence.
 * Best-effort — a defer that itself fails only costs backoff, never data.
 */
async function deferFailedDomain(db, domain, now, { claim = true, observedState = null, claimToken = null } = {}) {
  try {
    const failures = (Number(domain.investigate_failures) || 0) + 1;
    const patch = { investigate_failures: failures, updated_at: now };
    if (claim && failures >= MAX_INVESTIGATE_FAILURES) {
      patch.agent_state = 'watching';
      patch.watch_recheck_at = new Date(now.getTime() + WATCH_RECHECK_DAYS * 24 * 60 * 60 * 1000);
      patch.investigate_after = null;
      patch.probe_coverage_mask = 0; // a long-term park CONCLUDES the generation — the recheck re-earns probe coverage
      patch.score_reasons = `parked: ${failures} consecutive investigation failures`;
    } else {
      // Refresh targets (lane-owned aggregate states) never get re-parked —
      // only deferred: the backoff caps at the max interval instead.
      patch.investigate_after = new Date(now.getTime() + failureBackoffMs(failures));
    }
    // Compare-and-set on the state this run observed — a claim defers only
    // while `investigating` stands UNDER THIS RUN'S claim token (or, for a
    // failure BEFORE the claim CAS, the still-unclaimed selected state via
    // observedState); a refresh defers only while the domain still holds
    // its lane-owned state. Never overwrite a newer state or a reopened
    // mandate.
    const guard = { id: domain.id, agent_state: observedState || (claim ? 'investigating' : domain.agent_state) };
    if (claim && !observedState && claimToken) guard.investigate_claim_token = claimToken;
    const n = await db('seo_link_domains').where(guard).update(patch);
    // a long-term park concludes the generation for the hint cursor too
    if (n && patch.probe_coverage_mask === 0) await db('seo_link_domain_sources').where({ domain_id: domain.id }).whereNotNull('covered_at').update({ covered_at: null });
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
  limit = batchSize(), dryRun = false, domainIds = null, now: fixedNow = null,
  fetchPage: fetcher = fetchPage, llmDispatch = dispatch, exclusive = defaultExclusive,
} = {}) {
  // selection runs on the run-start clock; each domain's writes take their own (see the loop)
  const clock = fixedNow ? () => fixedNow : () => new Date();
  const now = clock();
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
      let claimToken = null; // minted by the claim CAS below; read by the catch-path defer too
      // Per-domain clock: a live run is sequential (up to 500 domains, each
      // with network timeouts and two 60s model calls), so a single run-start
      // timestamp would stamp late domains hours in the past and expire
      // their six-hour backoff at commit. An injected `now` (tests, replay)
      // stays fixed; otherwise every domain's claim/stamp/backoff is taken
      // when ITS work runs.
      const now = clock();
      try {
        const host = canonicalProspectDomain(domain.domain);
        if (!host) {
          // same backoff/parking as fetch and model failures — an invalid
          // name must not re-select every hourly sweep forever (the failure
          // ceiling eventually parks it watching)
          out.failed.push({ id: domain.id, domain: domain.domain, reason: 'invalid_host' });
          // this failure happens BEFORE the claim CAS: the row still holds
          // its selected state, so the defer must compare against that
          await deferFailedDomain(db, domain, now, { claim: claimState, observedState: domain.agent_state });
          continue;
        }

        // Claim: stamp `investigating` so the queue and UI show the domain in
        // flight (states 1–2 only; path refreshes never touch agent_state).
        // Compare-and-set against the SELECTED state — an admin reject/watch
        // or a lane move between selection and this statement wins, and the
        // claim is abandoned before any fetch is spent.
        // …and a row SELECTED as `investigating` still re-validates with the
        // same CAS (a cheap touch): an admin reject/watch between selection
        // and this statement must stop the paid work here, not after the
        // fetches and model call.
        // The claim also mints a GENERATION token: `investigating` alone
        // cannot tell this run's claim from a later one — an owner Watch/
        // Reject followed by Reopen returns the state to `investigating`
        // under a fresh mandate (mask + backoff reset), and a run that
        // started before it must not finish on top of it. Reopen clears
        // the token; the write phase and the failure defer both compare it.
        if (claimState) {
          claimToken = crypto.randomUUID();
          const claimed = await db('seo_link_domains')
            .where({ id: domain.id, agent_state: domain.agent_state })
            .update({ agent_state: 'investigating', investigate_claim_token: claimToken, updated_at: now });
          if (!claimed) { out.staleClaims += 1; continue; }
        }

        const [touches, existingPaths, competitorRows] = await Promise.all([
          db('seo_link_domain_sources').where({ domain_id: domain.id }).select('id', 'source', 'source_detail', 'source_ref', 'covered_at'),
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
        const priorProbeMask = Number(domain.probe_coverage_mask) || 0;
        const urls = candidateUrls(host, { touches, competitorUrls: (competitorRows || []).map((r) => r.source_url), existingPaths: orderedPaths, probeOffset: Math.floor(now.getTime() / (60 * 60 * 1000)), probeMask: priorProbeMask });
        // probe classification is by PATHNAME, so origin variants
        // (www/http fallbacks) and aliased hints all count toward the same
        // coverage bit (host-boundness is enforced separately)
        const probePathIndex = new Map(PROBE_PATHS.map((pp, i) => [pp, i]));
        const probeIdxFor = (u) => {
          try {
            const parsed = new URL(u);
            // a QUERY variant (/register?invite=…) can serve different content
            // than the public route: it is a hint, never coverage of the probe
            if (parsed.search) return undefined;
            const path = parsed.pathname.replace(/\/$/, '') || '/';
            return probePathIndex.get(path);
          } catch { return undefined; }
        };
        let passProbeMask = 0; // probes whose fetch reached a DEFINITIVE outcome this pass
        const pages = [];
        const fetchErrors = [];
        const redirectMap = new Map(); // normalized requested URL → normalized final URL (supersession evidence)
        const urlQueue = [...urls];
        // fetch URL → the apex URL it stands in for (origin fallback re-basing):
        // evidence keys (coverage, disproof, redirects) stay on the ORIGINAL
        // URL, which is the identity every path row and hint carries
        const rebasedFrom = new Map();
        const workingUrlFor = new Map(); // normalized ORIGINAL (apex) URL → the working origin's URL that answered
        // BOUNDED origin fallbacks tried when the https apex homepage fails:
        // www-only sites, plain-http sites, and legacy http-only www hosts
        // (canonicalization strips the www the registry once observed, so
        // the combined variant must be offered explicitly).
        const fallbackOrigins = [`https://www.${host}`, `http://${host}`, `http://www.${host}`];
        // Origin fallbacks are inserted at fetch time, AFTER candidateUrls
        // reserved the last pre-cap slots for uncovered probes — each one
        // spends a slot the reservation never saw. Re-apply the reservation
        // over the REMAINING queue against the REMAINING budget whenever the
        // queue changes shape, so hints can never push every probe past the
        // cap on a www-only domain (zero probe progress would park it on
        // routes nothing ever fetched).
        const reserveRemaining = (from) => {
          const rest = urlQueue.slice(from);
          const budget = MAX_FETCHES_PER_DOMAIN - (pages.length + fetchErrors.length);
          const coveredMask = priorProbeMask | passProbeMask;
          const uncoveredProbe = (u) => { const i = probeIdxFor(u); return i !== undefined && !((coveredMask >> i) & 1); };
          const probes = rest.filter(uncoveredProbe);
          if (!probes.length) return;
          const others = rest.filter((u) => !uncoveredProbe(u));
          const head = Math.max(0, budget - PROBE_SLOT_RESERVE);
          urlQueue.splice(from, rest.length, ...others.slice(0, head), ...probes, ...others.slice(head));
        };
        // The apex homepage FAILED as an origin — a dead vhost, or one that
        // redirects off-site (a parked/social landing) while www still
        // serves the real site: try the bounded alternatives next.
        const enqueueFallbacks = (at) => {
          // each fallback homepage stands in for the CANONICAL apex: its
          // evidence (coverage, a later 404 reconciliation) is keyed on
          // https://<host>, the identity every baseline/path row carries
          for (const fb of fallbackOrigins) rebasedFrom.set(fb, `https://${host}`);
          urlQueue.splice(at + 1, 0, ...fallbackOrigins);
          reserveRemaining(at + 1); // the fallbacks spend slots the reservation never saw
        };
        for (let qi = 0; qi < urlQueue.length; qi++) {
          const url = urlQueue[qi];
          if (pages.length + fetchErrors.length >= MAX_FETCHES_PER_DOMAIN) break;
          const claimUrl = rebasedFrom.get(url) || url;
          const probeIdx = probeIdxFor(url);
          out.fetches += 1;
          const page = await fetcher(url);
          const finalUrl = (page && page.finalUrl) || url;
          let probeDefinitive = false; // set per outcome below
          if (page && page.html && !page.blocked && !page.error && !TEXTUAL_MIME_RE.test(String(page.contentType || ''))) {
            // a binary 2xx body (PDF, image) decodes into `html` but is not
            // page text: it must never become model input, coverage, or
            // disproof — same textual-MIME rule the terms branch enforces
            fetchErrors.push({ url: claimUrl, reason: 'non_text_body' });
            // NOT definitive: nothing of this route reached the model (a
            // PDF application form, a legacy page with no MIME header), so
            // its coverage bit stays unset and the no-progress valve parks
            // the domain for review rather than letting a terminal verdict
            // close a route nobody read
          } else if (page && page.html && !page.blocked && !page.error && hostBound(host, finalUrl)) {
            const text = canonicalizeTerms(page.html);
            redirectMap.set(registry.normalizeSubmissionUrl(claimUrl), registry.normalizeSubmissionUrl(finalUrl));
            // html/text stay only for THIS domain's evidence verification —
            // never persisted, never prompted beyond the excerpt. `truncated`
            // rides along: a byte-capped page is positive evidence but never
            // COVERAGE (the model didn't see past the cut).
            // requestedUrl rides along: a followed canonical redirect
            // (http→https, slash) covers BOTH aliases — the original path's
            // URL must not stay "never covered" and re-select forever
            pages.push({ url: finalUrl, requestedUrl: claimUrl, status: page.status, excerpt: text.slice(0, PAGE_EXCERPT_CHARS), text, html: page.html, truncated: !!page.truncated });
            // a re-based fetch that ANSWERED is the route's WORKING execution
            // URL: the path (and its placements' target_url) must move to
            // it, or every claim would keep navigating the dead apex
            if (claimUrl !== url) workingUrlFor.set(registry.normalizeSubmissionUrl(claimUrl), finalUrl);
            // the route counts as INSPECTED only when the model saw the
            // whole page — same full-observation rule as content coverage:
            // a byte-capped body or text past the prompt excerpt may hold
            // the very form/instructions the verdict would close away, so
            // the probe bit stays unset (existence, not coverage) and the
            // no-progress valve parks the domain for review rather than
            // closing a route nobody fully read
            // (same substantive-text floor as content coverage: a short
            // client-rendered shell shows the model nothing of the route)
            probeDefinitive = !page.truncated && text.length >= MIN_COVERAGE_TEXT_CHARS && text.length <= PAGE_EXCERPT_CHARS;
            // A WORKING fallback origin carries EVERY still-queued apex URL:
            // the apex is dead, so probes, known paths, and provenance hints
            // alike re-base onto the origin that answers — a known custom
            // route (/get-listed) would otherwise fail on every generation
            // and stay due forever while the probes moved on.
            if (fallbackOrigins.includes(url)) {
              // a working origin makes the remaining fallbacks pointless —
              // drop them rather than spend slots on more homepages
              while (fallbackOrigins.includes(urlQueue[qi + 1])) urlQueue.splice(qi + 1, 1);
              for (let j = qi + 1; j < urlQueue.length; j++) {
                if (urlQueue[j].startsWith(`https://${host}/`)) {
                  const u = new URL(urlQueue[j]);
                  const moved = `${url}${u.pathname}${u.search}`;
                  rebasedFrom.set(moved, urlQueue[j]);
                  urlQueue[j] = moved;
                }
              }
              reserveRemaining(qi + 1);
            }
          } else if (page && page.html && !page.blocked && !page.error) {
            // the request was host-bound but a redirect left the domain —
            // an off-site page must never become model input or evidence
            fetchErrors.push({ url: claimUrl, reason: 'offsite_redirect' });
            probeDefinitive = true; // the route definitively leads off-site
            if (url === `https://${host}`) enqueueFallbacks(qi); // an off-site apex is a failed origin too
          } else {
            const reason = (page && (page.error || (page.blocked && 'blocked'))) || `status_${page && page.status}`;
            fetchErrors.push({ url: claimUrl, reason });
            probeDefinitive = /^status_(404|410)$/.test(reason); // gone is a verdict; timeouts/blocks/5xx retry
            // BOUNDED origin fallbacks: a site reachable only via www or
            // plain http would otherwise fail every candidate at the
            // canonical https apex and park a domain with a valid route —
            // when the apex homepage itself fails, try its two origin
            // variants next (same cap, same host-bound rules).
            if (url === `https://${host}`) enqueueFallbacks(qi);
          }
          // Coverage records only DEFINITIVE probe outcomes — a transient
          // failure leaves the bit unset so the uncovered-first ordering
          // retries the route before any terminal close (a permanently
          // failing probe still closes via the no-progress valve).
          if (probeIdx !== undefined && probeDefinitive) passProbeMask |= 1 << probeIdx;
        }

        // An evidence-less pass proves nothing: when every candidate fetch
        // failed (transient DNS, timeouts, blocks) — or every page that DID
        // load is a client-rendered shell whose canonical text is empty (the
        // model would receive no substantive content and could still return
        // a terminal verdict on the domain's NAME alone) — treat it as a
        // failed investigation (backoff applies) and spend no model call.
        if (!pages.some((pg) => pg.text.length >= MIN_COVERAGE_TEXT_CHARS)) {
          // …but DETERMINISTIC disproof needs no model: a pass where every
          // route 404s or redirects off-site must retire those routes (and
          // clear best_path_id) before deferring, or the worker keeps leasing
          // a path this pass just proved dead. Reconciled like goneKeys:
          // a key any page loaded for is never gone.
          const loadedKeys = new Set(pages.map((pg) => registry.normalizeSubmissionUrl(pg.url)).concat(pages.map((pg) => registry.normalizeSubmissionUrl(pg.requestedUrl || pg.url))));
          const earlyGone = new Set(fetchErrors
            .filter((f) => /^(status_(404|410)|offsite_redirect)$/.test(String(f.reason)))
            .map((f) => registry.normalizeSubmissionUrl(f.url))
            .filter((k) => !loadedKeys.has(k)));
          if (earlyGone.size) {
            await db.transaction(async (trx) => {
              const fresh = await trx('seo_link_domains').where({ id: domain.id }).forUpdate().first('agent_state', 'investigate_claim_token', 'best_path_id');
              const expected = claimState ? 'investigating' : domain.agent_state;
              if (!fresh || fresh.agent_state !== expected || (claimState && fresh.investigate_claim_token !== claimToken)) return;
              await disproveGonePaths(trx, { ...domain, best_path_id: fresh.best_path_id }, earlyGone, now);
            });
          }
          out.failed.push({ id: domain.id, domain: host, reason: pages.length ? 'no_substantive_page_evidence' : 'no_page_evidence' });
          await deferFailedDomain(db, domain, now, { claim: claimState, claimToken });
          continue;
        }

        // Reason phase — one WORKHORSE call, one repair retry.
        const sources = [...new Set(touches.map((t) => t.source))];
        const prompt = buildPrompt({ host, pages, existingPaths, sources });
        const res = await investigateWithModel(llmDispatch, prompt);
        out.llmCalls += res.calls || 1;
        if (!res.ok) {
          out.failed.push({ id: domain.id, domain: host, reason: res.reason });
          await deferFailedDomain(db, domain, now, { claim: claimState, claimToken }); // backoff, never an hourly re-spend
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
            // a UUID is case-insensitive; the DB ids are lowercase
            const clean = { ...p, offhost: {}, replaces_path_id: p.replaces_path_id ? String(p.replaces_path_id).toLowerCase() : p.replaces_path_id };
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
            // hostnames only — an untrusted URL's query/userinfo can carry
            // tokens or emails, and logs are no place for either
            const offhostHosts = Object.values(p.offhost).map((u) => { try { return new URL(u).hostname; } catch { return 'unparseable'; } });
            logger.info(`[link-investigator] ${host}: discarded model path (${p.rejectedClaim})${offhostHosts.length ? ` offhost: ${offhostHosts.join(', ')}` : ''}`);
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
        // A page covers its requested URL too, but ONLY across a canonical
        // (scheme/slash) redirect — a soft-redirect to a different page must
        // not mark the original path observed or disprove it.
        const schemelessKey = (u) => registry.normalizeSubmissionUrl(u).replace(/^https?:\/\//, '');
        const pageKeys = (pg) => {
          const keys = [registry.normalizeSubmissionUrl(pg.url)];
          if (pg.requestedUrl && schemelessKey(pg.requestedUrl) === schemelessKey(pg.url)) keys.push(registry.normalizeSubmissionUrl(pg.requestedUrl));
          return keys;
        };
        const fetchedKeys = new Set(pages.flatMap(pageKeys));
        // Coverage additionally requires SUBSTANTIVE canonical text — a
        // client-rendered script shell proves the URL exists but the model
        // observed nothing on it, so its omissions disprove nothing.
        // …and the model must have SEEN the whole page: the prompt carries at
        // most PAGE_EXCERPT_CHARS of canonical text, so a longer page is only
        // partially observed — existence, not coverage.
        const coverageKeys = new Set(pages
          .filter((pg) => !pg.truncated && pg.text.length >= MIN_COVERAGE_TEXT_CHARS && pg.text.length <= PAGE_EXCERPT_CHARS)
          .flatMap(pageKeys));
        // The pages a URL-less path's truth rests on: the pages its evidence
        // was read from, or — for a path that recorded none — the homepage
        // (the domain-level evidence). Disproof by omission and stamping both
        // require every one of them covered again this pass.
        const urllessEvidenceKeys = (p) => {
          const ev = evidencePagesOf(p);
          return (ev.length ? ev : [`https://${host}`]).map(registry.normalizeSubmissionUrl);
        };
        // A DETERMINISTIC 404/410 on a path's own URL is disproof of that
        // path (transient errors, blocks, and timeouts are not): the dead
        // path must retire and stamp instead of holding best_path_id and
        // re-selecting the domain every sweep.
        // …reconciled against what DID load: an apex 404 whose www/http
        // fallback then answered is the same normalized identity (www is
        // stripped), observed alive later in the pass — never a disproof.
        // …and a submission route that finishes OFF the registry domain is
        // disproof too: the investigator has definitive evidence the route
        // no longer stays on this site, so its path must not keep a positive
        // confidence the worker would keep navigating and rejecting.
        const goneKeys = new Set(fetchErrors
          .filter((f) => /^(status_(404|410)|offsite_redirect)$/.test(String(f.reason)))
          .map((f) => registry.normalizeSubmissionUrl(f.url))
          .filter((k) => !fetchedKeys.has(k)));
        let verifyAttempts = 0;
        for (const p of writable) {
          if (!p.submission_url) continue; // outreach-shaped paths have no URL to verify
          const key = registry.normalizeSubmissionUrl(p.submission_url);
          if (fetchedKeys.has(key)) continue;
          // the candidate phase already got a deterministic 404/410 for this
          // URL — that IS the verdict; no probe spend, no transient retry
          const goneReason = goneKeys.has(key) ? fetchErrors.find((f) => registry.normalizeSubmissionUrl(f.url) === key && /^(status_(404|410)|offsite_redirect)$/.test(String(f.reason))) : null;
          if (goneReason) { p.submissionUnverified = goneReason.reason; continue; }
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
        // The budget must not starve the same tail forever: paths whose
        // active row still lacks a verified hash go FIRST, and ties rotate
        // with the hourly pass offset — a third legal path is not stuck
        // behind the same two on every retry.
        const hashOnFile = (p) => existingPaths.some((e) => e.path_key === registry.pathKey(p.acquisition_type, p.submission_url) && e.legal_terms_hash);
        // The rotation cursor is DURABLE and MONOTONIC: an inconclusive terms
        // pass leaves the path unstamped, which makes the pass unsettled and
        // advances the domain's investigate_failures by exactly one — so each
        // retry starts one slot further along, and every un-hashed path gets
        // its bounded attempt before the failure ceiling, whatever the clock
        // stride (a hashed hour could repeat the same modulo indefinitely).
        const legalOrder = (() => {
          const legal = writable.filter((p) => p.legal_attestation && p.legal_terms_url);
          const unhashed = legal.filter((p) => !hashOnFile(p));
          const hashed = legal.filter(hashOnFile);
          const start = unhashed.length ? (Number(domain.investigate_failures) || 0) % unhashed.length : 0;
          return [...unhashed.slice(start), ...unhashed.slice(0, start), ...hashed];
        })();
        for (const p of legalOrder) {
          if (termsAttempted.has(p.legal_terms_url)) continue;
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
            .first('agent_state', 'investigate_claim_token', 'best_path_id', 'domain_rating', 'spam_score', 'organic_traffic', 'competitors_linked');
          // Claims must still hold `investigating` UNDER THIS RUN'S TOKEN
          // (an ABA Watch→Reopen returns the state but not the token); a
          // REFRESH must still see the lane state it selected — either way,
          // a state that moved during the un-locked network window owns the
          // row now.
          const expected = claimState ? 'investigating' : domain.agent_state;
          if (!fresh || fresh.agent_state !== expected || (claimState && fresh.investigate_claim_token !== claimToken)) { staleClaim = true; return; }
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
              ...(p.merchant_binding ? { merchant_binding_claim: p.merchant_binding, merchant_binding_verification: 'unverified_static_step3' } : {}),
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
              // the RECONCILED disproof set — an apex 404 answered by a working
              // www/http fallback is not a dead predecessor
              const gone = !!predKey && goneKeys.has(predKey);
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
              const echoedExisting = !replaces && existingPaths.find((e) => e.path_key === echoKey);
              if (echoedExisting) {
                uncoveredEcho = true;
                // mark the row DUE (evidence untouched): a recent stamp would
                // otherwise keep it out of every refresh bucket for 90 days
                // while its page went unread this pass. Gone URLs skip this —
                // the goneKeys disproof below retires them stamped.
                const exKey = echoedExisting.submission_url ? registry.normalizeSubmissionUrl(echoedExisting.submission_url) : null;
                if (!exKey || !goneKeys.has(exKey)) {
                  await trx('seo_link_acquisition_paths').where({ id: echoedExisting.id }).update({ last_investigated_at: null, updated_at: now });
                }
                continue;
              }
              row.last_investigated_at = null;
              p.unstamped = true;
            }
            if (p.submissionUnverified) {
              row.confidence = 0; // exists only as a claim until a pass observes the URL
              // A TRANSIENT verification failure (probe error, 5xx, block,
              // budget exhausted) is not a verdict on the claim: leave the
              // row unstamped so a later pass retries instead of hiding it
              // for 90 days. Deterministic rejections — off-host, missing
              // URL for a site-executed type, and a 404/410 on the claimed
              // URL itself — ARE verdicts and stamp normally (an echoed
              // dead URL must not re-select the domain every backoff
              // forever).
              const deterministicReject = ['offhost_submission_url', 'missing_submission_url', 'offsite_redirect'].includes(p.submissionUnverified)
                || /^status_(404|410)$/.test(String(p.submissionUnverified));
              if (!deterministicReject) {
                row.last_investigated_at = null;
                p.unstamped = true;
              }
            }
            const id = await upsertPath(trx, domain.id, row, { replacesPathId: replaces, now, preserveTermsHash: termsInconclusive, workingUrlFor });
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
            .where({ domain_id: domain.id }).whereNull('superseded_by').select('id', 'submission_url', 'investigation');
          const stampIds = new Set(writtenIds.filter((id) => !unstampedIds.has(id)));
          for (const ap of activeAll) {
            if (unstampedIds.has(ap.id)) continue; // transient verification failure — retryable next pass
            const k = ap.submission_url ? registry.normalizeSubmissionUrl(ap.submission_url) : null;
            if (k) { if (coverageKeys.has(k) || goneKeys.has(k)) stampIds.add(ap.id); continue; } // a 404/410 page IS a verdict on its path
            // URL-less: stamped when its evidence pages were re-read (the
            // homepage, for a path that recorded none)
            if (urllessEvidenceKeys(ap).every((u) => coverageKeys.has(u))) stampIds.add(ap.id);
          }
          if (stampIds.size) {
            await trx('seo_link_acquisition_paths').whereIn('id', [...stampIds]).update({ last_investigated_at: now, updated_at: now });
          }
          // An active path this pass could neither stamp nor retire (its
          // page — or a URL-less path's evidence pages — outside the
          // budget, failed, or only partially observed) leaves the domain
          // UNSETTLED like an unstamped write: it re-selects on the
          // escalating backoff, never on every hourly sweep.
          const activeLeftUnstamped = activeAll.some((ap) => !stampIds.has(ap.id) && !unstampedIds.has(ap.id));

          // Provenance-hint coverage cursor: a touch is COVERED once every
          // host-bound URL it carries was fully observed (or definitively
          // gone) this pass — stamped so the candidate order rotates past
          // it and the terminal valve knows what was never read.
          const definitiveKeys = new Set([...coverageKeys, ...goneKeys]);
          const touchCoveredNow = (t) => {
            const keys = touchUrls(t).filter((u) => hostBound(host, u)).map(registry.normalizeSubmissionUrl);
            return keys.length > 0 && keys.every((k) => definitiveKeys.has(k));
          };
          const hintTouches = touches.filter((t) => touchUrls(t).some((u) => hostBound(host, u)));
          const newlyCovered = hintTouches.filter((t) => !t.covered_at && touchCoveredNow(t));
          if (newlyCovered.length) {
            await trx('seo_link_domain_sources').whereIn('id', newlyCovered.map((t) => t.id).filter(Boolean)).update({ covered_at: now });
          }
          const hintsRemain = hintTouches.some((t) => !t.covered_at && !touchCoveredNow(t));
          const hintProgress = newlyCovered.length > 0;

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
              // A verdict AT the response cap may have been FORCED to omit
              // real paths — omission then proves nothing, and only the
              // deterministic 404/410 disproof still applies.
              .filter((s) => {
                const k = s.submission_url ? registry.normalizeSubmissionUrl(s.submission_url) : null;
                if (k && goneKeys.has(k)) return true;
                if ((verdict.paths || []).length >= MAX_MODEL_PATHS) return false;
                // a URL-less path is disproven only when EVERY page its
                // evidence was read from was covered again this pass — the
                // model saw the same evidence and still did not report it;
                // a path with no recorded evidence pages (legacy shape) rests
                // on the domain-level evidence, i.e. the homepage
                if (!k) return urllessEvidenceKeys(s).every((u) => coverageKeys.has(u));
                return coverageKeys.has(k);
              });
            for (const s of stale) {
              const prior = typeof s.investigation === 'string' ? (() => { try { return JSON.parse(s.investigation); } catch { return {}; } })() : (s.investigation || {});
              const urlGone = !!s.submission_url && goneKeys.has(registry.normalizeSubmissionUrl(s.submission_url));
              await trx('seo_link_acquisition_paths').where({ id: s.id }).update({
                confidence: 0,
                investigation: JSON.stringify({ ...prior, disproven_at: now.toISOString(), disproven_reason: urlGone ? 'submission URL is gone (404/410) or redirects off the registry domain' : `re-investigation verdict '${verdict.verdict}' did not reproduce this path` }),
                updated_at: now,
              });
            }
          }

          // Finish the domain: best path, score, verdict. Zero-value paths
          // (disproven, or confidence 0) never become the best path.
          const active = await trx('seo_link_acquisition_paths').where({ domain_id: domain.id }).whereNull('superseded_by').where({ baseline: false }).select('*');
          const ranked = active.map((p) => ({ p, v: pathValue(p) })).filter((r) => r.v > 0).sort((a, b) => b.v - a.v);
          const best = ranked.length ? ranked[0].p : null;
          // The baseline importer deliberately makes an imported domain's
          // descriptive baseline path its best path (the live placement
          // stays visible and seeds discovery). Baselines never RANK — they
          // describe a link, not a reproducible route — but a negative
          // refresh must not erase that pointer either: it stands until a
          // ranked replacement exists or the baseline URL itself is gone.
          let keptBaselineId = null;
          if (!best && fresh.best_path_id) {
            const held = await trx('seo_link_acquisition_paths')
              .where({ id: fresh.best_path_id, domain_id: domain.id, baseline: true }).whereNull('superseded_by').first('id', 'submission_url');
            const heldGone = !!(held && held.submission_url && goneKeys.has(registry.normalizeSubmissionUrl(held.submission_url)));
            if (held && !heldGone) keptBaselineId = held.id;
          }
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
          const unsettled = unstampedIds.size > 0 || uncoveredEcho || activeLeftUnstamped;
          const newProbeMask = priorProbeMask | passProbeMask;
          // An UNSETTLED pass (unstamped writes, an uncovered echo) is a
          // retryable non-verdict exactly like a failed fetch or model call:
          // it rides the SAME escalating failure curve and counter — a known
          // path whose page times out on every pass re-spends a model call
          // at 6h·12h·24h·48h·96h, never every six hours forever — and at
          // the ceiling a still-undecided domain parks for review. A settled
          // pass resets the counter.
          const failures = (Number(domain.investigate_failures) || 0) + 1;
          let parkNote = unsettled && failures >= MAX_INVESTIGATE_FAILURES ? `${failures} consecutive unsettled passes` : null;
          // The mask accumulates ONLY across a near-term deferral chain; a
          // CONCLUDED generation (qualified, not_reproducible, a plain
          // 30-day watching park, or a lane-owned refresh) resets it to 0 —
          // a recheck months later must re-earn probe coverage, or a route
          // added since (a new /register) could be closed on stale bits.
          // The decideState block below overrides this back to newProbeMask
          // when the pass defers near-term.
          // how soon this domain is due again — the escalating failure curve
          // for an unsettled pass (and, below, for a pass that made no probe
          // progress); the base interval otherwise
          let deferMs = unsettled ? failureBackoffMs(failures) : INVESTIGATE_BACKOFF_BASE_MS;
          const patch = { best_path_id: best ? best.id : keptBaselineId, score, score_reasons: `${reasons}${watchNote}`, updated_at: now, investigate_failures: unsettled ? failures : 0, investigate_after: unsettled ? new Date(now.getTime() + deferMs) : null, probe_coverage_mask: 0 };
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
            // (near-term: that path leads the next fetch rotation, so the
            // recheck must be on the backoff horizon, never 30 days out)
            if (verdict.verdict === 'not_reproducible' && best) { effectiveVerdict = 'watching'; downgradeNote = 'terminal verdict deferred: an uncovered active path remains'; tailDeferred = true; }
            // A TERMINAL close is also deferred while probe routes the
            // domain has NEVER been offered remain: the route may live on a
            // page no pass has requested yet, and the uncovered-first probe
            // ordering guarantees each deferred re-pass makes progress. The
            // cumulative probe_coverage_mask is the bound — closure fires
            // once every probe has had its attempt, or when a pass adds no
            // new probes (hints consumed every slot: nothing more to learn).
            // …and the same discipline for provenance hints: a close waits
            // until every hint URL has been offered a fetch (the persisted
            // covered_at cursor is the bound), and a pass that covers a new
            // hint is progress like a new probe bit
            const probesRemain = (newProbeMask & FULL_PROBE_MASK) !== FULL_PROBE_MASK || hintsRemain;
            const probeProgress = newProbeMask !== priorProbeMask || hintProgress;
            if (verdict.verdict === 'not_reproducible' && !best && probesRemain) {
              if (probeProgress) {
                // coverage is advancing — keep the near-term chain going
                effectiveVerdict = 'watching'; downgradeNote = 'terminal verdict deferred: unfetched candidate URLs remain'; tailDeferred = true;
              } else {
                // NO progress is not proof of absence: a route that only
                // times out or 5xxes must not be closed away during an
                // outage. Retry on the SAME escalating failure backoff a
                // failed pass gets (6h · 12h · 24h · 48h · 96h — a multi-day
                // route outage costs five model calls, not one every 6h);
                // at the ceiling, PARK FOR REVIEW on the normal watch
                // cadence (mask resets — the next generation re-earns
                // coverage) instead of ever closing on an uninspected route.
                effectiveVerdict = 'watching';
                patch.investigate_failures = failures;
                if (failures >= MAX_INVESTIGATE_FAILURES) {
                  downgradeNote = 'probe routes never reached a definitive result'; parkNote = parkNote || downgradeNote;
                } else {
                  downgradeNote = 'terminal verdict deferred: an uncovered probe has no definitive result yet'; tailDeferred = true;
                  deferMs = failureBackoffMs(failures);
                }
              }
            }
            patch.agent_state = effectiveVerdict === 'qualified' ? 'qualified' : effectiveVerdict === 'watching' ? 'watching' : 'not_reproducible';
            // A downgrade caused by TRANSIENT verification (an unstamped
            // path — failed probe, inconclusive terms, exhausted budget)
            // rechecks on the failure-backoff horizon, not the 30-day watch
            // cadence: the advertised rotated retry must actually be near.
            let transientDowngrade = downgradeNote && (unstampedIds.size > 0 || tailDeferred);
            // THE CEILING: a domain still undecided after MAX consecutive
            // unsettled / no-progress passes PARKS FOR REVIEW on the normal
            // watch cadence — the chain ends (mask resets, backoff cleared)
            // and an owner Reopen starts a fresh generation. A domain the
            // pass DID decide (qualified, or a genuine close) is never
            // parked for a side path that stays unverifiable: it keeps its
            // verdict and the retry cadence simply caps at the max interval.
            if (effectiveVerdict === 'watching' && parkNote) {
              downgradeNote = `${downgradeNote && !downgradeNote.includes(parkNote) ? `${downgradeNote}; ` : ''}parked for review: ${parkNote}`;
              transientDowngrade = false;
              patch.investigate_after = null;
            }
            if (effectiveVerdict === 'watching' && transientDowngrade) patch.probe_coverage_mask = newProbeMask; // the chain continues
            // A not_reproducible close commonly writes NO path rows, so the
            // path-based refresh buckets can never revisit it: the domain
            // itself carries its 90-day reinvestigation date instead (a
            // submission route added after the close is picked up on the
            // documented cadence, not only by an owner Reopen).
            patch.watch_recheck_at = effectiveVerdict === 'watching'
              ? new Date(now.getTime() + (transientDowngrade ? deferMs : WATCH_RECHECK_DAYS * 24 * 60 * 60 * 1000))
              : effectiveVerdict === 'not_reproducible'
                ? new Date(now.getTime() + REINVESTIGATE_AFTER_DAYS * 24 * 60 * 60 * 1000)
                : null;
            if (downgradeNote) patch.score_reasons = `${patch.score_reasons} · downgraded: ${downgradeNote}`;
          }
          await trx('seo_link_domains').where({ id: domain.id }).update(patch);
          // A CONCLUDED generation (mask reset to 0) also releases the hint
          // cursor: the next generation re-reads provenance hints uncovered-
          // first, so a 90-day recheck cannot re-read the same prefix and
          // miss a tail hint that became the route in the meantime.
          if (patch.probe_coverage_mask === 0) {
            await trx('seo_link_domain_sources').where({ domain_id: domain.id }).whereNotNull('covered_at').update({ covered_at: null });
          }
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
        await deferFailedDomain(db, domain, now, { claim: claimState, claimToken });
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
    deferFailedDomain, MAX_INVESTIGATE_FAILURES, INVESTIGATE_BACKOFF_BASE_MS, failureBackoffMs,
    PAYMENT_INPUTS, COMMUNICATION_INPUTS, EXECUTION_INPUTS, CLAIMABLE_STATES,
  },
};

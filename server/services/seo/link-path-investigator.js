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
const { validateInvestigation, INVESTIGATION_SCHEMA } = require('./link-path-investigation-schema');
const registry = require('./link-registry');

const LOCK_KEY = 'link-path-investigator';
const defaultExclusive = (name, fn) => require('../../utils/cron-lock').runExclusive(name, fn, { recordHealth: false });

const DEFAULT_BATCH = 50;
const batchSize = () => {
  const n = Number(process.env.LINK_INVESTIGATOR_BATCH);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 500) : DEFAULT_BATCH;
};

// §5 cost discipline: ~8 fetches + 1 LLM call per domain.
const MAX_FETCHES_PER_DOMAIN = 8;
const PAGE_EXCERPT_CHARS = 6000;
const REINVESTIGATE_AFTER_DAYS = 90;
const WATCH_RECHECK_DAYS = 30;
const LLM_TIMEOUT_MS = 60000;

// §5 fixed probe list, tried in order after the evidence-bearing candidates.
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
const FOREIGN_MARKER_RE = /€|£|¥|₹|₩|C\$|CA\$|A\$|AU\$|NZ\$|R\$|\b(CAD|AUD|EUR|GBP|NZD|MXN|JPY|CNY|CHF|SEK|NOK|DKK|ZAR|BRL|INR|PLN|SGD|HKD)\b/;

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
  const evidenceForeign = !!evidenceMarker && !evidenceUsd && FOREIGN_MARKER_RE.test(evidenceMarker);
  const quoteUsd = USD_MARKER_RE.test(quotes);
  const quoteForeign = FOREIGN_MARKER_RE.test(quotes);
  if (evidenceForeign || (quoteForeign && !evidenceUsd && !quoteUsd)) return 'foreign';
  if ((evidenceUsd || quoteUsd) && !quoteForeign && !evidenceForeign) return 'USD';
  if ((evidenceUsd || quoteUsd) && (quoteForeign || evidenceForeign)) return 'unknown'; // conflicting — fail closed
  return 'unknown';
}

const centsFor = (currency, text) => (currency === 'USD' ? parsePriceTextCents(text) : null);

// ---------------------------------------------------------------------------
// Candidate pages (§5): hint, competitor page, probe list — capped.
// ---------------------------------------------------------------------------

const looksLikeUrl = (s) => /^https?:\/\//i.test(String(s || '').trim());

/** URLs worth fetching for a domain, own-host only, deduped, uncapped (the fetch loop caps). */
function candidateUrls(host, { touches = [], competitorUrls = [], existingPaths = [] } = {}) {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const s = String(raw || '').trim();
    if (!looksLikeUrl(s)) return;
    if (canonicalProspectDomain(s) !== host) return; // never fetch off-domain
    const key = registry.normalizeSubmissionUrl(s);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  push(`https://${host}`);
  for (const t of touches) push(t.source_detail);
  for (const u of competitorUrls) push(u);
  for (const p of existingPaths) push(p.submission_url);
  for (const p of PROBE_PATHS) push(`https://${host}${p}`);
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
const EXECUTION_INPUTS = Object.freeze(['account_required', 'email_verification', 'agent_completable', 'legal_attestation', 'legal_terms_hash', 'execution_after_send']);

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
  const conf = Number(p.confidence);
  const c = Number.isFinite(conf) ? conf : 0;
  return c * (TYPE_WEIGHT[p.acquisition_type] || 0.3) * (p.payment_required ? 0.8 : 1);
};

/** 0–100 registry score + human-readable reasons from enrichment × best path confidence. */
function scoreDomain(domain, bestPath) {
  const dr = Number.isFinite(Number(domain.domain_rating)) ? Number(domain.domain_rating) : null;
  const spam = Number.isFinite(Number(domain.spam_score)) ? Number(domain.spam_score) : null;
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
    const rows = await db('seo_link_domains').whereIn('id', domainIds).select('*');
    return (rows || []).map((domain) => ({ domain, claimState: CLAIMABLE_STATES.includes(domain.agent_state) || (domain.agent_state === 'watching') }));
  }
  const seen = new Set();
  const out = [];
  const take = (rows, claimState) => {
    for (const domain of rows || []) {
      if (seen.has(domain.id) || out.length >= limit) return;
      seen.add(domain.id);
      out.push({ domain, claimState });
    }
  };
  const seedFirst = (q) => q.orderByRaw("CASE WHEN discovery_priority = 'owner_seed' THEN 0 ELSE 1 END").orderBy('created_at', 'asc').limit(limit);
  take(await seedFirst(db('seo_link_domains').whereIn('agent_state', CLAIMABLE_STATES).select('*')), true);
  if (out.length < limit) {
    take(await seedFirst(db('seo_link_domains').where('agent_state', 'watching').where('watch_recheck_at', '<=', now).select('*')), true);
  }
  const notSeen = (q) => ([...seen].length ? q.whereNotIn('d.id', [...seen]) : q);
  if (out.length < limit) {
    // Never-investigated active paths (baseline imports on acquired domains
    // included, §5): refreshed WITHOUT touching the domain's aggregate state.
    const rows = await notSeen(db('seo_link_domains as d')
      .join('seo_link_acquisition_paths as p', 'p.domain_id', 'd.id')
      .whereNull('p.superseded_by').whereNull('p.last_investigated_at'))
      .groupBy('d.id')
      .select('d.*')
      .orderByRaw("CASE WHEN d.discovery_priority = 'owner_seed' THEN 0 ELSE 1 END")
      .orderBy('d.created_at', 'asc')
      .limit(limit);
    take(rows, false);
  }
  if (out.length < limit) {
    const cutoff = new Date(now.getTime() - REINVESTIGATE_AFTER_DAYS * 24 * 60 * 60 * 1000);
    const rows = await notSeen(db('seo_link_domains as d')
      .join('seo_link_acquisition_paths as p', 'p.domain_id', 'd.id')
      .whereNull('p.superseded_by').where('p.last_investigated_at', '<', cutoff))
      .groupBy('d.id')
      .select('d.*')
      .orderByRaw('MIN(p.last_investigated_at) asc')
      .limit(limit);
    take(rows, false);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Path row assembly + write
// ---------------------------------------------------------------------------

/** Model path + derived fields → the seo_link_acquisition_paths column set. */
function pathRowFrom(modelPath, { legalTermsHash, now, evidence }) {
  const currency = deriveCurrency(modelPath);
  return {
    acquisition_type: modelPath.acquisition_type,
    submission_url: modelPath.submission_url || null,
    estimated_cost_cents: centsFor(currency, modelPath.price_text),
    renewal_cost_cents: centsFor(currency, modelPath.renewal_price_text),
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
async function upsertPath(trx, domainId, row, { replacesPathId = null, now }) {
  const existing = await trx('seo_link_acquisition_paths')
    .where({ domain_id: domainId, path_key: row.path_key }).whereNull('superseded_by').first('*');
  if (existing) {
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
    return existing.id;
  }
  await trx('seo_link_acquisition_paths')
    .insert({ domain_id: domainId, ...row })
    .onConflict(trx.raw('(domain_id, path_key) WHERE superseded_by IS NULL')).ignore();
  const inserted = await trx('seo_link_acquisition_paths')
    .where({ domain_id: domainId, path_key: row.path_key }).whereNull('superseded_by').first('id');
  const newId = inserted && inserted.id;
  // §3.2 supersession, step-3 minimal form (nothing executes yet — no
  // purchases, approvals or authority instances exist to pin or carry):
  // mark the matched predecessor superseded and repoint its placements.
  if (newId && replacesPathId) {
    const old = await trx('seo_link_acquisition_paths')
      .where({ id: replacesPathId, domain_id: domainId }).whereNull('superseded_by').first('id');
    if (old && old.id !== newId) {
      await trx('seo_link_acquisition_paths').where({ id: old.id }).update({ superseded_by: newId, superseded_at: now, updated_at: now });
      await trx('seo_link_prospects').where({ path_id: old.id }).update({ path_id: newId, updated_at: now });
    }
  }
  return newId;
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
  const targets = await selectTargets(db, { domainIds, limit, now });
  const out = {
    dryRun, gated, selected: targets.length, investigated: 0, qualified: 0,
    notReproducible: 0, watching: 0, pathRefreshes: 0, pathsWritten: 0,
    superseded: 0, failed: [], fetches: 0, llmCalls: 0,
  };
  if (gated || dryRun || !targets.length) {
    if (dryRun && !gated) {
      out.wouldFetch = targets.length * MAX_FETCHES_PER_DOMAIN;
      out.wouldCall = targets.length;
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
        if (claimState && domain.agent_state !== 'investigating') {
          await db('seo_link_domains').where({ id: domain.id }).update({ agent_state: 'investigating', updated_at: now });
        }

        const [touches, existingPaths, competitorRows] = await Promise.all([
          db('seo_link_domain_sources').where({ domain_id: domain.id }).select('source', 'source_detail', 'source_ref'),
          db('seo_link_acquisition_paths').where({ domain_id: domain.id }).whereNull('superseded_by').select('*'),
          db('seo_competitor_backlinks').whereIn('source_domain', [host, `www.${host}`]).limit(2).select('source_url'),
        ]);

        // Fetch phase — hardened fetcher only, capped, failures recorded.
        const urls = candidateUrls(host, { touches, competitorUrls: (competitorRows || []).map((r) => r.source_url), existingPaths });
        const pages = [];
        const fetchErrors = [];
        for (const url of urls) {
          if (pages.length + fetchErrors.length >= MAX_FETCHES_PER_DOMAIN) break;
          out.fetches += 1;
          const page = await fetcher(url);  
          if (page && page.html && !page.blocked && !page.error) {
            pages.push({ url: page.finalUrl || url, status: page.status, excerpt: canonicalizeTerms(page.html).slice(0, PAGE_EXCERPT_CHARS) });
          } else {
            fetchErrors.push({ url, reason: (page && (page.error || (page.blocked && 'blocked'))) || `status_${page && page.status}` });
          }
        }

        // Reason phase — one WORKHORSE call, one repair retry.
        const sources = [...new Set(touches.map((t) => t.source))];
        const prompt = buildPrompt({ host, pages, existingPaths, sources });
        const res = await investigateWithModel(llmDispatch, prompt);
        out.llmCalls += res.calls || 1;
        if (!res.ok) {
          out.failed.push({ id: domain.id, domain: host, reason: res.reason });
          continue; // stays `investigating`; a later sweep retries
        }
        const verdict = res.data;
        const validIds = new Set(existingPaths.map((p) => p.id));
        // Paths of type not_reproducible/unknown carry no executable identity —
        // they live in the evidence, never as rows (§6.3 marks them INVALID).
        const writable = (verdict.paths || []).filter((p) => p.acquisition_type !== 'not_reproducible' && p.acquisition_type !== 'unknown');

        // Legal terms: fetch + hash within the remaining budget (§3.2).
        const termsHashByUrl = new Map();
        for (const p of writable) {
          if (!p.legal_attestation || !p.legal_terms_url || termsHashByUrl.has(p.legal_terms_url)) continue;
          if (pages.length + fetchErrors.length + termsHashByUrl.size >= MAX_FETCHES_PER_DOMAIN) break;
          out.fetches += 1;
          const t = await fetcher(p.legal_terms_url);  
          if (t && t.html && !t.blocked && !t.error) termsHashByUrl.set(p.legal_terms_url, sha256(canonicalizeTerms(t.html)));
        }

        // Write phase — one transaction per domain.
        await db.transaction(async (trx) => {
          const writtenIds = [];
          for (const p of writable) {
            const evidence = {
              investigated_at: now.toISOString(),
              price_text: p.price_text, price_page_url: p.price_page_url,
              renewal_price_text: p.renewal_price_text, renewal_price_page_url: p.renewal_price_page_url,
              currency_evidence: p.currency_evidence, legal_terms_url: p.legal_terms_url,
              reasons: p.reasons, quotes: p.quotes,
              pages_fetched: pages.map((pg) => pg.url), fetch_errors: fetchErrors,
            };
            const row = pathRowFrom(p, { legalTermsHash: p.legal_terms_url ? termsHashByUrl.get(p.legal_terms_url) : null, now, evidence });
            const replaces = p.replaces_path_id && validIds.has(p.replaces_path_id) ? p.replaces_path_id : null;
            const id = await upsertPath(trx, domain.id, row, { replacesPathId: replaces, now });
            if (id) {
              writtenIds.push(id);
              out.pathsWritten += 1;
              if (replaces) out.superseded += 1;
            }
          }
          // Every active path of the domain was an input to this pass — stamp
          // them all so baselines leave the §5 selector even when the model
          // proposed a different key for the real path.
          await trx('seo_link_acquisition_paths').where({ domain_id: domain.id }).whereNull('superseded_by').update({ last_investigated_at: now, updated_at: now });

          // Finish the domain: best path, score, verdict.
          const active = await trx('seo_link_acquisition_paths').where({ domain_id: domain.id }).whereNull('superseded_by').where({ baseline: false }).select('*');
          const ranked = active.map((p) => ({ p, v: pathValue(p) })).sort((a, b) => b.v - a.v);
          const best = ranked.length ? ranked[0].p : null;
          const { score, reasons } = scoreDomain(domain, best);
          const watchNote = claimState && verdict.verdict === 'watching' && verdict.watch_reason ? ` · watching: ${verdict.watch_reason}` : '';
          const patch = { best_path_id: best ? best.id : null, score, score_reasons: `${reasons}${watchNote}`, updated_at: now };
          if (claimState) {
            patch.agent_state = verdict.verdict === 'qualified' ? 'qualified' : verdict.verdict === 'watching' ? 'watching' : 'not_reproducible';
            patch.watch_recheck_at = verdict.verdict === 'watching' ? new Date(now.getTime() + WATCH_RECHECK_DAYS * 24 * 60 * 60 * 1000) : null;
          }
          await trx('seo_link_domains').where({ id: domain.id }).update(patch);
        });

        out.investigated += 1;
        if (!claimState) out.pathRefreshes += 1;
        else if (verdict.verdict === 'qualified') out.qualified += 1;
        else if (verdict.verdict === 'watching') out.watching += 1;
        else out.notReproducible += 1;
      } catch (err) {
        logger.error(`[link-investigator] ${domain.domain}: ${err.message}`);
        out.failed.push({ id: domain.id, domain: domain.domain, reason: `error: ${err.message}` });
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
  _internals: {
    deriveCurrency, centsFor, candidateUrls, buildPrompt, investigateWithModel,
    selectTargets, pathRowFrom, upsertPath, changedInputs, scoreDomain, pathValue,
    canonicalizeTerms, batchSize, SYSTEM_PROMPT, TYPE_WEIGHT,
    PAYMENT_INPUTS, COMMUNICATION_INPUTS, EXECUTION_INPUTS, CLAIMABLE_STATES,
  },
};

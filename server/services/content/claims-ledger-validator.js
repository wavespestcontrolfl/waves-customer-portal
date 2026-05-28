/**
 * claims-ledger-validator.js — validates the claimsLedger a writer agent
 * emits alongside an optimized draft.
 *
 * The claims ledger is the audit trail that lets us prove every local claim in
 * generated copy traces to a verified fact. This validator checks:
 *   1. Each ledger entry's factIds exist in the facts-bank for this combo (P0
 *      if the model cites a fact that does not exist — a hallucinated source).
 *   2. The claim does not assert MORE certainty than its backing facts support
 *      (P2 — "ghost ants are common" backed by a directional fact must not
 *      become "ghost ants are the MOST common pest").
 *   3. Superlative / absolute language ("most", "always", "guaranteed",
 *      "#1", "eliminate") is only allowed when ALL backing facts are verified.
 *   4. The claim text actually appears in the body (P2 — ledger/body drift).
 *   5. The body does not contain phrases the facts-bank explicitly disallows
 *      (heuristic, P2 — surfaced for human review).
 *
 * It is split into a PURE core (validateLedger — no I/O, fully testable) and a
 * loader-backed convenience wrapper (validate — pulls facts for a city ×
 * service × county and calls the core).
 *
 * Severity model matches seo-completion-gate: P0/P1 reject, P2 warns. Missing
 * ledger severity is configurable (CLAIMS_LEDGER_MISSING_SEVERITY, default P2)
 * so this can be enabled before the writer agents are updated to emit ledgers,
 * then escalated to P0 once they do.
 */

const loader = require('../content-astro/facts-bank-loader');
const auditor = require('../content-astro/facts-bank-auditor');
const logger = require('../logger');

const STRENGTH_RANK = { verified: 3, partially_verified: 2, directional: 1, unverified: 0 };

// Absolute / superlative language that requires fully-verified backing.
const SUPERLATIVE_RE = /\b(most|always|never|all|every|guaranteed?|#1|number one|the best|fastest|only|100%|eliminat\w*|eradicat\w*|permanent\w*)\b/i;

const MISSING_LEDGER_SEVERITY = (process.env.CLAIMS_LEDGER_MISSING_SEVERITY || 'P2').toUpperCase();

function finding(severity, code, message, extra = {}) {
  return { severity, code, message, ...extra };
}

function normalizeText(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function strengthRank(s) {
  return STRENGTH_RANK[s] ?? 0;
}

/**
 * Derive crude trigger phrases from a prose disallowed-claim instruction so we
 * can heuristically flag obvious violations in the body. Example:
 *   "Do not claim same-day availability for Venice" → ["same-day availability"]
 * This is best-effort: it strips the "Do not (claim|mention|infer|...)" lead
 * and lifts the remaining distinctive noun phrase. Findings are P2 (review).
 */
function disallowedTriggers(pattern) {
  let p = normalizeText(pattern);
  // Strip the leading instruction verb ("do not claim/mention/...").
  p = p.replace(/^do not\s+(claim|mention|infer|state|imply|say|generate|use|put)\s+/i, '');
  // Cut at trailing qualifier clauses (note: do NOT split on "-", it breaks
  // hyphenated phrases like "same-day").
  p = p.split(/\s+(?:unless|without|until|except|because)\b/)[0];
  p = p.split(/\s+—\s+/)[0];
  // Drop a trailing "for <something>" target ("for Venice", "for any customer").
  p = p.replace(/\s+for\s+\w[\w\s'-]*$/i, '');
  p = p.trim();
  // Only keep multi-word clauses with signal; single common words are noise.
  if (p.split(' ').length < 2) return [];
  return [p];
}

/**
 * validateLedger({ claimsLedger, body, factsById, disallowedPatterns, options })
 * → { pass, findings, checked }
 *
 * Pure. `factsById` is a Map/object of fact_id → fact object (merged from
 * city + service + county). `disallowedPatterns` is the merged array of prose
 * instructions. No I/O.
 */
function validateLedger({ claimsLedger, body, factsById = {}, disallowedPatterns = [], options = {} } = {}) {
  const findings = [];
  const factIndex = factsById instanceof Map ? factsById : new Map(Object.entries(factsById || {}));
  const bodyNorm = normalizeText(body);
  const missingSeverity = options.missingLedgerSeverity || MISSING_LEDGER_SEVERITY;

  const ledger = Array.isArray(claimsLedger) ? claimsLedger : [];

  // 0. No ledger at all.
  if (ledger.length === 0) {
    findings.push(finding(missingSeverity, 'CLAIMS_LEDGER_MISSING',
      'Draft has no claimsLedger; cannot audit local claims to facts.'));
    return { pass: !hasBlocking(findings), findings, checked: 0 };
  }

  for (const entry of ledger) {
    const claimText = entry?.claim || '';
    const claimNorm = normalizeText(claimText);
    const factIds = Array.isArray(entry?.factIds) ? entry.factIds : [];

    // 1. Must cite at least one fact.
    if (factIds.length === 0) {
      findings.push(finding('P1', 'CLAIM_NO_FACT_IDS', `Claim cites no factIds: "${truncate(claimText)}"`, { claim: claimText }));
      continue;
    }

    // 2. Every cited fact must exist.
    const backingFacts = [];
    let hadUnknown = false;
    for (const fid of factIds) {
      const fact = factIndex.get(fid);
      if (!fact) {
        hadUnknown = true;
        findings.push(finding('P0', 'CLAIM_CITES_UNKNOWN_FACT',
          `Claim cites fact_id "${fid}" that does not exist in the facts-bank: "${truncate(claimText)}"`,
          { claim: claimText, fact_id: fid }));
      } else {
        backingFacts.push(fact);
      }
    }
    if (hadUnknown || backingFacts.length === 0) continue;

    // 3. Strength: a claim may not assert more certainty than its strongest
    //    backing fact. Declared claim strength (if present) is checked against
    //    the max backing strength.
    const maxBackingRank = Math.max(...backingFacts.map((f) => strengthRank(f.evidence_strength)));
    if (entry.strength && strengthRank(entry.strength) > maxBackingRank) {
      findings.push(finding('P2', 'CLAIM_STRENGTH_OVERREACH',
        `Claim asserts "${entry.strength}" but backing facts top out at rank ${maxBackingRank}: "${truncate(claimText)}"`,
        { claim: claimText }));
    }

    // 4. Superlative / absolute language requires fully-verified backing.
    if (SUPERLATIVE_RE.test(claimText) && maxBackingRank < STRENGTH_RANK.verified) {
      findings.push(finding('P2', 'CLAIM_SUPERLATIVE_UNVERIFIED',
        `Claim uses absolute/superlative language without fully-verified backing: "${truncate(claimText)}"`,
        { claim: claimText }));
    }

    // 5. The claim should correspond to body content (drift check). We look
    //    for a meaningful overlap, not exact match.
    if (bodyNorm && claimNorm && !bodyOverlaps(bodyNorm, claimNorm)) {
      findings.push(finding('P2', 'CLAIM_NOT_IN_BODY',
        `Claim in ledger does not appear to match body content: "${truncate(claimText)}"`,
        { claim: claimText }));
    }
  }

  // 6. Disallowed phrases in body (heuristic, review-only).
  for (const pattern of disallowedPatterns) {
    for (const trigger of disallowedTriggers(pattern)) {
      if (bodyNorm.includes(trigger)) {
        findings.push(finding('P2', 'DISALLOWED_PHRASE_SUSPECTED',
          `Body may contain a disallowed claim ("${trigger}") — facts-bank rule: "${truncate(pattern)}"`,
          { trigger }));
      }
    }
  }

  return { pass: !hasBlocking(findings), findings, checked: ledger.length };
}

// A claim "overlaps" the body if a run of 4+ consecutive significant words from
// the claim appears in the body (tolerates light rephrasing).
function bodyOverlaps(bodyNorm, claimNorm) {
  if (bodyNorm.includes(claimNorm)) return true;
  const words = claimNorm.split(' ').filter((w) => w.length > 3);
  if (words.length < 4) {
    // Short claim — require all significant words present.
    return words.every((w) => bodyNorm.includes(w));
  }
  for (let i = 0; i + 4 <= words.length; i++) {
    if (bodyNorm.includes(words.slice(i, i + 4).join(' '))) return true;
  }
  // Fallback: ≥60% of significant words present.
  const present = words.filter((w) => bodyNorm.includes(w)).length;
  return present / words.length >= 0.6;
}

function hasBlocking(findings) {
  return findings.some((f) => f.severity === 'P0' || f.severity === 'P1');
}

function truncate(s, n = 120) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// ── loader-backed convenience wrapper ───────────────────────────────

/**
 * validate(draft, { city, service, county }, opts) → { pass, findings, checked }
 *
 * Loads the facts for the combo, merges fact indexes + disallowed patterns,
 * extracts body + claimsLedger from the draft, and runs validateLedger.
 *
 * `draft.claimsLedger` is the agent output; `draft.body` (or draft.content) is
 * the generated body. city/service/county are facts-bank entity ids (already
 * normalized by facts-sufficiency).
 */
async function validate(draft, { city, service, county = null }, opts = {}) {
  const [cityFile, serviceFile] = await Promise.all([
    city ? loader.loadCity(city, opts) : null,
    service ? loader.loadService(service, opts) : null,
  ]);
  const countyId = county || cityFile?.county || null;
  const countyFile = countyId ? await loader.loadCounty(countyId, opts) : null;

  // Index ONLY copy-usable facts (public, public_copy_allowed, copy-safe
  // evidence, not expired). A claim citing an internal_only / prompt-only /
  // expired fact id must fail as CLAIM_CITES_UNKNOWN_FACT — published copy may
  // only assert facts that are safe for published copy, matching the facts_pack
  // guarantee the agent was given.
  const factsById = {};
  const disallowed = [];
  for (const file of [cityFile, serviceFile, countyFile]) {
    if (!file || file.ok === false) continue;
    for (const fact of loader.usableFacts(file, { purpose: 'copy' })) {
      if (fact?.id) factsById[fact.id] = fact;
    }
    for (const p of file.disallowed_claim_patterns || []) disallowed.push(p);
  }

  return validateLedger({
    claimsLedger: draft?.claimsLedger || draft?.claims_ledger,
    body: draft?.body || draft?.content || '',
    factsById,
    disallowedPatterns: disallowed,
    options: opts.options || {},
  });
}

module.exports = {
  validate,
  validateLedger,
  // exposed for tests / tuning
  disallowedTriggers,
  bodyOverlaps,
  STRENGTH_RANK,
  SUPERLATIVE_RE,
};

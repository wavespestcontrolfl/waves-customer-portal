/**
 * Email bounce → transcript rescue (email-bounce-recovery v2, local parts).
 *
 * bounce-recovery corrects DOMAIN typos only (gmial→gmail). The 2026-08-05
 * manual sweep of 36 active bounce suppressions showed the LOCAL part is
 * recoverable too when anchored to evidence we already hold: the customer's
 * own inbound email, the extractor's output on other calls, or the spelled
 * letters in the transcript ("T R Y A L S 24", "w like whiskey"). 9 of 36
 * were fixed that way by hand; this service productionizes the sweep.
 *
 * Evidence tiers (higher wins; only A/B ever auto-apply):
 *   A 'inbound_ground_truth'  — an address the customer has EMAILED US FROM
 *                               that is a near-miss of the bounced one.
 *   B 'domain_repair'         — mechanical: a TLD-less stored domain gets
 *                               `.com` tried; known domain typos
 *                               (gmial→gmail) via email-typo-correction.
 *   B 'extractor_consensus'   — call_log extraction/transcript sightings:
 *                               seen on ≥2 calls, or a near-miss variant of
 *                               the bounced address, or captured on a LATER
 *                               call (correction callback).
 *   C 'transcript_decode'     — reconstruction from spelled letters
 *                               (deterministic letter-run/phonetic decode,
 *                               plus a FAST-tier LLM pass whose supporting
 *                               quote must appear verbatim in the
 *                               transcript). SUGGEST-ONLY.
 *   D 'name_inference'        — never generated here; reserved status for
 *                               operator-entered suggestions.
 *
 * Actions (hands-off/exception-based, CLAUDE.md rule 14):
 *   - Tier A/B + all validations green → auto-apply: update customers/leads
 *     email, audit interaction, admin bell (real addresses shown — owner
 *     rule 2026-07-30: masked ops alerts "do nothing for me").
 *   - Everything else with a candidate → 'suggested' + ACT: email to
 *     contact@ carrying the evidence quote and the exact ops command that
 *     applies it (ops/agents/bounce-rescue-backfill.js --apply=<id>).
 *   - A candidate already on ANOTHER customer → duplicate signal, never
 *     auto-apply (the Trent Ryles/Ryals dup surfaced exactly this way).
 *
 * Loop guards: UNIQUE(bounced_email) ledger row per address; candidates
 * exclude every actively-suppressed address and every candidate this
 * owner's prior rescues already tried; marketing-stream bounces never
 * enter (suppression ledger owns those).
 *
 * Kill switch: EMAIL_BOUNCE_TRANSCRIPT_RESCUE=off (default on, matching
 * EMAIL_BOUNCE_RECOVERY).
 */

const dns = require('dns').promises;
const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const MODELS = require('../config/models');
const { callAnthropic } = require('./llm/call');
const { redactEmail, correctEmailDomain, meetsConfidence } = require('../utils/email-typo-correction');

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const EMAIL_SCAN_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// The BOUNCED input only needs enough shape to work with — a truncated
// domain ("…@gmail", no TLD) is exactly the malformed-but-real class the
// domain-repair tier exists to fix, so it must not be rejected at the door.
const LOOSE_EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
const OWN_DOMAIN_RE = /@wavespestcontrol\.com$/i;
const MX_TIMEOUT_MS = 5000;
const MAX_DECODE_CONTEXTS = 6;
const DECODE_CONTEXT_LINES = 3;

function rescueEnabled() {
  return String(process.env.EMAIL_BOUNCE_TRANSCRIPT_RESCUE || '').toLowerCase() !== 'off';
}

function suggestionRecipient() {
  return String(process.env.RESCUE_SUGGESTION_EMAIL_TO || 'contact@wavespestcontrol.com').trim();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function localPart(email) {
  return normalizeEmail(email).split('@')[0] || '';
}

function domainPart(email) {
  return normalizeEmail(email).split('@')[1] || '';
}

// Small-string Levenshtein — inputs are email local parts / addresses.
function editDistance(a, b) {
  const s = String(a || ''); const t = String(b || '');
  if (s === t) return 0;
  const prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (s[i - 1] === t[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[t.length];
}

// ── deterministic transcript decode ─────────────────────────────────

// Letter runs the way people spell on calls: "J-U-D-Y-B-O-D-M-E-R",
// "T R Y A L S", "B-Y-R-D". 4+ single letters separated by spaces/hyphens/
// dots/commas (transcribers vary), tolerant of the separators mixing. The
// apostrophe lookbehind keeps contractions out of the run — without it,
// "it's K-A-R-R-E-N…" donates a leading "s" (real prod dry-run artifact).
const LETTER_RUN_RE = /\b(?<!')(?:[a-z][\s\-.,]+){3,}[a-z]\b/gi;
// NATO-ish phonetic spelling: "w like whiskey", "c as in charlie",
// "zero zero as in zebra" is NOT matched — only single-letter anchors.
const PHONETIC_RE = /\b([a-z])\s+(?:like|as)\s+(?:in\s+)?[a-z]+/gi;

function lettersFromRun(run) {
  return run.replace(/[^a-z]/gi, '').toLowerCase();
}

/**
 * Deterministic candidates from one transcript's spelled segments, anchored
 * to the known-wrong bounced address:
 *  - a letter run R that is a near-miss (edit ≤2) of the bounced local's
 *    alpha core proposes R + the bounced local's digit tail @ same domain
 *    (Judy: run JUDYBODMER vs judyboedmer → judybodmer@gmail.com;
 *     Trent: run TRYALS vs tryles + '24' → tryals24@icloud.com).
 *  - phonetic letters + a digit tail heard adjacent propose exactly that
 *    local (Jimenez: w,c,w + '63' → wcw63@gmail.com) when it is a near-miss
 *    superset of the bounced local.
 */
function decodeSpelledCandidates(transcription, bouncedEmail) {
  const text = String(transcription || '');
  const bLocal = localPart(bouncedEmail);
  const bDomain = domainPart(bouncedEmail);
  if (!bLocal || !bDomain) return [];
  const alphaCore = bLocal.replace(/[^a-z]/g, '');
  const digitTail = (bLocal.match(/\d+$/) || [''])[0];
  const out = [];

  for (const m of text.match(LETTER_RUN_RE) || []) {
    const run = lettersFromRun(m);
    if (run.length < 4 || run === alphaCore) continue;
    if (editDistance(run, alphaCore) > 2) continue;
    const candidate = `${run}${digitTail}@${bDomain}`;
    out.push({ email: candidate, quote: m.trim() });
  }

  const phonetic = [...text.matchAll(PHONETIC_RE)].map((m) => m[1].toLowerCase());
  if (phonetic.length >= 2) {
    const candidate = `${phonetic.join('')}${digitTail}@${bDomain}`;
    if (localPart(candidate) !== bLocal
      && editDistance(localPart(candidate), bLocal) <= 2) {
      out.push({ email: candidate, quote: (text.match(PHONETIC_RE) || []).join(' … ') || 'phonetic spelling' });
    }
  }
  return out;
}

// Context windows around email talk — the input for the LLM decode.
function extractSpelledContexts(transcription) {
  const lines = String(transcription || '').split(/\n/);
  const contexts = [];
  lines.forEach((line, i) => {
    if (!/e-?mail|@|\bdot\b\s*(com|net|org|edu)/i.test(line)) return;
    contexts.push(lines.slice(Math.max(0, i - 1), i + DECODE_CONTEXT_LINES).join('\n'));
  });
  return contexts.slice(0, MAX_DECODE_CONTEXTS);
}

/**
 * FAST-tier LLM decode for the spellings deterministic code can't reach
 * ("o-h-a-t-b, abbreviation for Our House At The Beach"). The model output
 * is UNTRUSTED: its supporting quote must appear verbatim in the transcript
 * and the candidate is still revalidated (syntax/MX/suppression/collision)
 * before it can even be SUGGESTED. Decode failures degrade to "no tier-C
 * candidate" — the deterministic tiers still ran.
 */
async function llmDecodeCandidate({ contexts, bouncedEmail, transcription }) {
  if (!contexts.length || !process.env.ANTHROPIC_API_KEY) return null;
  const res = await callAnthropic({
    model: MODELS.FAST,
    system: [
      'You reconstruct email addresses that a phone-call transcriber mis-heard.',
      'The stored address is KNOWN WRONG (it hard-bounced). Use only the spelled',
      'letters, phonetic hints ("w like whiskey"), and stated abbreviations in the',
      'transcript excerpts. Reply as JSON: {"candidate_email": string|null,',
      '"supporting_quote": string} where supporting_quote is copied VERBATIM from',
      'the excerpts. If the excerpts do not determine a correction, candidate_email is null.',
    ].join(' '),
    text: `Known-wrong address: ${bouncedEmail}\n\nTranscript excerpts:\n${contexts.join('\n---\n')}`,
    jsonMode: true,
    maxTokens: 1024,
  }).catch((err) => {
    logger.warn(`[email-bounce-rescue] LLM decode failed: ${err.message}`);
    return null;
  });
  const candidate = normalizeEmail(res?.ok ? res.json?.candidate_email : null);
  const quote = String(res?.ok ? res.json?.supporting_quote || '' : '');
  if (!candidate || !EMAIL_RE.test(candidate) || candidate === normalizeEmail(bouncedEmail)) return null;
  // Anchor check: the quote must really be in the transcript (whitespace-
  // normalized) — an invented quote invalidates the decode.
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!quote || !norm(transcription).includes(norm(quote))) return null;
  return { email: candidate, quote };
}

// ── candidate gathering ─────────────────────────────────────────────

/**
 * Mechanical domain repairs, MX-verified downstream like everything else:
 *  - a domain with no dot is a truncation — try `.com` ("brandon.post00@gmail"
 *    was a real prod row; the .com variant was the working address).
 *  - the existing domain-typo corrector (gmial→gmail) applied to the whole
 *    address. Both are deterministic, so the tier is auto-apply eligible.
 */
function domainRepairCandidates(bouncedEmail) {
  const out = [];
  const local = localPart(bouncedEmail);
  const domain = domainPart(bouncedEmail);
  if (!local || !domain) return out;
  if (!domain.includes('.')) {
    out.push({ email: `${local}@${domain}.com`, quote: `stored domain "${domain}" has no TLD — truncation repair` });
  } else {
    const result = correctEmailDomain(bouncedEmail);
    if (result?.corrected && normalizeEmail(result.corrected) !== bouncedEmail && meetsConfidence(result.confidence, 'high')) {
      out.push({ email: normalizeEmail(result.corrected), quote: `domain typo repair (${result.rule}, ${result.confidence} confidence)` });
    }
  }
  return out;
}

async function findOwner(bouncedEmail) {
  const customer = await db('customers')
    .whereRaw('LOWER(email) = ?', [bouncedEmail])
    .whereNull('deleted_at')
    .first();
  if (customer) return { customer, lead: null };
  const lead = await db('leads')
    .whereRaw('LOWER(email) = ?', [bouncedEmail])
    .whereNull('deleted_at')
    .first();
  return { customer: null, lead };
}

async function inboundGroundTruth(bouncedEmail) {
  // Same-domain inbound senders, near-miss of the bounced address (Ronnie:
  // inbound ronnir@ vs bounced ronnier@). Domain-scoped so we never scan
  // the whole inbound table.
  const domain = domainPart(bouncedEmail);
  if (!domain) return [];
  const rows = await db('emails')
    .whereRaw("LOWER(split_part(from_address, '@', 2)) = ?", [domain])
    .distinct('from_address')
    .limit(50)
    .catch(() => []);
  return rows
    .map((r) => normalizeEmail(r.from_address))
    .filter((e) => EMAIL_RE.test(e) && e !== bouncedEmail && !OWN_DOMAIN_RE.test(e))
    .filter((e) => editDistance(e, bouncedEmail) <= 2)
    .map((email) => ({ email, quote: `inbound email received from ${email}` }));
}

async function callSightings(phone) {
  if (!phone) return [];
  const calls = await db('call_log')
    .where((q) => q.where('from_phone', phone).orWhere('to_phone', phone))
    .whereNotNull('transcription')
    .orderBy('created_at')
    .select('id', 'created_at', 'transcription', 'ai_extraction')
    .catch(() => []);
  const sightings = [];
  for (const call of calls) {
    const seen = new Set();
    const scan = (text, source) => {
      for (const m of String(text || '').match(EMAIL_SCAN_RE) || []) {
        const email = normalizeEmail(m);
        if (OWN_DOMAIN_RE.test(email) || seen.has(`${email}:${source}`)) continue;
        seen.add(`${email}:${source}`);
        sightings.push({ email, callId: call.id, callAt: call.created_at, source });
      }
    };
    scan(call.transcription, 'transcript');
    scan(typeof call.ai_extraction === 'string' ? call.ai_extraction : JSON.stringify(call.ai_extraction || {}), 'extraction');
  }
  return { sightings, calls };
}

function consensusCandidates(sightings, bouncedEmail) {
  const byEmail = new Map();
  for (const s of sightings) {
    if (s.email === bouncedEmail) continue;
    if (!byEmail.has(s.email)) byEmail.set(s.email, []);
    byEmail.get(s.email).push(s);
  }
  const bouncedFirstSeen = sightings
    .filter((s) => s.email === bouncedEmail)
    .reduce((min, s) => (!min || s.callAt < min ? s.callAt : min), null);
  const out = [];
  for (const [email, list] of byEmail) {
    if (!EMAIL_RE.test(email)) continue;
    const distinctCalls = new Set(list.map((s) => String(s.callId))).size;
    const nearMiss = domainPart(email) === domainPart(bouncedEmail)
      && editDistance(localPart(email), localPart(bouncedEmail)) <= 2;
    const laterCorrection = bouncedFirstSeen
      && list.some((s) => s.source === 'extraction' && s.callAt > bouncedFirstSeen);
    if (distinctCalls >= 2 || nearMiss || laterCorrection) {
      out.push({
        email,
        quote: `seen on ${distinctCalls} call(s)${nearMiss ? ', near-miss of the bounced address' : ''}${laterCorrection ? ', captured on a later call' : ''}`,
        distinctCalls,
      });
    }
  }
  // Most-corroborated first.
  return out.sort((a, b) => b.distinctCalls - a.distinctCalls);
}

// ── validation ──────────────────────────────────────────────────────

async function mxResolves(domain) {
  let timer;
  try {
    const records = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('mx_timeout')), MX_TIMEOUT_MS); }),
    ]);
    return Array.isArray(records) && records.length > 0;
  } catch (err) {
    // NXDOMAIN/no-MX = definitively bad; DNS infra trouble = unknown.
    if (['ENOTFOUND', 'ENODATA'].includes(err.code)) return false;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function validateCandidate(candidate, { bouncedEmail, ownerCustomerId, ownerLeadId }) {
  const email = normalizeEmail(candidate);
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'syntax' };
  if (email === normalizeEmail(bouncedEmail)) return { ok: false, reason: 'same_as_bounced' };
  const suppressed = await db('email_suppressions')
    .whereRaw('LOWER(email) = ?', [email]).where({ status: 'active' }).first();
  if (suppressed) return { ok: false, reason: 'candidate_suppressed' };
  const triedBefore = await db('email_bounce_rescues')
    .whereRaw('LOWER(candidate_email) = ?', [email])
    .where((q) => {
      if (ownerCustomerId) q.orWhere('customer_id', ownerCustomerId);
      if (ownerLeadId) q.orWhere('lead_id', ownerLeadId);
      if (!ownerCustomerId && !ownerLeadId) q.whereRaw('1 = 0');
    })
    .first().catch(() => null);
  if (triedBefore) return { ok: false, reason: 'already_tried' };
  const otherCustomer = await db('customers')
    .whereRaw('LOWER(email) = ?', [email]).whereNull('deleted_at').first();
  if (otherCustomer && otherCustomer.id !== ownerCustomerId) {
    return { ok: false, reason: 'collision', collisionCustomerId: otherCustomer.id };
  }
  const mx = await mxResolves(domainPart(email));
  if (mx === false) return { ok: false, reason: 'no_mx' };
  // mx === null (DNS trouble) is not a hard fail — but it does demote an
  // auto-apply to a suggestion (fail toward the human).
  return { ok: true, mxUnknown: mx === null };
}

// ── actions ─────────────────────────────────────────────────────────

async function applyFix({ bouncedEmail, candidate, owner, tier, evidence, appliedBy }) {
  return db.transaction(async (trx) => {
    let customersUpdated = 0;
    if (owner.customer) {
      customersUpdated = await trx('customers')
        .where({ id: owner.customer.id })
        .whereRaw('LOWER(email) = ?', [bouncedEmail])
        .update({ email: candidate, updated_at: new Date() });
      if (customersUpdated !== 1) {
        // The address moved under us (operator edit mid-rescue) — abort.
        throw Object.assign(new Error('owner email changed mid-rescue'), { code: 'STALE_OWNER' });
      }
    }
    const leadsUpdated = await trx('leads')
      .whereRaw('LOWER(email) = ?', [bouncedEmail])
      .whereNull('deleted_at')
      .update({ email: candidate, updated_at: new Date() });
    if (owner.customer) {
      await trx('customer_interactions').insert({
        customer_id: owner.customer.id,
        interaction_type: 'email_outbound',
        subject: 'Bounced email auto-corrected from call evidence',
        body: `Replaced the hard-bounced address with ${candidate} (${tier}). Evidence: ${String(evidence.quote || '').slice(0, 300)}`,
        metadata: JSON.stringify({
          bounced_email: bouncedEmail, candidate_email: candidate, tier, source: 'email-bounce-rescue',
        }),
      });
    }
    return { customersUpdated, leadsUpdated };
  }).then(async (counts) => {
    const name = owner.customer
      ? `${owner.customer.first_name || ''} ${owner.customer.last_name || ''}`.trim()
      : `${owner.lead.first_name || ''} ${owner.lead.last_name || ''}`.trim();
    // Owner rule 2026-07-30: ops bells show REAL addresses.
    await NotificationService.notifyAdmin(
      'system',
      'Bounced email auto-corrected from call evidence',
      `${name}: ${bouncedEmail} bounced; corrected to ${candidate} (${tier}). If this bounces too, a suppression bell will follow.`,
      {
        link: owner.customer ? `/admin/customers?customerId=${owner.customer.id}` : '/admin/leads',
        metadata: { dedupeKey: `email-rescue:${bouncedEmail}`, appliedBy },
      },
    ).catch((err) => logger.warn(`[email-bounce-rescue] bell failed: ${err.message}`));
    return counts;
  });
}

async function sendSuggestionEmail({ rescueRowId, bouncedEmail, candidate, tier, evidence, owner, reason }) {
  const email = require('./email');
  const name = owner.customer
    ? `${owner.customer.first_name || ''} ${owner.customer.last_name || ''}`.trim()
    : `${owner.lead?.first_name || ''} ${owner.lead?.last_name || ''}`.trim();
  const body = [
    `${name}'s email ${bouncedEmail} hard-bounced and could not be auto-corrected`,
    reason ? `(${reason}).` : '.',
    '',
    candidate ? `Best candidate from call evidence (${tier}): ${candidate}` : 'No confident candidate was found.',
    evidence?.quote ? `Evidence: "${String(evidence.quote).slice(0, 400)}"` : '',
    '',
    candidate
      ? `To apply it, run from the portal repo root:\n  railway run --service Postgres node ops/agents/bounce-rescue-backfill.js --apply=${rescueRowId} --execute`
      : 'Ask the customer for a working address at the next touchpoint.',
  ].filter(Boolean).join('\n');
  await email.send({
    to: suggestionRecipient(),
    subject: `ACT: bounced email fix ${candidate ? 'suggested' : 'needs a human'} — ${name || bouncedEmail}`,
    heading: 'Bounced email rescue',
    body,
  });
}

// ── main entry ──────────────────────────────────────────────────────

/**
 * Examine one hard-bounced address. Options:
 *   dryRun    — gather + validate + report, write nothing, send nothing.
 *   appliedBy — audit label for the apply path (webhook | backfill | operator).
 */
async function rescueBouncedAddress(rawEmail, { dryRun = false, appliedBy = 'webhook' } = {}) {
  if (!rescueEnabled()) return { skipped: 'disabled' };
  const bouncedEmail = normalizeEmail(rawEmail);
  if (!LOOSE_EMAIL_RE.test(bouncedEmail)) return { skipped: 'invalid_input' };

  if (!dryRun) {
    const existing = await db('email_bounce_rescues')
      .whereRaw('LOWER(bounced_email) = ?', [bouncedEmail]).first().catch(() => null);
    if (existing) return { skipped: 'already_examined', status: existing.status };
  }

  const owner = await findOwner(bouncedEmail);
  if (!owner.customer && !owner.lead) {
    if (!dryRun) await recordRescue({ bouncedEmail, status: 'skipped_no_owner' });
    return { skipped: 'no_owner' };
  }
  const phone = owner.customer?.phone || owner.lead?.phone || null;

  // Gather, tier order.
  const tiers = [];
  for (const c of await inboundGroundTruth(bouncedEmail)) {
    tiers.push({ tier: 'inbound_ground_truth', ...c });
  }
  for (const c of domainRepairCandidates(bouncedEmail)) {
    tiers.push({ tier: 'domain_repair', ...c });
  }
  const { sightings = [], calls = [] } = await callSightings(phone) || {};
  for (const c of consensusCandidates(sightings, bouncedEmail)) {
    tiers.push({ tier: 'extractor_consensus', ...c });
  }
  const transcriptAll = calls.map((c) => c.transcription).join('\n');
  for (const call of calls) {
    for (const c of decodeSpelledCandidates(call.transcription, bouncedEmail)) {
      tiers.push({ tier: 'transcript_decode', ...c });
    }
  }
  if (!tiers.some((t) => t.tier !== 'transcript_decode')) {
    const contexts = calls.flatMap((c) => extractSpelledContexts(c.transcription));
    const llm = await llmDecodeCandidate({ contexts, bouncedEmail, transcription: transcriptAll });
    if (llm) tiers.push({ tier: 'transcript_decode', ...llm, llm: true });
  }

  // First candidate that validates decides the outcome.
  let outcome = { status: 'no_candidate' };
  for (const cand of tiers) {
    const v = await validateCandidate(cand.email, {
      bouncedEmail,
      ownerCustomerId: owner.customer?.id || null,
      ownerLeadId: owner.lead?.id || null,
    });
    if (!v.ok) {
      if (v.reason === 'collision') {
        outcome = {
          status: 'suggested', tier: cand.tier, candidate: cand.email, evidence: cand,
          reason: 'candidate belongs to another customer — possible duplicate pair, review before applying',
        };
        break;
      }
      continue;
    }
    const autoTier = ['inbound_ground_truth', 'domain_repair', 'extractor_consensus'].includes(cand.tier);
    if (autoTier && !v.mxUnknown) {
      outcome = { status: 'applied', tier: cand.tier, candidate: cand.email, evidence: cand };
    } else {
      outcome = {
        status: 'suggested', tier: cand.tier, candidate: cand.email, evidence: cand,
        reason: v.mxUnknown ? 'MX could not be verified' : 'transcript decode requires a human OK',
      };
    }
    break;
  }

  if (dryRun) return { dryRun: true, bouncedEmail, owner: owner.customer?.id || owner.lead?.id, ...outcome };

  const row = await recordRescue({
    bouncedEmail,
    customerId: owner.customer?.id || null,
    leadId: owner.lead?.id || null,
    tier: outcome.tier || null,
    candidate: outcome.candidate || null,
    evidence: outcome.evidence ? { quote: outcome.evidence.quote, llm: !!outcome.evidence.llm } : {},
    status: outcome.status,
    appliedBy: outcome.status === 'applied' ? appliedBy : null,
  });
  if (!row) return { skipped: 'already_examined' }; // lost the unique race

  if (outcome.status === 'applied') {
    try {
      await applyFix({
        bouncedEmail, candidate: outcome.candidate, owner, tier: outcome.tier,
        evidence: outcome.evidence, appliedBy,
      });
      await db('email_bounce_rescues').where({ id: row.id })
        .update({ applied_at: new Date(), updated_at: new Date() });
    } catch (err) {
      // STALE_OWNER or write failure: demote the ledger row so --apply can retry.
      await db('email_bounce_rescues').where({ id: row.id })
        .update({ status: 'suggested', updated_at: new Date() });
      logger.warn(`[email-bounce-rescue] apply failed for ${redactEmail(bouncedEmail)}: ${err.message}`);
      outcome = { ...outcome, status: 'suggested', reason: `apply failed: ${err.message}` };
    }
  }
  if (outcome.status === 'suggested' || outcome.status === 'no_candidate') {
    await sendSuggestionEmail({
      rescueRowId: row.id, bouncedEmail, candidate: outcome.candidate || null,
      tier: outcome.tier || null, evidence: outcome.evidence || null, owner,
      reason: outcome.reason || null,
    }).catch((err) => logger.warn(`[email-bounce-rescue] suggestion email failed: ${err.message}`));
  }
  return { bouncedEmail, ...outcome, rescueId: row.id };
}

async function recordRescue({ bouncedEmail, customerId = null, leadId = null, tier = null, candidate = null, evidence = {}, status, appliedBy = null }) {
  try {
    const [row] = await db('email_bounce_rescues').insert({
      bounced_email: bouncedEmail,
      customer_id: customerId,
      lead_id: leadId,
      tier,
      candidate_email: candidate,
      evidence: JSON.stringify(evidence),
      status,
      applied_by: appliedBy,
    }).returning('*');
    return row;
  } catch (err) {
    // unique_violation = another path examined this address first.
    if (String(err.code) === '23505') return null;
    throw err;
  }
}

/**
 * Operator apply for a 'suggested' row (the ACT: email command). Revalidates
 * before writing — the world may have moved since the suggestion.
 */
async function applySuggestedRescue(rescueId, { appliedBy = 'operator' } = {}) {
  const row = await db('email_bounce_rescues').where({ id: rescueId }).first();
  if (!row) return { error: 'rescue row not found' };
  if (row.status === 'applied') return { error: 'already applied' };
  if (!row.candidate_email) return { error: 'row has no candidate' };
  const bouncedEmail = normalizeEmail(row.bounced_email);
  const owner = await findOwner(bouncedEmail);
  if (!owner.customer && !owner.lead) return { error: 'owner no longer carries the bounced address' };
  const v = await validateCandidate(row.candidate_email, {
    bouncedEmail,
    ownerCustomerId: owner.customer?.id || null,
    ownerLeadId: owner.lead?.id || null,
  });
  // 'already_tried' matches this row's own ledger entry by design — the
  // operator IS retrying it; every other failure still blocks.
  if (!v.ok && v.reason !== 'already_tried') return { error: `validation failed: ${v.reason}` };
  const evidence = typeof row.evidence === 'string' ? JSON.parse(row.evidence || '{}') : (row.evidence || {});
  const counts = await applyFix({
    bouncedEmail, candidate: normalizeEmail(row.candidate_email), owner,
    tier: row.tier, evidence, appliedBy,
  });
  await db('email_bounce_rescues').where({ id: row.id })
    .update({ status: 'applied', applied_at: new Date(), applied_by: appliedBy, updated_at: new Date() });
  return { applied: true, candidate: normalizeEmail(row.candidate_email), ...counts };
}

module.exports = {
  rescueEnabled,
  rescueBouncedAddress,
  applySuggestedRescue,
  // exported for unit tests — pure/deterministic pieces
  editDistance,
  decodeSpelledCandidates,
  extractSpelledContexts,
  consensusCandidates,
  validateCandidate,
};

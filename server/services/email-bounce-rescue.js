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
 * Evidence tiers:
 *   'domain_repair'         — mechanical: a TLD-less stored domain gets
 *                             `.com` tried; known domain typos via
 *                             email-typo-correction. AUTO-APPLY eligible.
 *   'inbound_ground_truth'  — a near-miss address the customer has EMAILED
 *                             US FROM. AUTO-APPLY only on non-freemail
 *                             domains (a same-org corporate sender is
 *                             identifying; on gmail-class domains a
 *                             near-miss inbound sender can be a stranger,
 *                             so those are suggest-only).
 *   'extractor_consensus'   — call_log extraction/transcript sightings
 *                             (≥2 calls, near-miss variant, or a later
 *                             correction call). SUGGEST-ONLY: hard-bounced
 *                             call-captured emails are re-verified and
 *                             surfaced for owner read-back, never
 *                             auto-corrected (AGENTS.md call-pipeline
 *                             rule — the original failure mode IS a
 *                             mishear).
 *   'transcript_decode'     — reconstruction from spelled letters
 *                             (deterministic letter-run/phonetic decode,
 *                             plus a FAST-tier LLM pass whose supporting
 *                             quote must appear verbatim in the
 *                             transcript). SUGGEST-ONLY.
 *
 * Actions (hands-off/exception-based, CLAUDE.md rule 14):
 *   - Auto-eligible tier + all validations green → apply. A PRIMARY
 *     customer email goes through propagateCustomerEmailChange with the
 *     call-path's narrowed review scope (['customer_email_missing']) so
 *     lead/estimate snapshots retarget and newsletter tokens rotate but
 *     read-back cards are never settled by an automated correction. A
 *     service-contact field updates that field only; a lead-only owner
 *     updates THAT lead row only. Audit interaction + admin bell (real
 *     addresses — owner rule 2026-07-30).
 *   - Everything else with a candidate → 'suggested' ledger row + ACT:
 *     email to contact@ carrying the evidence and the exact ops apply
 *     command (ops/agents/bounce-rescue-backfill.js --apply=<id>).
 *   - A candidate already on ANY other sendable record (another customer's
 *     primary/service-contact email, another lead, another billing email)
 *     → duplicate signal, never an apply.
 *
 * Ledger/loop guards: UNIQUE(bounced_email) row per examined address; the
 * auto path inserts as 'applying' FIRST and flips to 'applied' only after
 * the write commits (a crash leaves a stale 'applying' row that a later
 * pass may take over); no-owner addresses are NOT recorded, so evidence
 * arriving later can still be used. Candidates exclude every actively
 * suppressed address and this owner's previously tried candidates.
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
const OWN_DOMAIN_RE = /@wavespestcontrol\.com$/i;
// The BOUNCED input only needs enough shape to work with — a truncated
// domain ("…@gmail", no TLD) is exactly the malformed-but-real class the
// domain-repair tier exists to fix, so it must not be rejected at the door.
const LOOSE_EMAIL_RE = /^[^@\s]+@[^@\s]+$/;
const MX_TIMEOUT_MS = 5000;
const MAX_DECODE_CONTEXTS = 6;
const DECODE_CONTEXT_LINES = 3;
// A crashed auto-apply leaves an 'applying' ledger row; after this long a
// new pass may take it over and retry.
const APPLYING_STALE_MINUTES = 15;

// Consumer mailbox providers where a same-domain inbound near-miss can be a
// STRANGER (millions of local parts one edit apart) — inbound evidence on
// these domains is suggest-only. Corporate/org domains stay auto-eligible:
// a near-miss sender on the customer's own company domain is identifying.
const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'icloud.com', 'outlook.com', 'hotmail.com',
  'aol.com', 'comcast.net', 'att.net', 'msn.com', 'live.com', 'me.com',
  'mac.com', 'protonmail.com', 'proton.me', 'ymail.com', 'verizon.net',
]);

// Customer columns that can hold a sendable address — same set the
// bounce-recovery service overwrites. The matched field is what an apply
// updates; only the PRIMARY email fans out.
const CUSTOMER_EMAIL_FIELDS = ['email', 'service_contact_email', 'service_contact2_email', 'service_contact3_email'];

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

function isFreemailDomain(domain) {
  return FREEMAIL_DOMAINS.has(String(domain || '').toLowerCase());
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

// Letter runs the way people spell on calls: "J-A-N-E-B-O-D-M-E-R",
// "T R Y A L S", "B-Y-R-D". 4+ single letters separated by spaces/hyphens/
// dots/commas (transcribers vary), tolerant of the separators mixing. The
// apostrophe lookbehind keeps contractions out of the run — without it,
// "it's K-A-R-R-E-N…" donates a leading "s" (real prod dry-run artifact).
const LETTER_RUN_RE = /\b(?<!')(?:[a-z][\s\-.,]+){3,}[a-z]\b/gi;
// NATO-ish phonetic spelling: "w like whiskey", "c as in charlie" —
// single-letter anchors only.
const PHONETIC_RE = /\b([a-z])\s+(?:like|as)\s+(?:in\s+)?[a-z]+/gi;

function lettersFromRun(run) {
  return run.replace(/[^a-z]/gi, '').toLowerCase();
}

/**
 * Deterministic candidates from one transcript's spelled segments, anchored
 * to the known-wrong bounced address:
 *  - a letter run R that is a near-miss (edit ≤2) of the bounced local's
 *    alpha core proposes R + the bounced local's digit tail @ same domain.
 *  - phonetic letters + the bounced digit tail propose exactly that local
 *    when it is a near-miss of the bounced local.
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
 * (stated abbreviations, multi-run spellings). The model output is
 * UNTRUSTED: its supporting quote must appear verbatim in the transcript
 * and the candidate is still revalidated (syntax/MX/suppression/collision)
 * before it can even be SUGGESTED — decode-tier candidates never
 * auto-apply. Decode failures degrade to "no tier-C candidate".
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
 * Mechanical domain repairs, MX-verified downstream like everything else.
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

/**
 * Owner = whoever the bounced address is on file for. Checks every sendable
 * customer field (not just the primary email — SendGrid bounces target
 * service-contact and billing addresses too), then billing prefs, then
 * leads. Returns which FIELD matched so the apply updates that field.
 */
async function findOwner(bouncedEmail) {
  for (const field of CUSTOMER_EMAIL_FIELDS) {
    const customer = await db('customers')
      .whereRaw(`LOWER(${field}) = ?`, [bouncedEmail])
      .whereNull('deleted_at')
      .first()
      .catch(() => null);
    if (customer) return { customer, lead: null, field };
  }
  const billingPref = await db('notification_prefs')
    .whereRaw('LOWER(billing_email) = ?', [bouncedEmail])
    .first()
    .catch(() => null);
  if (billingPref?.customer_id) {
    const customer = await db('customers')
      .where({ id: billingPref.customer_id }).whereNull('deleted_at').first();
    if (customer) return { customer, lead: null, field: 'billing_email' };
  }
  const lead = await db('leads')
    .whereRaw('LOWER(email) = ?', [bouncedEmail])
    .whereNull('deleted_at')
    .first();
  return { customer: null, lead, field: lead ? 'email' : null };
}

async function inboundGroundTruth(bouncedEmail) {
  // Same-domain inbound senders, near-miss of the bounced address. Domain-
  // scoped so we never scan the whole inbound table. On freemail domains a
  // near-miss sender can be a stranger — those candidates are marked
  // suggest-only and never auto-apply.
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
    .map((email) => ({
      email,
      quote: `inbound email received from ${email}`,
      suggestOnly: isFreemailDomain(domain),
    }));
}

async function callSightings(phone) {
  if (!phone) return { sightings: [], calls: [] };
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

/**
 * A candidate collides when it is already a sendable address for a DIFFERENT
 * party — another customer's primary or service-contact email, another
 * customer's billing email, or another lead. Any hit is a duplicate signal,
 * never an apply.
 */
async function candidateCollision(email, { ownerCustomerId, ownerLeadId }) {
  const fieldChecks = CUSTOMER_EMAIL_FIELDS.map((f) => `LOWER(${f}) = ?`).join(' OR ');
  const otherCustomer = await db('customers')
    .whereRaw(`(${fieldChecks})`, CUSTOMER_EMAIL_FIELDS.map(() => email))
    .whereNull('deleted_at')
    .first();
  if (otherCustomer && otherCustomer.id !== ownerCustomerId) {
    return { kind: 'customer', id: otherCustomer.id };
  }
  const billingPref = await db('notification_prefs')
    .whereRaw('LOWER(billing_email) = ?', [email])
    .first()
    .catch(() => null);
  if (billingPref?.customer_id && billingPref.customer_id !== ownerCustomerId) {
    return { kind: 'billing_prefs', id: billingPref.customer_id };
  }
  const otherLead = await db('leads')
    .whereRaw('LOWER(email) = ?', [email])
    .whereNull('deleted_at')
    .first();
  if (otherLead && otherLead.id !== ownerLeadId
    && !(ownerCustomerId && otherLead.customer_id === ownerCustomerId)) {
    return { kind: 'lead', id: otherLead.id };
  }
  return null;
}

async function validateCandidate(candidate, { bouncedEmail, ownerCustomerId, ownerLeadId, excludeRescueId = null }) {
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
    .modify((q) => { if (excludeRescueId) q.whereNot('id', excludeRescueId); })
    .first().catch(() => null);
  if (triedBefore) return { ok: false, reason: 'already_tried' };
  const collision = await candidateCollision(email, { ownerCustomerId, ownerLeadId });
  if (collision) {
    return { ok: false, reason: 'collision', collision };
  }
  const mx = await mxResolves(domainPart(email));
  if (mx === false) return { ok: false, reason: 'no_mx' };
  // mx === null (DNS trouble) is not a hard fail — but it does demote an
  // auto-apply to a suggestion (fail toward the human).
  return { ok: true, mxUnknown: mx === null };
}

// ── actions ─────────────────────────────────────────────────────────

async function applyFix({ bouncedEmail, candidate, owner, tier, evidence, appliedBy }) {
  const counts = await db.transaction(async (trx) => {
    if (owner.customer) {
      const field = owner.field === 'billing_email' ? null : owner.field;
      if (field) {
        const updated = await trx('customers')
          .where({ id: owner.customer.id })
          .whereRaw(`LOWER(${field}) = ?`, [bouncedEmail])
          .update({ [field]: candidate, updated_at: new Date() });
        if (updated !== 1) {
          // The address moved under us (operator edit mid-rescue) — abort.
          throw Object.assign(new Error('owner email changed mid-rescue'), { code: 'STALE_OWNER' });
        }
      } else {
        const updated = await trx('notification_prefs')
          .where({ customer_id: owner.customer.id })
          .whereRaw('LOWER(billing_email) = ?', [bouncedEmail])
          .update({ billing_email: candidate, updated_at: new Date() });
        if (updated !== 1) {
          throw Object.assign(new Error('billing email changed mid-rescue'), { code: 'STALE_OWNER' });
        }
      }
      if (field === 'email') {
        // PRIMARY email changes ride the standard fanout so lead/estimate
        // snapshots retarget and newsletter tokens rotate. Same narrowed
        // review scope as the call-captured path: an automated correction
        // must never settle an owner read-back card.
        const fanout = require('./customer-email-fanout');
        await fanout.propagateCustomerEmailChange({
          before: owner.customer,
          after: { id: owner.customer.id, email: candidate },
          source: 'email-bounce-rescue',
          reviewReasonCodes: ['customer_email_missing'],
        }, trx);
      }
      await trx('customer_interactions').insert({
        customer_id: owner.customer.id,
        interaction_type: 'email_outbound',
        subject: 'Bounced email auto-corrected from evidence on file',
        body: `Replaced the hard-bounced ${owner.field} with ${candidate} (${tier}). Evidence: ${String(evidence.quote || '').slice(0, 300)}`,
        metadata: JSON.stringify({
          bounced_email: bouncedEmail, candidate_email: candidate, tier, field: owner.field, source: 'email-bounce-rescue',
        }),
      });
      return { customersUpdated: 1 };
    }
    // Lead-only owner: exactly the resolved lead row — other leads sharing
    // the same bad address belong to other prospects and must not inherit
    // this owner's recovered mailbox.
    const updated = await trx('leads')
      .where({ id: owner.lead.id })
      .whereRaw('LOWER(email) = ?', [bouncedEmail])
      .whereNull('deleted_at')
      .update({ email: candidate, updated_at: new Date() });
    if (updated !== 1) {
      throw Object.assign(new Error('lead email changed mid-rescue'), { code: 'STALE_OWNER' });
    }
    return { leadsUpdated: 1 };
  });

  const name = owner.customer
    ? `${owner.customer.first_name || ''} ${owner.customer.last_name || ''}`.trim()
    : `${owner.lead.first_name || ''} ${owner.lead.last_name || ''}`.trim();
  // Owner rule 2026-07-30: ops bells show REAL addresses.
  await NotificationService.notifyAdmin(
    'system',
    'Bounced email auto-corrected from evidence on file',
    `${name}: ${bouncedEmail} bounced; ${owner.field} corrected to ${candidate} (${tier}). If this bounces too, a suppression bell will follow.`,
    {
      link: owner.customer ? `/admin/customers?customerId=${owner.customer.id}` : '/admin/leads',
      metadata: { dedupeKey: `email-rescue:${bouncedEmail}`, appliedBy },
    },
  ).catch((err) => logger.warn(`[email-bounce-rescue] bell failed: ${err.message}`));
  return counts;
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
    candidate ? `Best candidate from evidence on file (${tier}): ${candidate}` : 'No confident candidate was found.',
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

  let staleApplyingRow = null;
  if (!dryRun) {
    const existing = await db('email_bounce_rescues')
      .whereRaw('LOWER(bounced_email) = ?', [bouncedEmail]).first().catch(() => null);
    if (existing) {
      const staleApplying = existing.status === 'applying'
        && existing.updated_at
        && (Date.now() - new Date(existing.updated_at).getTime()) > APPLYING_STALE_MINUTES * 60_000;
      if (!staleApplying) return { skipped: 'already_examined', status: existing.status };
      // A crash mid-apply left this row claimed but unwritten — take it over.
      staleApplyingRow = existing;
    }
  }

  const owner = await findOwner(bouncedEmail);
  if (!owner.customer && !owner.lead) {
    // Deliberately NOT recorded in the ledger: an address with no owner
    // today may gain one (or evidence) later — the unique row would make
    // that permanent.
    return { skipped: 'no_owner' };
  }
  const phone = owner.customer?.phone || owner.lead?.phone || null;

  // Gather, tier order (auto-eligible tiers first).
  const tiers = [];
  for (const c of domainRepairCandidates(bouncedEmail)) {
    tiers.push({ tier: 'domain_repair', ...c });
  }
  for (const c of await inboundGroundTruth(bouncedEmail)) {
    tiers.push({ tier: 'inbound_ground_truth', ...c });
  }
  const { sightings, calls } = await callSightings(phone);
  for (const c of consensusCandidates(sightings, bouncedEmail)) {
    tiers.push({ tier: 'extractor_consensus', ...c });
  }
  const transcriptAll = calls.map((c) => c.transcription).join('\n');
  for (const call of calls) {
    for (const c of decodeSpelledCandidates(call.transcription, bouncedEmail)) {
      tiers.push({ tier: 'transcript_decode', ...c });
    }
  }
  if (!tiers.length) {
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
          reason: 'candidate is already on file for another customer/lead — possible duplicate pair, review before applying',
        };
        break;
      }
      continue;
    }
    // Only mechanical repairs and non-freemail inbound ground truth may
    // auto-apply; call-derived evidence (consensus/decode) is owner
    // read-back territory per the call-pipeline rule.
    const autoTier = (cand.tier === 'domain_repair'
      || (cand.tier === 'inbound_ground_truth' && !cand.suggestOnly));
    if (autoTier && !v.mxUnknown) {
      outcome = { status: 'applied', tier: cand.tier, candidate: cand.email, evidence: cand };
    } else {
      outcome = {
        status: 'suggested', tier: cand.tier, candidate: cand.email, evidence: cand,
        reason: v.mxUnknown ? 'MX could not be verified'
          : cand.tier === 'inbound_ground_truth' ? 'freemail-domain inbound match — could be a different sender'
            : 'call-derived evidence requires owner read-back',
      };
    }
    break;
  }

  if (dryRun) return { dryRun: true, bouncedEmail, owner: owner.customer?.id || owner.lead?.id, ...outcome };

  // Auto-applies persist as 'applying' FIRST and flip to 'applied' only
  // after the write commits — a crash in between leaves a stale 'applying'
  // row that a later pass takes over (see entry check above).
  const persistStatus = outcome.status === 'applied' ? 'applying' : outcome.status;
  let row;
  if (staleApplyingRow) {
    await db('email_bounce_rescues').where({ id: staleApplyingRow.id }).update({
      tier: outcome.tier || null,
      candidate_email: outcome.candidate || null,
      evidence: JSON.stringify(outcome.evidence ? { quote: outcome.evidence.quote, llm: !!outcome.evidence.llm } : {}),
      status: persistStatus,
      updated_at: new Date(),
    });
    row = { ...staleApplyingRow, status: persistStatus };
  } else {
    row = await recordRescue({
      bouncedEmail,
      customerId: owner.customer?.id || null,
      leadId: owner.lead?.id || null,
      tier: outcome.tier || null,
      candidate: outcome.candidate || null,
      evidence: outcome.evidence ? { quote: outcome.evidence.quote, llm: !!outcome.evidence.llm } : {},
      status: persistStatus,
      appliedBy: outcome.status === 'applied' ? appliedBy : null,
    });
    if (!row) return { skipped: 'already_examined' }; // lost the unique race
  }

  if (outcome.status === 'applied') {
    try {
      await applyFix({
        bouncedEmail, candidate: outcome.candidate, owner, tier: outcome.tier,
        evidence: outcome.evidence, appliedBy,
      });
      await db('email_bounce_rescues').where({ id: row.id })
        .update({ status: 'applied', applied_at: new Date(), applied_by: appliedBy, updated_at: new Date() });
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
 * IN FULL before writing — the row's own ledger entry is excluded from the
 * prior-attempt check so the collision and suppression checks still run
 * (a row parked FOR a collision must never sail through on 'already_tried').
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
    excludeRescueId: row.id,
  });
  if (!v.ok) return { error: `validation failed: ${v.reason}${v.collision ? ` (${v.collision.kind} ${v.collision.id})` : ''}` };
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

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
 *                             mishear). One exception, the SELF-FIX below.
 *   'transcript_decode'     — reconstruction from spelled letters
 *                             (deterministic letter-run/phonetic decode,
 *                             plus a FAST-tier LLM pass whose supporting
 *                             quote must appear verbatim in the
 *                             transcript). SUGGEST-ONLY: it rebuilds
 *                             the address from the bounced one.
 *
 * Self-fix (GATE_CALL_BOUNCE_SELF_FIX, dark; owner 2026-11-17, page
 * NN7Qm52t): a customer's PRIMARY email may take one consensus fix per
 * customer when every candidate names the SAME address, a call record holds
 * that complete address, the newest call that talks about email names it,
 * and it is a small fix — same domain, at most 2 changes, no letter of the
 * bounced address dropped (isSmallFix). It must validate with a verified MX,
 * never have bounced, and never have been on the do-not-email list, even
 * when that block was released. Decoded spellings stay suggestions. Prod
 * ledger 2026-08 to 2026-11: the right near-miss guesses changed one letter
 * or two dots; the wrong guess of 11-02 dropped a letter; two other near-miss
 * guesses were addresses that had bounced months before. With the switch
 * on, the LLM decode also reads spoken corrections ("knock off that 3-7")
 * for the suggestion, and relookAfterNewCalls re-runs a no-fix address after
 * a later call that talks about email.
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
const { deliverOpsDigest } = require('./ops-digest');
const NotificationService = require('./notification-service');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');
const { callBounceSelfFixLive } = require('../config/feature-gates');

// Structured-output contract for the decode (llm/call.js jsonSchema). The
// verbatim-quote anchor and the syntax/MX/suppression revalidation still run.
const DECODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidate_email', 'supporting_quote'],
  properties: {
    candidate_email: { type: ['string', 'null'], description: 'The reconstructed address, or null when the excerpts do not determine one' },
    supporting_quote: { type: 'string', description: 'Copied VERBATIM from the excerpts' },
  },
};
const { correctEmailDomain, meetsConfidence } = require('../utils/email-typo-correction');

// Log-safe address. Local, not imported: email-typo-correction never
// exported a redactEmail, so the old import was undefined and the failed-
// apply log line threw before the suggestion email (the person's alert) went.
function redactEmail(value) {
  if (!value || typeof value !== 'string') return '';
  const [local, domain] = value.split('@');
  if (!domain) return '[redacted]';
  return `${local.slice(0, 2)}***@${domain}`;
}

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
// Self-fix (GATE_CALL_BOUNCE_SELF_FIX): only a COMPLETE address seen in the
// customer's own call records (extractor_consensus sightings), only small
// fixes, at most this many changes (selfFixCost). A decoded spelling
// (transcript_decode, rule-based or AI) rebuilds the address from the bounced
// one, borrowing its domain and digits, so it stays a suggestion (Codex r1
// on #7906: "J-O-H-N-S at yahoo dot com" decoded onto the old gmail address).
const SELF_FIX_TIER = 'extractor_consensus';
const SELF_FIX_MAX_COST = 2;
// Re-look sweep: rows per tick (each can cost one FAST-tier decode).
const RELOOK_BATCH = 10;

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

// Self-fix change count from the BOUNCED local part to a candidate's: an
// edit distance where dropping a letter of the bounced address is never a
// small fix (cost above SELF_FIX_MAX_COST), and a change keeps its kind
// (letter to letter, digit to digit, dot/symbol to dot/symbol). Adding any
// character, or dropping a digit or a dot, costs 1. So "drop the 37" is 2,
// one misheard letter is 1, two dots the caller never said is 2, and a
// guess that loses a letter the caller spelled is out.
const DROPPED_LETTER_COST = SELF_FIX_MAX_COST + 1;
function charKind(c) {
  if (/[a-z]/.test(c)) return 'letter';
  if (/[0-9]/.test(c)) return 'digit';
  return 'symbol';
}
function dropCost(c) {
  return charKind(c) === 'letter' ? DROPPED_LETTER_COST : 1;
}
function swapCost(a, b) {
  if (a === b) return 0;
  return charKind(a) === charKind(b) ? 1 : dropCost(a) + 1;
}
function selfFixCost(bouncedLocal, candidateLocal) {
  const s = String(bouncedLocal || '').toLowerCase();
  const t = String(candidateLocal || '').toLowerCase();
  let prev = [0];
  for (let j = 1; j <= t.length; j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    const row = [prev[0] + dropCost(s[i - 1])];
    for (let j = 1; j <= t.length; j++) {
      row[j] = Math.min(prev[j] + dropCost(s[i - 1]), row[j - 1] + 1, prev[j - 1] + swapCost(s[i - 1], t[j - 1]));
    }
    prev = row;
  }
  return prev[t.length];
}

// A self-fix candidate: same domain, a different local part, small fix.
function isSmallFix(bouncedEmail, candidateEmail) {
  const b = normalizeEmail(bouncedEmail);
  const c = normalizeEmail(candidateEmail);
  if (!c || c === b || domainPart(c) !== domainPart(b)) return false;
  return selfFixCost(localPart(b), localPart(c)) <= SELF_FIX_MAX_COST;
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

// Talk about an email address. EMAIL_TALK_PATTERN is the same test in SQL.
const EMAIL_TALK_RE = /e-?mail|@|\bdot\b\s*(com|net|org|edu)/i;

// Context windows around email talk — the input for the LLM decode.
function extractSpelledContexts(transcription) {
  const lines = String(transcription || '').split(/\n/);
  const contexts = [];
  lines.forEach((line, i) => {
    if (!EMAIL_TALK_RE.test(line)) return;
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
// Spoken corrections (GATE_CALL_BOUNCE_SELF_FIX): a caller who tells us how
// the stored address is wrong ("there's not a 3-7 after the 777", "it's a C,
// not a K"). The verbatim-quote anchor and every validation still apply.
const DECODE_CORRECTIONS_RULE = [
  'The caller may also say in words how the stored address is wrong, for',
  'example "knock off that 3-7", "there is no dot", or "it\'s a C, not a K".',
  'When an excerpt states such a correction plainly, apply exactly that',
  'correction to the known-wrong address and copy the correction words',
  'VERBATIM as the supporting_quote. Never guess a change the caller did not state.',
].join(' ');

async function llmDecodeCandidate({ contexts, bouncedEmail, transcription, readCorrections = false }) {
  if (!contexts.length) return null;
  const system = [
    'You reconstruct email addresses that a phone-call transcriber mis-heard.',
    'The stored address is KNOWN WRONG (it hard-bounced). Use only the spelled',
    'letters, phonetic hints ("w like whiskey"), and stated abbreviations in the',
    'transcript excerpts. Report the reconstructed candidate_email with a',
    'supporting_quote copied VERBATIM from the excerpts. If the excerpts do not',
    'determine a correction, candidate_email is null.',
  ];
  if (readCorrections) system.push(DECODE_CORRECTIONS_RULE);
  const res = await dispatchWithFallback(MODELS.TEXT_POLICIES.fastStructured, {
    laneId: 'bounce_rescue',
    system: system.join(' '),
    text: `Known-wrong address: ${bouncedEmail}\n\nTranscript excerpts:\n${contexts.join('\n---\n')}`,
    jsonMode: true,
    jsonSchema: DECODE_SCHEMA,
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
    .modify((qb) => require('./voice-agent/relay-protocol').whereNotSandboxCall(qb)) // a test call's spoken email is not evidence
    .whereNotNull('transcription')
    .orderBy('created_at')
    .select('id', 'created_at', 'transcription', 'ai_extraction', 'processed_at', 'processing_status')
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
async function candidateCollision(email, { ownerCustomerId, ownerLeadId }, q = db) {
  // The owner is excluded IN SQL, not post-hoc: with `.first()` and no
  // exclusion, a candidate present on BOTH the owner and another party
  // could return the owner row and read as collision-free (codex r2).
  const fieldChecks = CUSTOMER_EMAIL_FIELDS.map((f) => `LOWER(${f}) = ?`).join(' OR ');
  const otherCustomer = await q('customers')
    .whereRaw(`(${fieldChecks})`, CUSTOMER_EMAIL_FIELDS.map(() => email))
    .whereNull('deleted_at')
    .modify((b) => { if (ownerCustomerId) b.whereNot('id', ownerCustomerId); })
    .first();
  if (otherCustomer && otherCustomer.id !== ownerCustomerId) {
    return { kind: 'customer', id: otherCustomer.id };
  }
  const billingPref = await q('notification_prefs')
    .whereRaw('LOWER(billing_email) = ?', [email])
    .modify((b) => { if (ownerCustomerId) b.whereNot('customer_id', ownerCustomerId); })
    .first()
    .catch(() => null);
  if (billingPref?.customer_id && billingPref.customer_id !== ownerCustomerId) {
    return { kind: 'billing_prefs', id: billingPref.customer_id };
  }
  const otherLead = await q('leads')
    .whereRaw('LOWER(email) = ?', [email])
    .whereNull('deleted_at')
    .modify((b) => {
      if (ownerLeadId) b.whereNot('id', ownerLeadId);
      if (ownerCustomerId) {
        b.where((q2) => q2.whereNull('customer_id').orWhereNot('customer_id', ownerCustomerId));
      }
    })
    .first();
  if (otherLead && otherLead.id !== ownerLeadId
    && !(ownerCustomerId && otherLead.customer_id === ownerCustomerId)) {
    return { kind: 'lead', id: otherLead.id };
  }
  // Gmail ignores local-part dots and everything after '+': a dot or tag
  // variant of a mailbox another party holds is that party's inbox (the
  // identity the destination lock keys on). The bounce recovery's check,
  // fail-closed (pre-push audit on #7906).
  const { gmailMailboxOwnedByOther } = require('./email-bounce-recovery');
  if (await gmailMailboxOwnedByOther(email, ownerCustomerId, q)) return { kind: 'gmail_mailbox', id: null };
  return null;
}

// An active do-not-email row covers the address. `q` = db, or the save's
// transaction for the re-check under the destination lock.
function activeSuppression(email, q = db) {
  return q('email_suppressions')
    .where(require('../utils/email-equivalence').suppressionCoversEmail(email)).where({ status: 'active' }).first();
}

async function validateCandidate(candidate, { bouncedEmail, ownerCustomerId, ownerLeadId, excludeRescueId = null }) {
  const email = normalizeEmail(candidate);
  if (!EMAIL_RE.test(email)) return { ok: false, reason: 'syntax' };
  if (email === normalizeEmail(bouncedEmail)) return { ok: false, reason: 'same_as_bounced' };
  const suppressed = await activeSuppression(email);
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

// ── self-fix (GATE_CALL_BOUNCE_SELF_FIX) ────────────────────────────

// Once per customer: an earlier self-fix that was saved (or is being saved)
// means this address is the self-fixed one bouncing again — a person takes
// it. A failed read counts as an earlier fix (fail toward the human).
async function hadEarlierSelfFix(customerId) {
  const row = await db('email_bounce_rescues')
    .where({ customer_id: customerId })
    .whereIn('status', ['applied', 'applying'])
    .whereRaw("evidence->>'self_fix' = 'true'")
    .first('id')
    .catch(() => ({ id: 'read_failed' }));
  return Boolean(row);
}

// Never a known-bad address: one that bounced before (for anyone; the
// ledger) or ever sat on the do-not-email list (any status, so a released
// block still counts; this also covers bounces from before the ledger) stays
// out. Both reads match a Gmail dot or + alias too (suppressionCoversEmail):
// it is the same inbox. A failed read counts as known-bad (fail toward the
// human).
async function knownBadAddress(email, q = db) {
  const { suppressionCoversEmail } = require('../utils/email-equivalence');
  const [bounced, blocked] = await Promise.all([
    q('email_bounce_rescues').where(suppressionCoversEmail(email, 'bounced_email')).first('id'),
    q('email_suppressions').where(suppressionCoversEmail(email)).first('id'),
  ]).catch(() => [{ id: 'read_failed' }]);
  return Boolean(bounced || blocked);
}

// A call whose processing reached its verdict, so its extraction will not
// change: processed_at is the verdict time (set since 2026-10-10, never
// backfilled), and these are the processor's verdict statuses
// (call-recording-processor.js). No status, 'pending', 'processing' and the
// retry lanes are not finished.
const CALL_VERDICT_STATUSES = new Set(['processed', 'spam', 'voicemail', 'customer_creation_failed', 'lead_creation_failed']);
function callFinished(call) {
  return Boolean(call.processed_at) || CALL_VERDICT_STATUSES.has(call.processing_status);
}

// The customer's newest call that talks about email must be finished and
// must name the fix in full (its transcript or AI extraction). A later call
// may carry a correction no tier can read ("there is no 3 at the end"), and
// a call still in processing may still change its extraction, so a person
// decides (Codex r1 and the pre-push audit on #7906).
function newestEmailCallNames(calls, address) {
  const talk = (calls || []).filter((c) => EMAIL_TALK_RE.test(String(c.transcription || '')));
  const newest = talk[talk.length - 1];
  if (!newest || !callFinished(newest)) return false;
  const extraction = typeof newest.ai_extraction === 'string'
    ? newest.ai_extraction : JSON.stringify(newest.ai_extraction || {});
  const named = `${newest.transcription || ''}\n${extraction}`.match(EMAIL_SCAN_RE) || [];
  return named.some((e) => normalizeEmail(e) === address);
}

/**
 * The self-fix outcome, or null. Only a customer's PRIMARY email. Every
 * candidate, from any tier, must name ONE address (two addresses = the
 * evidence disagrees, a person decides); a call record must hold that
 * complete address (SELF_FIX_TIER), and so must the newest call that talks
 * about email; and it must be a small fix. The address passes
 * validateCandidate with a verified MX, is not a known-bad address, and the
 * customer has no earlier self-fix.
 */
async function selfFixOutcome({ tiers, owner, bouncedEmail, validations, calls }) {
  if (!owner.customer || owner.field !== 'email') return null;
  const bounced = normalizeEmail(bouncedEmail);
  const addresses = new Set(tiers.map((c) => normalizeEmail(c.email)).filter((e) => e && e !== bounced));
  if (addresses.size !== 1) return null;
  const [key] = addresses;
  const cand = tiers.find((c) => c.tier === SELF_FIX_TIER && normalizeEmail(c.email) === key);
  if (!cand || !isSmallFix(bounced, key) || !newestEmailCallNames(calls, key)) return null;
  const v = validations.get(key) || await validateCandidate(key, {
    bouncedEmail, ownerCustomerId: owner.customer.id, ownerLeadId: null,
  });
  if (!v.ok || v.mxUnknown) return null;
  if (await knownBadAddress(key)) return null;
  if (await hadEarlierSelfFix(owner.customer.id)) return null;
  return { status: 'applied', tier: cand.tier, candidate: key, evidence: cand, selfFix: true };
}

// What the ledger row keeps of an outcome's evidence.
function ledgerEvidence(outcome) {
  if (!outcome.evidence) return {};
  const out = { quote: outcome.evidence.quote, llm: Boolean(outcome.evidence.llm) };
  if (outcome.selfFix) out.self_fix = true;
  return out;
}

// ── actions ─────────────────────────────────────────────────────────

// Re-judge the destination under its lock: validateCandidate (and, for a
// self-fix, knownBadAddress) read it before the lock, so a writer that took
// or blocked the address in between would be missed. Every other writer of a
// customer email takes the same lock, so after it this read is final
// (pre-push audit on #7906). Taken or blocked = the change rolls back.
async function assertDestinationFree(trx, { candidate, owner, selfFix }) {
  const taken = await candidateCollision(candidate, {
    ownerCustomerId: owner.customer?.id || null, ownerLeadId: owner.lead?.id || null,
  }, trx);
  const blocked = selfFix ? await knownBadAddress(candidate, trx) : await activeSuppression(candidate, trx);
  if (taken || blocked) {
    throw Object.assign(new Error('destination taken or blocked mid-rescue'), { code: 'STALE_DESTINATION' });
  }
}

// The rescue's ledger row turns 'applied' in the same transaction as the
// email change, so a committed fix always carries its record (and the
// once-per-customer guard always sees a self-fix). The row must still be
// this run's 'applying' claim, or the change rolls back (pre-push audit on
// #7906). No row id (the operator apply) = no ledger write here.
async function markApplied(trx, rescueRowId, appliedBy) {
  if (!rescueRowId) return;
  const marked = await trx('email_bounce_rescues')
    .where({ id: rescueRowId, status: 'applying' })
    .update({ status: 'applied', applied_at: new Date(), applied_by: appliedBy, updated_at: new Date() });
  if (marked !== 1) throw Object.assign(new Error('rescue row no longer claimed'), { code: 'STALE_CLAIM' });
}

async function applyFix({ bouncedEmail, candidate, owner, tier, evidence, appliedBy, selfFix = false, rescueRowId = null }) {
  const counts = await db.transaction(async (trx) => {
    if (owner.customer) {
      const field = owner.field === 'billing_email' ? null : owner.field;
      if (field) {
        // Row → destination key (the key every summary handoff takes), so a
        // handoff that read the candidate as unowned commits its request
        // before this claim or re-judges ownership after it.
        await trx('customers').where({ id: owner.customer.id }).forUpdate().first('id');
        await require('../utils/customer-comms-lock').lockCustomerEmail(trx, candidate);
        const updated = await trx('customers')
          .where({ id: owner.customer.id })
          .whereRaw(`LOWER(${field}) = ?`, [bouncedEmail])
          .update({ [field]: candidate, updated_at: new Date() });
        if (updated !== 1) {
          // The address moved under us (operator edit mid-rescue) — abort.
          throw Object.assign(new Error('owner email changed mid-rescue'), { code: 'STALE_OWNER' });
        }
      } else {
        await trx('notification_prefs').where({ customer_id: owner.customer.id }).forUpdate().first('customer_id');
        await require('../utils/customer-comms-lock').lockCustomerEmail(trx, candidate);
        const updated = await trx('notification_prefs')
          .where({ customer_id: owner.customer.id })
          .whereRaw('LOWER(billing_email) = ?', [bouncedEmail])
          .update({ billing_email: candidate, updated_at: new Date() });
        if (updated !== 1) {
          throw Object.assign(new Error('billing email changed mid-rescue'), { code: 'STALE_OWNER' });
        }
      }
      await assertDestinationFree(trx, { candidate, owner, selfFix });
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
        body: selfFix
          ? `Replaced the hard-bounced email ${bouncedEmail} with ${candidate}, a small fix found in this customer's own calls (${tier}, self-fix). To undo, put the old address back. Evidence: ${String(evidence.quote || '').slice(0, 300)}`
          : `Replaced the hard-bounced ${owner.field} ${bouncedEmail} with ${candidate} (${tier}). Evidence: ${String(evidence.quote || '').slice(0, 300)}`,
        metadata: JSON.stringify({
          bounced_email: bouncedEmail,
          candidate_email: candidate,
          tier,
          field: owner.field,
          source: 'email-bounce-rescue',
          ...(selfFix ? { self_fix: true } : {}),
        }),
      });
      await markApplied(trx, rescueRowId, appliedBy);
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
    await markApplied(trx, rescueRowId, appliedBy);
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

// Admin-alerts-brevity scope (owner ruling 2026-09-28): short bell copy —
// no customer name in the headline (keeps it short and generic); the full
// customer-named report still lands in `detail`.
function bounceSuggestionHeadlineAndSummary(candidate) {
  return {
    headline: 'Email — bounce needs a fix',
    summary: candidate ? `Best guess is ${candidate}. Confirm and apply it.` : 'No good replacement found. Ask for a new address.',
  };
}

// What the alert-relevance sweep reads to close this alert once the owner's
// record holds a different working address (admin-alert-relevance.js, class
// email_bounce_fix; owner 2026-11-03): the bounced address, its owner and the
// field it bounced from. The sweep repeats the doneWhen value; a test pins it.
const BOUNCE_ALERT_DONE_WHEN = 'bounced_email_replaced';
function bounceAlertMetadata({ bouncedEmail, owner }) {
  let ownerRef = null;
  if (owner?.customer?.id) ownerRef = { customerId: String(owner.customer.id), ownerField: owner.field || 'email' };
  else if (owner?.lead?.id) ownerRef = { leadId: String(owner.lead.id), ownerField: 'email' };
  return ownerRef ? { doneWhen: BOUNCE_ALERT_DONE_WHEN, bouncedEmail, ...ownerRef } : {};
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
  const subject = `ACT: bounced email fix ${candidate ? 'suggested' : 'needs a human'} — ${name || bouncedEmail}`;
  const { headline, summary } = bounceSuggestionHeadlineAndSummary(candidate);
  const result = await deliverOpsDigest({
    key: 'email-bounce-rescue',
    subject,
    text: body,
    headline,
    summary,
    // One row per address; a repeat bounce of the SAME address is already
    // deduped upstream (email-rescue:${bouncedEmail} on the auto-corrected
    // bell above) before this path ever runs for it. Every call here is
    // therefore a DIFFERENT customer's bounce needing a human — count alone
    // (1, always equal to the prior row's count) would go quiet after the
    // first; newCount:1 says every one of them is new news, so it rings.
    count: 1,
    newCount: 1,
    link: '/admin/customers',
    metadata: bounceAlertMetadata({ bouncedEmail, owner }),
    sendEmail: () => email.send({
      to: suggestionRecipient(),
      subject,
      heading: 'Bounced email rescue',
      body,
    }),
  });
  // email.send resolves { ok: false } instead of throwing (missing SMTP,
  // sendMail failure) — a swallowed failure here would silently strand a
  // read-back prompt behind an already-recorded ledger row. Throw so the
  // caller's fallback surface (admin bell) runs.
  if (!result?.ok) {
    throw new Error(`suggestion email not sent: ${result?.error || 'unknown'}`);
  }
}

// Fallback surface when the ACT: email cannot be sent: an admin bell with
// the same actionable content, so the suggestion is never invisible. The
// bell is the BACKUP channel only — email-first per the approvals rule.
async function suggestionFallbackBell({ rescueRowId, bouncedEmail, candidate, owner, sendError }) {
  const name = owner.customer
    ? `${owner.customer.first_name || ''} ${owner.customer.last_name || ''}`.trim()
    : `${owner.lead?.first_name || ''} ${owner.lead?.last_name || ''}`.trim();
  await NotificationService.notifyAdmin(
    'system',
    'Bounced-email suggestion could not be emailed — action needed',
    `${name}: ${bouncedEmail} bounced. ${candidate
      ? `Candidate on file: ${candidate}. Apply with: node ops/agents/bounce-rescue-backfill.js --apply=${rescueRowId} --execute`
      : 'No confident candidate — ask for a working address at the next touchpoint.'} (Suggestion email failed: ${String(sendError).slice(0, 120)})`,
    {
      link: owner.customer ? `/admin/customers?customerId=${owner.customer.id}` : '/admin/leads',
      metadata: { dedupeKey: `email-rescue-suggestion:${bouncedEmail}` },
    },
  ).catch((err) => logger.warn(`[email-bounce-rescue] fallback bell failed: ${err.message}`));
}

// ── outcome ─────────────────────────────────────────────────────────

/**
 * First candidate that validates decides the outcome. Then, with
 * GATE_CALL_BOUNCE_SELF_FIX on, a call-derived suggestion may become a
 * self-fix (selfFixOutcome); a collision never does.
 */
async function decideOutcome({ tiers, owner, bouncedEmail, calls = [] }) {
  const validations = new Map();
  let outcome = { status: 'no_candidate' };
  for (const cand of tiers) {
    const v = await validateCandidate(cand.email, {
      bouncedEmail,
      ownerCustomerId: owner.customer?.id || null,
      ownerLeadId: owner.lead?.id || null,
    });
    validations.set(normalizeEmail(cand.email), v);
    if (!v.ok) {
      if (v.reason === 'collision') {
        outcome = {
          status: 'suggested', tier: cand.tier, candidate: cand.email, evidence: cand, collision: true,
          reason: 'candidate is already on file for another customer/lead — possible duplicate pair, review before applying',
        };
        break;
      }
      continue;
    }
    // Only mechanical repairs and non-freemail inbound ground truth may
    // auto-apply; call-derived evidence (consensus/decode) is owner
    // read-back territory per the call-pipeline rule (one exception: the
    // self-fix below).
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
  if (outcome.status === 'applied' || outcome.collision || !callBounceSelfFixLive()) return outcome;
  return (await selfFixOutcome({ tiers, owner, bouncedEmail, validations, calls })) || outcome;
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

  let reusableRow = null;
  if (!dryRun) {
    const existing = await db('email_bounce_rescues')
      .whereRaw('LOWER(bounced_email) = ?', [bouncedEmail]).first().catch(() => null);
    if (existing) {
      const staleApplying = existing.status === 'applying'
        && existing.updated_at
        && (Date.now() - new Date(existing.updated_at).getTime()) > APPLYING_STALE_MINUTES * 60_000;
      // 'no_candidate' is NOT terminal: transcription/extraction/inbound
      // sync may land AFTER the first webhook look, so a re-bounce or
      // backfill re-examines with the fresh evidence and updates the same
      // row. 'applied' and 'suggested' stay terminal ('suggested' would
      // re-send ACT emails on every redelivery otherwise).
      const reusable = staleApplying || existing.status === 'no_candidate';
      if (!reusable) return { skipped: 'already_examined', status: existing.status };
      reusableRow = existing;
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
    const llm = await llmDecodeCandidate({
      contexts, bouncedEmail, transcription: transcriptAll, readCorrections: callBounceSelfFixLive(),
    });
    if (llm) tiers.push({ tier: 'transcript_decode', ...llm, llm: true });
  }

  let outcome = await decideOutcome({ tiers, owner, bouncedEmail, calls });

  if (dryRun) return { dryRun: true, bouncedEmail, owner: owner.customer?.id || owner.lead?.id, ...outcome };

  // Auto-applies persist as 'applying' FIRST and flip to 'applied' in the
  // write's own transaction (markApplied) — a crash before it leaves a stale
  // 'applying' row that a later pass takes over (see entry check above).
  const persistStatus = outcome.status === 'applied' ? 'applying' : outcome.status;
  let row;
  if (reusableRow) {
    // Re-examination of a no_candidate / stale-applying row: same ledger
    // row, fresh outcome. Skip the re-write (and any re-send) when a
    // re-examined no_candidate stayed no_candidate.
    if (reusableRow.status === 'no_candidate' && outcome.status === 'no_candidate') {
      return { skipped: 'already_examined', status: 'no_candidate' };
    }
    // Claim the row: the write lands only while the row still has the
    // status this run read (a stale 'applying' row: only while still
    // stale). A bounce webhook and the re-look sweep can examine the same
    // row at once; the run that loses writes nothing, so it cannot apply
    // twice or demote the winner's record (Codex r1 on #7906).
    const claimed = await db('email_bounce_rescues')
      .where({ id: reusableRow.id, status: reusableRow.status })
      .modify((q) => {
        if (reusableRow.status === 'applying') {
          q.where('updated_at', '<', new Date(Date.now() - APPLYING_STALE_MINUTES * 60_000));
        }
      })
      .update({
        tier: outcome.tier || null,
        candidate_email: outcome.candidate || null,
        evidence: JSON.stringify(ledgerEvidence(outcome)),
        status: persistStatus,
        updated_at: new Date(),
      });
    if (!claimed) return { skipped: 'already_examined' };
    row = { ...reusableRow, status: persistStatus };
  } else {
    row = await recordRescue({
      bouncedEmail,
      customerId: owner.customer?.id || null,
      leadId: owner.lead?.id || null,
      tier: outcome.tier || null,
      candidate: outcome.candidate || null,
      evidence: ledgerEvidence(outcome),
      status: persistStatus,
      appliedBy: outcome.status === 'applied' ? appliedBy : null,
    });
    if (!row) return { skipped: 'already_examined' }; // lost the unique race
  }

  if (outcome.status === 'applied') {
    try {
      await applyFix({
        bouncedEmail, candidate: outcome.candidate, owner, tier: outcome.tier,
        evidence: outcome.evidence, appliedBy, selfFix: Boolean(outcome.selfFix),
        rescueRowId: row.id,
      });
    } catch (err) {
      // STALE_OWNER, STALE_CLAIM or a write failure: the transaction rolled
      // back, so nothing changed. Demote this run's own 'applying' claim so
      // --apply can retry; never a row another run already finished.
      await db('email_bounce_rescues').where({ id: row.id, status: 'applying' })
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
    }).catch(async (err) => {
      logger.warn(`[email-bounce-rescue] suggestion email failed: ${err.message}`);
      await suggestionFallbackBell({
        rescueRowId: row.id, bouncedEmail, candidate: outcome.candidate || null,
        owner, sendError: err.message,
      });
    });
  }
  return { bouncedEmail, ...outcome, rescueId: row.id };
}

// ── re-look after a later call (GATE_CALL_BOUNCE_SELF_FIX) ──────────

// The words the decode reads (extractSpelledContexts), as a Postgres regex: a
// later call that never talks about email holds no correction, so it costs
// no re-look. Bound as a value — the pattern's `?` must not reach the SQL.
const EMAIL_TALK_PATTERN = 'e-?mail|@|\\mdot\\M\\s*(com|net|org|edu)';

/**
 * A no-fix bounced address gets one more look after each later processed
 * call (processing verdict after the last look) that talks about email. Only a customer whose PRIMARY email is still
 * the bounced address; leads stay as they are. The look is the normal
 * rescue (self-fix rules included); a look that finds nothing marks the row
 * looked, so the same call is never read (or paid for) twice.
 */
async function relookAfterNewCalls({ limit = RELOOK_BATCH, rescueFn = rescueBouncedAddress } = {}) {
  if (!rescueEnabled() || !callBounceSelfFixLive()) return { skipped: 'gated_off' };
  const { whereNotSandboxCall } = require('./voice-agent/relay-protocol');
  const rows = await db('email_bounce_rescues as r')
    .join('customers as c', 'c.id', 'r.customer_id')
    .where('r.status', 'no_candidate')
    .whereNull('c.deleted_at')
    .whereNotNull('c.phone')
    .whereRaw('LOWER(c.email) = LOWER(r.bounced_email)')
    .whereExists(function laterEmailCall() {
      this.select(db.raw('1')).from('call_log as cl')
        .where((w) => w.whereRaw('cl.from_phone = c.phone').orWhereRaw('cl.to_phone = c.phone'))
        .whereNotNull('cl.transcription')
        // A processing verdict after the last look: a call still in
        // processing (no processed_at) waits for its verdict.
        .whereRaw('cl.processed_at > r.updated_at')
        .whereRaw('cl.transcription ~* ?', [EMAIL_TALK_PATTERN])
        .modify((qb) => whereNotSandboxCall(qb, 'cl.source'));
    })
    .orderBy('r.updated_at')
    .limit(limit)
    .select('r.id', 'r.bounced_email');
  const summary = { examined: 0, fixed: 0, suggested: 0, unchanged: 0, failed: 0 };
  for (const row of rows) {
    summary.examined += 1;
    // The look covers calls processed before it started: a call that lands
    // while the rescue runs stays newer than the mark (Codex r1 on #7906).
    const lookedAt = new Date();
    try {
      const result = await rescueFn(row.bounced_email, { appliedBy: 'relook' });
      if (result?.status === 'applied') summary.fixed += 1;
      else if (result?.status === 'suggested') summary.suggested += 1;
      else summary.unchanged += 1;
    } catch (err) {
      summary.failed += 1;
      logger.warn(`[email-bounce-rescue] re-look failed for ${redactEmail(row.bounced_email)}: ${err.message}`);
    }
    // Still no fix: mark the row looked (a failed look too — one paid read
    // per call, never one per tick).
    await db('email_bounce_rescues')
      .where({ id: row.id, status: 'no_candidate' })
      .update({ updated_at: lookedAt })
      .catch((err) => logger.warn(`[email-bounce-rescue] re-look mark failed: ${err.message}`));
  }
  return summary;
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
 * Read-only preview of what applySuggestedRescue would change — the ops
 * script's --apply dry run prints this so the operator sees the exact
 * target (owner, field, bounced → candidate) and the CURRENT validation
 * verdict before running --execute on a possibly stale/mistyped id.
 */
async function previewSuggestedRescue(rescueId) {
  const row = await db('email_bounce_rescues').where({ id: rescueId }).first();
  if (!row) return { error: 'rescue row not found' };
  const bouncedEmail = normalizeEmail(row.bounced_email);
  const owner = await findOwner(bouncedEmail);
  const ownerName = owner.customer
    ? `${owner.customer.first_name || ''} ${owner.customer.last_name || ''}`.trim()
    : owner.lead ? `${owner.lead.first_name || ''} ${owner.lead.last_name || ''}`.trim() : null;
  const validation = row.candidate_email
    ? await validateCandidate(row.candidate_email, {
      bouncedEmail,
      ownerCustomerId: owner.customer?.id || null,
      ownerLeadId: owner.lead?.id || null,
      excludeRescueId: row.id,
    })
    : { ok: false, reason: 'row has no candidate' };
  return {
    rescueId: row.id,
    status: row.status,
    tier: row.tier,
    bouncedEmail,
    candidate: row.candidate_email ? normalizeEmail(row.candidate_email) : null,
    owner: owner.customer
      ? { kind: 'customer', id: owner.customer.id, name: ownerName, field: owner.field }
      : owner.lead ? { kind: 'lead', id: owner.lead.id, name: ownerName, field: 'email' } : null,
    validation,
  };
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
  if (!v.ok) return { error: `validation failed: ${v.reason}${v.collision ? ` (${[v.collision.kind, v.collision.id].filter(Boolean).join(' ')})` : ''}` };
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
  relookAfterNewCalls,
  applySuggestedRescue,
  previewSuggestedRescue,
  // exported for unit tests — pure/deterministic pieces
  editDistance,
  selfFixCost,
  isSmallFix,
  decodeSpelledCandidates,
  extractSpelledContexts,
  consensusCandidates,
  validateCandidate,
  bounceSuggestionHeadlineAndSummary,
  bounceAlertMetadata,
  BOUNCE_ALERT_DONE_WHEN,
  CUSTOMER_EMAIL_FIELDS,
  sendSuggestionEmail,
};

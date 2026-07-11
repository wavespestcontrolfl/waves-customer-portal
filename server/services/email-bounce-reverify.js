/**
 * Bounce-triggered call-audio email re-verification.
 *
 * The use case this encodes (owner, 2026-07-11, the Pitts bounce): a
 * call-captured email hard-bounced (apitz6958@yahoo.com) and the domain
 * corrector rightly had nothing — the error was in the LOCAL PART, which the
 * corrector never touches. But the source RECORDING is ground truth: re-run
 * the audio through the transcription pipeline (whose contact-dictation pass
 * transcribes spelled letters literally), decode email candidates, and add
 * deterministic NAME-ANCHORED candidates — the caller spelled his surname
 * P-I-T-T-S seconds before dictating a local part that ends in the same
 * word, so "apitz" vs "apitts" resolves against the spelled name. The bounce
 * itself corroborates: the wrong variant is the one that bounced.
 *
 * Output is a Needs-Review card with ranked candidates and the exact
 * read-back question ("A-P-I-T-T-S-6-9-5-8 at yahoo — that right?").
 * NOTHING is written to the customer and NOTHING is sent — the owner
 * confirms with the customer, then updates the record (house rule: owner
 * sends all customer communication).
 *
 * Dark behind GATE_CALL_BOUNCE_REVERIFY (each run re-transcribes audio =
 * real provider spend; bounces are rare, but the switch is the owner's).
 * Best-effort everywhere: this runs off the bounce webhook path and must
 * never throw into it.
 */

const db = require('../models/db');
const logger = require('./logger');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SOURCE_CALL_LOOKBACK_DAYS = 180;

// ── Pure helpers (exported for tests) ───────────────────────────────────

function levenshtein(a, b) {
  const m = a.length; const n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Deterministic name-anchored candidates: when the bounced local part looks
 * like (letters + digits) and the letters sit within edit distance 2 of a
 * form built from the caller's own name, propose that form with the same
 * digits and domain. This is what turns "apitz6958" + spelled "Pitts" into
 * apitts6958 — no model involved, so it can't hallucinate.
 */
function nameAnchoredEmailCandidates({ bouncedEmail, firstName = null, lastName = null }) {
  const email = String(bouncedEmail || '').trim().toLowerCase();
  const at = email.indexOf('@');
  if (at <= 0) return [];
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const m = local.match(/^([a-z.]+?)(\d*)$/);
  if (!m) return [];
  const [, alpha, digits] = m;
  const first = String(firstName || '').toLowerCase().replace(/[^a-z]/g, '');
  const last = String(lastName || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!last && !first) return [];
  const forms = new Set([
    first && last ? `${first[0]}${last}` : null,
    first && last ? `${first}${last}` : null,
    first && last ? `${first}.${last}` : null,
    first && last ? `${first[0]}.${last}` : null,
    last || null,
    first || null,
  ].filter(Boolean));
  const out = [];
  for (const form of forms) {
    const dist = levenshtein(alpha.replace(/\./g, ''), form.replace(/\./g, ''));
    if (dist === 0 || dist > 2 || dist >= form.length) continue;
    const value = `${form}${digits}@${domain}`;
    if (value === email || !EMAIL_RE.test(value)) continue;
    out.push({ value, source: 'name_anchor', confidence: dist === 1 ? 'high' : 'medium', edit_distance: dist });
  }
  // Nearest form first.
  out.sort((a, b) => a.edit_distance - b.edit_distance);
  return out;
}

/** "apitts6958@yahoo.com" → "A-P-I-T-T-S-6-9-5-8 at yahoo — is that right?" */
function buildReadbackQuestion(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.indexOf('@');
  if (at <= 0) return null;
  const spelled = e.slice(0, at).toUpperCase().split('').map((ch) => (ch === '.' ? 'DOT' : ch)).join('-');
  const domainWord = e.slice(at + 1).split('.')[0];
  return `${spelled} at ${domainWord} — is that right?`;
}

/**
 * Merge decoder + name-anchored candidates: dedupe by value, union sources,
 * and rank agreement (both sources) above single-source, high above medium.
 * The bounced address itself never survives.
 */
function mergeCandidates({ bouncedEmail, decoderCandidates = [], nameCandidates = [] }) {
  const bounced = String(bouncedEmail || '').trim().toLowerCase();
  const byValue = new Map();
  const add = (value, source, confidence) => {
    const v = String(value || '').trim().toLowerCase();
    if (!v || v === bounced || !EMAIL_RE.test(v)) return;
    const cur = byValue.get(v) || { value: v, sources: [], confidence: 'medium' };
    if (!cur.sources.includes(source)) cur.sources.push(source);
    if (confidence === 'high') cur.confidence = 'high';
    byValue.set(v, cur);
  };
  for (const c of decoderCandidates) add(c.value, 'audio_decoder', Number(c.confidence) >= 0.8 ? 'high' : 'medium');
  for (const c of nameCandidates) add(c.value, 'name_anchor', c.confidence);
  const rank = (c) => (c.sources.length > 1 ? 0 : 1) * 10 + (c.confidence === 'high' ? 0 : 1);
  return [...byValue.values()].sort((a, b) => rank(a) - rank(b)).slice(0, 3);
}

// ── Orchestration ────────────────────────────────────────────────────────

async function findSourceCall({ bouncedEmail, customerId = null }) {
  const bounced = String(bouncedEmail || '').trim().toLowerCase();
  const q = db('call_log')
    .whereNotNull('recording_url')
    .whereRaw(`created_at >= now() - interval '${SOURCE_CALL_LOOKBACK_DAYS} days'`)
    .where(function () {
      // Text-level match — no ::jsonb casts (legacy malformed rows). The
      // exact-email hit is the strongest link; a customer link is the
      // fallback when the extraction stored a variant.
      this.whereRaw('LOWER(COALESCE(ai_extraction, \'\')) LIKE ?', [`%${bounced}%`]);
      if (customerId) this.orWhere('customer_id', customerId);
    })
    .select('id', 'recording_url', 'created_at', 'customer_id', 'ai_extraction')
    .orderByRaw('(LOWER(COALESCE(ai_extraction, \'\')) LIKE ?) DESC, created_at DESC', [`%${bounced}%`])
    .limit(1);
  return (await q)[0] || null;
}

async function reverifyBouncedEmailFromCall({ bouncedEmail, customerId = null }) {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('callBounceReverify')) return { skipped: 'gated_off' };
    const bounced = String(bouncedEmail || '').trim().toLowerCase();
    if (!EMAIL_RE.test(bounced)) return { skipped: 'no_email' };

    const call = await findSourceCall({ bouncedEmail: bounced, customerId });
    if (!call) return { skipped: 'no_source_call' };

    // One card per call: skip BEFORE spending on re-transcription (bounces of
    // the report + invoice + receipt for the same bad address arrive together).
    const openCard = await db('triage_items')
      .where({ call_log_id: call.id, reason_code: 'email_bounce_reverify' })
      .whereIn('status', ['open', 'in_progress'])
      .first('id')
      .catch(() => null);
    if (openCard) return { skipped: 'card_open' };

    // Re-run the AUDIO through the full transcription pipeline. The stored
    // transcript is the wrong artifact here — it's where the mis-heard
    // letter lives; the contact-dictation pass re-listens letter-by-letter.
    const CallProc = require('./call-recording-processor');
    const result = await CallProc.transcribeRecording(call.recording_url);
    if (!result?.transcription) return { skipped: 'retranscribe_failed' };

    const { decodeDictatedContacts } = require('./contact-dictation');
    const decoded = await decodeDictatedContacts({
      transcript: result.transcription,
      contactPassTranscript: result.contactPassTranscript || null,
    });
    const decoderCandidates = (decoded?.emails || []).flatMap((e) => e.candidates || []);

    const v1 = (() => { try { return JSON.parse(call.ai_extraction) || {}; } catch { return {}; } })();
    const nameCandidates = nameAnchoredEmailCandidates({
      bouncedEmail: bounced,
      firstName: v1.first_name,
      lastName: v1.last_name,
    });

    const candidates = mergeCandidates({ bouncedEmail: bounced, decoderCandidates, nameCandidates });
    if (!candidates.length) return { skipped: 'no_candidates' };

    const { buildTriageItem } = require('./call-routing-gates');
    await db('triage_items')
      .insert(buildTriageItem({
        callLogId: call.id,
        flag: 'email_bounce_reverify',
        extraction: { meta: { call_summary: `Hard bounce on ${bounced} — audio re-verification proposes ${candidates[0].value}` } },
        severity: 'advisory',
        extraPayload: {
          bounced_email: bounced,
          candidates,
          readback_question: buildReadbackQuestion(candidates[0].value),
          transcriber: { provider: result.provider || null, contact_pass: !!result.contactPassTranscript },
          customer_id: customerId || call.customer_id || null,
        },
      }))
      .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
      .ignore();

    logger.info(`[bounce-reverify] Carded ${candidates.length} candidate(s) for bounced address (call ${call.id})`);
    return { carded: true, callId: call.id, candidates };
  } catch (err) {
    logger.warn(`[bounce-reverify] failed open: ${err.message}`);
    return { skipped: 'error', error: err.message };
  }
}

module.exports = {
  reverifyBouncedEmailFromCall,
  nameAnchoredEmailCandidates,
  buildReadbackQuestion,
  mergeCandidates,
  findSourceCall,
};

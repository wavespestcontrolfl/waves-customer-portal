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

/**
 * Only decoder candidates PLAUSIBLY ABOUT the bounced address may compete —
 * a call can dictate several emails (spouse's, a buyer's), and an unrelated
 * one must never outrank the correction for the recipient that bounced.
 * Relevant = same domain AND local part within edit distance 3.
 */
function filterDecoderCandidatesToBounced(decoderCandidates, bouncedEmail) {
  const bounced = String(bouncedEmail || '').trim().toLowerCase();
  const at = bounced.indexOf('@');
  if (at <= 0) return [];
  const bLocal = bounced.slice(0, at);
  const bDomain = bounced.slice(at + 1);
  return (decoderCandidates || []).filter((c) => {
    const v = String(c?.value || '').trim().toLowerCase();
    const vAt = v.indexOf('@');
    if (vAt <= 0) return false;
    if (v.slice(vAt + 1) !== bDomain) return false;
    return levenshtein(v.slice(0, vAt), bLocal) <= 3;
  });
}

// LIKE-pattern escaping: '_' matches any char and '%' any run — and '_' is a
// COMMON email character (first_last@…), so an unescaped predicate can match
// a different address and burn a re-transcription on the wrong call.
function escapeLike(value) {
  return String(value || '').replace(/[\\%_]/g, (ch) => `\\${ch}`);
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
 * and rank agreement (both sources) above single-source, then by confidence.
 * Confidence is NUMERIC 0–1 to match the Needs Review renderer
 * (ConfirmEvidence prints `${value} (NN%)` from payload.email_candidates).
 * The bounced address itself never survives.
 */
function mergeCandidates({ bouncedEmail, decoderCandidates = [], nameCandidates = [] }) {
  const bounced = String(bouncedEmail || '').trim().toLowerCase();
  const byValue = new Map();
  const add = (value, source, confidence) => {
    const v = String(value || '').trim().toLowerCase();
    if (!v || v === bounced || !EMAIL_RE.test(v)) return;
    const conf = Math.max(0, Math.min(1, Number(confidence) || 0));
    const cur = byValue.get(v) || { value: v, sources: [], confidence: 0 };
    if (!cur.sources.includes(source)) cur.sources.push(source);
    cur.confidence = Math.max(cur.confidence, conf);
    byValue.set(v, cur);
  };
  for (const c of decoderCandidates) add(c.value, 'audio_decoder', c.confidence);
  for (const c of nameCandidates) add(c.value, 'name_anchor', c.edit_distance === 1 ? 0.85 : 0.6);
  const merged = [...byValue.values()];
  for (const c of merged) {
    // Independent agreement (audio + name anchor) is the strongest evidence —
    // exactly how the original Pitts case was settled.
    if (c.sources.length > 1) c.confidence = Math.min(0.98, c.confidence + 0.1);
  }
  merged.sort((a, b) => (b.sources.length - a.sources.length) || (b.confidence - a.confidence));
  return merged.slice(0, 3);
}

// ── Orchestration ────────────────────────────────────────────────────────

async function findSourceCall({ bouncedEmail, customerId = null }) {
  const bounced = String(bouncedEmail || '').trim().toLowerCase();
  // The extraction must actually CONTAIN the bounced address (text-level —
  // no ::jsonb casts on legacy rows). A bare customer fallback would pick the
  // customer's latest recorded call even when this address never came from a
  // call at all (manual entry, old variant) and burn a re-transcription on
  // unrelated audio that can only yield misleading candidates. No match →
  // no evidence → skip. customerId only ranks among multiple matches.
  const q = db('call_log')
    .whereNotNull('recording_url')
    .whereRaw(`created_at >= now() - interval '${SOURCE_CALL_LOOKBACK_DAYS} days'`)
    .whereRaw('LOWER(COALESCE(ai_extraction, \'\')) LIKE ?', [`%${escapeLike(bounced)}%`])
    .select('id', 'recording_url', 'recording_duration_seconds', 'duration_seconds', 'created_at', 'customer_id', 'ai_extraction')
    .modify((qb) => {
      if (customerId) qb.orderByRaw('(customer_id = ?) DESC, created_at DESC', [customerId]);
      else qb.orderBy('created_at', 'desc');
    })
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

    // CLAIM FIRST, transcribe second: bounces of the report + invoice +
    // receipt for the same bad address arrive together, and each
    // fire-and-forget invocation would pass a read-only check before the
    // first inserts — all paying for provider work. The partial unique index
    // on (call_log_id, reason_code) WHERE open makes this insert the mutex:
    // exactly one caller gets a row back and proceeds.
    const { buildTriageItem } = require('./call-routing-gates');
    const claimed = await db('triage_items')
      .insert(buildTriageItem({
        callLogId: call.id,
        flag: 'email_bounce_reverify',
        extraction: { meta: { call_summary: `Hard bounce on ${bounced} — re-listening to the source recording…` } },
        severity: 'advisory',
        extraPayload: { bounced_email: bounced, analyzing: true, customer_id: customerId || call.customer_id || null },
      }))
      .onConflict(db.raw('(call_log_id, reason_code) WHERE status IN (\'open\', \'in_progress\')'))
      .ignore()
      .returning('id');
    if (!claimed.length) {
      // An open card already exists for this call. If it's about a DIFFERENT
      // bounced address (one recording can dictate two emails, both wrong),
      // annotate it rather than silently dropping the second bounce — the
      // office re-listens to the same audio once for both.
      try {
        const openCard = await db('triage_items')
          .where({ call_log_id: call.id, reason_code: 'email_bounce_reverify' })
          .whereIn('status', ['open', 'in_progress'])
          .first('id', 'payload');
        const payload = typeof openCard?.payload === 'string' ? JSON.parse(openCard.payload) : (openCard?.payload || null);
        if (payload && payload.bounced_email && payload.bounced_email !== bounced) {
          const extra = Array.isArray(payload.additional_bounced_emails) ? payload.additional_bounced_emails : [];
          if (!extra.includes(bounced)) {
            extra.push(bounced);
            await db('triage_items').where({ id: openCard.id }).update({
              payload: JSON.stringify({ ...payload, additional_bounced_emails: extra }),
              summary: `${payload.bounced_email} and ${extra.length} more address(es) from this call hard-bounced — confirm on the read-back`,
              updated_at: new Date(),
            });
          }
        }
      } catch (e) { logger.warn(`[bounce-reverify] open-card annotation failed open: ${e.message}`); }
      return { skipped: 'card_open' };
    }
    const cardId = claimed[0].id || claimed[0];

    // Re-run the AUDIO through the full transcription pipeline. The stored
    // transcript is the wrong artifact here — it's where the mis-heard
    // letter lives; the contact-dictation pass re-listens letter-by-letter.
    const CallProc = require('./call-recording-processor');
    // forceContactPass: the primary transcript may have normalized the
    // misheard address into something that no longer trips the dictation
    // signals — for a bounce re-verify the letter-fidelity pass IS the point.
    const result = await CallProc.transcribeRecording(call.recording_url, { forceContactPass: true });
    // Same hallucination guard the live pipeline applies before trusting a
    // transcript — a near-silent recording can yield a long invented one,
    // and candidates decoded from it would be confidently wrong.
    // Guard signature is (transcription, recordingSeconds) — fails open on
    // unknown duration, same as the live pipeline.
    // Same duration fallback as the live pipeline: legacy/imported rows can
    // have duration_seconds without recording_duration_seconds.
    const recordingSeconds = Number(call.recording_duration_seconds) || Number(call.duration_seconds) || 0;
    if (!result?.transcription || CallProc.isImplausibleTranscript(result.transcription, recordingSeconds)) {
      await db('triage_items').where({ id: cardId }).del().catch(() => {});
      return { skipped: !result?.transcription ? 'retranscribe_failed' : 'implausible_transcript' };
    }

    const { decodeDictatedContacts } = require('./contact-dictation');
    const decoded = await decodeDictatedContacts({
      transcript: result.transcription,
      contactPassTranscript: result.contactPassTranscript || null,
    });
    const decoderCandidates = filterDecoderCandidatesToBounced(
      (decoded?.emails || []).flatMap((e) => e.candidates || []),
      bounced,
    );

    const v1 = (() => { try { return JSON.parse(call.ai_extraction) || {}; } catch { return {}; } })();
    const nameCandidates = nameAnchoredEmailCandidates({
      bouncedEmail: bounced,
      firstName: v1.first_name,
      lastName: v1.last_name,
    });

    const candidates = mergeCandidates({ bouncedEmail: bounced, decoderCandidates, nameCandidates });
    if (!candidates.length) {
      // The claim row was only the mutex — an empty card would ask the office
      // to confirm nothing.
      await db('triage_items').where({ id: cardId }).del().catch(() => {});
      return { skipped: 'no_candidates' };
    }

    // Payload keys match the Needs Review renderer's contract
    // (ConfirmEvidence): email_as_heard → "Heard", email_candidates →
    // value+(NN%), confirmation_question → the read-back script. NEVER
    // 'candidates' — that key renders as shared-phone customer matches.
    await db('triage_items')
      .where({ id: cardId })
      .update({
        summary: `Hard bounce on ${bounced} — audio re-verification proposes ${candidates[0].value}`,
        payload: JSON.stringify({
          flag: 'email_bounce_reverify',
          bounced_email: bounced,
          email_as_heard: bounced,
          email_candidates: candidates,
          confirmation_question: buildReadbackQuestion(candidates[0].value),
          transcriber: { provider: result.provider || null, contact_pass: !!result.contactPassTranscript },
          customer_id: customerId || call.customer_id || null,
        }),
        updated_at: new Date(),
      });

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
  filterDecoderCandidatesToBounced,
  escapeLike,
  findSourceCall,
};

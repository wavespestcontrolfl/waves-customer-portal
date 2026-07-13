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
  // Distance budget scales with the local part: an absolute 3 would let
  // "bob@" compete when "a@" bounced. clamp(floor(len/2), 1, 3).
  const maxDist = Math.max(1, Math.min(3, Math.floor(bLocal.length / 2)));
  return (decoderCandidates || []).filter((c) => {
    const v = String(c?.value || '').trim().toLowerCase();
    const vAt = v.indexOf('@');
    if (vAt <= 0) return false;
    if (v.slice(vAt + 1) !== bDomain) return false;
    return levenshtein(v.slice(0, vAt), bLocal) <= maxDist;
  });
}

// Boundary-anchored regex for locating an email inside free text: a bare
// substring match burns a re-transcription on the WRONG call whenever the
// bounced address sits inside a longer one (ann@example.com inside
// joann@example.com). Left boundary: no local-part character before the
// address. Right boundary: no domain continuation after it — a plain
// alnum/hyphen (a@x.com vs a@x.company) or a dot that starts another label
// (a@x.com vs a@x.com.au); a sentence-trailing dot still matches. Postgres
// ARE and JS RegExp both accept this syntax.
function emailBoundaryRegex(email) {
  const escaped = String(email || '').trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(^|[^a-z0-9._%+-])${escaped}($|[^a-z0-9.-]|\\.([^a-z0-9-]|$))`;
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
    .whereRaw('LOWER(COALESCE(ai_extraction, \'\')) ~ ?', [emailBoundaryRegex(bounced)])
    // twilio_call_sid + recording_sid ride along for the PAN quarantine
    // path: without the call SID, quarantineCardRecording can strip
    // call_log.recording_url but cannot clear the recording media already
    // synced onto the unified voice message (Codex #2676 round-7/8 P1).
    // transcription + transcript_structured ride along for the legacy-heal
    // pass (round-10 P1): a processed legacy call's STORED artifacts can
    // carry the same card readback this re-listen detects.
    .select('id', 'recording_url', 'recording_sid', 'twilio_call_sid', 'recording_duration_seconds', 'duration_seconds', 'created_at', 'customer_id', 'ai_extraction', 'transcription', 'transcript_structured')
    .modify((qb) => {
      if (customerId) qb.orderByRaw('(customer_id = ?) DESC, created_at DESC', [customerId]);
      else qb.orderBy('created_at', 'desc');
    })
    .limit(1);
  return (await q)[0] || null;
}

/**
 * @param {string} bouncedEmail   the address that just hard-bounced
 * @param {string} [sourceEmail]  the address to LOCATE the call by (the
 *                                original capture) — differs from bouncedEmail
 *                                when a domain-corrected RESEND re-bounced
 * @param {string[]} [alsoExclude] additional known-bad variants that must
 *                                never resurface as candidates
 */
async function reverifyBouncedEmailFromCall({ bouncedEmail, customerId = null, sourceEmail = null, alsoExclude = [] }) {
  try {
    const { isEnabled } = require('../config/feature-gates');
    if (!isEnabled('callBounceReverify')) return { skipped: 'gated_off' };
    const bounced = String(bouncedEmail || '').trim().toLowerCase();
    if (!EMAIL_RE.test(bounced)) return { skipped: 'no_email' };

    const matchEmail = String(sourceEmail || bounced).trim().toLowerCase();
    const call = await findSourceCall({ bouncedEmail: matchEmail, customerId });
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
        // CAS retry: the worker's final write and this annotation race on the
        // same payload column — an unconditional update from a stale read
        // would clobber whichever wrote first. Condition on updated_at and
        // re-read on a miss, mirroring the worker's delete CAS.
        for (let attempt = 0; attempt < 3; attempt++) {
          const openCard = await db('triage_items')
            .where({ call_log_id: call.id, reason_code: 'email_bounce_reverify' })
            .whereIn('status', ['open', 'in_progress'])
            .first('id', 'payload', 'updated_at');
          const payload = typeof openCard?.payload === 'string' ? JSON.parse(openCard.payload) : (openCard?.payload || null);
          if (!payload || !payload.bounced_email || payload.bounced_email === bounced) break;
          const extra = Array.isArray(payload.additional_bounced_emails) ? payload.additional_bounced_emails : [];
          if (extra.includes(bounced)) break;
          extra.push(bounced);
          const updated = { ...payload, additional_bounced_emails: extra };
          // If the first pass already FINISHED, no worker will re-enter the
          // candidate loop for this card — compute this address's read-back
          // right here from the decode stored on the card (all local, no
          // provider work). While analyzing, the worker's re-read loop picks
          // the annotation up instead.
          if (!payload.analyzing && Array.isArray(payload.decoder_candidates_all)) {
            const v1 = (() => { try { return JSON.parse(call.ai_extraction) || {}; } catch { return {}; } })();
            const knownBad = new Set([payload.bounced_email, ...extra, matchEmail]);
            const cands = mergeCandidates({
              bouncedEmail: bounced,
              decoderCandidates: filterDecoderCandidatesToBounced(payload.decoder_candidates_all, bounced),
              nameCandidates: nameAnchoredEmailCandidates({ bouncedEmail: bounced, firstName: v1.first_name, lastName: v1.last_name }),
            }).filter((c) => !knownBad.has(c.value));
            if (cands.length) {
              updated.additional_reverifications = [
                ...(Array.isArray(payload.additional_reverifications) ? payload.additional_reverifications : []),
                { bounced_email: bounced, email_as_heard: bounced, email_candidates: cands, confirmation_question: buildReadbackQuestion(cands[0].value) },
              ];
            }
          }
          const won = await db('triage_items')
            .where({ id: openCard.id, updated_at: openCard.updated_at })
            .update({
              payload: JSON.stringify(updated),
              summary: `${payload.bounced_email} and ${extra.length} more address(es) from this call hard-bounced — confirm on the read-back`,
              updated_at: new Date(),
            });
          if (won) break;
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
    // quarantine + call: a PAN first detected on this re-listen must strip
    // the recording like the live pipeline would (Codex #2676 round-5 P1) —
    // this path mutates contact data anyway, so it is a mutating caller.
    const result = await CallProc.transcribeRecording(call.recording_url, { call, forceContactPass: true, quarantine: true });
    // Heal the PERSISTED artifacts too (Codex #2676 round-10 P1): the
    // quarantine above strips the audio, but a legacy call's stored
    // transcription / transcript_structured / admin-thread body still carry
    // the raw readback — scrub-and-persist them exactly like the backfill
    // and live-fallback paths do. Best-effort: a heal failure never blocks
    // the bounce-reverify decode this job exists for.
    try {
      const panScrubMod = require('../utils/pan-scrub');
      const legacyText = panScrubMod.scrubPansDetailed(call.transcription ?? null);
      const legacyStructured = CallProc.scrubStructuredTranscript(call.transcript_structured ?? null);
      if (legacyText.count + legacyStructured.count > 0) {
        await db('call_log').where({ id: call.id }).update({
          ...(legacyText.count > 0 ? { transcription: legacyText.text } : {}),
          ...(legacyStructured.count > 0 ? { transcript_structured: legacyStructured.json } : {}),
          updated_at: db.fn.now(),
        });
        // Quarantine FIRST (round-11 P1): the message sync derives media
        // from call.recording_url, so syncing while it is still populated
        // could write/reattach the PAN-bearing audio to the admin thread
        // moments before a best-effort quarantine that might fail.
        await CallProc.quarantineCardRecording(call, { source: 'bounce_reverify_legacy' }).catch(() => {});
        call.recording_url = null;
        if (legacyText.count > 0) {
          call.transcription = legacyText.text;
          // The synced voice message shows the transcript as its body —
          // heal it with the recording reference already stripped.
          await CallProc.updateUnifiedVoiceMessage(call, { body: legacyText.text, media: null }).catch(() => {});
        }
        if (legacyStructured.count > 0) call.transcript_structured = legacyStructured.json;
      }
    } catch (healErr) {
      logger.warn(`[bounce-reverify] legacy PAN heal failed for call ${call.id}: ${healErr.message}`);
    }
    // Same hallucination guard the live pipeline applies before trusting a
    // transcript — a near-silent recording can yield a long invented one,
    // and candidates decoded from it would be confidently wrong.
    // Guard signature is (transcription, recordingSeconds) — fails open on
    // unknown duration, same as the live pipeline.
    // Same duration fallback as the live pipeline: legacy/imported rows can
    // have duration_seconds without recording_duration_seconds.
    const recordingSeconds = Number(call.recording_duration_seconds) || Number(call.duration_seconds) || 0;
    if (!result?.transcription || CallProc.isImplausibleTranscript(result.transcription, recordingSeconds)) {
      // Unconditional delete is correct HERE (unlike the no-candidates path
      // below): every address annotated onto this card shares this one
      // recording, so a failed or implausible re-transcription dooms them all
      // equally — no address could ever be carded from it.
      await db('triage_items').where({ id: cardId }).del().catch(() => {});
      return { skipped: !result?.transcription ? 'retranscribe_failed' : 'implausible_transcript' };
    }

    const { decodeDictatedContacts } = require('./contact-dictation');
    const decoded = await decodeDictatedContacts({
      transcript: result.transcription,
      contactPassTranscript: result.contactPassTranscript || null,
    });
    const allDecoderCandidates = (decoded?.emails || []).flatMap((e) => e.candidates || []);

    const v1 = (() => { try { return JSON.parse(call.ai_extraction) || {}; } catch { return {}; } })();

    // A SECOND bounced address may be annotated onto the claim row at ANY
    // point while this runs (one recording can dictate two emails, both
    // wrong). The audio work is already paid for, so every annotated address
    // is tried against the same decode — and the shared mutex row is only
    // deleted via compare-and-swap on updated_at: an annotation landing
    // between the read and the delete voids the delete (the annotation path
    // bumps updated_at) and the loop processes the new address instead of
    // letting it vanish with the card.
    const norm = (e) => String(e || '').trim().toLowerCase();
    const alsoExcludeNorm = alsoExclude.map(norm);
    const candidatesFor = (addr, excluded) => mergeCandidates({
      bouncedEmail: addr,
      decoderCandidates: filterDecoderCandidatesToBounced(allDecoderCandidates, addr),
      nameCandidates: nameAnchoredEmailCandidates({ bouncedEmail: addr, firstName: v1.first_name, lastName: v1.last_name }),
    }).filter((c) => !excluded.has(c.value));

    let carded = null;
    const tried = new Set();
    while (!carded) {
      const row = await db('triage_items').where({ id: cardId }).first('payload', 'updated_at').catch(() => null);
      if (!row) return { skipped: 'card_gone' };
      const rowPayload = typeof row.payload === 'string'
        ? (() => { try { return JSON.parse(row.payload); } catch { return {}; } })()
        : (row.payload || {});
      const annotated = (Array.isArray(rowPayload.additional_bounced_emails) ? rowPayload.additional_bounced_emails : [])
        .map(norm)
        .filter((e) => EMAIL_RE.test(e));
      const known = [...new Set([bounced, ...annotated])];
      // EVERY address on the card hard-bounced — none may resurface as a candidate.
      const excluded = new Set([...known, matchEmail, ...alsoExcludeNorm]);
      const pending = known.filter((e) => !tried.has(e));
      if (!pending.length) {
        // No address on the card produced candidates — the claim row was only
        // the mutex, and an empty card would ask the office to confirm
        // nothing. Zero rows deleted = a concurrent annotation won; loop.
        const deleted = await db('triage_items')
          .where({ id: cardId, updated_at: row.updated_at })
          .del()
          .catch(() => 1); // fail open like the other delete paths — never loop on a DB error
        if (deleted) return { skipped: 'no_candidates' };
        continue;
      }
      for (const addr of pending) {
        tried.add(addr);
        const cands = candidatesFor(addr, excluded);
        if (cands.length) { carded = { address: addr, candidates: cands }; break; }
      }
    }
    const { candidates } = carded;

    // Payload keys match the Needs Review renderer's contract
    // (ConfirmEvidence): email_as_heard → "Heard", email_candidates →
    // value+(NN%), confirmation_question → the read-back script. NEVER
    // 'candidates' — that key renders as shared-phone customer matches.
    // Re-read before the final write: a SECOND bounced address can have been
    // annotated onto the claim row while transcription ran — a fresh payload
    // object must not clobber additional_bounced_emails.
    const currentRow = await db('triage_items').where({ id: cardId }).first('payload', 'status').catch(() => null);
    const currentPayload = typeof currentRow?.payload === 'string'
      ? (() => { try { return JSON.parse(currentRow.payload); } catch { return {}; } })()
      : (currentRow?.payload || {});
    // Every bounced address on the card OTHER than the carded one rides along
    // as additional — including the primary, when an annotated address won.
    const otherBounced = [...new Set([
      bounced,
      ...(Array.isArray(currentPayload.additional_bounced_emails) ? currentPayload.additional_bounced_emails : [])
        .map(norm),
    ])].filter((e) => EMAIL_RE.test(e) && e !== carded.address);
    // Each OTHER address gets its own read-back block when the decode
    // supports one (same local computation the annotation path uses for
    // late arrivals) — otherwise the office would see only the primary's
    // candidates for a card that covers several bounced addresses.
    const knownBadFinal = new Set([carded.address, ...otherBounced, matchEmail, ...alsoExcludeNorm]);
    const additionalReverifications = otherBounced
      .map((addr) => {
        const cands = candidatesFor(addr, knownBadFinal);
        return cands.length
          ? { bounced_email: addr, email_as_heard: addr, email_candidates: cands, confirmation_question: buildReadbackQuestion(cands[0].value) }
          : null;
      })
      .filter(Boolean);
    // An operator can resolve/dismiss the placeholder while transcription
    // runs — they acted on "analyzing…", not on evidence. Candidates landing
    // reopens the card so the correction can't hide in a closed bucket while
    // the bad address stays on file.
    const wasClosed = !!currentRow && !['open', 'in_progress'].includes(currentRow.status);
    await db('triage_items')
      .where({ id: cardId })
      .update({
        summary: `Hard bounce on ${carded.address} — audio re-verification proposes ${candidates[0].value}`,
        payload: JSON.stringify({
          flag: 'email_bounce_reverify',
          bounced_email: carded.address,
          email_as_heard: carded.address,
          email_candidates: candidates,
          confirmation_question: buildReadbackQuestion(candidates[0].value),
          transcriber: { provider: result.provider || null, contact_pass: !!result.contactPassTranscript },
          customer_id: customerId || call.customer_id || null,
          // The raw decode, kept on the card so a bounce arriving AFTER this
          // write can get its read-back computed locally instead of paying
          // for a second transcription (see the annotation path).
          decoder_candidates_all: allDecoderCandidates.slice(0, 24).map((c) => ({ value: c.value, confidence: c.confidence })),
          ...(otherBounced.length ? { additional_bounced_emails: otherBounced } : {}),
          ...(additionalReverifications.length ? { additional_reverifications: additionalReverifications } : {}),
        }),
        updated_at: new Date(),
        ...(wasClosed ? { status: 'open', resolved_at: null } : {}),
      });
    if (wasClosed) {
      // The call-level bookkeeping followed the mid-analysis close; an open
      // triage row exists again, so the call is back in review.
      await db('call_log').where({ id: call.id }).update({ review_status: 'open', updated_at: new Date() }).catch(() => {});
    }

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
  emailBoundaryRegex,
  findSourceCall,
};

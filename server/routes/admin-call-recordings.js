const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const {
  adminAuthenticate,
  requireTechOrAdmin,
  requireAdmin,
} = require('../middleware/admin-auth');
const CallRecordingProcessor = require('../services/call-recording-processor');
const { findKnownCallerCustomer } = require('../utils/known-caller-phone');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function maskSid(sid) {
  if (!sid) return 'none';
  const value = String(sid);
  return value.length <= 8 ? `${value.slice(0, 2)}…` : `${value.slice(0, 2)}…${value.slice(-6)}`;
}

function rejectQueryString(req, res, next) {
  if (req.originalUrl.includes('?')) {
    return res.status(400).json({
      error: 'Query strings are not supported for recording audio',
    });
  }
  return next();
}

function canonicalTwilioRecordingUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl || rawUrl !== rawUrl.trim()) return null;

  let url;
  try {
    url = new URL(rawUrl, 'https://api.twilio.com/');
  } catch {
    return null;
  }

  if (
    !['http:', 'https:'].includes(url.protocol)
    || url.hostname !== 'api.twilio.com'
    || url.port
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    return null;
  }

  // Twilio historically emitted HTTP media URLs and now redirects them to
  // HTTPS. Upgrade the one exact trusted host locally so Basic credentials are
  // never sent over plaintext and the proxy still refuses all redirects.
  url.protocol = 'https:';
  if (!url.pathname.endsWith('.mp3')) url.pathname += '.mp3';
  return url.toString();
}

// Fetch recording audio with the normal Bearer-authenticated middleware. The
// client converts the response to a short-lived Blob URL, so credentials never
// appear in request URLs, browser history, proxy logs, or Referer headers.
router.get(
  '/audio/:id',
  rejectQueryString,
  adminAuthenticate,
  requireTechOrAdmin,
  async (req, res) => {
    try {
      const config = require('../config');
      const param = req.params.id;
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(param);
      const recording = await db('call_log')
        .where(isUuid ? { id: param } : { recording_sid: param })
        .first();

      if (!recording?.recording_url) return res.status(404).json({ error: 'Recording not found' });

      const url = canonicalTwilioRecordingUrl(recording.recording_url);
      if (!url) return res.status(502).json({ error: 'Unable to load recording' });

      const authHeader = 'Basic ' + Buffer.from(`${config.twilio.accountSid}:${config.twilio.authToken}`).toString('base64');
      const audioRes = await fetch(url, {
        headers: { Authorization: authHeader },
        redirect: 'manual',
      });
      if (!audioRes.ok) return res.status(502).json({ error: 'Unable to load recording' });

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'private, no-store');
      const buffer = await audioRes.arrayBuffer();
      return res.send(Buffer.from(buffer));
    } catch (err) {
      logger.error('[call-recordings] Audio proxy failed', { error: err.message });
      return res.status(500).json({ error: 'Unable to load recording' });
    }
  },
);

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /stats — processing dashboard stats
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await CallRecordingProcessor.getStats();
    res.json(stats);
  } catch (err) { next(err); }
});

// GET /recordings — list recordings with processing status
router.get('/recordings', async (req, res, next) => {
  try {
    const { status, limit = 50, page = 1 } = req.query;
    let query = db('call_log')
      .whereNotNull('recording_url')
      .where('recording_url', '!=', '')
      .leftJoin('customers', 'call_log.customer_id', 'customers.id')
      .select(
        'call_log.*',
        'customers.first_name', 'customers.last_name',
        'customers.email as customer_email', 'customers.phone as customer_phone'
      )
      .orderBy('call_log.created_at', 'desc');

    if (status) query = query.where('call_log.processing_status', status);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const recordings = await query.limit(parseInt(limit)).offset(offset);

    const [{ count: total }] = await db('call_log')
      .whereNotNull('recording_url')
      .where('recording_url', '!=', '')
      .count('* as count');

    res.json({ recordings, total: parseInt(total), page: parseInt(page) });
  } catch (err) { next(err); }
});

// POST /process/:callSid — process a single recording.
// force=true (via query or body) bypasses the "already processed" dedup
// guard so the admin Reprocess button can re-extract on an existing row.
router.post('/process/:callSid', async (req, res, next) => {
  try {
    const force = req.query.force === 'true' || req.body?.force === true;
    // `operator` = a human pressed Process, which selects the short quiet
    // window for a stalled claim. Distinct from `force`, which means "re-run
    // a call that already finished" and carries its own extraction policy —
    // conflating them made manual first runs behave like reprocesses.
    const operator = req.query.operator === 'true' || req.body?.operator === true || force;
    const result = await CallRecordingProcessor.processRecording(req.params.callSid, { force, operator });
    // A blocked claim is not a completed run — surface it as a conflict so
    // no client can render it as success (the owner's manual Process tap
    // during the 2026-08-31 wedge got a 200 and a success toast while the
    // call sat unprocessed). Other skip reasons (e.g. a rejected
    // transcription) completed real work and stay 200.
    if (result?.skipped && result?.reason === 'already_processing') {
      // The retry window differs by caller and only the SERVER knows it: a
      // forced run (the reprocess buttons) takes over a claim 3 quiet minutes
      // after it stops beating, an unforced one waits the conservative 10.
      // Telling every operator "ten minutes" cost about seven of them on a
      // hot call in the exact recovery flow this route exists for (codex P2).
      // The processor inspected the claim we are blocked behind and knows
      // which window applies — a claim with no beat of its own (a legacy row,
      // or a pod mid-rolling-deploy) keeps the conservative one whatever the
      // caller asked for.
      const quietMinutes = Number(result.retryAfterMinutes) || 10;
      return res.status(409).json({
        ...result,
        error: `Another pass is still working this call. If it has stalled, try again about ${quietMinutes} minutes after it goes quiet.`,
      });
    }
    res.json(result);
  } catch (err) { next(err); }
});

// POST /process-all — process all pending recordings
router.post('/process-all', async (req, res, next) => {
  try {
    const result = await CallRecordingProcessor.processAllPending();
    res.json(result);
  } catch (err) { next(err); }
});

// POST /synopsis/:callSid — generate or regenerate lead synopsis
router.post('/synopsis/:callSid', async (req, res, next) => {
  try {
    const result = await CallRecordingProcessor.generateSynopsis(req.params.callSid);
    res.json(result);
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// OPERATOR CORRECTIONS — customer relink, recording adoption (admin-only)
// ═══════════════════════════════════════════════════════════════════

// PUT /calls/:id/customer — repoint (or unlink) the call's customer. The
// override is stamped in metadata so a reprocess keeps the human's link
// instead of re-resolving it from the transcript, and the unified voice
// message is re-homed so Customer 360 shows the call under the right person.
router.put('/calls/:id/customer', requireAdmin, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Call id must be a UUID' });
    // An unlink is an explicit JSON null, never a missing field: a body
    // that merely parses as {} must not stamp a permanent override and
    // drop the call's timeline entry.
    if (!req.body || !Object.prototype.hasOwnProperty.call(req.body, 'customer_id')) return res.status(400).json({ error: 'customer_id is required (a UUID to link, or null to unlink)' });
    const customerId = req.body.customer_id ?? null;
    if (customerId !== null && !UUID_RE.test(String(customerId))) return res.status(400).json({ error: 'customer_id must be a UUID or null' });
    const call = await db('call_log').where({ id: req.params.id }).first('id', 'customer_id', 'twilio_call_sid');
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (customerId) {
      const customer = await db('customers').where({ id: customerId }).whereNull('deleted_at').first('id');
      if (!customer) return res.status(404).json({ error: 'Customer not found' });
    }
    const override = {
      customer_id: customerId,
      previous_customer_id: call.customer_id || null,
      by: req.technicianId || null,
      at: new Date().toISOString(),
    };
    // Not while a pass holds the claim: the running pass keeps its own
    // resolved customer for the leads, contacts and texts it is about to
    // write, so a mid-pass relink would leave those on the old customer.
    // The office retries once the pass finishes (a few minutes at most).
    // The link and the call's own timeline entry (customer_interactions,
    // keyed on metadata.call_log_id and unique per call) change in ONE
    // transaction: the row is derived from the call, a reprocess cannot
    // re-mint it under the new customer while it sits under the old one,
    // and a relink that commits without it would report success on a
    // half-applied correction. Any failure rolls both back and surfaces.
    const moved = await db.transaction(async (trx) => {
      const relinked = await trx('call_log').where({ id: call.id })
        .whereRaw("processing_status IS DISTINCT FROM 'processing'")
        .update({
          customer_id: customerId,
          metadata: db.raw("jsonb_set(COALESCE(metadata, '{}'::jsonb), '{customer_link_override}', ?::jsonb, true)", [JSON.stringify(override)]),
          updated_at: new Date(),
        });
      if (!relinked) return null;
      const timeline = trx('customer_interactions')
        .where({ interaction_type: 'call' })
        .whereRaw("metadata ->> 'call_log_id' = ?", [String(call.id)]);
      const rows = customerId
        ? await timeline.update({ customer_id: customerId })
        : await timeline.del();
      // The operator's correction IS the fix for an earlier
      // customer_creation_failed: its card resolves here (no reprocess runs
      // from this endpoint), and the review flag clears only when no other
      // open card still needs a person.
      const repaired = await trx('triage_items')
        .where({ call_log_id: call.id, reason_code: 'customer_creation_failed' })
        .whereIn('status', ['open', 'in_progress'])
        .update({ status: 'resolved', resolved_at: new Date(), resolution_note: customerId ? `Customer set by operator (${customerId})` : 'Unlinked by operator' });
      if (repaired > 0) {
        await trx('call_log')
          .where({ id: call.id })
          .whereNotExists(trx('triage_items').where('triage_items.call_log_id', call.id).whereIn('triage_items.status', ['open', 'in_progress']))
          .update({ review_status: null });
      }
      return { timelineRows: rows, repaired };
    });
    if (!moved) {
      return res.status(409).json({ error: 'A pass is still working this call. Change the customer once it finishes.', reason: 'already_processing' });
    }
    const timelineMoved = moved.timelineRows;
    const warnings = [];
    if (call.twilio_call_sid) {
      // Best-effort here; the hourly call-log relink sweep re-homes any
      // linked call whose thread still sits under another customer, so a
      // failure is reported, not silently swallowed.
      await require('../services/conversations').syncVoiceMessageForCall(call.twilio_call_sid)
        .catch((e) => {
          logger.warn(`[call-recordings] voice message re-home after relink failed for ${maskSid(call.twilio_call_sid)}: ${e.message}`);
          warnings.push('voice_message_rehome_failed: the hourly relink sweep will retry it');
        });
    }
    logger.info(`[call-recordings] call ${call.id} customer link set by operator (${customerId ? 'linked' : 'unlinked'}; timeline rows moved: ${timelineMoved})`);
    res.json({ success: true, customer_id: customerId, override, timeline_rows_moved: timelineMoved, warnings });
  } catch (err) { next(err); }
});

// POST /calls/:id/adopt-recording — swap in a recording that arrived after
// the call had finished processing (parked by the recording-status webhook)
// and reprocess. The recording being replaced is kept in the parked list.
router.post('/calls/:id/adopt-recording', requireAdmin, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Call id must be a UUID' });
    const wanted = String(req.body?.recording_sid || '');
    if (!/^RE[0-9a-f]{32}$/i.test(wanted)) return res.status(400).json({ error: 'recording_sid must be a Twilio RecordingSid' });
    const call = await db('call_log').where({ id: req.params.id }).first('id', 'twilio_call_sid', 'recording_sid', 'recording_url', 'recording_duration_seconds', 'metadata', 'processing_status', 'transcription_metadata');
    if (!call) return res.status(404).json({ error: 'Call not found' });
    // A PAN-quarantined call never gets audio re-attached — the webhook
    // deletes a recording that arrives for one instead of storing it, and
    // adoption must keep that invariant: a call quarantined AFTER the
    // recording was parked would otherwise have card audio restored.
    const panQuarantined = (() => {
      try {
        const raw = call.transcription_metadata;
        const meta = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        return String(meta?.pan_detected) === 'true';
      } catch { return false; }
    })();
    if (call.processing_status === 'processing') {
      return res.status(409).json({ error: 'A pass is still working this call. Try again after it finishes.', reason: 'already_processing' });
    }
    let meta = {};
    try { meta = typeof call.metadata === 'string' ? JSON.parse(call.metadata) : (call.metadata || {}); } catch { meta = {}; }
    const parked = Array.isArray(meta.additional_recordings) ? meta.additional_recordings : [];
    const chosen = parked.find((r) => r && r.recording_sid === wanted);
    if (!chosen) return res.status(404).json({ error: 'That recording is not parked on this call' });
    // A quarantined call keeps no audio: the call's CURRENT recording (the
    // one the card may have been heard on) is the helper's primary, and
    // the helper sweeps every parked recording — the chosen one included.
    // Each delete tombstones its entry (URL gone now; delete_pending while
    // a failed Twilio delete is owed to the recovery sweep), so a swallowed
    // failure can never leave card audio reachable.
    const quarantineParked = async () => {
      // The row AS IT IS NOW, never this request's snapshot: another
      // operator or a callback can have swapped the current recording
      // between the read above and a failed swap, and the helper deletes
      // the primary it is handed — the snapshot's stale SID would leave the
      // newly current audio at Twilio with nothing owed.
      const fresh = await db('call_log').where({ id: call.id }).first().catch(() => null);
      const row = fresh || call;
      const q = await CallRecordingProcessor.quarantineCardRecording(
        row,
        { source: 'adopt_recording_post_quarantine' },
      ).catch((e) => {
        logger.error(`[call-recordings] quarantine delete failed for call ${call.id}: ${e.message}`);
        return null;
      });
      if (!q) return { deleted: 0, delete_pending: parked.length + (row.recording_sid ? 1 : 0) };
      const current = row.recording_sid ? (q.twilioDeleted ? { deleted: 1, delete_pending: 0 } : { deleted: 0, delete_pending: 1 }) : { deleted: 0, delete_pending: 0 };
      return { deleted: current.deleted + (q.parked?.deleted ?? 0), delete_pending: current.delete_pending + (q.parked?.pending ?? 0) };
    };
    const quarantinedResponse = (res, outcome, prefix) => res.status(409).json({
      error: outcome.delete_pending
        ? `${prefix} Its parked audio is no longer reachable here; a Twilio delete that did not complete is retried by the recovery sweep.`
        : `${prefix} Its parked audio has been deleted.`,
      reason: 'pan_quarantined',
      ...outcome,
    });
    if (panQuarantined) {
      return quarantinedResponse(res, await quarantineParked(), 'This call is PAN-quarantined; recordings are never re-attached.');
    }
    // The recording being replaced stays in the parked list as evidence.
    const replaced = call.recording_sid ? [{
      recording_sid: call.recording_sid,
      recording_url: call.recording_url,
      recording_duration_seconds: call.recording_duration_seconds ?? null,
      received_at: null,
      parked_because: 'replaced_by_operator',
    }] : [];
    const swapped = await db('call_log')
      .where({ id: call.id })
      .whereRaw("processing_status IS DISTINCT FROM 'processing'")
      // Re-checked IN the write: a quarantine stamp landing between the
      // read above and this update makes the swap refuse.
      .whereRaw("(transcription_metadata IS NULL OR (transcription_metadata::jsonb ->> 'pan_detected') IS DISTINCT FROM 'true')")
      // Fenced to the row this request READ: the recording it is replacing
      // and the parked entry it is adopting must both still be there — a
      // second operator or a fresh callback that changed either makes this
      // swap refuse instead of reporting a recording it did not process.
      .where(function baselineRecording() {
        if (call.recording_sid) this.where('recording_sid', call.recording_sid);
        else this.whereNull('recording_sid');
      })
      .whereRaw("COALESCE(metadata -> 'additional_recordings', '[]'::jsonb) @> ?::jsonb", [JSON.stringify([{ recording_sid: chosen.recording_sid }])])
      .update({
        recording_sid: chosen.recording_sid,
        recording_url: chosen.recording_url,
        recording_duration_seconds: chosen.recording_duration_seconds ?? null,
        transcription_status: 'pending',
        // The old audio's transcript must not survive the swap (a failed
        // transcription of the adopted audio would fall back to it).
        transcription: null,
        transcript_structured: null,
        transcription_provider: null,
        // …and everything derived from it, so a deferred or failed reprocess
        // never shows the previous audio's extraction beside the new one.
        ai_extraction: null,
        ai_extraction_enriched: null,
        ai_extraction_validation_errors: null,
        v2_extraction_status: null,
        call_summary: null,
        lead_synopsis: null,
        sentiment: null,
        lead_quality: null,
        // The row is no longer "processed": its transcript and extraction
        // describe the previous recording. NULL puts it back in the sweep,
        // so even if the immediate pass below defers (CDN not ready) or
        // fails, the adopted audio is processed and the stale derived
        // fields are replaced — never a processed row whose audio does not
        // match its intelligence.
        processing_status: null,
        // The parked list is rewritten against the CURRENT array — the
        // chosen entry removed, the replaced recording appended — never
        // from this request's snapshot, so a callback that parked another
        // recording between the read and this write keeps its entry.
        metadata: db.raw(
          "jsonb_set(jsonb_set(COALESCE(metadata, '{}'::jsonb), '{additional_recordings}',"
          + " (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) FROM jsonb_array_elements(COALESCE(metadata -> 'additional_recordings', '[]'::jsonb)) e WHERE e ->> 'recording_sid' <> ?) || ?::jsonb, true),"
          + " '{adopted_recording}', ?::jsonb, true)",
          [chosen.recording_sid, JSON.stringify(replaced), JSON.stringify({ recording_sid: chosen.recording_sid, by: req.technicianId || null, at: new Date().toISOString(), previous_recording_sid: call.recording_sid || null })],
        ),
        updated_at: new Date(),
      });
    if (!swapped) {
      // Distinguish the quarantine race from an ordinary contention: the
      // former must also delete the parked audio at Twilio.
      const now = await db('call_log').where({ id: call.id }).first('transcription_metadata').catch(() => null);
      let racedQuarantine = false;
      try {
        const raw = now?.transcription_metadata;
        const meta = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        racedQuarantine = String(meta?.pan_detected) === 'true';
      } catch { racedQuarantine = false; }
      if (racedQuarantine) {
        return quarantinedResponse(res, await quarantineParked(), 'This call was PAN-quarantined while the swap was being made; recordings are never re-attached.');
      }
      return res.status(409).json({ error: 'This call changed while the swap was being made (a pass claimed it, or its recordings changed). Reload and try again.', reason: 'call_changed' });
    }
    logger.info(`[call-recordings] operator adopted recording ${maskSid(chosen.recording_sid)} on call ${call.id}; reprocessing`);
    const result = await CallRecordingProcessor.processRecording(call.twilio_call_sid, { force: true, operator: true });
    if (result?.success === true) {
      // Only a completed pass closes the review card; a deferred or failed
      // one leaves it open with the row queued for the sweep. And it closes
      // only when no other parked recording still awaits a decision — the
      // recording this adoption replaced stays in the list as evidence, not
      // as a review item; any other callback-parked entry keeps the card
      // open, retargeted to it, so it does not vanish from the inbox with no
      // operator decision recorded.
      // Read the list as it is NOW (the swap rewrote it against the current
      // row, and a callback may have parked more since).
      const after = await db('call_log').where({ id: call.id }).first('metadata').catch(() => null);
      let nowParked = [];
      try {
        const m = typeof after?.metadata === 'string' ? JSON.parse(after.metadata) : (after?.metadata || {});
        nowParked = Array.isArray(m.additional_recordings) ? m.additional_recordings : [];
      } catch { nowParked = []; }
      const stillForReview = nowParked.filter((r) => r && r.parked_because !== 'replaced_by_operator' && r.recording_sid !== chosen.recording_sid);
      const openCard = db('triage_items')
        .where({ call_log_id: call.id, reason_code: 'additional_recording' })
        .whereIn('status', ['open', 'in_progress']);
      // The adoption and reprocess are done either way; a card update that
      // fails is reported, not swallowed, so a stale card never hides
      // behind a plain success.
      let warning = null;
      try {
        if (stillForReview.length === 0) {
          await openCard.update({ status: 'resolved', resolved_at: new Date(), resolution_note: `Adopted ${chosen.recording_sid}` });
        } else {
          const next = stillForReview[0];
          await openCard.update({
            payload: db.raw("COALESCE(payload, '{}'::jsonb) || ?::jsonb", [JSON.stringify({
              recording_sid: next.recording_sid,
              recording_duration_seconds: next.recording_duration_seconds ?? null,
              parked_because: next.parked_because,
              kept_recording_sid: chosen.recording_sid,
              remaining_for_review: stillForReview.length,
            })]),
          });
        }
      } catch (cardErr) {
        logger.warn(`[call-recordings] additional-recording review card not updated for call ${call.id}: ${cardErr.message}`);
        warning = 'The recording was adopted and processed, but its review card could not be updated; resolve it from the Triage inbox.';
      }
      return res.json({ success: true, adopted: chosen.recording_sid, remaining_for_review: stillForReview.length, ...(warning ? { warning } : {}), result });
    }
    if (result?.skipped && result?.reason === 'already_processing') {
      return res.status(409).json({ ...result, adopted: chosen.recording_sid, error: 'The recording was adopted but another pass is still working this call; the sweep will process the adopted audio once it goes quiet.' });
    }
    res.json({
      success: false,
      adopted: chosen.recording_sid,
      queued: true,
      result,
      error: 'The recording was adopted and queued; the immediate pass did not complete, so the next sweep will process it. The review card stays open until it does.',
    });
  } catch (err) { next(err); }
});

// GET /recording/:id — get single recording detail
router.get('/recording/:id', async (req, res, next) => {
  try {
    const recording = await db('call_log')
      .where('call_log.id', req.params.id)
      .leftJoin('customers', 'call_log.customer_id', 'customers.id')
      .select('call_log.*', 'customers.first_name', 'customers.last_name', 'customers.email as customer_email')
      .first();

    if (!recording) return res.status(404).json({ error: 'Recording not found' });
    res.json({ recording });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════
// CALL DISPOSITION — Tag calls + block spam numbers
// ═══════════════════════════════════════════════════════════════════

// Disposition labels for timeline entries
const DISPOSITION_LABELS = {
  new_lead_booked: 'New Lead — Booked',
  new_lead_no_booking: 'New Lead — No Booking',
  existing_service_q: 'Service Question',
  existing_complaint: 'Complaint',
  spam: 'Spam / Wrong Number',
};

// Live-customer ownership of the caller number: the call's own customer link,
// else the shared known-caller identity lookup (same mechanism + column set
// the pre-connect voice screen uses — utils/known-caller-phone.js).
async function findLiveCustomerForCall(call) {
  if (call.customer_id) {
    const linked = await db('customers')
      .where({ id: call.customer_id })
      .whereNull('deleted_at')
      .first('id', 'first_name', 'last_name');
    if (linked) return linked;
  }
  return findKnownCallerCustomer(db, call.from_phone);
}

// PUT /calls/:id/disposition — tag a call
router.put('/calls/:id/disposition', async (req, res, next) => {
  try {
    const { disposition } = req.body;

    // Auto-add disposition column if missing
    const cols = await db('call_log').columnInfo();
    if (!cols.disposition) {
      await db.schema.alterTable('call_log', t => t.string('disposition', 50)).catch(() => {});
    }

    // Find the call record
    let call = await db('call_log').where({ id: req.params.id }).first();
    if (!call) call = await db('call_log').where({ twilio_call_sid: req.params.id }).first();
    if (!call) return res.status(404).json({ error: 'Call not found' });

    if (disposition === 'spam') {
      // SPAM: hard-block the number + delete call from log.
      // Schema is owned by migration 20260418000006 (PR 1):
      //   number / block_type / blocked_by(uuid FK technicians) / reason
      //
      // Guard: a number that belongs to a LIVE customer can never be tagged
      // spam from here. A hard_block silently kills every future inbound call
      // and text from a paying customer, and the operator has no way to see
      // that from the call row. Refuse with 409 so the UI can explain.
      // Only INBOUND rows carry the caller in from_phone; on an outbound row
      // from_phone is OUR Twilio number. `direction` is nullable/unconstrained,
      // so fail closed: anything other than an explicit 'inbound' is refused
      // rather than risk hard-blocking a Waves number.
      if (String(call.direction || '').toLowerCase() !== 'inbound') {
        return res.status(409).json({
          error: 'Spam can only be tagged on inbound calls.',
          code: 'NOT_INBOUND_CALL',
        });
      }
      const owner = await findLiveCustomerForCall(call);
      if (owner) {
        return res.status(409).json({
          error: 'This number belongs to an existing customer and cannot be tagged spam. Archive or edit the customer record instead.',
          code: 'CUSTOMER_NUMBER',
          customer_id: owner.id,
          customer_name: [owner.first_name, owner.last_name].filter(Boolean).join(' ') || null,
        });
      }
      if (call.from_phone) {
        await db('blocked_numbers').insert({
          number: call.from_phone,
          block_type: 'hard_block',
          blocked_by: req.technicianId || null,
          reason: 'Tagged spam from call disposition',
          auto_blocked: false,
        }).onConflict('number').ignore();
        logger.info(`[calls] Blocked spam number: ${call.from_phone}`);
      }
      // Delete the call log entry. sms_log rows are deliberately KEPT: they are
      // the A2P/consent audit trail for every text we ever sent to that number
      // and must survive a block (the block itself stops future sends).
      await db('call_log').where({ id: call.id }).del();
      res.json({ success: true, disposition, deleted: true });
    } else {
      // NON-SPAM: save disposition + attach to customer timeline
      await db('call_log').where({ id: call.id }).update({ disposition, updated_at: new Date() });

      // Attach to customer timeline if customer_id exists
      if (call.customer_id) {
        const label = DISPOSITION_LABELS[disposition] || disposition;
        const duration = call.duration_seconds ? `${Math.floor(call.duration_seconds / 60)}m ${call.duration_seconds % 60}s` : '';
        await db('customer_interactions').insert({
          customer_id: call.customer_id,
          interaction_type: 'inbound_call',
          subject: `Call tagged: ${label}${duration ? ` (${duration})` : ''}`,
          body: call.transcript_text || null,
          metadata: JSON.stringify({
            disposition,
            callSid: call.twilio_call_sid,
            recordingSid: call.recording_sid || null,
            phone: call.from_phone,
            duration: call.duration_seconds,
            recordingAvailable: Boolean(call.recording_url),
          }),
        }).catch(() => {});
        logger.info(`[calls] Tagged call ${call.id} as "${label}" → customer ${call.customer_id} timeline`);
      }

      res.json({ success: true, disposition });
    }
  } catch (err) { next(err); }
});

// GET /blocked — list blocked numbers (UI expects { phone, reason, blocked_at }
// — alias from new schema for back-compat until the inbox UI redesign in PR 4).
router.get('/blocked', async (req, res, next) => {
  try {
    const rows = await db('blocked_numbers').orderBy('blocked_at', 'desc');
    res.json({
      numbers: rows.map(r => ({
        id: r.id,
        phone: r.number,
        block_type: r.block_type,
        reason: r.reason,
        blocked_at: r.blocked_at,
        auto_blocked: r.auto_blocked,
      })),
    });
  } catch (err) { next(err); }
});

// DELETE /blocked/:phone — unblock a number
router.delete('/blocked/:phone', async (req, res, next) => {
  try {
    await db('blocked_numbers').where({ number: req.params.phone }).del();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;

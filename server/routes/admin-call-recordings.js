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
// CALL INTELLIGENCE — the review-ready view, commitments, corrections
// ═══════════════════════════════════════════════════════════════════

// GET /calls/:id/intelligence — one normalized object: outcome, intent,
// appointment, prices, objections, evidence-linked commitments with their
// fulfillment, later outcomes, honest processing state, and which values a
// person overrode. Read-only apart from the fulfillment refresh (open AI
// rows are marked fulfilled when a later record proves it).
router.get('/calls/:id/intelligence', async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Call id must be a UUID' });
    const { loadCallIntelligence } = require('../services/call-intelligence');
    const intelligence = await loadCallIntelligence(db, req.params.id);
    if (!intelligence) return res.status(404).json({ error: 'Call not found' });
    res.json({ intelligence });
  } catch (err) { next(err); }
});

// POST /calls/:id/commitments — the office records a promise the AI missed.
router.post('/calls/:id/commitments', requireAdmin, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Call id must be a UUID' });
    const call = await db('call_log').where({ id: req.params.id }).first('id');
    if (!call) return res.status(404).json({ error: 'Call not found' });
    const { addHumanCommitment } = require('../services/call-commitments');
    const row = await addHumanCommitment(db, call.id, {
      party: req.body?.party,
      kind: req.body?.kind,
      description: req.body?.description,
      due_at: req.body?.due_at ?? null,
      channel: req.body?.channel ?? null,
      reviewedBy: req.technicianId || null,
    });
    res.status(201).json({ commitment: row });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PATCH /commitments/:id — confirm / dismiss / fulfill / reopen / edit. A
// human verdict is recorded on the row and survives every reprocess.
router.patch('/commitments/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Commitment id must be a UUID' });
    const { applyHumanUpdate } = require('../services/call-commitments');
    const row = await applyHumanUpdate(db, req.params.id, {
      action: req.body?.action,
      description: req.body?.description,
      due_at: req.body?.due_at,
      note: req.body?.note,
      reviewedBy: req.technicianId || null,
    });
    res.json({ commitment: row });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

// PUT /calls/:id/customer — repoint (or unlink) the call's customer. The
// override is stamped in metadata so a reprocess keeps the human's link
// instead of re-resolving it from the transcript, and the unified voice
// message is re-homed so Customer 360 shows the call under the right person.
router.put('/calls/:id/customer', requireAdmin, async (req, res, next) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Call id must be a UUID' });
    const customerId = req.body?.customer_id ?? null;
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
    await db('call_log').where({ id: call.id }).update({
      customer_id: customerId,
      metadata: db.raw("jsonb_set(COALESCE(metadata, '{}'::jsonb), '{customer_link_override}', ?::jsonb, true)", [JSON.stringify(override)]),
      updated_at: new Date(),
    });
    if (call.twilio_call_sid) {
      await require('../services/conversations').syncVoiceMessageForCall(call.twilio_call_sid)
        .catch((e) => logger.warn(`[call-recordings] voice message re-home after relink failed for ${maskSid(call.twilio_call_sid)}: ${e.message}`));
    }
    logger.info(`[call-recordings] call ${call.id} customer link set by operator (${customerId ? 'linked' : 'unlinked'})`);
    res.json({ success: true, customer_id: customerId, override });
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
    const call = await db('call_log').where({ id: req.params.id }).first('id', 'twilio_call_sid', 'recording_sid', 'recording_url', 'recording_duration_seconds', 'metadata', 'processing_status');
    if (!call) return res.status(404).json({ error: 'Call not found' });
    if (call.processing_status === 'processing') {
      return res.status(409).json({ error: 'A pass is still working this call. Try again after it finishes.', reason: 'already_processing' });
    }
    let meta = {};
    try { meta = typeof call.metadata === 'string' ? JSON.parse(call.metadata) : (call.metadata || {}); } catch { meta = {}; }
    const parked = Array.isArray(meta.additional_recordings) ? meta.additional_recordings : [];
    const chosen = parked.find((r) => r && r.recording_sid === wanted);
    if (!chosen) return res.status(404).json({ error: 'That recording is not parked on this call' });
    const remaining = parked.filter((r) => r.recording_sid !== wanted);
    if (call.recording_sid) {
      remaining.push({
        recording_sid: call.recording_sid,
        recording_url: call.recording_url,
        recording_duration_seconds: call.recording_duration_seconds ?? null,
        received_at: null,
        parked_because: 'replaced_by_operator',
      });
    }
    const swapped = await db('call_log')
      .where({ id: call.id })
      .whereRaw("processing_status IS DISTINCT FROM 'processing'")
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
        // The row is no longer "processed": its transcript and extraction
        // describe the previous recording. NULL puts it back in the sweep,
        // so even if the immediate pass below defers (CDN not ready) or
        // fails, the adopted audio is processed and the stale derived
        // fields are replaced — never a processed row whose audio does not
        // match its intelligence.
        processing_status: null,
        metadata: db.raw(
          "jsonb_set(jsonb_set(COALESCE(metadata, '{}'::jsonb), '{additional_recordings}', ?::jsonb, true), '{adopted_recording}', ?::jsonb, true)",
          [JSON.stringify(remaining), JSON.stringify({ recording_sid: chosen.recording_sid, by: req.technicianId || null, at: new Date().toISOString(), previous_recording_sid: call.recording_sid || null })],
        ),
        updated_at: new Date(),
      });
    if (!swapped) return res.status(409).json({ error: 'This call changed while the swap was being made (a pass claimed it, or its recordings changed). Reload and try again.', reason: 'call_changed' });
    logger.info(`[call-recordings] operator adopted recording ${maskSid(chosen.recording_sid)} on call ${call.id}; reprocessing`);
    const result = await CallRecordingProcessor.processRecording(call.twilio_call_sid, { force: true, operator: true });
    if (result?.success === true) {
      // Only a completed pass closes the review card; a deferred or failed
      // one leaves it open with the row queued for the sweep.
      await db('triage_items')
        .where({ call_log_id: call.id, reason_code: 'additional_recording' })
        .whereIn('status', ['open', 'in_progress'])
        .update({ status: 'resolved', resolved_at: new Date(), resolution_note: `Adopted ${chosen.recording_sid}` })
        .catch(() => {});
      return res.json({ success: true, adopted: chosen.recording_sid, result });
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

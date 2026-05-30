const express = require('express');
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const sendgrid = require('../services/sendgrid-mail');
const { shortenOrPassthrough } = require('../services/short-url');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { publicPortalUrl } = require('../utils/portal-url');
const {
  CONTENT_LIBRARY_VERSION,
  PRODUCT_REGISTRY_VERSION,
  PROTOCOL_VERSION,
  TEMPLATE_VERSION,
  buildOutline,
  createPublicToken,
  hashToken,
} = require('../services/lawn-service-outline');

const router = express.Router();

router.use(adminAuthenticate, requireTechOrAdmin);

function publicUrlForToken(token) {
  return `${publicPortalUrl()}/service-outlines/${encodeURIComponent(token)}`;
}

function safePacket(row, rawToken = null) {
  if (!row) return null;
  return {
    id: row.id,
    estimateId: row.estimate_id,
    customerId: row.customer_id,
    leadId: row.lead_id,
    status: row.status,
    title: row.title,
    turfType: row.turf_type,
    turfConfidence: row.turf_confidence,
    mixedTurfFlag: row.mixed_turf_flag,
    protocolTrack: row.protocol_track,
    serviceTier: row.service_tier,
    month: row.month,
    seasonBand: row.season_band,
    jurisdictionId: row.jurisdiction_id,
    validationStatus: row.validation_status,
    validationErrors: row.validation_errors_json || [],
    adminWarnings: row.admin_warnings_json || [],
    summary: row.summary_json || {},
    content: row.content_json || {},
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    sentAt: row.sent_at,
    sentMethod: row.sent_method,
    firstViewedAt: row.first_viewed_at,
    lastViewedAt: row.last_viewed_at,
    viewCount: row.view_count || 0,
    contentLibraryVersion: row.content_library_version,
    protocolVersion: row.protocol_version,
    productRegistryVersion: row.product_registry_version,
    templateVersion: row.template_version,
    generationMode: row.generation_mode,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    publicUrl: rawToken ? publicUrlForToken(rawToken) : null,
  };
}

function coerceInput(body = {}) {
  return {
    turfType: body.turfType || body.turf_type || null,
    detailLevel: body.detailLevel || 'standard',
    includeProductCards: body.includeProductCards === true,
    includeProductCategories: body.includeProductCategories !== false,
    includePortalReporting: body.includePortalReporting !== false,
    includeGpsReminders: body.includeGpsReminders !== false,
    includePublicGuideLink: body.includePublicGuideLink !== false,
    includeExclusions: body.includeExclusions !== false,
    serviceTier: body.serviceTier || null,
    month: body.month || null,
    jurisdictionId: body.jurisdictionId || null,
    customerNote: body.customerNote || '',
  };
}

async function loadEstimate(id) {
  if (!id) return null;
  return db('estimates').where({ id }).first();
}

async function logEvent(trx, packet, eventType, req, metadata = {}) {
  await trx('service_outline_events').insert({
    packet_id: packet.id,
    customer_id: packet.customer_id || null,
    lead_id: packet.lead_id || null,
    estimate_id: packet.estimate_id || null,
    event_type: eventType,
    metadata_json: metadata,
    actor_type: req?.technicianId ? 'admin' : 'system',
    actor_id: req?.technicianId || null,
  });
}

async function insertPacket(trx, { estimate, outline, input, req, rawToken, status = 'draft' }) {
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 45);
  const turf = outline.meta.turf;
  const rule = outline.meta.jurisdictionRule;
  const row = {
    customer_id: estimate.customer_id || null,
    lead_id: estimate.lead_id || null,
    estimate_id: estimate.id,
    service_line: 'lawn_care',
    status,
    title: outline.content.title,
    turf_type: turf.turfType,
    turf_confidence: turf.confidence,
    mixed_turf_flag: turf.mixed,
    protocol_track: turf.turfType,
    service_tier: input.serviceTier || outline.estimateSnapshot.tier || null,
    month: outline.inputSnapshot.month,
    season_band: outline.inputSnapshot.seasonBand,
    jurisdiction_id: rule?.jurisdiction_id || outline.inputSnapshot.jurisdictionId || null,
    fertilizer_rule_version: rule?.version || null,
    content_library_version: CONTENT_LIBRARY_VERSION,
    protocol_version: PROTOCOL_VERSION,
    product_registry_version: PRODUCT_REGISTRY_VERSION,
    template_version: TEMPLATE_VERSION,
    generation_mode: 'rules_only',
    estimate_snapshot_json: outline.estimateSnapshot,
    input_snapshot_json: outline.inputSnapshot,
    summary_json: outline.summary,
    content_json: outline.content,
    content_html: outline.contentHtml,
    validation_status: outline.validation.status,
    validation_errors_json: outline.validation.errors,
    admin_warnings_json: outline.validation.warnings,
    token_hash: tokenHash,
    token_last_four: rawToken.slice(-4),
    token_created_at: trx.fn.now(),
    expires_at: expiresAt,
    noindex: true,
    created_by: req.technicianId,
  };
  const [packet] = await trx('service_outline_packets').insert(row).returning('*');

  for (const card of outline.content.productCards || []) {
    await trx('service_outline_packet_products').insert({
      packet_id: packet.id,
      product_id: card.id,
      product_fact_version: card.labelVersion || null,
      display_mode: 'product_card',
      relevance_reason: card.relevanceReason,
      eligibility_status: 'eligible',
    });
  }

  await logEvent(trx, packet, 'created', req, { validationStatus: outline.validation.status });
  await logEvent(trx, packet, outline.validation.status === 'blocked' ? 'validation_blocked' : outline.validation.status === 'warning' ? 'validation_warning' : 'validation_passed', req, {
    errors: outline.validation.errors,
    warnings: outline.validation.warnings,
  });
  return packet;
}

function inputFromPacket(packet) {
  const snapshot = packet?.input_snapshot_json || {};
  return {
    turfType: packet?.turf_type || snapshot.turfType || null,
    detailLevel: snapshot.detailLevel || 'standard',
    includeProductCards: Array.isArray(packet?.content_json?.productCards) && packet.content_json.productCards.length > 0,
    includeProductCategories: true,
    includePortalReporting: true,
    includeGpsReminders: true,
    includePublicGuideLink: true,
    includeExclusions: true,
    serviceTier: packet?.service_tier || snapshot.serviceTier || null,
    month: packet?.month || snapshot.month || null,
    jurisdictionId: packet?.jurisdiction_id || snapshot.jurisdictionId || null,
    customerNote: snapshot.customerNote || '',
  };
}

router.post('/preview', async (req, res, next) => {
  try {
    const estimate = await loadEstimate(req.body.estimateId || req.body.estimate_id);
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    const input = coerceInput(req.body);
    const outline = await buildOutline({ db, estimate, input });
    res.json({
      outline: outline.content,
      summary: outline.summary,
      validation: outline.validation,
      meta: {
        templateVersion: TEMPLATE_VERSION,
        contentLibraryVersion: CONTENT_LIBRARY_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        productRegistryVersion: PRODUCT_REGISTRY_VERSION,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const estimate = await loadEstimate(req.body.estimateId || req.body.estimate_id);
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    const input = coerceInput(req.body);
    const outline = await buildOutline({ db, estimate, input });
    const rawToken = createPublicToken();
    const packet = await db.transaction((trx) => insertPacket(trx, {
      estimate,
      outline,
      input,
      req,
      rawToken,
      status: req.body.approve === true && outline.validation.status !== 'blocked' ? 'approved' : 'draft',
    }));
    res.status(201).json({
      packet: safePacket(packet, rawToken),
      validation: outline.validation,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/content-modules', async (req, res, next) => {
  try {
    const modules = await db('lawn_service_content_modules')
      .orderBy('key', 'asc')
      .orderBy('version', 'desc')
      .select(
        'id',
        'key',
        'title',
        'audience',
        'plain_text',
        'status',
        'version',
        'valid_from',
        'valid_to',
        'approved_at',
        'source_notes',
        'updated_at',
      );
    res.json({ modules });
  } catch (err) {
    next(err);
  }
});

router.patch('/content-modules/:id', async (req, res, next) => {
  try {
    const module = await db('lawn_service_content_modules').where({ id: req.params.id }).first();
    if (!module) return res.status(404).json({ error: 'Content module not found' });
    const nextStatus = req.body.status || module.status;
    if (!['draft', 'review', 'approved', 'deprecated', 'retired'].includes(nextStatus)) {
      return res.status(400).json({ error: 'Invalid module status' });
    }
    const update = {
      updated_at: db.fn.now(),
    };
    if (req.body.title !== undefined) update.title = String(req.body.title || '').trim();
    if (req.body.audience !== undefined) update.audience = String(req.body.audience || '').trim();
    if (req.body.plainText !== undefined) update.plain_text = String(req.body.plainText || '').trim();
    if (req.body.sourceNotes !== undefined) update.source_notes = req.body.sourceNotes || null;
    update.status = nextStatus;
    if (nextStatus === 'approved') {
      update.approved_by = req.technicianId || null;
      update.approved_at = db.fn.now();
    }
    if (!update.title && req.body.title !== undefined) return res.status(400).json({ error: 'Title is required' });
    if (!update.plain_text && req.body.plainText !== undefined) return res.status(400).json({ error: 'Module text is required' });
    const [row] = await db('lawn_service_content_modules')
      .where({ id: module.id })
      .update(update)
      .returning('*');
    res.json({ module: row });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const packet = await db('service_outline_packets').where({ id: req.params.id }).first();
    if (!packet) return res.status(404).json({ error: 'Service outline not found' });
    res.json({ packet: safePacket(packet) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/events', async (req, res, next) => {
  try {
    const packet = await db('service_outline_packets').where({ id: req.params.id }).first();
    if (!packet) return res.status(404).json({ error: 'Service outline not found' });
    const events = await db('service_outline_events')
      .where({ packet_id: packet.id })
      .orderBy('created_at', 'desc')
      .limit(100);
    res.json({ events });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    const packet = await db('service_outline_packets').where({ id: req.params.id }).first();
    if (!packet) return res.status(404).json({ error: 'Service outline not found' });
    if (packet.validation_status === 'blocked') {
      return res.status(422).json({ error: 'Blocked service outlines cannot be approved', validationErrors: packet.validation_errors_json || [] });
    }
    const [updated] = await db.transaction(async (trx) => {
      const [row] = await trx('service_outline_packets')
        .where({ id: packet.id })
        .update({
          status: 'approved',
          approved_by: req.technicianId,
          approved_at: trx.fn.now(),
          updated_at: trx.fn.now(),
        })
        .returning('*');
      await logEvent(trx, row, 'approved', req);
      return [row];
    });
    res.json({ packet: safePacket(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/revoke', async (req, res, next) => {
  try {
    const packet = await db('service_outline_packets').where({ id: req.params.id }).first();
    if (!packet) return res.status(404).json({ error: 'Service outline not found' });
    const [updated] = await db.transaction(async (trx) => {
      const [row] = await trx('service_outline_packets')
        .where({ id: packet.id })
        .update({ status: 'revoked', revoked_at: trx.fn.now(), updated_at: trx.fn.now() })
        .returning('*');
      await logEvent(trx, row, 'revoked', req);
      return [row];
    });
    res.json({ packet: safePacket(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/regenerate', async (req, res, next) => {
  try {
    const sourcePacket = await db('service_outline_packets').where({ id: req.params.id }).first();
    if (!sourcePacket) return res.status(404).json({ error: 'Service outline not found' });
    const estimate = sourcePacket.estimate_id ? await loadEstimate(sourcePacket.estimate_id) : null;
    if (!estimate) return res.status(404).json({ error: 'Estimate not found for this outline' });

    const input = { ...inputFromPacket(sourcePacket), ...coerceInput(req.body || {}) };
    const outline = await buildOutline({ db, estimate, input });
    const rawToken = createPublicToken();
    const revokeOld = req.body.revokeOld !== false;
    const packet = await db.transaction(async (trx) => {
      if (revokeOld && !sourcePacket.revoked_at) {
        const [revoked] = await trx('service_outline_packets')
          .where({ id: sourcePacket.id })
          .update({ status: 'revoked', revoked_at: trx.fn.now(), updated_at: trx.fn.now() })
          .returning('*');
        await logEvent(trx, revoked, 'revoked', req, { reason: 'regenerated', replacementPending: true });
      }
      const inserted = await insertPacket(trx, {
        estimate,
        outline,
        input,
        req,
        rawToken,
        status: req.body.approve === false || outline.validation.status === 'blocked' ? 'draft' : 'approved',
      });
      await logEvent(trx, inserted, 'regenerated_from_packet', req, {
        sourcePacketId: sourcePacket.id,
        sourceContentLibraryVersion: sourcePacket.content_library_version,
        sourceProtocolVersion: sourcePacket.protocol_version,
        sourceProductRegistryVersion: sourcePacket.product_registry_version,
        revokedSource: revokeOld,
      });
      return inserted;
    });

    res.status(201).json({
      packet: safePacket(packet, rawToken),
      validation: outline.validation,
      sourcePacket: safePacket({ ...sourcePacket, status: revokeOld ? 'revoked' : sourcePacket.status }),
      publicUrl: publicUrlForToken(rawToken),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/send', async (req, res, next) => {
  try {
    const packet = await db('service_outline_packets').where({ id: req.params.id }).first();
    if (!packet) return res.status(404).json({ error: 'Service outline not found' });
    if (packet.validation_status === 'blocked') {
      return res.status(422).json({ error: 'Blocked service outlines cannot be sent', validationErrors: packet.validation_errors_json || [] });
    }
    if (packet.revoked_at) return res.status(422).json({ error: 'Revoked service outline cannot be sent' });
    if (packet.expires_at && new Date(packet.expires_at) <= new Date()) {
      return res.status(422).json({ error: 'Expired service outline cannot be sent' });
    }

    const estimate = packet.estimate_id ? await db('estimates').where({ id: packet.estimate_id }).first() : null;
    if (!estimate) return res.status(404).json({ error: 'Estimate not found for this outline' });

    const method = String(req.body.method || 'sms').toLowerCase();
    const sendSms = ['sms', 'both'].includes(method);
    const sendEmail = ['email', 'both'].includes(method);
    if (!sendSms && !sendEmail) return res.status(400).json({ error: 'Send method must be sms, email, or both' });

    const requestedToken = String(req.body.token || '').trim();
    const canReuseToken = requestedToken && packet.token_hash && hashToken(requestedToken) === packet.token_hash;
    const token = canReuseToken ? requestedToken : createPublicToken();
    const publicUrl = publicUrlForToken(token);
    const shortUrl = sendSms ? await shortenOrPassthrough(publicUrl, {
      entityType: 'service_outline',
      entityId: packet.id,
      customerId: packet.customer_id || estimate.customer_id || null,
    }) : publicUrl;
    const outcomes = {};

    if (!canReuseToken) {
      await db('service_outline_packets')
        .where({ id: packet.id })
        .update({
          token_hash: hashToken(token),
          token_last_four: token.slice(-4),
          token_created_at: db.fn.now(),
          expires_at: new Date(Date.now() + 1000 * 60 * 60 * 24 * 45),
          updated_at: db.fn.now(),
        });
    }

    if (sendSms) {
      if (!estimate.customer_phone) {
        outcomes.sms = { ok: false, error: 'No phone on estimate' };
      } else {
        const smsBody = `Waves: Your lawn care program overview is ready: ${shortUrl} Reply STOP to opt out.`;
        outcomes.sms = await sendCustomerMessage({
          to: estimate.customer_phone,
          body: smsBody,
          channel: 'sms',
          audience: estimate.customer_id ? 'customer' : 'lead',
          purpose: 'estimate_followup',
          customerId: estimate.customer_id || undefined,
          leadId: estimate.lead_id || undefined,
          estimateId: estimate.id,
          identityTrustLevel: estimate.customer_id ? 'phone_matches_customer' : 'phone_provided_unverified',
          consentBasis: estimate.customer_id ? undefined : {
            status: 'transactional_allowed',
            source: 'admin_lawn_service_outline_send',
            capturedAt: estimate.created_at || new Date().toISOString(),
          },
          entryPoint: 'admin_lawn_service_outline_send',
          metadata: {
            packetId: packet.id,
            original_message_type: 'lawn_service_outline',
          },
        });
      }
    }

    if (sendEmail) {
      if (!estimate.customer_email) {
        outcomes.email = { ok: false, error: 'No email on estimate' };
      } else if (!sendgrid.isConfigured()) {
        outcomes.email = { ok: false, error: 'SendGrid is not configured' };
      } else {
        const title = packet.title || 'Your Waves Lawn Care Program Overview';
        const html = `
          <p>Hi ${estimate.customer_name || 'there'},</p>
          <p>Your Waves lawn care program overview is ready. It explains what a typical visit includes, how treatments change by season, and how service is documented.</p>
          <p><a href="${publicUrl}">View your lawn care program overview</a></p>
          <p>Waves Pest Control</p>
        `;
        outcomes.email = await sendgrid.sendOne({
          to: estimate.customer_email,
          subject: title,
          html,
          text: `Your Waves lawn care program overview is ready: ${publicUrl}`,
          categories: ['lawn_service_outline'],
        });
      }
    }

    const hasSuccess = (outcomes.sms?.sent === true) || !!outcomes.email?.messageId;
    const [updated] = await db.transaction(async (trx) => {
      const [row] = await trx('service_outline_packets')
        .where({ id: packet.id })
        .update({
          status: hasSuccess ? 'sent' : packet.status,
          sent_at: hasSuccess ? trx.fn.now() : packet.sent_at,
          sent_method: hasSuccess ? method : packet.sent_method,
          updated_at: trx.fn.now(),
        })
        .returning('*');
      if (sendSms) await logEvent(trx, row, 'sent_sms', req, outcomes.sms || {});
      if (sendEmail) await logEvent(trx, row, 'sent_email', req, outcomes.email || {});
      if (!hasSuccess) await logEvent(trx, row, 'failed', req, outcomes);
      return [row];
    });

    res.json({
      packet: safePacket(updated, token),
      publicUrl,
      outcomes,
    });
  } catch (err) {
    logger.error(`[admin-service-outlines] send failed: ${err.stack || err.message}`);
    next(err);
  }
});

module.exports = router;

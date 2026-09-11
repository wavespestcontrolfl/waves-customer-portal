'use strict';

const crypto = require('crypto');
const db = require('../models/db');
const VisitGroups = require('./visit-groups');

const VISIT_SUMMARY_TOKEN_RE = /^[a-f0-9]{64}$/;

/** Issue once. Creation gates never revoke an already issued customer link. */
async function ensureVisitSummaryToken(packetId, database = db) {
  const key = process.env.DATA_HYGIENE_VAULT_KEY;
  if (!key) throw new Error('Visit summary encryption key is unavailable');
  try {
    return await database.transaction(async (trx) => {
      const packet = await trx('visit_completion_packets').where({ id: packetId }).first();
      if (!packet || !['processing', 'done'].includes(packet.status)) throw new Error('Packet unavailable');
      const visit = await trx('service_visits').where({ id: packet.visit_id }).forUpdate().first();
      if (!visit || !['closing', 'closed'].includes(visit.status)) {
        throw new Error('Visit unavailable');
      }
      if (visit.summary_token_revoked_at) return null;
      const pending = await trx('visit_completion_packet_items').where({ packet_id: packet.id })
        .whereNot('status', 'done').first('id');
      if (pending) throw new Error('Member reports are still pending');
      if (visit.summary_token_enc) {
        const result = await trx.raw('SELECT pgp_sym_decrypt(?, ?) AS token', [visit.summary_token_enc, key]);
        const token = result.rows[0].token;
        if (!VISIT_SUMMARY_TOKEN_RE.test(token)
            || crypto.createHash('sha256').update(token).digest('hex') !== visit.summary_token_hash) {
          throw new Error('Stored summary token does not match');
        }
        return token;
      }
      if (visit.summary_token_hash || visit.summary_token_issued_at) throw new Error('Incomplete token identity');
      const token = crypto.randomBytes(32).toString('hex');
      await trx('service_visits').where({ id: visit.id }).update({
        summary_token_hash: crypto.createHash('sha256').update(token).digest('hex'),
        summary_token_enc: trx.raw('pgp_sym_encrypt(?, ?)', [token, key]),
        summary_token_issued_at: trx.fn.now(), updated_at: trx.fn.now(),
      });
      return token;
    });
  } catch {
    // Knex errors interpolate bindings. Never propagate the key, token,
    // ciphertext, original message or cause to route/worker logs.
    throw new Error('Visit summary link could not be prepared');
  }
}

/** Members a customer may see: never a backfill, only an auto_send report posture. */
function publishableSummaryItems(items) {
  return items.filter((item) => {
    const notes = typeof item.structured_notes === 'string' ? JSON.parse(item.structured_notes) : item.structured_notes;
    return !notes?.backfill && (!notes?.typedReportDelivery || notes.typedReportDelivery === 'auto_send');
  });
}

/** An internal-only packet has no customer summary: no link is minted for it. */
async function packetHasPublishableSummary(packetId, database = db) {
  const items = await database('visit_completion_packet_items as i')
    .join('service_records as r', 'r.id', 'i.service_record_id')
    .where('i.packet_id', packetId).select('r.structured_notes');
  return publishableSummaryItems(items).length > 0;
}

/** Explicit customer projection. Notes, addresses and billing tokens stay out. */
async function getVisitCompletionSummary(token, database = db) {
  if (!VISIT_SUMMARY_TOKEN_RE.test(String(token || ''))) return null;
  const visit = await database('service_visits').where({
    summary_token_hash: crypto.createHash('sha256').update(token).digest('hex'),
  }).whereNull('summary_token_revoked_at').whereNotNull('summary_token_issued_at')
    .whereIn('status', ['closing', 'closed']).first();
  if (!visit) return null;
  const packet = await database('visit_completion_packets').where({ visit_id: visit.id })
    .whereIn('status', ['processing', 'done']).first('id');
  if (!packet) return null;
  const items = await database('visit_completion_packet_items as i')
    .join('service_records as r', 'r.id', 'i.service_record_id')
    .join('scheduled_services as s', 's.id', 'i.scheduled_service_id')
    .where('i.packet_id', packet.id).orderBy('s.window_start').orderBy('s.id')
    .select('i.status', 'r.id', 'r.service_type', 'r.structured_notes', 'r.report_view_token',
      'r.customer_id', 'r.scheduled_service_id', 's.id as member_id', 's.visit_id');
  // The packet's own membership is the floor: a visit that retained
  // cancelled or skipped members can close with one recorded service.
  if (!items.length || items.some((item) => item.status !== 'done'
      || item.customer_id !== visit.customer_id || item.visit_id !== visit.id
      || item.scheduled_service_id !== item.member_id)) return null;
  const visible = publishableSummaryItems(items);
  if (!visible.length) return null;
  return {
    serviceDate: VisitGroups.dateOnly(visit.scheduled_date),
    services: visible.map((item) => {
      const notes = typeof item.structured_notes === 'string' ? JSON.parse(item.structured_notes) : item.structured_notes;
      return {
        id: item.id, serviceType: item.service_type,
        outcome: notes?.visitOutcome || 'completed',
        reportUrl: /^[a-f0-9]{32}$/.test(item.report_view_token || '')
          ? `/report/${item.report_view_token}` : null,
      };
    }),
  };
}

module.exports = { VISIT_SUMMARY_TOKEN_RE, ensureVisitSummaryToken, packetHasPublishableSummary, getVisitCompletionSummary };

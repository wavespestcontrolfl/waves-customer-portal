'use strict';

const express = require('express');
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { noStore } = require('../middleware/no-store');
const { isEnabled } = require('../config/feature-gates');
const { validate: isUuid } = require('uuid');
const { completionOwnershipError } = require('../services/complete-scheduled-service');
const { saveVisitCompletionPacket, runVisitCompletionPacketEffects, visitCloseoutMemberQuery, retainedCloseoutMembers } = require('../services/visit-completion-packets');
const { dateOnly } = require('../services/visit-groups');
const { technicianCurrentVisitFilter } = require('../services/technician-visit-scope');

const router = express.Router();
router.use(adminAuthenticate, requireTechOrAdmin, noStore);

// Every read and resume checks the complete live member set. The save also
// repeats this ownership check under its customer/stop/member locks.
router.use('/:visitId', async (req, res, next) => {
  try {
    if (!isUuid(req.params.visitId)) return res.status(404).json({ error: 'Visit not found.' });
    const visit = await db('service_visits').where({ id: req.params.visitId }).whereNot('status', 'dissolved').first();
    if (!visit) return res.status(404).json({ error: 'Visit not found.' });
    const members = await visitCloseoutMemberQuery(visit.id).orderBy('window_start').orderBy('id');
    if (members.length < 2) return res.status(409).json({ error: 'Refresh the schedule. This visit no longer contains multiple services.' });
    const packet = await db('visit_completion_packets').where({ visit_id: visit.id }).first('id', 'status', 'error', 'payload');
    const retainedIds = new Set(retainedCloseoutMembers(members, packet).map((member) => member.serviceId));
    const current = members.filter((member) => !retainedIds.has(member.id));
    if (!current.length) return res.status(404).json({ error: 'Visit not found.' });
    const ownership = current.map((member) => completionOwnershipError({
      role: req.techRole, actorTechnicianId: req.technicianId, assignedTechnicianId: member.technician_id,
    })).find(Boolean);
    if (ownership) return res.status(ownership.status).json(ownership.payload);
    const accessible = new Set((await technicianCurrentVisitFilter(req,
      db('scheduled_services').where({ visit_id: visit.id })).select('id')).map((row) => row.id));
    if (!current.every((member) => accessible.has(member.id))) return res.status(404).json({ error: 'Visit not found.' });
    if (!packet && Number(visit.behavior_version) < 2 && !isEnabled('visitCloseout')) return res.status(404).json({ error: 'Visit closeout is unavailable.' });
    req.visitCloseout = { visit, members, packet, retainedIds };
    return next();
  } catch (err) { return next(err); }
});

router.get('/:visitId', async (req, res, next) => {
  try {
    const { visit, members, packet, retainedIds } = req.visitCloseout;
    const invoice = packet
      ? await db('invoices').where({ visit_completion_packet_id: packet.id }).first('id', 'status', 'total')
      : null;
    return res.json({
      visitId: visit.id, serviceDate: dateOnly(visit.scheduled_date),
      members: members.map((member) => ({ id: member.id, serviceType: member.service_type, status: member.status,
        requiresForm: !retainedIds.has(member.id) })),
      // Office review is a terminal state: a processing packet's error is the
      // recovery worker's retry marker, not an intervention request.
      packet: packet ? { id: packet.id, status: packet.status,
        officeReview: packet.status === 'failed' || (packet.status === 'done' && Boolean(packet.error)) } : null,
      invoice: invoice ? { id: invoice.id, status: invoice.status, total: Number(invoice.total) } : null,
      canRevokeSummary: req.techRole === 'admin' && Boolean(visit.summary_token_issued_at) && !visit.summary_token_revoked_at,
      summaryRevoked: Boolean(visit.summary_token_revoked_at),
    });
  } catch (err) { return next(err); }
});

router.post('/:visitId', async (req, res, next) => {
  try {
    const saved = await saveVisitCompletionPacket({
      visitId: req.params.visitId, items: req.body?.items,
      idempotencyKey: req.get('Idempotency-Key'),
      actor: { techRole: req.techRole, technicianId: req.technicianId },
    });
    if (!saved.body.packetId) return res.status(saved.status).json(saved.body);
    const result = await runVisitCompletionPacketEffects(saved.body.packetId);
    return res.status(result.status).json({ ...result.body, canRevokeSummary: req.techRole === 'admin' && Boolean(result.body.summaryUrl) });
  } catch (err) { return next(err); }
});

router.post('/:visitId/resume', async (req, res, next) => {
  try {
    const { packet } = req.visitCloseout;
    if (!packet) return res.status(404).json({ error: 'Saved visit closeout not found.' });
    const result = await runVisitCompletionPacketEffects(packet.id, undefined, { actor: { techRole: req.techRole, technicianId: req.technicianId } });
    return res.status(result.status).json({ ...result.body, canRevokeSummary: req.techRole === 'admin' && Boolean(result.body.summaryUrl) });
  } catch (err) { return next(err); }
});

router.post('/:visitId/revoke-summary', requireAdmin, async (req, res, next) => {
  try {
    const { visit } = req.visitCloseout;
    if (!visit.summary_token_issued_at) return res.status(409).json({ error: 'This visit has no issued summary link.' });
    await db('service_visits').where({ id: visit.id }).whereNull('summary_token_revoked_at').update({
      summary_token_revoked_at: db.fn.now(), updated_at: db.fn.now(),
    });
    return res.json({ revoked: true });
  } catch (err) { return next(err); }
});

module.exports = router;

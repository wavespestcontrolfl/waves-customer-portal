/**
 * Admin service-request management.
 *
 * Customers create service requests from the portal (POST /api/requests); this
 * router is the staff side — list them and move them through their lifecycle
 * (new → acknowledged → scheduled → resolved). A status change emails the
 * customer via account.request_updated so they know their request moved
 * forward (the companion to the request-received email sent on creation).
 */

const express = require('express');
const router = express.Router();
const Joi = require('joi');
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const AccountMembershipEmail = require('../services/account-membership-email');

router.use(adminAuthenticate, requireTechOrAdmin);

// Lifecycle the customer portal already renders (PortalPage STATUS_ORDER).
const STATUSES = ['new', 'acknowledged', 'scheduled', 'resolved'];
const STATUS_LABELS = {
  new: 'New',
  acknowledged: 'Acknowledged',
  scheduled: 'Scheduled',
  resolved: 'Resolved',
};

// Strip HTML-ish characters before storage so admin/UI surfaces can never
// render injected markup (mirrors routes/requests.js).
function stripHtml(value) {
  return String(value || '').replace(/[<>]/g, '');
}

const listSchema = Joi.object({
  status: Joi.string().valid(...STATUSES).optional(),
  customerId: Joi.string().uuid().optional(),
  limit: Joi.number().integer().min(1).max(200).default(50),
  page: Joi.number().integer().min(1).default(1),
});

const updateSchema = Joi.object({
  status: Joi.string().valid(...STATUSES).optional(),
  adminNotes: Joi.string().trim().allow('').max(2000).optional(),
  assignedTechnicianId: Joi.string().uuid().allow(null).optional(),
}).min(1);

// GET /api/admin/requests — list service requests for staff triage.
router.get('/', async (req, res, next) => {
  try {
    const { value, error } = listSchema.validate(req.query, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });
    const { status, customerId, limit, page } = value;
    const offset = (page - 1) * limit;

    let query = db('service_requests')
      .leftJoin('customers', 'service_requests.customer_id', 'customers.id')
      .leftJoin('technicians', 'service_requests.assigned_technician_id', 'technicians.id')
      .select(
        'service_requests.id',
        'service_requests.customer_id as customerId',
        'service_requests.category',
        'service_requests.subject',
        'service_requests.description',
        'service_requests.urgency',
        'service_requests.location_on_property as locationOnProperty',
        'service_requests.status',
        'service_requests.admin_notes as adminNotes',
        'service_requests.assigned_technician_id as assignedTechnicianId',
        'service_requests.created_at as createdAt',
        'service_requests.updated_at as updatedAt',
        'service_requests.resolved_at as resolvedAt',
        'customers.first_name as customerFirstName',
        'customers.last_name as customerLastName',
        'customers.email as customerEmail',
        'customers.phone as customerPhone',
        'technicians.name as assignedTechnician',
      );
    if (status) query = query.where('service_requests.status', status);
    if (customerId) query = query.where('service_requests.customer_id', customerId);

    const requests = await query
      .orderBy('service_requests.created_at', 'desc')
      .limit(limit)
      .offset(offset);

    let countQuery = db('service_requests');
    if (status) countQuery = countQuery.where({ status });
    if (customerId) countQuery = countQuery.where({ customer_id: customerId });
    const total = await countQuery.count('id as count').first();

    res.json({ requests, total: parseInt(total?.count || 0, 10), limit, page });
  } catch (err) { next(err); }
});

// PATCH /api/admin/requests/:id — update status / notes / assignment.
// On a real status change, email the customer (fire-and-forget).
router.patch('/:id', async (req, res, next) => {
  try {
    const { value, error } = updateSchema.validate(req.body, { stripUnknown: true });
    if (error) return res.status(400).json({ error: error.details[0].message });

    const existing = await db('service_requests').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Service request not found' });

    const patch = { updated_at: new Date() };
    const statusChanged = value.status !== undefined && value.status !== existing.status;
    if (value.status !== undefined) {
      patch.status = value.status;
      // Stamp resolved_at the first time it resolves; clear if reopened.
      if (value.status === 'resolved' && existing.status !== 'resolved') {
        patch.resolved_at = new Date();
      } else if (value.status !== 'resolved' && existing.resolved_at) {
        patch.resolved_at = null;
      }
    }
    if (value.adminNotes !== undefined) patch.admin_notes = stripHtml(value.adminNotes);
    if (value.assignedTechnicianId !== undefined) patch.assigned_technician_id = value.assignedTechnicianId;

    // For a status transition, gate the write on the status we observed so two
    // concurrent PATCHes to the same target can't both "win": only the writer
    // that actually flips the status from `existing.status` updates. The loser
    // matches zero rows, so it never re-stamps updated_at (which would change
    // the sender's idempotency key) nor sends a duplicate customer email.
    const updateQuery = db('service_requests').where({ id: req.params.id });
    if (statusChanged) updateQuery.where({ status: existing.status });
    const [updated] = await updateQuery.update(patch).returning('*');

    if (statusChanged && !updated) {
      // Another writer transitioned this request first; surface the current
      // row without re-notifying.
      const current = await db('service_requests').where({ id: req.params.id }).first();
      return res.json({ request: current, statusChanged: false });
    }

    if (statusChanged) {
      // Notify the customer their request moved forward. Fire-and-forget like
      // the request-received path — an email hiccup must not fail the staff
      // action. Idempotency on the sender keys to updated_at, so each distinct
      // status change emails exactly once.
      void AccountMembershipEmail.sendRequestUpdated({
        customerId: updated.customer_id,
        request: updated,
        statusLabel: STATUS_LABELS[updated.status] || updated.status,
      }).catch((err) => logger.error(`[admin-requests] request-updated email failed for ${updated.id}: ${err.message}`));
    }

    res.json({ request: updated, statusChanged });
  } catch (err) { next(err); }
});

module.exports = router;

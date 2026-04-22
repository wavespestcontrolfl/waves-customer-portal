/**
 * Admin credentials route — Virginia's CRUD surface for the FDACS/insurance
 * single source of truth.
 *
 * Mounted at /api/admin/credentials. Soft delete only (compliance audit
 * trail); PATCH + POST write an activity_log row via the existing table so
 * the admin UI can show "last updated by X on Y".
 *
 * No feature-flag gate at the route level — the flag controls whether the
 * client-side UI is visible. Routes are always reachable so a flag flip
 * doesn't require a server restart.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');

router.use(adminAuthenticate, requireAdmin);

const ALLOWED_FIELDS = {
  slug: 'slug',
  displayName: 'display_name',
  credentialType: 'credential_type',
  issuingAuthority: 'issuing_authority',
  credentialNumber: 'credential_number',
  holderName: 'holder_name',
  issuedDate: 'issued_date',
  expirationDate: 'expiration_date',
  status: 'status',
  jurisdictions: 'jurisdictions',
  displayFormatShort: 'display_format_short',
  displayFormatLong: 'display_format_long',
  displayFormatLegal: 'display_format_legal',
  isPublic: 'is_public',
  sortOrder: 'sort_order',
  notes: 'notes',
};

const TYPES = ['license', 'insurance', 'certification', 'registration'];
const STATUSES = ['active', 'expired', 'pending_renewal', 'revoked'];

function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    credentialType: row.credential_type,
    issuingAuthority: row.issuing_authority,
    credentialNumber: row.credential_number,
    holderName: row.holder_name,
    issuedDate: row.issued_date,
    expirationDate: row.expiration_date,
    status: row.status,
    jurisdictions: row.jurisdictions || [],
    displayFormatShort: row.display_format_short,
    displayFormatLong: row.display_format_long,
    displayFormatLegal: row.display_format_legal,
    isPublic: row.is_public,
    sortOrder: row.sort_order,
    notes: row.notes,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBodyToColumns(body) {
  const updates = {};
  for (const [k, col] of Object.entries(ALLOWED_FIELDS)) {
    if (body[k] === undefined) continue;
    if (col === 'issued_date' || col === 'expiration_date') {
      updates[col] = body[k] || null; // empty string → null
    } else {
      updates[col] = body[k];
    }
  }
  return updates;
}

function validate(updates, { partial = false } = {}) {
  if (!partial) {
    for (const req of ['slug', 'display_name', 'credential_type', 'credential_number']) {
      if (!updates[req]) return `Missing required field: ${req}`;
    }
  }
  if (updates.credential_type && !TYPES.includes(updates.credential_type)) {
    return `credential_type must be one of ${TYPES.join(', ')}`;
  }
  if (updates.status && !STATUSES.includes(updates.status)) {
    return `status must be one of ${STATUSES.join(', ')}`;
  }
  return null;
}

async function logActivity(adminUserId, action, description, metadata) {
  try {
    await db('activity_log').insert({
      admin_user_id: adminUserId || null,
      action,
      description,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
  } catch (e) {
    logger.warn(`[admin-credentials] activity_log write failed: ${e.message}`);
  }
}

// GET — list all (includes archived; UI filters)
router.get('/', async (_req, res, next) => {
  try {
    const rows = await db('business_credentials')
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'desc');
    res.json({ credentials: rows.map(toApi) });
  } catch (err) { next(err); }
});

// GET /:id
router.get('/:id', async (req, res, next) => {
  try {
    const row = await db('business_credentials').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    res.json(toApi(row));
  } catch (err) { next(err); }
});

// POST — create
router.post('/', async (req, res, next) => {
  try {
    const updates = mapBodyToColumns(req.body);
    const invalid = validate(updates, { partial: false });
    if (invalid) return res.status(400).json({ error: invalid });

    const [row] = await db('business_credentials').insert(updates).returning('*');
    await logActivity(req.technicianId, 'credential_created',
      `${row.display_name} (${row.slug}) created`,
      { credential_id: row.id, slug: row.slug });
    res.status(201).json(toApi(row));
  } catch (err) {
    if (err.message?.includes('business_credentials_slug_unique') || err.code === '23505') {
      return res.status(409).json({ error: 'A credential with that slug already exists' });
    }
    next(err);
  }
});

// PATCH /:id
router.patch('/:id', async (req, res, next) => {
  try {
    const updates = mapBodyToColumns(req.body);
    const invalid = validate(updates, { partial: true });
    if (invalid) return res.status(400).json({ error: invalid });
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updatable fields in body' });
    }
    updates.updated_at = db.fn.now();
    const [row] = await db('business_credentials')
      .where({ id: req.params.id })
      .update(updates)
      .returning('*');
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    await logActivity(req.technicianId, 'credential_updated',
      `${row.display_name} (${row.slug}) updated: ${Object.keys(updates).filter(k => k !== 'updated_at').join(', ')}`,
      { credential_id: row.id, slug: row.slug, fields: Object.keys(updates).filter(k => k !== 'updated_at') });
    res.json(toApi(row));
  } catch (err) { next(err); }
});

// DELETE /:id — soft delete via archived_at
router.delete('/:id', async (req, res, next) => {
  try {
    const [row] = await db('business_credentials')
      .where({ id: req.params.id })
      .update({ archived_at: db.fn.now(), updated_at: db.fn.now() })
      .returning('*');
    if (!row) return res.status(404).json({ error: 'Credential not found' });
    await logActivity(req.technicianId, 'credential_archived',
      `${row.display_name} (${row.slug}) archived`,
      { credential_id: row.id, slug: row.slug });
    res.json({ success: true, credential: toApi(row) });
  } catch (err) { next(err); }
});

// GET /:id/activity — recent activity_log rows for this credential
router.get('/:id/activity', async (req, res, next) => {
  try {
    const rows = await db('activity_log')
      .leftJoin('technicians', 'activity_log.admin_user_id', 'technicians.id')
      .select('activity_log.*', 'technicians.name as admin_name')
      .whereRaw("activity_log.metadata->>'credential_id' = ?", [req.params.id])
      .orderBy('activity_log.created_at', 'desc')
      .limit(50);
    res.json({
      activity: rows.map((r) => ({
        id: r.id,
        action: r.action,
        description: r.description,
        metadata: r.metadata,
        createdAt: r.created_at,
        adminName: r.admin_name,
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;

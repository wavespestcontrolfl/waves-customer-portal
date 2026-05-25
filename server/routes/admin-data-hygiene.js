const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin, requireTechOrAdmin } = require('../middleware/admin-auth');
const { isEnabled } = require('../config/feature-gates');
const { runScan } = require('../services/data-hygiene');
const {
  auditHygieneProposalApply,
  auditHygieneProposalReject,
  auditHygieneProposalRevert,
} = require('../services/audit-log');
const {
  hashSensitiveValue,
  redactSensitiveValue,
  vaultAttachAuditLog,
  vaultReadSensitive,
} = require('../services/data-hygiene/sensitive-vault');

router.use(adminAuthenticate, requireTechOrAdmin);

const ALLOWED_STATUSES = new Set(['pending', 'auto_applied', 'approved', 'rejected', 'superseded', 'stale', 'reverted', 'all']);
const ALLOWED_PHASES = new Set(['normalization', 'extraction']);
const PROPERTY_PREF_APPLY_FIELDS = new Set([
  'neighborhood_gate_code',
  'property_gate_code',
  'garage_code',
  'lockbox_code',
  'parking_notes',
  'access_notes',
  'pet_details',
]);

router.get('/proposals', async (req, res, next) => {
  try {
    const status = ALLOWED_STATUSES.has(String(req.query.status || 'pending'))
      ? String(req.query.status || 'pending')
      : 'pending';
    const limit = normalizeLimit(req.query.limit, 100);

    const query = db('data_hygiene_proposals as p')
      .leftJoin('customers as c', 'p.scope_id', 'c.id')
      .select(
        'p.id',
        'p.rule_id',
        'p.rule_version',
        'p.resource_type',
        'p.resource_id',
        'p.scope_type',
        'p.scope_id',
        'p.field',
        'p.current_value',
        'p.proposed_value',
        'p.source',
        'p.confidence',
        'p.tier',
        'p.evidence',
        'p.is_sensitive',
        'p.status',
        'p.reject_reason',
        'p.created_at',
        'p.updated_at',
        'c.first_name',
        'c.last_name',
        'c.phone',
        'c.email'
      )
      .orderBy('p.created_at', 'desc')
      .limit(limit);

    if (status !== 'all') query.where('p.status', status);

    const rows = await query;
    res.json({
      proposals: rows.map(formatProposal),
      status,
      limit,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/scan', async (req, res, next) => {
  try {
    if (!isEnabled('dataHygieneScanner')) {
      return res.status(403).json({ error: 'Data Hygiene scanner is disabled' });
    }

    const mode = req.body?.mode === 'dry_run' ? 'dry_run' : 'manual';
    const phases = normalizePhases(req.body?.phases);
    if (phases.includes('extraction') && !isEnabled('dataHygieneExtraction')) {
      return res.status(403).json({ error: 'Data Hygiene extraction is disabled' });
    }

    const result = await runScan({
      mode,
      phases,
      triggeredBy: req.technicianId,
    });

    res.status(result.lock_busy ? 409 : 200).json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/proposals/:id/reject', async (req, res, next) => {
  try {
    const reason = normalizeRejectReason(req.body?.reason);
    const [updated] = await db('data_hygiene_proposals')
      .where({ id: req.params.id, status: 'pending' })
      .update({
        status: 'rejected',
        reject_reason: reason,
        reviewer_id: req.technicianId,
        reviewed_via: 'ui',
        reviewed_at: db.fn.now(),
        updated_at: db.fn.now(),
      })
      .returning('*');

    if (!updated) return res.status(404).json({ error: 'Pending proposal not found' });

    await auditHygieneProposalReject({
      proposal_id: updated.id,
      rule_id: updated.rule_id,
      rule_version: updated.rule_version,
      source: updated.source,
      field: updated.field,
      resource_type: updated.resource_type,
      resource_id: updated.resource_id,
      scope_type: updated.scope_type,
      scope_id: updated.scope_id,
      reject_reason: reason,
      reviewer_id: req.technicianId,
      reviewed_via: 'ui',
      is_sensitive: updated.is_sensitive,
      evidence_summary: summarizeEvidence(parseJsonMaybe(updated.evidence)),
    });

    res.json({ proposal: formatProposal(updated) });
  } catch (err) {
    next(err);
  }
});

router.post('/proposals/:id/reveal', requireAdmin, async (req, res, next) => {
  try {
    if (!isEnabled('dataHygieneSensitiveReveal')) {
      return res.status(403).json({ error: 'Sensitive reveal is disabled' });
    }

    const proposal = await db('data_hygiene_proposals')
      .where({ id: req.params.id })
      .first();
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });
    if (!proposal.is_sensitive) return res.status(422).json({ error: 'Proposal is not sensitive' });

    const vault = await db('data_hygiene_sensitive_vault')
      .where({ proposal_id: proposal.id, field: proposal.field })
      .first();
    if (!vault) return res.status(422).json({ error: 'Sensitive vault row missing for proposal' });

    const raw = await vaultReadSensitive({
      vault_id: vault.id,
      actor_id: req.technicianId,
      reason: 'data_hygiene_reveal',
    });
    if (!raw) return res.status(404).json({ error: 'Sensitive value not found' });

    res.json({
      proposalId: proposal.id,
      field: proposal.field,
      currentValue: raw.before_raw === undefined ? null : raw.before_raw,
      proposedValue: raw.after_raw === undefined ? null : raw.after_raw,
      readAuditLogId: raw.read_audit_log_id,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/proposals/:id/approve', async (req, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const proposal = await trx('data_hygiene_proposals')
        .where({ id: req.params.id })
        .forUpdate()
        .first();

      if (!proposal || proposal.status !== 'pending') {
        const err = new Error('Pending proposal not found');
        err.status = 404;
        throw err;
      }
      if (!canApplyProposal(proposal)) {
        const err = new Error('This proposal type is not allowlisted for apply yet');
        err.status = 422;
        throw err;
      }

      const vault = await trx('data_hygiene_sensitive_vault')
        .where({ proposal_id: proposal.id, field: proposal.field })
        .first();
      if (!vault) {
        const err = new Error('Sensitive vault row missing for proposal');
        err.status = 422;
        throw err;
      }

      const raw = await vaultReadSensitive({
        trx,
        vault_id: vault.id,
        actor_id: req.technicianId,
        reason: 'data_hygiene_apply',
      });
      const currentRaw = raw?.before_raw === undefined ? null : raw.before_raw;
      const proposedRaw = raw?.after_raw === undefined ? null : raw.after_raw;
      const target = await resolvePropertyPreferencesTarget({
        trx,
        proposal,
        currentRaw,
      });

      await applyPropertyPreferenceValue({
        trx,
        proposal,
        target,
        proposedRaw,
      });

      const auditId = await auditHygieneProposalApply({
        trx,
        proposal_id: proposal.id,
        rule_id: proposal.rule_id,
        rule_version: proposal.rule_version,
        source: proposal.source,
        field: proposal.field,
        resource_type: proposal.resource_type,
        resource_id: target.id,
        scope_type: proposal.scope_type,
        scope_id: proposal.scope_id,
        before_redacted: redactSensitiveValue(currentRaw, proposal.field),
        after_redacted: redactSensitiveValue(proposedRaw, proposal.field),
        before_hash: hashSensitiveValue(currentRaw),
        after_hash: hashSensitiveValue(proposedRaw),
        vault_id: vault.id,
        reviewer_id: req.technicianId,
        reviewed_via: 'ui',
        is_sensitive: true,
      });

      await vaultAttachAuditLog({ trx, vault_id: vault.id, audit_log_id: auditId });

      const [updatedProposal] = await trx('data_hygiene_proposals')
        .where({ id: proposal.id })
        .update({
          status: 'approved',
          reviewer_id: req.technicianId,
          reviewed_via: 'ui',
          reviewed_at: db.fn.now(),
          applied_at: db.fn.now(),
          resource_id: target.id,
          updated_at: db.fn.now(),
        })
        .returning('*');

      return updatedProposal;
    });

    res.json({ proposal: formatProposal(result) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

router.post('/proposals/:id/revert', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.transaction(async (trx) => {
      const proposal = await trx('data_hygiene_proposals')
        .where({ id: req.params.id })
        .forUpdate()
        .first();

      if (!proposal || proposal.status !== 'approved') {
        const err = new Error('Approved proposal not found');
        err.status = 404;
        throw err;
      }
      if (!canApplyProposal(proposal)) {
        const err = new Error('This proposal type is not allowlisted for revert yet');
        err.status = 422;
        throw err;
      }
      if (!proposal.resource_id) {
        const err = new Error('Approved proposal is missing its applied resource id');
        err.status = 422;
        throw err;
      }

      const vault = await trx('data_hygiene_sensitive_vault')
        .where({ proposal_id: proposal.id, field: proposal.field })
        .first();
      if (!vault) {
        const err = new Error('Sensitive vault row missing for proposal');
        err.status = 422;
        throw err;
      }

      const raw = await vaultReadSensitive({
        trx,
        vault_id: vault.id,
        actor_id: req.technicianId,
        reason: 'data_hygiene_revert',
      });
      const beforeRaw = raw?.before_raw === undefined ? null : raw.before_raw;
      const afterRaw = raw?.after_raw === undefined ? null : raw.after_raw;

      const target = await trx('property_preferences')
        .where({ id: proposal.resource_id, customer_id: proposal.scope_id })
        .forUpdate()
        .first();
      if (!target) {
        const err = new Error('Applied property preferences row not found');
        err.status = 404;
        throw err;
      }
      const actual = target[proposal.field] === undefined ? null : target[proposal.field];
      if (!valuesEqual(actual, afterRaw)) {
        const err = new Error('Cannot revert; current field value changed after approval');
        err.status = 409;
        throw err;
      }

      await trx('property_preferences')
        .where({ id: target.id, customer_id: proposal.scope_id })
        .update({
          [proposal.field]: beforeRaw,
          updated_at: db.fn.now(),
        });

      const auditId = await auditHygieneProposalRevert({
        trx,
        proposal_id: proposal.id,
        rule_id: proposal.rule_id,
        rule_version: proposal.rule_version,
        source: proposal.source,
        field: proposal.field,
        resource_type: proposal.resource_type,
        resource_id: target.id,
        scope_type: proposal.scope_type,
        scope_id: proposal.scope_id,
        before_redacted: redactSensitiveValue(afterRaw, proposal.field),
        after_redacted: redactSensitiveValue(beforeRaw, proposal.field),
        before_hash: hashSensitiveValue(afterRaw),
        after_hash: hashSensitiveValue(beforeRaw),
        vault_id: vault.id,
        original_audit_id: vault.audit_log_id,
        reverted_by: req.technicianId,
        is_sensitive: true,
        reviewed_via: 'ui',
      });
      await vaultAttachAuditLog({ trx, vault_id: vault.id, audit_log_id: auditId });

      const [updatedProposal] = await trx('data_hygiene_proposals')
        .where({ id: proposal.id })
        .update({
          status: 'reverted',
          reviewer_id: req.technicianId,
          reviewed_via: 'ui',
          reviewed_at: db.fn.now(),
          updated_at: db.fn.now(),
        })
        .returning('*');

      return updatedProposal;
    });

    res.json({ proposal: formatProposal(result) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
});

function normalizeLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 250);
}

function normalizePhases(value) {
  const raw = Array.isArray(value) ? value : ['normalization'];
  const phases = raw.map(String).filter((phase) => ALLOWED_PHASES.has(phase));
  return phases.length ? [...new Set(phases)] : ['normalization'];
}

function normalizeRejectReason(value) {
  const allowed = new Set(['wrong_person', 'wrong_property', 'outdated', 'bad_parse', 'noise', 'other']);
  return allowed.has(String(value || '')) ? String(value) : 'other';
}

function canApplyProposal(proposal) {
  return proposal.resource_type === 'property_preferences'
    && proposal.scope_type === 'customer'
    && proposal.is_sensitive === true
    && PROPERTY_PREF_APPLY_FIELDS.has(proposal.field);
}

async function resolvePropertyPreferencesTarget({ trx, proposal, currentRaw }) {
  const existing = proposal.resource_id
    ? await trx('property_preferences')
      .where({ id: proposal.resource_id, customer_id: proposal.scope_id })
      .forUpdate()
      .first()
    : await trx('property_preferences')
      .where({ customer_id: proposal.scope_id })
      .forUpdate()
      .first();

  if (existing) {
    const actual = existing[proposal.field] === undefined ? null : existing[proposal.field];
    if (!valuesEqual(actual, currentRaw)) {
      const err = new Error('Proposal is stale; current field value changed');
      err.status = 409;
      throw err;
    }
    return existing;
  }

  if (currentRaw !== null && currentRaw !== undefined) {
    const err = new Error('Cannot create property preferences row for a non-empty before value');
    err.status = 409;
    throw err;
  }

  const [created] = await trx('property_preferences')
    .insert({ customer_id: proposal.scope_id })
    .returning('*');
  return created;
}

async function applyPropertyPreferenceValue({ trx, proposal, target, proposedRaw }) {
  const updated = await trx('property_preferences')
    .where({ id: target.id, customer_id: proposal.scope_id })
    .update({
      [proposal.field]: proposedRaw,
      updated_at: db.fn.now(),
    });
  if (!updated) {
    const err = new Error('Property preferences update failed');
    err.status = 409;
    throw err;
  }
}

function valuesEqual(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

function summarizeEvidence(evidence = {}) {
  return {
    evidence_source_type: evidence.evidence_source_type || null,
    evidence_source_id: evidence.evidence_source_id || null,
    channel: evidence.channel || null,
    matched_label: evidence.matched_label || null,
    source_excerpt: evidence.source_excerpt || null,
  };
}

function formatProposal(row) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(' ').trim();
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    field: row.field,
    currentValue: parseJsonMaybe(row.current_value),
    proposedValue: parseJsonMaybe(row.proposed_value),
    source: row.source,
    confidence: row.confidence == null ? null : Number(row.confidence),
    tier: row.tier,
    evidence: parseJsonMaybe(row.evidence) || {},
    isSensitive: !!row.is_sensitive,
    status: row.status,
    rejectReason: row.reject_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    customer: row.scope_type === 'customer'
      ? {
          id: row.scope_id,
          name: name || null,
          phone: row.phone || null,
          email: row.email || null,
        }
      : null,
  };
}

function parseJsonMaybe(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

module.exports = router;

/**
 * Hermes vendor login discovery worker.
 *
 * Machine-to-machine endpoints only. Hermes may find login/register URLs and
 * signup requirements, but it must not receive, create, or store passwords.
 */
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { hermesAuth } = require('../middleware/hermes-auth');

router.use(hermesAuth);

const TERMINAL_OUTCOMES = ['found', 'needs_manual_signup', 'not_found', 'failed', 'skipped'];
const CLAIM_LEASE_MINUTES = 15;

function cleanString(value) {
  const str = String(value ?? '').trim();
  return str || null;
}

function normalizeHttpUrl(value, baseUrl = null) {
  const raw = cleanString(value);
  if (!raw) return null;
  try {
    const base = cleanString(baseUrl);
    const url = base ? new URL(raw, base) : new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function parseJsonObject(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function parseBoundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function cleanStringArray(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || '').split(/\n|;/);
  return source.map(cleanString).filter(Boolean).slice(0, 20);
}

function confidence(value, fallback = 0.70) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function businessProfile() {
  return {
    business_name: process.env.VENDOR_PORTAL_BUSINESS_NAME || 'Waves Pest Control',
    contact_email: process.env.VENDOR_PORTAL_CONTACT_EMAIL || 'contact@wavespestcontrol.com',
    instructions: [
      'Find vendor login, registration, or account request URLs.',
      'Do not create an account, set a password, submit tax documents, or complete MFA.',
      'Report required manual signup steps, account approval requirements, and evidence URLs.',
    ],
  };
}

function mapJob(row) {
  const config = parseJsonObject(row.config_json, {});
  return {
    vendor_id: row.vendor_id,
    vendor_name: row.vendor_name,
    vendor_type: row.vendor_type || null,
    website: row.website || null,
    known_login_url: row.login_url || null,
    sync_method: row.sync_method || null,
    vendor_credential_status: row.vendor_credential_status || null,
    connection_id: row.connection_id,
    connection_type: row.connection_type,
    claim_token: config.loginDiscovery?.claimToken || null,
    discovery: config.loginDiscovery || null,
    report_requires: ['connection_id', 'claim_token', 'outcome'],
    allowed_outcomes: TERMINAL_OUTCOMES,
    instructions: {
      goal: 'Find the vendor portal login/register path needed for authenticated account pricing.',
      capture: [
        'login_url',
        'registration_url',
        'pricing_portal_url',
        'rep_contact_url or rep_email/rep_phone when signup is rep-gated',
        'signup_requirements',
        'evidence_url',
      ],
      forbidden: [
        'Do not use or request passwords.',
        'Do not submit final account creation forms.',
        'Do not accept terms, upload documents, or bypass MFA.',
      ],
    },
  };
}

function noteFromReport({ outcome, loginUrl, registrationUrl, contactUrl, repEmail, repPhone, requirements, notes }) {
  const parts = [`Hermes login discovery ${new Date().toISOString().slice(0, 10)}: ${outcome}.`];
  if (loginUrl) parts.push(`Login: ${loginUrl}`);
  if (registrationUrl) parts.push(`Register: ${registrationUrl}`);
  if (contactUrl) parts.push(`Contact: ${contactUrl}`);
  if (repEmail) parts.push(`Rep email: ${repEmail}`);
  if (repPhone) parts.push(`Rep phone: ${repPhone}`);
  if (requirements.length) parts.push(`Requirements: ${requirements.join('; ')}`);
  if (notes) parts.push(`Notes: ${notes}`);
  return parts.join(' ');
}

// GET /claim?n=10 — lease queued vendor-login discovery tasks
router.get('/claim', async (req, res, next) => {
  try {
    const limit = parseBoundedInt(req.query.n, 10, 1, 50);
    const now = new Date();
    const claimedUntil = new Date(now.getTime() + CLAIM_LEASE_MINUTES * 60 * 1000);
    const jobs = await db.transaction(async (trx) => {
      const rows = await trx('vendor_connections as vc')
        .join('vendors as v', 'v.id', 'vc.vendor_id')
        .where('vc.is_active', true)
        .where(function openOrExpiredLoginDiscovery() {
          this.whereRaw("vc.config_json->'loginDiscovery'->>'status' = 'queued'")
            .orWhere(function expiredRunningLease() {
              this.whereRaw("vc.config_json->'loginDiscovery'->>'status' = 'running'")
                .andWhere(function expiredOrMissingClaim() {
                  this.whereRaw("vc.config_json->'loginDiscovery'->>'claimedUntil' IS NULL")
                    .orWhereRaw("(vc.config_json->'loginDiscovery'->>'claimedUntil')::timestamptz <= now()");
                });
            });
        })
        .orderBy('vc.updated_at', 'asc')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .select(
          'vc.id as connection_id',
          'vc.vendor_id',
          'vc.connection_type',
          'vc.config_json',
          'v.name as vendor_name',
          'v.type as vendor_type',
          'v.website',
          'v.login_url',
          'v.sync_method',
          'v.credential_status as vendor_credential_status',
        );

      const claimed = [];
      for (const row of rows) {
        const config = parseJsonObject(row.config_json, {});
        const claimToken = crypto.randomUUID();
        const loginDiscovery = {
          ...(config.loginDiscovery || {}),
          status: 'running',
          claimedAt: now.toISOString(),
          claimedUntil: claimedUntil.toISOString(),
          claimToken,
          leaseMinutes: CLAIM_LEASE_MINUTES,
        };
        await trx('vendor_connections').where({ id: row.connection_id }).update({
          config_json: JSON.stringify({
            ...config,
            loginDiscovery,
          }),
          updated_at: new Date(),
        });
        claimed.push(mapJob({
          ...row,
          config_json: {
            ...config,
            loginDiscovery,
          },
        }));
      }
      return claimed;
    });

    res.json({ jobs, business_profile: businessProfile() });
  } catch (err) { next(err); }
});

// POST /report — discovered URLs and manual signup requirements
router.post('/report', async (req, res, next) => {
  try {
    const body = req.body || {};
    const outcome = cleanString(body.outcome);
    if (!TERMINAL_OUTCOMES.includes(outcome)) {
      return res.status(400).json({ error: `outcome must be one of: ${TERMINAL_OUTCOMES.join(', ')}` });
    }

    const connectionId = cleanString(body.connection_id || body.connectionId);
    const claimToken = cleanString(body.claim_token || body.claimToken);
    if (!connectionId || !claimToken) {
      return res.status(400).json({ error: 'connection_id and claim_token required' });
    }

    const result = await db.transaction(async (trx) => {
      const connection = await trx('vendor_connections as vc')
        .join('vendors as v', 'v.id', 'vc.vendor_id')
        .whereRaw("vc.config_json->'loginDiscovery'->>'status' = 'running'")
        .whereRaw("vc.config_json->'loginDiscovery'->>'claimToken' = ?", [claimToken])
        .whereRaw("(vc.config_json->'loginDiscovery'->>'claimedUntil')::timestamptz > now()")
        .where('vc.id', connectionId)
        .forUpdate()
        .select(
          'vc.*',
          'v.name as vendor_name',
          'v.website',
          'v.login_url as vendor_login_url',
          'v.credential_status as vendor_credential_status',
          'v.sync_method_notes',
        )
        .first();
      if (!connection) {
        return { status: 409, body: { error: 'running login discovery lease not found or expired' } };
      }

      const loginUrl = normalizeHttpUrl(body.login_url || body.loginUrl, connection.website);
      const registrationUrl = normalizeHttpUrl(body.registration_url || body.registrationUrl || body.signup_url || body.signupUrl, connection.website);
      const pricingPortalUrl = normalizeHttpUrl(body.pricing_portal_url || body.pricingPortalUrl, connection.website);
      const contactUrl = normalizeHttpUrl(body.rep_contact_url || body.contact_url || body.contactUrl, connection.website);
      const repEmail = cleanString(body.rep_email || body.repEmail);
      const repPhone = cleanString(body.rep_phone || body.repPhone);
      const evidenceUrl = normalizeHttpUrl(body.evidence_url || body.evidenceUrl || body.source_url || body.sourceUrl, connection.website);
      const notes = cleanString(body.notes);
      const requirements = cleanStringArray(body.signup_requirements || body.requirements);

      if (['found', 'needs_manual_signup'].includes(outcome) && !loginUrl && !registrationUrl && !pricingPortalUrl && !contactUrl && !repEmail) {
        return { status: 400, body: { error: 'found outcomes require a login, registration, portal, contact URL, or rep email' } };
      }

      const config = parseJsonObject(connection.config_json, {});
      const loginDiscovery = {
        ...(config.loginDiscovery || {}),
        status: outcome === 'failed' ? 'failed' : 'completed',
        outcome,
        reportedAt: new Date().toISOString(),
        loginUrl,
        registrationUrl,
        pricingPortalUrl,
        contactUrl,
        repEmail,
        repPhone,
        evidenceUrl,
        requirements,
        notes,
        confidence: confidence(body.confidence ?? body.source_confidence ?? body.sourceConfidence),
      };

      const discoveryNote = noteFromReport({
        outcome,
        loginUrl,
        registrationUrl,
        contactUrl,
        repEmail,
        repPhone,
        requirements,
        notes,
      });
      const existingNotes = cleanString(connection.sync_method_notes);
      const nextNotes = [existingNotes, discoveryNote].filter(Boolean).join('\n').slice(-4000);
      const nextLoginUrl = loginUrl || pricingPortalUrl || registrationUrl || connection.vendor_login_url || null;
      const protectedVendorStatus = ['configured', 'not_required'].includes(String(connection.vendor_credential_status || ''));
      let nextVendorCredentialStatus = connection.vendor_credential_status || null;
      if (!protectedVendorStatus) {
        if (['found', 'needs_manual_signup'].includes(outcome)) nextVendorCredentialStatus = 'needs_login';
        else if (outcome === 'not_found') nextVendorCredentialStatus = 'needs_rep_setup';
        else if (outcome === 'failed') nextVendorCredentialStatus = 'failed';
      }

      await trx('vendors').where({ id: connection.vendor_id }).update({
        ...(nextLoginUrl ? { login_url: nextLoginUrl } : {}),
        credential_status: nextVendorCredentialStatus,
        sync_method_notes: nextNotes,
        updated_at: new Date(),
      });

      await trx('vendor_connections').where({ id: connection.id }).update({
        credential_status: connection.credential_status === 'configured'
          ? 'configured'
          : (outcome === 'failed' ? 'failed' : 'missing'),
        failure_reason: outcome === 'failed' ? (notes || 'Hermes login discovery failed') : null,
        config_json: JSON.stringify({
          ...config,
          loginDiscovery,
        }),
        updated_at: new Date(),
      });

      return {
        status: 200,
        body: {
          ok: true,
          vendor_id: connection.vendor_id,
          vendor_name: connection.vendor_name,
          connection_id: connection.id,
          outcome,
          login_url: nextLoginUrl,
        },
      };
    });

    res.status(result.status).json(result.body);
  } catch (err) { next(err); }
});

module.exports = router;

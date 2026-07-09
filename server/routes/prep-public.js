/**
 * Public prep guide route — GET /api/public/prep/:token.
 *
 * No auth. Token is the only gate; rate-limit mitigates brute force.
 * Returns interpolated prep guide blocks for the customer-facing
 * PrepGuidePage to render. Email-only blocks (cta, signature, small_note)
 * are filtered out so the page doesn't show a "Open prep guide" CTA
 * linking back to itself.
 */
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { prepTemplateForProjectType } = require('../services/project-email');
const { getProjectType } = require('../services/project-types');
const { loadTemplateByKey } = require('../services/email-template-library');
const { portalUrl } = require('../utils/portal-url');
const { formatDisplayDate } = require('../utils/date-only');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

const TOKEN_RE = /^[a-f0-9]{32}$/i;

const EMAIL_ONLY_BLOCK_TYPES = new Set(['cta', 'signature', 'small_note']);

function interpolate(text, vars) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '');
}

function interpolateBlock(block, vars) {
  if (!block || typeof block !== 'object') return block;
  const result = { ...block };
  if (typeof result.content === 'string') {
    result.content = interpolate(result.content, vars);
  }
  if (Array.isArray(result.rows)) {
    result.rows = result.rows.map((row) => ({
      ...row,
      value: typeof row.value === 'string' ? interpolate(row.value, vars) : row.value,
    }));
  }
  return result;
}

const PRIVACY_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Referrer-Policy': 'no-referrer',
};

router.get('/:token', async (req, res) => {
  res.set(PRIVACY_HEADERS);

  const { token } = req.params;
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'Not found' });

  try {
    const project = await db('projects')
      .where({ prep_token: token })
      .first();
    if (!project) return res.status(404).json({ error: 'Not found' });

    if (project.prep_expires_at && new Date(project.prep_expires_at) < new Date()) {
      return res.status(404).json({ error: 'Not found' });
    }

    const customer = project.customer_id
      ? await db('customers').where({ id: project.customer_id }).first()
      : null;

    const templateKey = project.prep_template_key || prepTemplateForProjectType(project.project_type);
    if (!templateKey) {
      return res.status(404).json({ error: 'Not found' });
    }

    const loaded = await loadTemplateByKey(templateKey);
    if (!loaded?.activeVersion) {
      logger.warn(`[prep-public] No active version for template ${templateKey}`);
      return res.status(404).json({ error: 'Not found' });
    }

    let blocks;
    try {
      blocks = typeof loaded.activeVersion.blocks === 'string'
        ? JSON.parse(loaded.activeVersion.blocks)
        : loaded.activeVersion.blocks;
    } catch {
      blocks = [];
    }
    if (!Array.isArray(blocks)) blocks = [];

    const filteredBlocks = blocks.filter((b) => !EMAIL_ONLY_BLOCK_TYPES.has(b.type));

    const customerFirstName = String(customer?.first_name || '').trim().split(/\s+/)[0] || 'there';
    const typeLabel = getProjectType(project.project_type)?.label || project.project_type || 'Waves service';
    const serviceDate = formatDisplayDate(project.project_date || project.created_at, { fallback: '' });
    const techName = String(project.tech_name || project.technician_name || '').trim() || 'your Waves technician';

    const propertyAddress = customer
      ? [
        customer.address_line1,
        [customer.city, customer.state].filter(Boolean).join(', '),
        customer.zip,
      ].filter(Boolean).join(' ')
      : '';

    const vars = {
      first_name: customerFirstName,
      customer_name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ').trim() || 'Waves customer',
      project_type: typeLabel,
      service_date: serviceDate,
      property_address: propertyAddress,
      technician_name: techName,
      company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
    };

    const renderedBlocks = filteredBlocks.map((b) => interpolateBlock(b, vars));

    const ipHash = req.ip
      ? crypto.createHash('sha256').update(req.ip).digest('hex').slice(0, 16)
      : null;
    void db('prep_guide_views').insert({
      project_id: project.id,
      ip_hash: ipHash,
      user_agent: String(req.get('user-agent') || '').slice(0, 512) || null,
    }).catch((err) => logger.warn(`[prep-public] view log failed: ${err.message}`));
    void db('projects').where({ id: project.id }).update({
      prep_view_count: db.raw('COALESCE(prep_view_count, 0) + 1'),
      prep_first_viewed_at: db.raw('COALESCE(prep_first_viewed_at, now())'),
    }).catch((err) => logger.warn(`[prep-public] view count update failed: ${err.message}`));

    return res.json({
      customerFirstName,
      // Full contact block (owner 2026-07-09): the prep page renders the
      // same name / email / phone / address lines as the report heroes.
      customerName: vars.customer_name,
      customerEmail: String(customer?.email || '').trim() || null,
      customerPhone: String(customer?.phone || '').trim() || null,
      projectTypeLabel: typeLabel,
      serviceDate,
      propertyAddress,
      technicianName: techName,
      supportPhone: WAVES_SUPPORT_PHONE_DISPLAY,
      blocks: renderedBlocks,
    });
  } catch (err) {
    logger.error(`[prep-public] Error for token ${token}: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

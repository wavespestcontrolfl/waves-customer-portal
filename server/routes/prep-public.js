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
const { etDateString } = require('../utils/datetime-et');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { getServiceContactSlots } = require('../services/customer-contact');

// Full names of the configured service-contact slots (tenant, home buyer,
// property manager) — same shape as the tracker's contact block
// (track-public.js).
function serviceContactNamesOf(customer) {
  return [...new Set(
    getServiceContactSlots(customer)
      .filter((slot) => slot.phone || slot.email)
      .map((slot) => slot.name)
      .filter(Boolean),
  )];
}

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

const TOKEN_RE = /^[a-f0-9]{32}$/i;

const EMAIL_ONLY_BLOCK_TYPES = new Set(['cta', 'signature', 'small_note']);

// Upcoming-visits band (owner 2026-07-12): the page shows the customer's
// next 1-2 OPEN visits of the SAME service family as this prep guide —
// nothing else from their schedule. service_type keyword filter per
// project_type, the same family matching prep-guide-sender.js uses.
// Types with no clean scheduled-service family simply render no band.
const VISIT_FAMILY_KEYWORDS = {
  flea: ['flea'],
  cockroach: ['roach'],
  german_roach_knockdown: ['roach'],
  palmetto_roach_knockdown: ['roach'],
  bed_bug: ['bed bug'],
  rodent_exclusion: ['rodent'],
  rodent_sanitation: ['rodent'],
  rodent_inspection: ['rodent'],
  rodent_trapping: ['rodent'],
  rodent_bait_station: ['rodent'],
  wildlife_trapping: ['wildlife', 'trapping'],
  termite_inspection: ['termite'],
  termite_treatment: ['termite'],
  termite_bait_station: ['termite'],
  pre_treatment_termite_certificate: ['termite'],
  wdo_inspection: ['wdo', 'wood destroying'],
  mosquito_event: ['mosquito'],
  one_time_lawn_treatment: ['lawn'],
  palm_injection: ['palm'],
  tree_shrub: ['tree', 'shrub'],
  pest_inspection: ['pest'],
  one_time_pest_treatment: ['pest'],
};

// Same statuses the prep senders treat as "no longer an upcoming visit".
const CLOSED_VISIT_STATUSES = ['cancelled', 'completed', 'rescheduled', 'skipped', 'no_show'];

// Customer-facing arrival window: 2 HOURS from window_start, display-only
// (house rule — window_end drives scheduling and is never shown).
function formatArrivalWindow(windowStart) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(windowStart || ''));
  if (!match) return null;
  const startMinutes = (Number(match[1]) * 60) + Number(match[2]);
  const fmt = (totalMinutes) => {
    const dayMinutes = ((totalMinutes % 1440) + 1440) % 1440;
    const h24 = Math.floor(dayMinutes / 60);
    const minutes = dayMinutes % 60;
    const meridiem = h24 >= 12 ? 'PM' : 'AM';
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    return { text: `${h12}:${String(minutes).padStart(2, '0')}`, meridiem };
  };
  const start = fmt(startMinutes);
  const end = fmt(startMinutes + 120);
  return start.meridiem === end.meridiem
    ? `${start.text}–${end.text} ${end.meridiem}`
    : `${start.text} ${start.meridiem}–${end.text} ${end.meridiem}`;
}

// Next 1-2 open same-family visits — dates + window + service label only,
// no ids and no PII beyond what the page already carries. Never throws: a
// lookup hiccup renders the guide without the band, not a 500.
async function fetchUpcomingFamilyVisits(customerId, projectType) {
  const keywords = VISIT_FAMILY_KEYWORDS[projectType];
  if (!customerId || !keywords || !keywords.length) return [];
  try {
    const rows = await db('scheduled_services')
      .where({ customer_id: customerId })
      .whereNotIn('status', CLOSED_VISIT_STATUSES)
      .where('scheduled_date', '>=', etDateString())
      .where(function familyMatch() {
        keywords.forEach((keyword, i) => {
          if (i === 0) this.whereRaw('LOWER(service_type) LIKE ?', [`%${keyword}%`]);
          else this.orWhereRaw('LOWER(service_type) LIKE ?', [`%${keyword}%`]);
        });
      })
      .orderBy('scheduled_date', 'asc')
      .orderBy('window_start', 'asc')
      .limit(2)
      .select('scheduled_date', 'window_start', 'service_type');
    return rows.map((row) => ({
      dateLabel: formatDisplayDate(row.scheduled_date, { fallback: '' }),
      windowLabel: formatArrivalWindow(row.window_start),
      serviceLabel: String(row.service_type || '').trim() || null,
    })).filter((visit) => visit.dateLabel);
  } catch (err) {
    logger.warn(`[prep-public] upcoming-visits lookup failed: ${err.message}`);
    return [];
  }
}

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
    const upcomingVisits = await fetchUpcomingFamilyVisits(project.customer_id, project.project_type);

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
      // Contact block (owner 2026-07-13): names and address ONLY — never
      // email/phone. Prep guides are emailed to the account's service
      // contacts (tenant / home buyer / property manager) via the same
      // tokenized link, so contact PII stays off the payload entirely;
      // their names render under the account holder's. Matches the tracker
      // (track-public.js).
      customerName: vars.customer_name,
      serviceContactNames: serviceContactNamesOf(customer),
      projectTypeLabel: typeLabel,
      serviceDate,
      propertyAddress,
      technicianName: techName,
      supportPhone: WAVES_SUPPORT_PHONE_DISPLAY,
      upcomingVisits,
      blocks: renderedBlocks,
    });
  } catch (err) {
    logger.error(`[prep-public] Error for token ${token}: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

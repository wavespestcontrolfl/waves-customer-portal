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

// Family key for the upcoming-visits band on scheduled-service tokens:
// the service row carries a template key, not a project_type, so map it
// back to a representative project_type for VISIT_FAMILY_KEYWORDS.
const VISIT_FAMILY_TYPE_BY_TEMPLATE_KEY = {
  'prep.flea': 'flea',
  'prep.cockroach': 'cockroach',
  'prep.bed_bug': 'bed_bug',
  'prep.rodent': 'rodent_trapping',
  'prep.termite': 'termite_treatment',
  'prep.mosquito': 'mosquito_event',
  'prep.lawn': 'one_time_lawn_treatment',
  'prep.interior_pest': 'one_time_pest_treatment',
  'prep.wildlife': 'wildlife_trapping',
};

// Resolve the token owner: projects first (the original prep surface),
// then scheduled_services (booking-triggered and manual pest prep, which
// have no project row — 20260714100000). Returns null when neither owns
// the token or the guide can't render; the route answers a uniform 404
// so unknown/expired/unmapped stay indistinguishable.
async function resolvePrepSource(token) {
  const now = new Date();

  const project = await db('projects').where({ prep_token: token }).first();
  if (project) {
    if (project.prep_expires_at && new Date(project.prep_expires_at) < now) return null;
    const customer = project.customer_id
      ? await db('customers').where({ id: project.customer_id }).first()
      : null;
    const templateKey = project.prep_template_key || prepTemplateForProjectType(project.project_type);
    if (!templateKey) return null;
    return {
      customer,
      templateKey,
      customerId: project.customer_id,
      familyType: project.project_type,
      typeLabel: getProjectType(project.project_type)?.label || project.project_type || 'Waves service',
      serviceDate: formatDisplayDate(project.project_date || project.created_at, { fallback: '' }),
      techName: String(project.tech_name || project.technician_name || '').trim() || 'your Waves technician',
      serviceAddress: null,
      viewRow: { project_id: project.id },
      countView: () => db('projects').where({ id: project.id }).update({
        prep_view_count: db.raw('COALESCE(prep_view_count, 0) + 1'),
        prep_first_viewed_at: db.raw('COALESCE(prep_first_viewed_at, now())'),
      }),
    };
  }

  const service = await db('scheduled_services as s')
    .leftJoin('technicians as t', 's.technician_id', 't.id')
    .where('s.prep_token', token)
    .first(
      's.id', 's.customer_id', 's.service_type', 's.scheduled_date',
      's.prep_template_key', 's.prep_expires_at',
      's.service_address_line1', 's.service_address_city', 's.service_address_state', 's.service_address_zip',
      't.name as tech_name',
    );
  if (!service) return null;
  if (service.prep_expires_at && new Date(service.prep_expires_at) < now) return null;
  if (!service.prep_template_key) return null;
  const customer = service.customer_id
    ? await db('customers').where({ id: service.customer_id }).first()
    : null;
  const serviceAddress = service.service_address_line1
    ? [
      service.service_address_line1,
      [service.service_address_city, service.service_address_state].filter(Boolean).join(', '),
      service.service_address_zip,
    ].filter(Boolean).join(' ')
    : null;
  return {
    customer,
    templateKey: service.prep_template_key,
    customerId: service.customer_id,
    familyType: VISIT_FAMILY_TYPE_BY_TEMPLATE_KEY[service.prep_template_key] || null,
    typeLabel: String(service.service_type || '').trim() || 'Waves service',
    serviceDate: formatDisplayDate(service.scheduled_date, { fallback: '' }),
    techName: String(service.tech_name || '').trim() || 'your Waves technician',
    serviceAddress,
    viewRow: { scheduled_service_id: service.id },
    countView: () => db('scheduled_services').where({ id: service.id }).update({
      prep_view_count: db.raw('COALESCE(prep_view_count, 0) + 1'),
      prep_first_viewed_at: db.raw('COALESCE(prep_first_viewed_at, now())'),
    }),
  };
}

// Load + interpolate the guide blocks for a resolved source. Shared by the
// JSON page payload and the PDF download. Returns null when the template
// has no active version (uniform 404 upstream).
async function renderGuideForSource(source) {
  const { customer, templateKey } = source;

  const loaded = await loadTemplateByKey(templateKey);
  if (!loaded?.activeVersion) {
    logger.warn(`[prep-public] No active version for template ${templateKey}`);
    return null;
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
  const { typeLabel, serviceDate, techName } = source;

  const propertyAddress = source.serviceAddress || (customer
    ? [
      customer.address_line1,
      [customer.city, customer.state].filter(Boolean).join(', '),
      customer.zip,
    ].filter(Boolean).join(' ')
    : '');

  const vars = {
    first_name: customerFirstName,
    customer_name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ').trim() || 'Waves customer',
    project_type: typeLabel,
    service_date: serviceDate,
    property_address: propertyAddress,
    technician_name: techName,
    company_phone: WAVES_SUPPORT_PHONE_DISPLAY,
  };

  return {
    customerFirstName,
    customerName: vars.customer_name,
    typeLabel,
    serviceDate,
    techName,
    propertyAddress,
    renderedBlocks: filteredBlocks.map((b) => interpolateBlock(b, vars)),
  };
}

router.get('/:token', async (req, res) => {
  res.set(PRIVACY_HEADERS);

  const { token } = req.params;
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'Not found' });

  try {
    const source = await resolvePrepSource(token);
    if (!source) return res.status(404).json({ error: 'Not found' });

    const guide = await renderGuideForSource(source);
    if (!guide) return res.status(404).json({ error: 'Not found' });
    const { customer } = source;
    const {
      customerFirstName, typeLabel, serviceDate, techName, propertyAddress, renderedBlocks,
    } = guide;

    const upcomingVisits = await fetchUpcomingFamilyVisits(source.customerId, source.familyType);

    const ipHash = req.ip
      ? crypto.createHash('sha256').update(req.ip).digest('hex').slice(0, 16)
      : null;
    void db('prep_guide_views').insert({
      ...source.viewRow,
      ip_hash: ipHash,
      user_agent: String(req.get('user-agent') || '').slice(0, 512) || null,
    }).catch((err) => logger.warn(`[prep-public] view log failed: ${err.message}`));
    void source.countView()
      .catch((err) => logger.warn(`[prep-public] view count update failed: ${err.message}`));

    return res.json({
      customerFirstName,
      // Contact block (owner 2026-07-13): names and address ONLY — never
      // email/phone. Prep guides are emailed to the account's service
      // contacts (tenant / home buyer / property manager) via the same
      // tokenized link, so contact PII stays off the payload entirely;
      // their names render under the account holder's. Matches the tracker
      // (track-public.js).
      customerName: guide.customerName,
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
    // Token prefix only — a full capability token in the logs is a leak.
    logger.error(`[prep-public] Error for token ${token.slice(0, 8)}…: ${err.message}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Downloadable PDF twin of the page (action-bar Download button — same
// treatment service reports get). Same token gate, uniform 404s, and PII
// posture; view analytics stay on the page route only.
router.get('/:token/pdf', async (req, res) => {
  res.set(PRIVACY_HEADERS);

  const { token } = req.params;
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: 'Not found' });

  try {
    const source = await resolvePrepSource(token);
    if (!source) return res.status(404).json({ error: 'Not found' });

    const guide = await renderGuideForSource(source);
    if (!guide) return res.status(404).json({ error: 'Not found' });

    const { renderPrepGuidePdf } = require('../services/pdf/prep-guide-pdf');
    const title = `${guide.typeLabel} Prep Guide`;
    // Sanitized filename (prevents header injection via customer-derived
    // service labels — same posture as documents.js).
    const safe = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Prep_Guide';
    renderPrepGuidePdf({
      title,
      blocks: guide.renderedBlocks,
      technicianName: guide.techName,
      customerName: guide.customerName,
      propertyAddress: guide.propertyAddress,
      fileName: `Waves_${safe(title)}.pdf`,
    }, res);
    return undefined;
  } catch (err) {
    logger.error(`[prep-public] PDF error for token ${token.slice(0, 8)}…: ${err.message}`);
    if (!res.headersSent) return res.status(500).json({ error: 'Internal server error' });
    return res.end();
  }
});

router._test = { resolvePrepSource };

module.exports = router;

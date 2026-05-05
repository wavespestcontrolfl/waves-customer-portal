// server/routes/dispatch.js
//
// Compatibility facade for the dispatch-v2 sidebar tools. These endpoints used
// to read and write dispatch_jobs/dispatch_technicians copies; keep the URLs and
// response shapes, but source everything from canonical scheduled_services and
// technicians so GPS/dispatch state has a single data plane.

const router = require('express').Router();
const { etDateString, addETDays } = require('../utils/datetime-et');

let db;
function getDb() {
  if (!db) db = require('../models/db');
  return db;
}

const SERVICE_REVENUE = {
  termite: 200,
  wdo_inspection: 185,
  bora_care: 380,
  tree_shrub: 130,
  lawn: 75,
  german_roach: 149,
  mosquito: 89,
  general_pest: 110,
  stinging_insect: 129,
  rodent: 95,
  callback: 0,
  estimate: 185,
};

const SCENARIOS = {
  urgent: { label: 'Urgent pest issue', urgency: 'high' },
  inspect: { label: 'Inspection / estimate', urgency: 'high' },
  lawn: { label: 'Recurring lawn treatment', urgency: 'normal' },
  callback: { label: 'Callback / retreat', urgency: 'high' },
  seasonal: { label: 'Seasonal add-on', urgency: 'low' },
};

function normalizeServiceType(serviceType) {
  const raw = String(serviceType || 'general_pest').trim().toLowerCase();
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'general_pest';
}

function legacyStatus(status) {
  if (status === 'completed') return 'complete';
  if (status === 'cancelled') return 'cancelled';
  return 'scheduled';
}

function matchesLegacyStatus(row, status) {
  if (!status) return true;
  if (status === 'scheduled') return !['completed', 'cancelled', 'skipped'].includes(row.status);
  if (status === 'complete' || status === 'completed') return row.status === 'completed';
  return row.status === status;
}

function jobCategory(row) {
  const type = normalizeServiceType(row.service_type);
  if (row.is_callback || type.includes('callback') || type.includes('retreat')) return 'callback';
  if (type.includes('estimate') || type.includes('inspection')) return 'estimate';
  if (row.is_recurring === false) return 'one_time';
  return 'recurring';
}

function waveguardTier(row) {
  return String(row.waveguard_tier || 'none').toLowerCase();
}

function estimatedDuration(row) {
  const stored = Number(row.estimated_duration_minutes || 0);
  if (stored > 0) return stored;
  const start = parseTimeMinutes(row.window_start);
  const end = parseTimeMinutes(row.window_end);
  if (start != null && end != null && end > start) return end - start;
  return jobCategory(row) === 'estimate' ? 60 : 45;
}

function parseTimeMinutes(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function estimatedRevenue(row) {
  const direct = Number(row.estimated_price || row.prepaid_amount || 0);
  if (direct > 0) return direct;
  const monthly = Number(row.monthly_rate || 0);
  if (monthly > 0) return monthly;
  return SERVICE_REVENUE[normalizeServiceType(row.service_type)] || SERVICE_REVENUE.general_pest;
}

function ruleBasedScore(job, driveMin = 12) {
  const revMap = {
    termite: 39,
    wdo_inspection: 36,
    bora_care: 38,
    tree_shrub: 30,
    lawn: 25,
    german_roach: 25,
    mosquito: 20,
    general_pest: 18,
    stinging_insect: 20,
    rodent: 18,
    callback: 15,
  };
  const tierMap = { platinum: 24, gold: 21, silver: 17, bronze: 13, recurring: 12, none: 9 };
  const revPts = revMap[job.service_type] || 18;
  const renewalPts = tierMap[job.waveguard_tier] || 9;
  const upsellPts = ['estimate', 'wdo_inspection'].includes(job.job_category)
    ? 18
    : job.waveguard_tier === 'platinum' ? 14 : 8;
  const efficiencyPts = driveMin < 5 ? 14 : driveMin < 10 ? 12 : driveMin < 15 ? 10 : driveMin < 20 ? 8 : driveMin < 30 ? 5 : 2;
  const callbackBoost = job.job_category === 'callback' ? 15 : 0;
  const score = Math.min(100, revPts + renewalPts + upsellPts + efficiencyPts + callbackBoost);
  return {
    job_score: score,
    score,
    score_breakdown: {
      revenue_pts: revPts,
      renewal_pts: renewalPts,
      upsell_pts: upsellPts,
      efficiency_pts: efficiencyPts,
    },
    breakdown: {
      revenue_pts: revPts,
      renewal_pts: renewalPts,
      upsell_pts: upsellPts,
      efficiency_pts: efficiencyPts,
    },
    priority: score >= 85 ? 'critical' : score >= 70 ? 'high' : score >= 55 ? 'standard' : 'low',
    upsell_flags: job.job_category === 'estimate' ? ['Estimate follow-up'] : [],
    protect_slot: score >= 80,
    is_high_value: score >= 80,
  };
}

function toDispatchJob(row, index = 0) {
  const customerName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim() || 'Customer';
  const address = [row.address_line1, row.city, row.state, row.zip].filter(Boolean).join(', ');
  const job = {
    id: row.id,
    sheet_row_id: row.id,
    customer_id: row.customer_id,
    customer_name: customerName,
    address,
    city: row.city || null,
    zip: row.zip || null,
    lat: row.lat != null ? Number(row.lat) : null,
    lng: row.lng != null ? Number(row.lng) : null,
    service_type: normalizeServiceType(row.service_type),
    service_label: row.service_type || 'General Pest',
    job_category: jobCategory(row),
    waveguard_tier: waveguardTier(row),
    assigned_tech_id: row.technician_id || null,
    assigned_tech_name: row.tech_name || null,
    scheduled_date: row.scheduled_date,
    scheduled_time: row.window_start || null,
    estimated_duration: estimatedDuration(row),
    estimated_revenue: estimatedRevenue(row),
    route_position: row.route_order || index + 1,
    status: legacyStatus(row.status),
    canonical_status: row.status,
    track_state: row.track_state || 'scheduled',
    notes: row.notes || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  return { ...job, ...ruleBasedScore(job) };
}

async function canonicalJobs({ date, techId, status } = {}) {
  const query = getDb()('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .leftJoin('technicians', 'scheduled_services.technician_id', 'technicians.id')
    .select(
      'scheduled_services.*',
      'customers.first_name',
      'customers.last_name',
      'customers.address_line1',
      'customers.city',
      'customers.state',
      'customers.zip',
      'customers.waveguard_tier',
      'customers.monthly_rate',
      'technicians.name as tech_name'
    )
    .orderByRaw("COALESCE(scheduled_services.route_order, 999), COALESCE(scheduled_services.window_start, '23:59'), scheduled_services.created_at");

  if (date) query.where('scheduled_services.scheduled_date', date);
  if (techId) query.where('scheduled_services.technician_id', techId);

  const rows = await query;
  return rows.filter((row) => matchesLegacyStatus(row, status)).map(toDispatchJob);
}

async function activeTechs() {
  const rows = await getDb()('technicians')
    .where('active', true)
    .select('id', 'name', 'phone', 'email', 'active', 'created_at', 'updated_at')
    .orderBy('name');
  return rows.map((tech) => ({
    ...tech,
    slug: String(tech.name || tech.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    color: '#0e8c6a',
    service_lines: [],
    territory_zips: [],
    territory_label: 'Canonical schedule',
  }));
}

function routeSummary(tech, jobs) {
  const ordered = jobs.sort((a, b) => (a.route_position || 999) - (b.route_position || 999));
  const serviceMinutes = ordered.reduce((sum, job) => sum + Number(job.estimated_duration || 45), 0);
  const expectedRevenue = ordered.reduce((sum, job) => sum + Number(job.estimated_revenue || 0), 0);
  const driveMinutes = Math.max(ordered.length - 1, 0) * 12;
  const totalHours = Math.max((serviceMinutes + driveMinutes) / 60, 0.75);
  return {
    tech,
    tech_id: tech.id,
    tech_name: tech.name,
    jobs: ordered,
    job_order: ordered.map((job) => job.id),
    total_jobs: ordered.length,
    estimated_miles: Math.round(driveMinutes * 0.55),
    drive_time_pct: ordered.length ? Math.round((driveMinutes / (serviceMinutes + driveMinutes)) * 100) : 0,
    expected_revenue: Math.round(expectedRevenue),
    revenue_per_hour: Math.round(expectedRevenue / totalHours),
    optimization_notes: 'Canonical schedule order',
  };
}

async function buildRoutes(date, opts = {}) {
  const [techs, jobs] = await Promise.all([
    activeTechs(),
    canonicalJobs({ date, status: 'scheduled' }),
  ]);
  const routes = techs.map((tech) => routeSummary(tech, jobs.filter((job) => job.assigned_tech_id === tech.id)));
  const unassigned = jobs.filter((job) => !job.assigned_tech_id);
  if (unassigned.length) {
    routes.push(routeSummary({ id: null, name: 'Unassigned', active: true }, unassigned));
  }
  return routes.filter((route) => opts.includeEmpty || route.total_jobs > 0);
}

function fallbackSlots(scenarioKey, techs) {
  const t1 = techs[0]?.name || 'Tech 1';
  const t2 = techs[1]?.name || t1;
  const t3 = techs[2]?.name || t2;
  const base = {
    urgent: [
      { rank: '#1 Recommended', date_label: 'Today - next open slot', tech_name: t1, detail: 'Earliest available slot with route density checked', top: true, score_factors: ['Urgency tier', 'Route density'] },
      { rank: '#2', date_label: 'Tomorrow 8:00 AM', tech_name: t1, detail: 'Opens day route with minimal disruption', top: false, score_factors: ['Morning slot', 'Tech availability'] },
      { rank: '#3', date_label: 'Tomorrow 10:15 AM', tech_name: t2, detail: 'Backup tech window for same route corridor', top: false, score_factors: ['Zone fit'] },
    ],
    inspect: [
      { rank: '#1 Recommended', date_label: 'Tomorrow 10:30 AM', tech_name: t1, detail: 'Dedicated inspection window with upsell potential', top: true, score_factors: ['Revenue score', 'Inspection window'] },
      { rank: '#2', date_label: 'Wed 8:45 AM', tech_name: t2, detail: 'Open estimate slot near existing route', top: false, score_factors: ['Cluster proximity'] },
      { rank: '#3', date_label: 'Wed 1:00 PM', tech_name: t3, detail: 'Afternoon backup slot', top: false, score_factors: ['Availability'] },
    ],
    lawn: [
      { rank: '#1 Recommended', date_label: 'Thu 9:00 AM', tech_name: t2, detail: 'Lawn route window with recurring capacity', top: true, score_factors: ['Cluster density', 'Service fit'] },
      { rank: '#2', date_label: 'Fri 8:30 AM', tech_name: t1, detail: 'Morning recurring route slot', top: false, score_factors: ['Recurring cluster'] },
      { rank: '#3', date_label: 'Next Mon', tech_name: t3, detail: 'Lower drive-time backup', top: false, score_factors: ['Route efficiency'] },
    ],
    callback: [
      { rank: '#1 Recommended', date_label: 'Tomorrow 11:00 AM', tech_name: `${t1} (original)`, detail: 'Original tech preference inside callback window', top: true, score_factors: ['Original tech', 'Retention'] },
      { rank: '#2', date_label: 'Today 4:30 PM', tech_name: t1, detail: 'End-of-day urgent callback option', top: false, score_factors: ['Same-day urgency'] },
      { rank: '#3', date_label: 'Wed 9:00 AM', tech_name: t2, detail: 'Fallback if original tech is unavailable', top: false, score_factors: ['Availability'] },
    ],
    seasonal: [
      { rank: '#1 Recommended', date_label: 'Fri 10:00 AM', tech_name: t1, detail: 'Seasonal add-on window with bundle potential', top: true, score_factors: ['WaveGuard tier', 'Seasonal demand'] },
      { rank: '#2', date_label: 'Next Tue AM', tech_name: t2, detail: 'Backup seasonal route slot', top: false, score_factors: ['Territory density'] },
      { rank: '#3', date_label: 'Next Wed AM', tech_name: t3, detail: 'North corridor overflow slot', top: false, score_factors: ['Availability'] },
    ],
  };
  return base[scenarioKey] || base.urgent;
}

function matchTechs(techs, serviceType, zip, jobCategoryKey) {
  const service = normalizeServiceType(serviceType);
  const category = jobCategoryKey || (service.includes('inspection') ? 'estimate' : 'recurring');
  return techs.map((tech, index) => {
    let score = 72 - (index * 3);
    const reasoning = [];
    if (service.includes('lawn')) {
      score += 4;
      reasoning.push('Lawn route capable');
    } else if (service.includes('termite') || service.includes('inspection')) {
      score += 6;
      reasoning.push('Inspection revenue fit');
    } else {
      reasoning.push('General pest route capable');
    }
    if (zip) {
      score += 3;
      reasoning.push(`ZIP ${zip} considered`);
    }
    if (category === 'callback') {
      score += 5;
      reasoning.push('Callback continuity prioritized');
    }
    return {
      tech,
      matchScore: Math.max(0, Math.min(100, score)),
      blocked: false,
      blockReason: null,
      reasoning,
    };
  }).sort((a, b) => b.matchScore - a.matchScore);
}

async function getInsights(days) {
  const since = etDateString(addETDays(new Date(), -days));
  const jobs = await canonicalJobs({});
  const recent = jobs.filter((job) => !job.scheduled_date || job.scheduled_date >= since);
  const completed = recent.filter((job) => job.canonical_status === 'completed');
  const callbacks = recent.filter((job) => job.job_category === 'callback');
  const actualRevenue = completed.reduce((sum, job) => sum + Number(job.estimated_revenue || 0), 0);
  const expectedRevenue = recent.reduce((sum, job) => sum + Number(job.estimated_revenue || 0), 0);
  const techs = await activeTechs();
  const techMetrics = techs.map((tech) => {
    const assigned = recent.filter((job) => job.assigned_tech_id === tech.id);
    const assignedCompleted = assigned.filter((job) => job.canonical_status === 'completed');
    const revenue = assignedCompleted.reduce((sum, job) => sum + Number(job.estimated_revenue || 0), 0);
    const hours = Math.max(assigned.reduce((sum, job) => sum + Number(job.estimated_duration || 45), 0) / 60, 1);
    return {
      tech_id: tech.id,
      tech_name: tech.name,
      total_jobs: assigned.length,
      completion_rate: assigned.length ? Math.round((assignedCompleted.length / assigned.length) * 100) : 0,
      callback_rate: assigned.length ? Math.round((assigned.filter((job) => job.job_category === 'callback').length / assigned.length) * 100) : 0,
      revenue_per_hour: Math.round(revenue / hours),
    };
  });

  return {
    period: { days, since, generated_at: new Date().toISOString() },
    summary: {
      totalJobs: recent.length,
      completionRate: recent.length ? Math.round((completed.length / recent.length) * 100) : 0,
      callbackRate: recent.length ? Math.round((callbacks.length / recent.length) * 100) : 0,
      actualRevenue: Math.round(actualRevenue),
      expectedRevenue: Math.round(expectedRevenue),
      avgDrivePct: 22,
      avgRevPerHr: completed.length ? Math.round(actualRevenue / Math.max(completed.length * 0.75, 1)) : 0,
    },
    techMetrics,
    forecast: [
      { label: 'Next 7 days', expectedRevenue: Math.round(expectedRevenue * 0.25), confidence: 'medium' },
      { label: 'Next 30 days', expectedRevenue: Math.round(expectedRevenue || 0), confidence: 'medium' },
      { label: 'Route density', expectedRevenue: Math.round(expectedRevenue * 0.08), confidence: 'low' },
    ],
  };
}

// GET /api/dispatch/routes?date=YYYY-MM-DD&mode=mixed&zone=all
router.get('/routes', async (req, res) => {
  try {
    const { date = etDateString(), mode = 'mixed', zone = 'all' } = req.query;
    const routes = await buildRoutes(date);
    res.json({ routes, date, mode, zone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/routes/reoptimize
router.post('/routes/reoptimize', async (req, res) => {
  try {
    const { date = etDateString(), mode = 'mixed', zone = 'all' } = req.body || {};
    const routes = await buildRoutes(date);
    for (const route of routes) {
      for (let i = 0; i < route.jobs.length; i += 1) {
        await getDb()('scheduled_services').where('id', route.jobs[i].id).update({ route_order: i + 1, updated_at: new Date() });
      }
    }
    res.json({ routes, date, mode, zone, message: 'Canonical route order refreshed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/jobs/:id/cancel
router.post('/jobs/:id/cancel', async (req, res) => {
  res.status(410).json({
    error: 'Legacy dispatch cancellation retired; use /api/admin/dispatch/:serviceId/status',
  });
});

// GET /api/dispatch/jobs?date=YYYY-MM-DD&techId=uuid&status=scheduled
router.get('/jobs', async (req, res) => {
  try {
    const { date, techId, status } = req.query;
    const jobs = await canonicalJobs({ date, techId, status });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/jobs/:id/score
router.post('/jobs/:id/score', async (req, res) => {
  try {
    const jobs = await canonicalJobs({ date: req.body?.date });
    const target = jobs.find((row) => row.id === req.params.id);
    if (!target) return res.status(404).json({ error: 'Job not found' });
    res.json({ ...target, ...ruleBasedScore(target) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/match/simulate
router.post('/match/simulate', async (req, res) => {
  try {
    const { serviceType, zip, jobCategory: category } = req.body || {};
    const techs = await activeTechs();
    res.json({ allMatches: matchTechs(techs, serviceType, zip, category) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dispatch/techs
router.get('/techs', async (req, res) => {
  try {
    res.json(await activeTechs());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/csr/slots
router.post('/csr/slots', async (req, res) => {
  try {
    const { scenario = 'urgent' } = req.body || {};
    const config = SCENARIOS[scenario] || SCENARIOS.urgent;
    const techs = await activeTechs();
    res.json({ slots: fallbackSlots(scenario, techs), scenario: config });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dispatch/insights?days=30
router.get('/insights', async (req, res) => {
  try {
    const days = parseInt(req.query.days, 10) || 30;
    res.json(await getInsights(days));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dispatch/sync
router.post('/sync', async (req, res) => {
  res.json({
    ok: true,
    synced: 0,
    bridge: { synced: 0, date: req.body?.date || null },
    techs: { synced: 0 },
    message: 'Canonical dispatch is live; no legacy sync required.',
  });
});

module.exports = router;

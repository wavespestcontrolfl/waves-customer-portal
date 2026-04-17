// server/services/dispatch/route-optimizer.js
const Anthropic = require('@anthropic-ai/sdk');
const { scoreJob, driveMins } = require('./job-scorer');
const WikiQA = require('../knowledge/wiki-qa');
const MODELS = require('../../config/models');

let db;
function getDb() {
  if (!db) db = require('../../models/db');
  return db;
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function calcMetrics(jobs) {
  const totalJobs = jobs.length;
  let totalMiles = 0;
  for (let i = 1; i < jobs.length; i++) {
    const mins = driveMins(jobs[i - 1].lat, jobs[i - 1].lng, jobs[i].lat, jobs[i].lng);
    totalMiles += mins / 2.5;
  }
  const driveMinsTotal = totalMiles * 2.5;
  const workMins = totalJobs * 40;
  const shiftMins = driveMinsTotal + workMins;
  const expectedRevenue = jobs.reduce((s, j) => s + (parseFloat(j.estimated_revenue) || 85), 0);
  const shiftHours = shiftMins / 60;
  return {
    totalJobs,
    estimatedMiles: Math.round(totalMiles),
    driveTimePct: shiftMins > 0 ? Math.round((driveMinsTotal / shiftMins) * 100) : 0,
    expectedRevenue: Math.round(expectedRevenue),
    revenuePerHour: shiftHours > 0 ? Math.round(expectedRevenue / shiftHours) : 0,
  };
}

function tspLite(jobs) {
  if (!jobs.length) return [];
  const estimates = jobs.filter((j) => ['estimate', 'wdo_inspection'].includes(j.job_category) || (j.score || 0) >= 85);
  const high = jobs.filter((j) => (j.score || 0) >= 70 && !estimates.includes(j)).sort((a, b) => b.score - a.score);
  const standard = jobs.filter((j) => (j.score || 0) < 70).sort((a, b) => b.score - a.score);
  // Place estimates in mid-morning slot (position 3-4)
  const ordered = [...high.slice(0, 2), ...estimates, ...high.slice(2), ...standard];
  return ordered.slice(0, 10);
}

async function optimizeTechRoute(tech, date, mode, zone) {
  const rules = await WikiQA.lookup('routing rules');

  let q = getDb()('dispatch_jobs').where('scheduled_date', date).where('assigned_tech_id', tech.id).where('status', 'scheduled');
  if (mode === 'recurring') q.where('job_category', 'recurring');
  if (mode === 'one_time') q.where('job_category', 'one_time');
  const jobs = await q;

  if (!jobs.length) return { tech, jobs: [], metrics: { totalJobs: 0, estimatedMiles: 0, driveTimePct: 0, expectedRevenue: 0, revenuePerHour: 0 }, notes: '' };

  // Score each job
  let prev = null;
  const scored = [];
  for (const job of jobs) {
    const s = await scoreJob(job, prev?.lat, prev?.lng);
    scored.push(s);
    prev = s;
  }

  const ordered = tspLite(scored);
  const metrics = calcMetrics(ordered);

  // AI optimization note
  let notes = '';
  try {
    const res = await client.messages.create({
      model: MODELS.FLAGSHIP,
      max_tokens: 120,
      messages: [{
        role: 'user',
        content: `One-sentence dispatch note for this route:\nTech: ${tech.name}\nJobs: ${ordered.map((j) => `${j.customer_name} (${j.service_type}, score ${j.score})`).join(', ')}\nDrive time: ${metrics.driveTimePct}%\nReturn plain text only.`,
      }],
    });
    notes = res.content[0].text.trim();
  } catch {
    notes = metrics.driveTimePct > 25 ? `Drive time at ${metrics.driveTimePct}% — consider tightening cluster.` : `Route efficient at ${metrics.driveTimePct}% drive time.`;
  }

  // Save session
  await getDb()('dispatch_route_sessions').insert({
    date, tech_id: tech.id, mode, zone,
    job_order: ordered.map((j) => j.id),
    total_jobs: metrics.totalJobs,
    estimated_miles: metrics.estimatedMiles,
    drive_time_pct: metrics.driveTimePct,
    expected_revenue: metrics.expectedRevenue,
    revenue_per_hour: metrics.revenuePerHour,
    optimized_by: 'ai',
    optimization_notes: notes,
  }).catch(err => logger.error(`[dispatch:route-optimizer] Failed to save route session: ${err.message}`));

  // Update route positions
  for (let i = 0; i < ordered.length; i++) {
    await getDb()('dispatch_jobs').where('id', ordered[i].id).update({ route_position: i + 1 }).catch(err => logger.error(`[dispatch:route-optimizer] Failed to update route position for job ${ordered[i].id}: ${err.message}`));
  }

  return { tech, jobs: ordered, metrics, notes };
}

async function optimizeDay(date, options = {}) {
  const { mode = 'mixed', zone = 'all' } = options;
  const techs = await getDb()('dispatch_technicians').where('active', true);
  return Promise.all(techs.map((t) => optimizeTechRoute(t, date, mode, zone)));
}

async function absorbCancellation(jobId) {
  const job = await getDb()('dispatch_jobs').where('id', jobId).first();
  if (!job) throw new Error('Job not found');

  await getDb()('dispatch_jobs').where('id', jobId).update({ status: 'cancelled' });

  // Find nearby unscheduled job
  const fill = await getDb()('dispatch_jobs')
    .where('status', 'scheduled')
    .whereNull('assigned_tech_id')
    .where('scheduled_date', job.scheduled_date)
    .first();

  let message = 'Cancellation absorbed — route reflowed.';
  if (fill) {
    await getDb()('dispatch_jobs').where('id', fill.id).update({ assigned_tech_id: job.assigned_tech_id, scheduled_date: job.scheduled_date });
    message = `Cancellation absorbed — ${fill.customer_name} (${fill.service_type}) inserted from queue.`;
  }
  return { message, insertedJob: fill || null };
}

module.exports = { optimizeDay, optimizeTechRoute, absorbCancellation };

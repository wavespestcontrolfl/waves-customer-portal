// server/services/dispatch/tech-matcher.js
const WikiQA = require('../knowledge/wiki-qa');

let db;
function getDb() {
  if (!db) db = require('../../models/db');
  return db;
}

const LICENSE_MAP = {
  termite: 'termite',
  bora_care: 'termite',
  termidor: 'termite',
  wdo_inspection: 'wdo',
  lawn: 'lawn',
  tree_shrub: 'lawn',
};

function scoreTech(tech, job) {
  const licenses = tech.licenses || [];
  const serviceLines = tech.service_lines || [];
  const territory = tech.territory_zips || [];

  const required = LICENSE_MAP[job.service_type];
  if (required && !licenses.includes(required)) {
    return { tech, matchScore: -1, blocked: true, blockReason: `Needs ${required} license`, reasoning: `${tech.name} lacks required ${required} license` };
  }
  if (!serviceLines.includes(job.service_type) && !serviceLines.includes('all')) {
    return { tech, matchScore: -1, blocked: true, blockReason: `Service line not in scope`, reasoning: `${tech.name} does not perform ${job.service_type}` };
  }

  let score = 40;
  const reasons = [];

  if (job.zip && territory.includes(job.zip)) { score += 20; reasons.push('territory match'); }
  if (job.job_category === 'callback' && job.original_tech_id === tech.id) { score += 25; reasons.push('original tech'); }
  if (['estimate', 'wdo_inspection'].includes(job.job_category)) { score += Math.round((tech.upsell_rate || 0) * 15); reasons.push(`upsell ${Math.round((tech.upsell_rate || 0) * 100)}%`); }
  score += Math.round((tech.completion_rate || 0) * 10);
  reasons.push(`completion ${Math.round((tech.completion_rate || 0) * 100)}%`);

  return { tech, matchScore: score, blocked: false, reasoning: reasons.join(' · ') };
}

async function matchJob(job) {
  const techs = await getDb()('dispatch_technicians').where('active', true);
  const scores = techs.map((t) => scoreTech(t, job)).sort((a, b) => b.matchScore - a.matchScore);
  return { bestMatch: scores[0], allMatches: scores };
}

async function simulate(serviceType, zip, jobCategory = 'recurring') {
  return matchJob({ service_type: serviceType, zip, job_category: jobCategory, original_tech_id: null });
}

module.exports = { matchJob, simulate };

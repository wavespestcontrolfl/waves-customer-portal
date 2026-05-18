const db = require('../../models/db');
const { minutesFromElapsed } = require('../../utils/duration-minutes');

function computeOnSiteMin(record = {}) {
  const explicit = minutesFromElapsed(record.timeOnSite);
  if (explicit > 0) return explicit;
  if (!record.started_at || !record.ended_at) return null;
  const started = new Date(record.started_at).getTime();
  const ended = new Date(record.ended_at).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return null;
  const minutes = Math.round((ended - started) / 60000);
  return minutes >= 0 ? minutes : null;
}

async function computeLinearFt(serviceRecordId, knex = db) {
  const row = await knex('service_products')
    .where({ service_record_id: serviceRecordId, area_unit: 'linear_ft' })
    .sum('area_value as sum')
    .first();
  const total = Number(row?.sum || 0);
  return total > 0 ? Math.round(total) : null;
}

module.exports = {
  computeLinearFt,
  computeOnSiteMin,
};

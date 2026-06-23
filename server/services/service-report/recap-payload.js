// Builds the render payload for a visit recap = { customerName, serviceDate,
// pestReportV2, media }. Reuses the existing report data path + the pure
// buildPestReportV2 aggregator, so the recap is driven by the SAME script the
// customer report uses (no duplicated report logic). media is [] in Phase 1
// (data-only fallback tier); Phase 2 fills it with the tech's tagged clips.
const db = require('../../models/db');
const { buildReportV1Data } = require('./report-data');
const { buildServiceReportDynamicContext } = require('./dynamic-context');
const { buildPestReportV2 } = require('./pest-report-v2');
const { loadServiceRecordForPdf, ensureReportToken } = require('./pdf-queue');
const { getMediaForRecap } = require('./recap-media');

function formatServiceDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

// Phase 1 = pest service line only (the premium-experience intelligence the recap
// leans on is pest-shaped). Broadens later (mosquito/typed) when those payloads exist.
function isPestRecapEligible(service) {
  return String(service?.service_line || '').toLowerCase() === 'pest';
}

async function buildRecapPayload(serviceRecordId, { knex = db } = {}) {
  const service = await loadServiceRecordForPdf(serviceRecordId, knex);
  if (!service) throw new Error('Service record not found');
  if (!isPestRecapEligible(service)) return null;

  const token = await ensureReportToken(serviceRecordId, knex);
  const data = await buildReportV1Data(service, token, knex);
  const dynamicContext = await buildServiceReportDynamicContext({ recordId: serviceRecordId, mode: 'static', knex });
  if (!dynamicContext?.premiumExperience) return null;

  // Seasonal forecast, best-effort (never blocks the render).
  let forecast = null;
  try {
    const { getForecast } = require('../pest-forecast/forecast');
    forecast = await Promise.race([
      getForecast({ zip: service.zip }),
      new Promise((resolve) => { const t = setTimeout(() => resolve(null), 4000); if (t.unref) t.unref(); }),
    ]);
  } catch { forecast = null; }

  const pestReportV2 = buildPestReportV2({
    premiumExperience: dynamicContext.premiumExperience,
    pestPressure: data.pestPressure,
    activity: data.activity,
    forecast,
  });
  if (!pestReportV2) return null;

  const firstName = String(data.customerName || service.first_name || 'there').trim().split(/\s+/)[0] || 'there';
  // Tech-captured clips (presigned GET srcs) fill the composition's media slots;
  // empty = the data-only fallback tier. Best-effort — never blocks the render.
  const media = await getMediaForRecap(serviceRecordId, knex).catch(() => []);
  return {
    customerName: firstName,
    serviceDate: formatServiceDate(service.service_date),
    pestReportV2,
    media,
  };
}

module.exports = { buildRecapPayload, isPestRecapEligible, formatServiceDate };

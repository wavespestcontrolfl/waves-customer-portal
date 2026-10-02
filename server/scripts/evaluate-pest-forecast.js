#!/usr/bin/env node
/** No writes, sends, live model calls, or automatic claim promotion.
 * --input <json> reads a fixture/export { records: [], forecasts: [] }.
 * --from YYYY-MM-DD --to YYYY-MM-DD reads an explicitly selected database
 * via PEST_FORECAST_EVAL_DATABASE_URL in a READ ONLY transaction.
 */
// Some shared location helpers load the application logger/config. Suppress
// legacy .env loading before importing them; this CLI selects its DB explicitly.
process.env.WAVES_LOCAL_DEV = '1';
const fs = require('node:fs');
const { evaluateForecasts, loadEvaluationData } = require('../services/pest-forecast/validation');
const { validCalendarDate, etDateString } = require('../utils/datetime-et');

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--input', '--from', '--to'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Usage: --input <json> OR --from YYYY-MM-DD --to YYYY-MM-DD');
    options[args[i]] = args[i + 1];
  }
  let data;
  if (options['--input'] && !options['--from'] && !options['--to']) {
    data = JSON.parse(fs.readFileSync(options['--input'], 'utf8'));
  } else {
    const from = validCalendarDate(options['--from']);
    const to = validCalendarDate(options['--to']);
    if (options['--input'] || !from || !to || from > to || to > etDateString()
      || (new Date(to) - new Date(from)) / 86400000 > 90) throw new Error('Use a valid, past date range of at most 90 days.');
    if (!process.env.PEST_FORECAST_EVAL_DATABASE_URL) throw new Error('Set PEST_FORECAST_EVAL_DATABASE_URL explicitly; no default database is used.');
    const knex = require('knex')({ client: 'pg', connection: process.env.PEST_FORECAST_EVAL_DATABASE_URL, pool: { min: 0, max: 1 } });
    try { data = await loadEvaluationData(knex, { from, to }); }
    finally { await knex.destroy(); }
  }
  if (!Array.isArray(data.records) || !Array.isArray(data.forecasts)) throw new Error('Input must contain records and forecasts arrays.');
  process.stdout.write(`${JSON.stringify(evaluateForecasts(data), null, 2)}\n`);
}

if (require.main === module) main().catch(() => {
  // Query errors can carry operational data or connection details. Keep the
  // CLI failure generic; aggregate results are the only shareable output.
  console.error('Pest forecast evaluation failed. Check arguments, input shape, and the explicitly selected database.');
  process.exitCode = 1;
});
module.exports = { main };

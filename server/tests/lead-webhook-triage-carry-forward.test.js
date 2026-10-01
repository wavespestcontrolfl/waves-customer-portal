/**
 * The AI triage replaces a fresh form lead's extracted_data
 * (routes/lead-webhook.js TRIAGE_REPLACE_EXTRACTED_SQL). Runs that exact SQL
 * over literal rows: the intake keys it carries forward survive, the
 * submission's page URLs survive (the lead funnel's landing-page view reads
 * them), and nothing else from intake attribution comes along.
 * Needs DATABASE_URL (CI); skipped locally without one.
 */
const { _test: { TRIAGE_REPLACE_EXTRACTED_SQL } } = require('../routes/lead-webhook');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
describeDb('AI triage extracted_data replace', () => {
  const knexLib = require('knex');
  let knex;
  beforeAll(() => { knex = knexLib({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } }); });
  afterAll(async () => { if (knex) await knex.destroy(); });

  const replace = async (intake, triage) => {
    const { rows } = await knex.raw(
      `SELECT ${TRIAGE_REPLACE_EXTRACTED_SQL} AS out FROM (SELECT CAST(? AS jsonb) AS extracted_data) t`,
      // placeholders in text order: the triage snapshot (select list), then the intake row
      [JSON.stringify(triage), intake == null ? null : JSON.stringify(intake)],
    );
    return rows[0].out;
  };

  test('keeps the page URLs and the carried keys; drops UTMs, click ids and lead source', async () => {
    const out = await replace({
      stage: 'lead_webhook_received',
      sign_host: '4512 Greenbrook Dr',
      attribution: {
        pageUrl: 'https://www.wavespestcontrol.com/pest-control/ants/',
        landingUrl: 'https://www.wavespestcontrol.com/?utm_source=google',
        leadSource: { source: 'google_ads' },
        utm: { source: 'google' },
        clickIds: { gclid: 'abc' },
      },
    }, { summary: 'Ants in the kitchen' });
    expect(out).toEqual({
      stage: 'lead_webhook_received',
      sign_host: '4512 Greenbrook Dr',
      attribution: {
        pageUrl: 'https://www.wavespestcontrol.com/pest-control/ants/',
        landingUrl: 'https://www.wavespestcontrol.com/?utm_source=google',
      },
      summary: 'Ants in the kitchen',
    });
  });

  test('an intake with no page URLs adds no attribution key at all', async () => {
    expect(await replace({ stage: 'lead_webhook_received', attribution: { utm: { source: 'x' } } }, { summary: 's' }))
      .toEqual({ stage: 'lead_webhook_received', summary: 's' });
    expect(await replace(null, { summary: 's' })).toEqual({ summary: 's' });
  });
});

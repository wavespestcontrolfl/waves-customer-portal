/**
 * The lead funnel's other views group by SQL keys (services/lead-funnel.js
 * FUNNEL_BREAKDOWN_SQL, over the route's asa / l / c aliases). Runs each key
 * over literal rows. Needs DATABASE_URL (CI); skipped locally without one.
 */
const { FUNNEL_BREAKDOWN_SQL: B } = require('../services/lead-funnel');

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;
describeDb('lead funnel breakdown keys', () => {
  const knexLib = require('knex');
  let knex;
  beforeAll(() => { knex = knexLib({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } }); });
  afterAll(async () => { if (knex) await knex.destroy(); });

  const keysFor = async ({ extracted = null, leadCity = null, heard = null, landing = null, customerCity = null, service = null, channel = 'form' }) => {
    const { rows } = await knex.raw(
      `SELECT ${B.page} AS page, ${B.service} AS service, ${B.city} AS city, ${B.heard} AS heard
         FROM (SELECT CAST(? AS jsonb) AS extracted_data, CAST(? AS text) AS city, CAST(? AS text) AS heard_about, CAST(? AS text) AS first_contact_channel) l,
              (SELECT CAST(? AS text) AS landing_page_url, CAST(? AS text) AS city) c,
              (SELECT CAST(? AS text) AS service_line) asa`,
      [extracted == null ? null : JSON.stringify(extracted), leadCity, heard, channel, landing, customerCity, service],
    );
    return rows[0];
  };

  test('landing page: host + path of the lead\'s own page, without scheme, www, query, fragment or trailing slash', async () => {
    expect((await keysFor({ extracted: { attribution: {
      landingUrl: 'https://www.WavesPestControl.com/pest-control/ants/?utm_source=chatgpt.com#top',
      pageUrl: 'https://example.com/other',
    } } })).page).toBe('wavespestcontrol.com/pest-control/ants');
    // a spoke stays distinct from the hub
    expect((await keysFor({ extracted: { attribution: { pageUrl: 'https://bradentonflpestcontrol.com/' } } })).page)
      .toBe('bradentonflpestcontrol.com');
  });

  test('landing page falls back to the customer\'s first page, then stays unknown', async () => {
    expect((await keysFor({ extracted: { attribution: { landingUrl: '' } }, landing: 'https://www.wavespestcontrol.com/quote/?gclid=abc' })).page)
      .toBe('wavespestcontrol.com/quote');
    expect((await keysFor({ extracted: 'not an object', landing: 'wavespestcontrol.com' })).page).toBe('wavespestcontrol.com');
    // quote wizard (top-level) and lawn assessment (nested) store snake_case,
    // and both win over the customer's first page
    expect((await keysFor({ extracted: { landing_url: 'https://wavespestcontrol.com/quote/?x=1' }, landing: 'https://wavespestcontrol.com/old' })).page)
      .toBe('wavespestcontrol.com/quote');
    expect((await keysFor({ extracted: { attribution: { landing_url: 'https://www.wavespestcontrol.com/lawn-assessment/' } } })).page)
      .toBe('wavespestcontrol.com/lawn-assessment');
    // a call (or a row with no lead) never inherits the customer's earlier page
    expect((await keysFor({ channel: 'call', landing: 'https://wavespestcontrol.com/pest-control/ants' })).page).toBe('(unknown)');
    expect((await keysFor({ channel: null, landing: 'https://wavespestcontrol.com/pest-control/ants' })).page).toBe('(unknown)');
    expect(await keysFor({})).toEqual({ page: '(unknown)', service: '(unknown)', city: '(unknown)', heard: '(unknown)' });
  });

  test('city, service and heard-about keys', async () => {
    expect(await keysFor({ leadCity: ' sarasota ', heard: 'chatgpt', service: 'pest' }))
      .toMatchObject({ city: 'Sarasota', heard: 'chatgpt', service: 'pest' });
    expect(await keysFor({ leadCity: '', customerCity: 'LAKEWOOD RANCH', heard: '', service: '' }))
      .toMatchObject({ city: 'Lakewood Ranch', heard: '(unknown)', service: '(unknown)' });
  });
});

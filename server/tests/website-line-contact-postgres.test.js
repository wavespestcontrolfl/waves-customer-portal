/**
 * websiteLineRefusal on real Postgres (services/website-line-contact.js). The
 * helper's two reads run as built against sms_log and call_log TEMP tables
 * that copy the production column types, the sms_log direction CHECK and the
 * last-10 expression index of migration 20260927000006. Each test runs in one
 * transaction that is rolled back. The TEMP tables shadow the migrated ones,
 * so nothing real is read or written.
 */
const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => jest.fn(() => { throw new Error('the helper must read the test transaction'); }));

const { websiteLineRefusal, WEBSITE_LINE_REFUSAL } = require('../services/website-line-contact');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const { websiteOnlyLines } = require('../config/shared-phone-lines');

const WEB_LINE = '+19412542617';
const OTHER_WEB_LINE = websiteOnlyLines(TWILIO_NUMBERS).find((line) => line.number !== WEB_LINE).number;
const PERSON = '+19415550123';

(SKIP ? describe.skip : describe)('website-only line contact check (real PG)', () => {
  let knex;
  let trx;

  beforeAll(() => {
    const { hostname } = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) throw new Error('DATABASE_URL must point to loopback PostgreSQL');
    knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
  });

  beforeEach(async () => {
    trx = await knex.transaction();
    await trx.raw(`
      CREATE TEMP TABLE sms_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        direction text NOT NULL CHECK (direction = ANY (ARRAY['outbound'::text, 'inbound'::text])),
        from_phone varchar(20) NOT NULL,
        to_phone varchar(20) NOT NULL
      );
      CREATE TEMP TABLE call_log (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        direction varchar(255),
        from_phone varchar(20),
        to_phone varchar(20),
        source varchar(255)
      );
      CREATE INDEX ON sms_log ((right(regexp_replace(from_phone, '\\D', '', 'g'), 10)));
      CREATE INDEX ON call_log ((right(regexp_replace(from_phone, '\\D', '', 'g'), 10)));
    `);
  });

  afterEach(async () => { await trx.rollback(); });
  afterAll(async () => { await knex.destroy(); });

  const refusal = (from = WEB_LINE, to = PERSON) => websiteLineRefusal(from, to, { database: trx });

  test('no contact is refused; an inbound text, or an inbound call stored without +1, lets the reply go', async () => {
    expect(await refusal()).toBe(WEBSITE_LINE_REFUSAL);
    await trx('sms_log').insert({ direction: 'inbound', from_phone: PERSON, to_phone: WEB_LINE });
    expect(await refusal()).toBeNull();
    await trx('sms_log').del();
    await trx('call_log').insert({ direction: 'inbound', from_phone: '9415550123', to_phone: '9412542617' });
    expect(await refusal()).toBeNull();
  });

  test('contact on another website line, an outbound row, a sandbox call, or a foreign number with the same last 10 digits is refused', async () => {
    await trx('sms_log').insert([
      { direction: 'inbound', from_phone: PERSON, to_phone: OTHER_WEB_LINE },
      { direction: 'outbound', from_phone: WEB_LINE, to_phone: PERSON },
      { direction: 'inbound', from_phone: '+449415550123', to_phone: WEB_LINE },
    ]);
    await trx('call_log').insert([
      { direction: 'outbound', from_phone: PERSON, to_phone: WEB_LINE },
      // A Sandy sandbox call is internal, never a person who reached Waves on the line.
      { direction: 'inbound', from_phone: PERSON, to_phone: WEB_LINE, source: require('../services/voice-agent/relay-protocol').VOICE_RELAY_SANDBOX_SOURCE },
    ]);
    expect(await refusal()).toBe(WEBSITE_LINE_REFUSAL);
    // The contact on the other line still counts for that line.
    expect(await refusal(OTHER_WEB_LINE)).toBeNull();
  });

  test('both reads can use the last-10 expression index on from_phone', async () => {
    const built = [];
    const database = (table) => { const query = trx(table); built.push(query); return query; };
    await websiteLineRefusal(WEB_LINE, PERSON, { database });
    expect(built).toHaveLength(2);
    await trx.raw('SET LOCAL enable_seqscan = off');
    for (const query of built) {
      const plan = (await trx.raw(`EXPLAIN ${query.toString()}`)).rows.map((row) => row['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/Index Scan/);
    }
  });
});

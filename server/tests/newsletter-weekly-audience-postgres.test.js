// CI's DB-gated pass runs this against PostgreSQL. Minimal newsletter_sends and
// newsletter_send_deliveries tables live in a unique schema, dropped after the suite. It runs the
// real count of warm issues that reached a reader (sender's reachedDelivery rule).
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

jest.setTimeout(30000);

(SKIP ? describe.skip : describe)('sentWarmIssueCount on PostgreSQL', () => {
  let database;
  let sentWarmIssueCount;
  const schema = `nl_warm_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    await database.raw(`
      CREATE TABLE newsletter_sends (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        newsletter_type text, status text NOT NULL, audience_phase text
      )`);
    await database.raw(`
      CREATE TABLE newsletter_send_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        send_id uuid NOT NULL REFERENCES newsletter_sends(id) ON DELETE CASCADE,
        status text, bounce_reason text, sent_at timestamptz, delivered_at timestamptz, opened_at timestamptz,
        clicked_at timestamptz, bounced_at timestamptz, complained_at timestamptz, unsubscribed_at timestamptz
      )`);
    ({ sentWarmIssueCount } = require('../services/newsletter-weekly-audience'));
  });
  afterEach(async () => {
    await database('newsletter_send_deliveries').del();
    await database('newsletter_sends').del();
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  const issue = async (fields, deliveries = []) => {
    const [row] = await database('newsletter_sends').insert({ status: 'sent', audience_phase: 'warm', ...fields }).returning('*');
    for (const delivery of deliveries) await database('newsletter_send_deliveries').insert({ send_id: row.id, ...delivery });
    return row;
  };

  test('a sent warm issue with a delivered row counts; an all-skipped, all-bounced or empty one does not', async () => {
    await issue({ newsletter_type: 'local-weekly-fresh-events' }, [{ status: 'delivered', delivered_at: new Date() }, { status: 'skipped' }]);
    await issue({ newsletter_type: 'local-weekly-fresh-events' }, [{ status: 'skipped' }, { status: 'skipped' }]);
    await issue({ newsletter_type: 'local-weekly-fresh-events' }, [{ status: 'bounced', bounced_at: new Date() }]);
    await issue({ newsletter_type: 'local-weekly-fresh-events' }, []);
    await expect(sentWarmIssueCount(database)).resolves.toBe(1);
  });

  test('only sent warm issues count, and a legacy row with no type counts by its phase', async () => {
    const delivered = [{ status: 'delivered', delivered_at: new Date() }];
    await issue({ newsletter_type: null }, delivered);
    await issue({ status: 'draft' }, delivered);
    await issue({ status: 'failed' }, delivered);
    await issue({ audience_phase: 'all' }, delivered);
    await issue({ audience_phase: null }, delivered);
    await expect(sentWarmIssueCount(database)).resolves.toBe(1);
  });
});

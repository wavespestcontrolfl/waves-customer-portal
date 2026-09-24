/**
 * The monthly cron's and retry sweep's skip paths (billing-cron.js) write
 * two operator-facing records that are the ONLY recovery signal for a
 * once-a-month dues charge that was skipped:
 *   - autopay_log rows with event_type 'skipped_unresolved_outcome' /
 *     'skipped_lock_contention' (logAutopay swallows insert errors);
 *   - customer_health_alerts rows with alert_type
 *     'billing_collection_deferred' (the inserts are try/catch + log).
 * A CHECK constraint or a too-short column would make both vanish
 * silently. This suite proves against a real Postgres schema that the
 * values are accepted: no CHECK constraint touches either column, the
 * lengths fit, and an actual insert of each succeeds (rolled back).
 * Skips cleanly without DATABASE_URL, like the other Postgres suites.
 */
const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
jest.setTimeout(30000);

const SKIP_EVENTS = ['skipped_unresolved_outcome', 'skipped_lock_contention', 'skipped_already_paid'];
const DEFERRED_ALERT_TYPE = 'billing_collection_deferred';

postgres('billing skip events / deferred alert — accepted by the live schema (real Postgres)', () => {
  let db;
  beforeAll(() => { db = require('../models/db'); });
  afterAll(async () => { await db.destroy(); });

  test('neither autopay_log.event_type nor customer_health_alerts.alert_type carries a CHECK constraint, and the values fit', async () => {
    const { rows: checks } = await db.raw(`
      SELECT c.conrelid::regclass::text AS table_name, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      WHERE c.contype = 'c'
        AND c.conrelid IN ('autopay_log'::regclass, 'customer_health_alerts'::regclass)
    `);
    const touching = checks.filter((r) => /event_type|alert_type/.test(r.def));
    expect(touching).toEqual([]);

    const { rows: cols } = await db.raw(`
      SELECT table_name, column_name, character_maximum_length AS len
      FROM information_schema.columns
      WHERE (table_name = 'autopay_log' AND column_name = 'event_type')
         OR (table_name = 'customer_health_alerts' AND column_name = 'alert_type')
    `);
    const lenOf = (t, c) => cols.find((r) => r.table_name === t && r.column_name === c)?.len;
    for (const ev of SKIP_EVENTS) expect(lenOf('autopay_log', 'event_type')).toBeGreaterThanOrEqual(ev.length);
    expect(lenOf('customer_health_alerts', 'alert_type')).toBeGreaterThanOrEqual(DEFERRED_ALERT_TYPE.length);
  });

  test('an actual insert of each skip event and of the deferred alert succeeds (rolled back)', async () => {
    const ROLLBACK = new Error('rollback-sentinel');
    let written = null;
    await db.transaction(async (trx) => {
      const [customer] = await trx('customers')
        .insert({ first_name: 'Schema', last_name: 'Probe', phone: '+15550000000' })
        .returning('id');
      const customerId = customer.id ?? customer;
      const events = await trx('autopay_log')
        .insert(SKIP_EVENTS.map((event_type) => ({
          customer_id: customerId, event_type, details: JSON.stringify({ source: 'schema-probe' }),
        })))
        .returning('event_type');
      const [alert] = await trx('customer_health_alerts')
        .insert({
          customer_id: customerId, alert_type: DEFERRED_ALERT_TYPE, severity: 'high',
          title: 'schema probe', description: 'schema probe', trigger_data: JSON.stringify({ source: 'schema-probe' }),
        })
        .returning('alert_type');
      written = { events: events.map((r) => r.event_type ?? r), alert: alert.alert_type ?? alert };
      throw ROLLBACK;
    }).catch((err) => { if (err !== ROLLBACK) throw err; });
    expect(written).toEqual({ events: SKIP_EVENTS, alert: DEFERRED_ALERT_TYPE });
  });
});

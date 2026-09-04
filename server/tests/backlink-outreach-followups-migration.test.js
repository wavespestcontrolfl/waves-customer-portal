/**
 * 20260903000070 — the outreach follow-up columns on seo_link_prospects
 * (plan §6.4): its own status machine, due date, draft, token, stamps.
 */
const migration = require('../models/migrations/20260903000070_link_outreach_followups');

function fakeKnex({ hasColumn }) {
  const raws = []; const altered = [];
  const knex = {
    raw: async (sql) => { raws.push(sql); },
    schema: {
      hasColumn: async () => hasColumn,
      alterTable: async (table, cb) => {
        const cols = [];
        cb(new Proxy({}, { get: (_, method) => (...args) => { cols.push({ method, args }); const chain = new Proxy({}, { get: () => () => chain }); return chain; } }));
        altered.push({ table, cols });
      },
    },
  };
  return { knex, raws, altered };
}
const COLS = ['follow_up_status', 'follow_up_due_at', 'follow_up_subject', 'follow_up_body', 'follow_up_send_token', 'follow_up_attempted_at', 'follow_up_sent_at', 'follow_up_skipped_reason', 'follow_up_attempts'];

test('up adds the nine follow-up columns, the status CHECK and the due index; idempotent when present', async () => {
  const f = fakeKnex({ hasColumn: false });
  await migration.up(f.knex);
  expect(f.altered).toHaveLength(1);
  expect(f.altered[0].table).toBe('seo_link_prospects');
  expect(f.altered[0].cols.map((c) => c.args[0])).toEqual(COLS);
  expect(f.raws).toHaveLength(2);
  expect(f.raws[0]).toMatch(/ADD CONSTRAINT seo_link_prospects_follow_up_status_check CHECK \(follow_up_status IN \('none', 'due', 'drafted', 'sending', 'sent', 'send_error', 'skipped'\)\)/);
  expect(f.raws[1]).toMatch(/CREATE INDEX IF NOT EXISTS seo_link_prospects_follow_up_due_idx ON seo_link_prospects \(follow_up_status, follow_up_due_at\)/);
  const g = fakeKnex({ hasColumn: true });
  await migration.up(g.knex);
  expect(g.altered).toHaveLength(0);
  expect(g.raws).toHaveLength(0);
});

test('down mirrors up', async () => {
  const f = fakeKnex({ hasColumn: true });
  await migration.down(f.knex);
  expect(f.raws[0]).toMatch(/DROP INDEX IF EXISTS seo_link_prospects_follow_up_due_idx/);
  expect(f.raws[1]).toMatch(/DROP CONSTRAINT IF EXISTS seo_link_prospects_follow_up_status_check/);
  expect(f.altered[0].cols.map((c) => c.args[0])).toEqual(COLS);
  expect(f.altered[0].cols.every((c) => c.method === 'dropColumn')).toBe(true);
  const g = fakeKnex({ hasColumn: false });
  await migration.down(g.knex);
  expect(g.altered).toHaveLength(0);
});

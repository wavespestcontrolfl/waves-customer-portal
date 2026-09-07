/**
 * Booking-recovery SMS fits ONE segment (owner, 2026-09-07): the copy the
 * 20260907000010 migration writes, rendered the way the SMS renderer renders
 * it (portal link scheme stripped) with every service label the service can
 * substitute and the branded short link, counts as a single GSM-7 segment.
 * The migration only rewrites the exact audited body (admin-edit guard).
 */
const path = require('path');
const { countSegments } = require('../services/messaging/segment-counter');
const { stripPortalUrlScheme } = require('../routes/admin-sms-templates');
const migration = require(path.resolve(__dirname, '../models/migrations/20260907000010_booking_recovery_sms_one_segment.js'));
const { _internals } = require('../services/booking-abandon-recovery');

const SHORT_LINK = 'https://portal.wavespestcontrol.com/l/k3j9'; // short-url.js shape
const LONG_FIRST_NAME = 'Christopher';

function render(body, vars) {
  let out = body;
  for (const [k, v] of Object.entries(vars)) out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => v);
  return stripPortalUrlScheme(out).replace(/\n{3,}/g, '\n\n').trim();
}

describe('booking recovery SMS — one segment', () => {
  test('every service label + the short link renders as ONE GSM-7 segment', () => {
    const labels = [...Object.values(_internals.SERVICE_LABELS), 'your service'];
    for (const service_type of labels) {
      const text = render(migration.NEXT, { first_name: LONG_FIRST_NAME, service_type, booking_url: SHORT_LINK });
      const c = countSegments(text);
      expect({ service_type, encoding: c.encoding, segments: c.segmentCount, chars: c.characterCount }).toEqual({ service_type, encoding: 'GSM_7', segments: 1, chars: c.characterCount });
      expect(text).not.toContain('https://');
      expect(text).toContain('portal.wavespestcontrol.com/l/k3j9');
      expect(text).toMatch(/Reply STOP to opt out\.$/);
    }
  });

  test('the previous copy really was two segments (the reason for the change)', () => {
    const text = render(migration.EXPECTED, { first_name: LONG_FIRST_NAME, service_type: 'Pest Control', booking_url: SHORT_LINK });
    expect(countSegments(text).segmentCount).toBe(2);
  });

  test('the rewrite keeps the exact variable set', () => {
    const vars = (b) => (b.match(/\{[a-z_]+\}/g) || []).sort();
    expect(vars(migration.NEXT)).toEqual(vars(migration.EXPECTED));
  });

  test('migration rewrites only the audited body; a hand-edited row is skipped; down reverts only its own copy', async () => {
    const fakeKnex = (rowBody) => {
      const calls = [];
      const table = () => ({
        columnInfo: async () => ({ body: {}, updated_at: {} }),
        where: (pred) => ({ update: async (patch) => { calls.push({ pred, patch }); return pred.body === rowBody ? 1 : 0; } }),
      });
      const knex = Object.assign(table, { schema: { hasTable: async () => true } });
      return { knex, calls };
    };
    const { knex: k1, calls: c1 } = fakeKnex(migration.EXPECTED);
    await migration.up(k1);
    expect(c1[0].pred).toEqual({ template_key: 'booking_abandonment_recovery', body: migration.EXPECTED });
    expect(c1[0].patch.body).toBe(migration.NEXT);
    // Edited in /admin since → the predicate matches nothing, nothing written over it.
    const { knex: k2, calls: c2 } = fakeKnex('Custom copy Virginia wrote');
    await migration.up(k2);
    expect(c2[0].pred.body).toBe(migration.EXPECTED);
    // down: only a row still carrying NEXT goes back.
    const { knex: k3, calls: c3 } = fakeKnex(migration.NEXT);
    await migration.down(k3);
    expect(c3[0].pred).toEqual({ template_key: 'booking_abandonment_recovery', body: migration.NEXT });
    expect(c3[0].patch.body).toBe(migration.EXPECTED);
  });
});

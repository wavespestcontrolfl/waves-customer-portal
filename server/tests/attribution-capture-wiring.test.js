/**
 * Attribution capture hardening — migration shape + wiring guards.
 *
 * Source-pattern guards (house style — see attribution-funnel-wiring.test.js):
 * they pin the persistence + funnel-bridge call sites and the env-gated spend
 * syncs in place so a refactor can't silently drop them.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

// ---------------------------------------------------------------------------
// Migration shape
// ---------------------------------------------------------------------------

// Minimal fake knex.schema capturing alterTable column/index calls.
function makeSchemaKnex({ tables = {}, columns = {} } = {}) {
  const calls = { jsonb: [], uuid: [], unique: [], references: [], dropped: [] };
  const builder = {
    jsonb: (name) => { calls.jsonb.push(name); return builder; },
    uuid: (name) => { calls.uuid.push(name); return builder; },
    unique: (name, opts) => { calls.unique.push({ name, opts }); return builder; },
    references: (col) => { calls.references.push({ col }); return builder; },
    inTable: (t) => { calls.references[calls.references.length - 1].table = t; return builder; },
    onDelete: (mode) => { calls.references[calls.references.length - 1].onDelete = mode; return builder; },
    dropColumn: (name) => { calls.dropped.push(name); return builder; },
  };
  const knex = {
    schema: {
      hasTable: async (t) => tables[t] !== false,
      hasColumn: async (t, c) => !!columns[`${t}.${c}`],
      alterTable: async (t, cb) => { calls.alteredTable = t; cb(builder); },
    },
  };
  knex._calls = calls;
  return knex;
}

describe('migration 20260705000200 — self_booked_appointments.attribution', () => {
  const migration = require('../models/migrations/20260705000200_self_booked_appointments_attribution');

  test('adds a nullable jsonb attribution column', async () => {
    const knex = makeSchemaKnex();
    await migration.up(knex);
    expect(knex._calls.alteredTable).toBe('self_booked_appointments');
    expect(knex._calls.jsonb).toEqual(['attribution']);
  });

  test('idempotent — no-ops when the column already exists', async () => {
    const knex = makeSchemaKnex({ columns: { 'self_booked_appointments.attribution': true } });
    await migration.up(knex);
    expect(knex._calls.alteredTable).toBeUndefined();
  });

  test('no-ops when the table is absent', async () => {
    const knex = makeSchemaKnex({ tables: { self_booked_appointments: false } });
    await migration.up(knex);
    expect(knex._calls.alteredTable).toBeUndefined();
  });

  test('down drops only the added column', async () => {
    const knex = makeSchemaKnex({ columns: { 'self_booked_appointments.attribution': true } });
    await migration.down(knex);
    expect(knex._calls.dropped).toEqual(['attribution']);
  });
});

describe('migration 20260705000201 — ad_service_attribution.self_booked_appointment_id', () => {
  const migration = require('../models/migrations/20260705000201_ad_service_attribution_self_booking');

  test('adds a nullable uuid FK with SET NULL and a UNIQUE per-booking dedupe index', async () => {
    const knex = makeSchemaKnex();
    await migration.up(knex);
    expect(knex._calls.alteredTable).toBe('ad_service_attribution');
    expect(knex._calls.uuid).toEqual(['self_booked_appointment_id']);
    expect(knex._calls.references[0]).toMatchObject({ col: 'id', table: 'self_booked_appointments', onDelete: 'SET NULL' });
    expect(knex._calls.unique).toEqual([
      { name: 'self_booked_appointment_id', opts: { indexName: 'uq_ad_service_attribution_self_booking' } },
    ]);
  });

  test('idempotent — no-ops when the column already exists', async () => {
    const knex = makeSchemaKnex({ columns: { 'ad_service_attribution.self_booked_appointment_id': true } });
    await migration.up(knex);
    expect(knex._calls.alteredTable).toBeUndefined();
  });

  test('no-ops when either table is absent', async () => {
    for (const missing of ['ad_service_attribution', 'self_booked_appointments']) {
      const knex = makeSchemaKnex({ tables: { [missing]: false } });
      await migration.up(knex);
      expect(knex._calls.alteredTable).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Gap A — every-booking attribution persistence wiring
// ---------------------------------------------------------------------------

describe('booking.js self-booking attribution wiring', () => {
  const src = read('../routes/booking.js');

  test('persists the full client attribution object on the self_booked_appointments insert', () => {
    expect(src).toMatch(/attribution:\s*\(attribution && typeof attribution === 'object'\)\s*\n?\s*\?\s*JSON\.stringify\(attribution\)\s*:\s*null/);
  });

  test('hands attributeSelfBooking the booking id (the per-booking funnel-row dedupe key)', () => {
    expect(src).toMatch(/selfBookedAppointmentId:\s*booking\?\.id \|\| null/);
  });
});

describe('lead-estimate-link organic self-booking row wiring', () => {
  const src = read('../services/lead-estimate-link.js');

  test('classifies with the shared determineLeadSource (no duplicated classifier)', () => {
    expect(src).toMatch(/require\('\.\/lead-source-classify'\)/);
  });

  test('organic rows derive is_paid from the classifier channel (webhook parity) and dedupe per booking', () => {
    expect(src).toMatch(/is_paid:\s*classified\.channel === 'paid'/);
    expect(src).toMatch(/\.onConflict\('self_booked_appointment_id'\)\.ignore\(\)/);
  });

  test('no capture, no row — attribution-less callers never fabricate a funnel row', () => {
    expect(src).toMatch(/if \(!attributionHasCapture\(attribution\)\) return \{ attributed: false, reason: 'no_attribution_capture' \}/);
  });

  test('BOTH self-booking funnel rows are born at booked — the booking is committed, and a born-won lead never fires the bridge', () => {
    expect((src.match(/funnel_stage: 'booked'/g) || []).length).toBe(2);
    // neither self-booking insert initializes at the bottom rung anymore
    expect(src).not.toMatch(/funnel_stage: 'lead'/);
  });

  test('embedded-iframe bookings defer a portal landing_url to the referrer (portal-url helper, booking scope only)', () => {
    expect(src).toMatch(/require\('\.\.\/utils\/portal-url'\)/);
    expect(src).toMatch(/landingHost === portalHost && referrerHost && referrerHost !== portalHost/);
  });

  test('recovery-link bookings are excluded from the acquisition mint (booking.js passes the source; the mint gates on it)', () => {
    const booking = read('../routes/booking.js');
    expect(booking).toMatch(/bookingSource:\s*source \|\| null/);
    expect(src).toMatch(/NON_ACQUISITION_BOOKING_SOURCES = new Set\(\['booking_recovery'\]\)/);
    expect(src).toMatch(/reason: 'recovery_rebooking'/);
  });

  test('classifier compares NORMALIZED utm source/medium in the paid/social branches (casing fix, webhook included)', () => {
    const classify = read('../services/lead-source-classify.js');
    expect(classify).toMatch(/source === 'google' && medium === 'cpc'/);
    expect(classify).toMatch(/source === 'facebook' \|\| source === 'fb'/);
    expect(classify).not.toMatch(/utmSource === 'google'/);
  });

  test('lead-webhook still owns the same classifier (extraction, not a fork)', () => {
    const webhook = read('../routes/lead-webhook.js');
    expect(webhook).toMatch(/require\('\.\.\/services\/lead-source-classify'\)/);
    expect(webhook).not.toMatch(/function determineLeadSource\(/);
  });
});

// ---------------------------------------------------------------------------
// Gap B — funnel-stage bridge wired into every lead status-transition path
// ---------------------------------------------------------------------------

describe('lead-funnel-bridge call sites', () => {
  test('markConverted / markLost mirror onto the funnel row', () => {
    const src = read('../services/lead-attribution.js');
    expect(src).toMatch(/bridgeLeadFunnelStage\(leadId, 'won'\)/);
    expect(src).toMatch(/bridgeLeadFunnelStage\(leadId, 'lost'\)/);
  });

  test('estimate sent/viewed transitions bridge with the caller database handle, GATED on the status update applying (replay guard)', () => {
    const src = read('../services/lead-estimate-link.js');
    expect(src).toMatch(/if \(advanced\) await bridgeLeadFunnelStage\(lead\.id, 'estimate_sent', database\)/);
    expect(src).toMatch(/if \(advanced\) await bridgeLeadFunnelStage\(lead\.id, 'estimate_viewed', database\)/);
  });

  test('admin manual transitions bridge (PUT status edit, send-sms contacted, schedule-appointment won)', () => {
    const src = read('../routes/admin-leads.js');
    expect(src).toMatch(/bridgeLeadFunnelStage\(req\.params\.id, updates\.status\)/);
    expect(src).toMatch(/bridgeLeadFunnelStage\(req\.params\.id, 'contacted'\)/);
    expect(src).toMatch(/bridgeLeadFunnelStage\(req\.params\.id, 'won'\)/);
  });

  test('lead-response agent contacted transition bridges', () => {
    const src = read('../services/lead-response-tools.js');
    expect(src).toMatch(/bridgeLeadFunnelStage\(input\.lead_id, 'contacted'\)/);
  });

  test('phone-booking conversion bridges inside its savepoint', () => {
    const src = read('../services/call-recording-processor.js');
    expect(src).toMatch(/bridgeLeadFunnelStage\(leadId, 'won', inner\)/);
  });

  test('Intelligence Bar lead tools bridge (single status update + set-based bulk)', () => {
    const src = read('../services/intelligence-bar/leads-tools.js');
    expect(src).toMatch(/bridgeLeadFunnelStage\(lead\.id, new_status\)/);
    expect(src).toMatch(/bridgeLeadsFunnelStage\(ids, new_status\)/);
  });

  test('the bridge isolates transactional callers behind a savepoint', () => {
    const src = read('../services/lead-funnel-bridge.js');
    expect(src).toMatch(/db\.isTransaction && typeof db\.transaction === 'function'/);
    expect(src).toMatch(/db\.transaction\(\(sp\) => run\(sp\)\)/);
  });

  test('staleness sweep collapses flipped leads to the lost bucket in the same transaction', () => {
    const src = read('../services/lead-staleness.js');
    expect(src).toMatch(/bridgeLeadsFunnelStage\(flipped\.map\(\(\{ id \}\) => id\), 'unresponsive', trx\)/);
  });
});

// ---------------------------------------------------------------------------
// Gap D — spend syncs are scheduled, env-gated
// ---------------------------------------------------------------------------

describe('scheduler ad-spend sync registration', () => {
  const src = read('../services/scheduler.js');

  test('Google Ads daily sync is scheduled and no-ops without GOOGLE_ADS_* env', () => {
    expect(src).toMatch(/cron\.schedule\('0 6 \* \* \*'/);
    expect(src).toMatch(/googleAds\.isConfigured\(\)/);
    expect(src).toMatch(/googleAds\.syncDailyPerformance\(7\)/);
  });

  test('Meta Ads daily sync is scheduled and no-ops without META_ADS_* env', () => {
    expect(src).toMatch(/cron\.schedule\('15 6 \* \* \*'/);
    expect(src).toMatch(/metaAds\.isConfigured\(\)/);
    expect(src).toMatch(/metaAds\.syncDailyPerformance\(7\)/);
  });
});

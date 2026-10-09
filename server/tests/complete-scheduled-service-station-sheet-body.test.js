/**
 * GATE_STATION_FAST_COMPLETE (owner 2026-10-08): a termite or rodent bait station
 * visit completed from the Fast Complete sheet posts `termiteStations` and the
 * typed station counts exactly as the full form does, so /complete writes the
 * same termite_station_checks rows from either body. The sheet's own client
 * rules are tested in client/src/components/tech/FastCompleteSheet.station-flow.test.jsx;
 * this suite proves the server side of the contract against real Postgres.
 *
 * Runs only against a private waves_audit_* Postgres clone (CI provides one):
 *   DATABASE_URL=postgres://wavespestcontrol@localhost:5432/waves_audit_<slug>
 * Wiring copied from complete-scheduled-service-declined-station-checks.test.js.
 */
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  ...jest.requireActual('../services/weather-forecast'), getDailyRainOutlookBounded: jest.fn(async () => null),
}));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: false, blocked: true, code: 'test' })),
}));
jest.mock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: jest.fn(() => false),
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(async () => null),
}));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ suppressed: true })) }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn(async () => ({ sent: 0 })) }));
jest.mock('../services/admin-unread', () => ({ getUnreadCountForAdmin: jest.fn(async () => ({ count: 0, at: Date.now() })) }));
jest.mock('../services/customer-card', () => ({ ensureCardForCompletion: jest.fn(async () => {}) }));
jest.mock('../services/tree-shrub-assessment', () => ({
  ...jest.requireActual('../services/tree-shrub-assessment'),
  scoreAndStoreTreeShrubAssessment: jest.fn(async () => null),
}));
jest.mock('../services/referral-engine', () => ({ creditReferralOnFirstService: jest.fn(async () => {}) }));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  isNewRecurringSignupCandidate: jest.fn(async () => false), sendNewRecurringWelcome: jest.fn(async () => {}),
}));
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn(async () => {}), sendMembershipRenewalReminder: jest.fn(async () => {}) }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: jest.fn(async () => {}) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(), loadTemplateByKey: jest.fn(async () => null), activeSuppressionFor: jest.fn(async () => null),
}));
jest.mock('../services/review-request', () => ({ enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined) }));

const knex = require('knex');
const { randomUUID } = require('crypto');

const connection = process.env.DATABASE_URL;
const postgres = connection && /\/waves_audit_/.test(connection) ? describe : describe.skip;
let mockPg;
jest.setTimeout(90000);

// A visit of a bait station form with `stationCount` pinned stations on the
// property, as the registry holds them (the panel and the sheet both preload
// these and post a status for each).
async function seedVisit({ projectType = 'termite_bait_station', program = 'termite', stationCount = 4 } = {}) {
  const { etDateString } = require('../utils/datetime-et');
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(),
    serviceKey: `fixture_station_${randomUUID().slice(0, 8)}`,
    stationIds: Array.from({ length: stationCount }, () => randomUUID()) };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'StationSheet', phone: '+12025550178',
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `Fixture Station Visit ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('service_completion_profiles').insert({ service_key: f.serviceKey, service_name_snapshot: 'Fixture Station Visit',
    completion_mode: 'service_report', project_type: projectType, active: true });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
    service_type: `Fixture Station Visit ${f.serviceKey}`, scheduled_date: etDateString(), window_start: '09:00', window_end: '10:00', status: 'confirmed',
    estimated_price: 0, estimated_duration_minutes: 60, create_invoice_on_complete: false });
  await mockPg('termite_stations').insert(f.stationIds.map((id, i) => ({
    id, customer_id: f.customerId, station_number: i + 1, program,
    geometry_image: JSON.stringify({ type: 'circle', cx: 0.05 + i * 0.09, cy: 0.5, r: 0.02 }),
    is_active: true, owned_by: program === 'termite' ? 'customer' : 'waves',
  })));
  return f;
}

async function cleanup(f) {
  await mockPg('notifications').whereRaw("metadata::text like ?", [`%${f.serviceId}%`]).del().catch(() => {});
  await mockPg('service_completion_attempts').where('service_id', f.serviceId).del().catch(() => {});
  await mockPg('termite_station_checks').whereIn('station_id', f.stationIds).del().catch(() => {});
  await mockPg('termite_stations').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ id: f.serviceId }).del().catch(() => {});
  await mockPg('service_completion_profiles').where({ service_key: f.serviceKey }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

// What the full form (CompletionPanel, station map on) sends for the same
// statuses: an entry for every pinned station, `touched` on a tap, and the
// typed counts its auto-count writes (client/src/lib/station-checks.js).
function fullFormBody(f, statuses, findingsType, values) {
  return {
    customerRecap: 'Visit complete.',
    visitOutcome: 'completed',
    products: [],
    areasServiced: [],
    sendCompletionSms: false,
    requestReview: false,
    structuredFindings: { type: findingsType, values },
    termiteStations: f.stationIds.map((id, i) => {
      const status = statuses[i];
      return { id, status: status || 'ok', ...(status ? { touched: true } : {}) };
    }),
  };
}

// What the Fast Complete sheet sends for the same statuses (FastCompleteStations
// + FastCompleteSheet.jsx reportCompletionBody): the same stations and typed
// values, beside the sheet's own fields (the report the tech read, no
// products, no places for a typed form, the customer text off).
function sheetBody(f, statuses, findingsType, values, { seen = f.stationIds } = {}) {
  return {
    visitOutcome: 'completed',
    products: [],
    areasServiced: [],
    structuredFindings: { type: findingsType, values },
    // An entry for every station the sheet checked (`seen`), as the sheet sends it.
    termiteStations: seen.map((id, i) => (statuses[i] ? { id, status: statuses[i], touched: true } : { id, status: 'ok' })),
    // The stations the sheet checked, bound to the completion under the visit lock.
    stationRosterSeen: seen,
    technicianNotes: 'Station 2 had activity. I replaced the bait in 3.',
    reportDraftBase: 'WHAT WE FOUND\nSome activity at one station.',
    sendCompletionSms: false,
    includePayLink: false,
    requestReview: false,
  };
}

async function complete(f, completionBody) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
    actor: { techRole: 'admin', technicianId: f.techId, technician: null }, body: completionBody });
}

// The check rows by station number, so two visits on two properties compare.
async function checksByNumber(f) {
  const rows = await mockPg('termite_station_checks as c')
    .join('termite_stations as s', 's.id', 'c.station_id')
    .whereIn('c.station_id', f.stationIds)
    .select('s.station_number', 'c.status')
    .orderBy('s.station_number');
  return rows.map((row) => [row.station_number, row.status]);
}

postgres('GATE_STATION_FAST_COMPLETE: the sheet\'s completion body writes the same station checks as the full form\'s', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  const TERMITE_VALUES = (counts) => ({ ...counts, termite_activity: 'Active termites present', bait_consumption: 'Light feeding' });

  test('termite: activity at station 2 and bait replaced at station 3 write identical check rows from either body', async () => {
    const statuses = [null, 'activity', 'serviced', null];
    const counts = { total_stations: '4', stations_checked: '4', stations_inaccessible: '0', stations_with_activity: '1' };
    const full = await seedVisit();
    const sheet = await seedVisit();
    try {
      expect(await complete(full, fullFormBody(full, statuses, 'termite_bait_station', TERMITE_VALUES(counts)))).toMatchObject({ status: 200 });
      expect(await complete(sheet, sheetBody(sheet, statuses, 'termite_bait_station', TERMITE_VALUES(counts)))).toMatchObject({ status: 200 });
      const fullRows = await checksByNumber(full);
      expect(fullRows).toEqual([[1, 'ok'], [2, 'activity'], [3, 'serviced'], [4, 'ok']]);
      expect(await checksByNumber(sheet)).toEqual(fullRows);
      // The same typed counts reach the saved record's frozen findings.
      const frozenOf = async (f) => {
        const record = await mockPg('service_records').where({ customer_id: f.customerId }).first();
        const serviceData = typeof record.service_data === 'string' ? JSON.parse(record.service_data) : record.service_data;
        return serviceData?.typedReportSnapshot?.values || {};
      };
      const [fullFrozen, sheetFrozen] = [await frozenOf(full), await frozenOf(sheet)];
      expect(fullFrozen).toMatchObject(counts);
      expect(sheetFrozen).toMatchObject(counts);
      // Neither body adds, moves or retires a station.
      for (const f of [full, sheet]) {
        const stations = await mockPg('termite_stations').where({ customer_id: f.customerId });
        expect(stations).toHaveLength(4);
        expect(stations.every((s) => s.is_active === true)).toBe(true);
      }
    } finally { await cleanup(full); await cleanup(sheet); }
  });

  test('rodent: consumption at station 2 and a station that could not be reached write identical check rows from either body', async () => {
    const statuses = [null, 'activity', 'inaccessible'];
    const values = { stations_checked: '2', stations_inaccessible: '1', bait_consumption: 'Light' };
    const full = await seedVisit({ projectType: 'rodent_bait_station', program: 'rodent', stationCount: 3 });
    const sheet = await seedVisit({ projectType: 'rodent_bait_station', program: 'rodent', stationCount: 3 });
    try {
      expect(await complete(full, fullFormBody(full, statuses, 'rodent_bait_station', values))).toMatchObject({ status: 200 });
      expect(await complete(sheet, sheetBody(sheet, statuses, 'rodent_bait_station', values))).toMatchObject({ status: 200 });
      const fullRows = await checksByNumber(full);
      expect(fullRows).toEqual([[1, 'ok'], [2, 'activity'], [3, 'inaccessible']]);
      expect(await checksByNumber(sheet)).toEqual(fullRows);
    } finally { await cleanup(full); await cleanup(sheet); }
  });

  test('rodent: a consumption mark beside a bait consumption level of None is refused before anything is written (the sheet holds it first)', async () => {
    const f = await seedVisit({ projectType: 'rodent_bait_station', program: 'rodent', stationCount: 3 });
    try {
      const out = await complete(f, sheetBody(f, [null, 'activity', null], 'rodent_bait_station', { stations_checked: '3', stations_inaccessible: '0', bait_consumption: 'None' }));
      expect(out).toMatchObject({ status: 400, body: { code: 'rodent_consumption_conflict' } });
      expect(await checksByNumber(f)).toEqual([]);
    } finally { await cleanup(f); }
  });

  // The roster the sheet checked is bound to the completion: a station retired
  // or added between the sheet's read and Complete is refused under the lock,
  // and nothing is written.
  describe('the roster changed between the sheet\'s read and the completion', () => {
    const TERMITE = (counts) => ({ ...counts, termite_activity: 'None observed', bait_consumption: 'None — bait intact' });
    const COUNTS = { total_stations: '4', stations_checked: '4', stations_inaccessible: '0', stations_with_activity: '0' };
    const nothingWritten = async (f) => {
      expect(await checksByNumber(f)).toEqual([]);
      expect(await mockPg('service_records').where({ customer_id: f.customerId })).toEqual([]);
      const row = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
      expect(row.status).toBe('confirmed');
    };

    test('a station retired since is refused with station_roster_changed', async () => {
      const f = await seedVisit();
      try {
        await mockPg('termite_stations').where({ id: f.stationIds[3] }).update({ is_active: false });
        const out = await complete(f, sheetBody(f, [], 'termite_bait_station', TERMITE(COUNTS)));
        expect(out).toMatchObject({ status: 409, body: { code: 'station_roster_changed' } });
        await nothingWritten(f);
      } finally { await cleanup(f); }
    });

    test('a station added since is refused too', async () => {
      const f = await seedVisit();
      try {
        const added = randomUUID();
        await mockPg('termite_stations').insert({
          id: added, customer_id: f.customerId, station_number: 9, program: 'termite', is_active: true, owned_by: 'customer',
          geometry_image: JSON.stringify({ type: 'circle', cx: 0.9, cy: 0.9, r: 0.02 }),
        });
        f.stationIds.push(added);
        const out = await complete(f, sheetBody(f, [], 'termite_bait_station', TERMITE(COUNTS), { seen: f.stationIds.slice(0, 4) }));
        expect(out).toMatchObject({ status: 409, body: { code: 'station_roster_changed' } });
        await nothingWritten(f);
      } finally { await cleanup(f); }
    });

    test('the same roster completes; another program\'s station is no part of it', async () => {
      const f = await seedVisit();
      try {
        const other = randomUUID();
        await mockPg('termite_stations').insert({
          id: other, customer_id: f.customerId, station_number: 1, program: 'rodent', is_active: true, owned_by: 'waves',
          geometry_image: JSON.stringify({ type: 'circle', cx: 0.8, cy: 0.2, r: 0.02 }),
        });
        f.stationIds.push(other);
        const out = await complete(f, sheetBody(f, [], 'termite_bait_station', TERMITE(COUNTS), { seen: f.stationIds.slice(0, 4) }));
        expect(out).toMatchObject({ status: 200 });
        expect(await mockPg('termite_station_checks').whereIn('station_id', f.stationIds.slice(0, 4))).toHaveLength(4);
      } finally { await cleanup(f); }
    });

    test('the full form sends no marker: it may edit the roster, and a retired station does not refuse it', async () => {
      const f = await seedVisit();
      try {
        await mockPg('termite_stations').where({ id: f.stationIds[3] }).update({ is_active: false });
        const out = await complete(f, fullFormBody(f, [], 'termite_bait_station', TERMITE(COUNTS)));
        expect(out).toMatchObject({ status: 200 });
      } finally { await cleanup(f); }
    });
  });

  // Codex P2 on #6205: the roster check is serialized with station edits by the
  // roster lock (termite-stations.js lockStationRoster), and the sheet's check
  // rows are written in the completion transaction under it.
  describe('an office station edit racing a sheet completion', () => {
    const TERMITE = { total_stations: '4', stations_checked: '4', stations_inaccessible: '0', stations_with_activity: '0', termite_activity: 'None observed', bait_consumption: 'None — bait intact' };
    const TermiteStations = require('../services/termite-stations');
    const officeRetire = (f, id) => mockPg.transaction((trx) => TermiteStations.upsertStationsForCustomer(trx, {
      customerId: f.customerId, entries: [{ id, retire: true }], program: 'termite',
    }));
    // Never frozen counts that disagree with stored rows.
    const consistent = async (f, out) => {
      const rows = await checksByNumber(f);
      if (out.status === 200) expect(rows).toHaveLength(4);
      else {
        expect(out).toMatchObject({ status: 409, body: { code: 'station_roster_changed' } });
        expect(rows).toEqual([]);
        expect(await mockPg('service_records').where({ customer_id: f.customerId })).toEqual([]);
      }
    };

    test('a retire and a completion started together: the completion either refuses or commits all four checks first', async () => {
      for (let round = 0; round < 3; round += 1) {
        const f = await seedVisit();
        try {
          const [out] = await Promise.all([
            complete(f, sheetBody(f, [], 'termite_bait_station', TERMITE)),
            officeRetire(f, f.stationIds[3]),
          ]);
          await consistent(f, out);
        } finally { await cleanup(f); }
      }
    });

    test('a retire waits while a transaction holds the roster lock, and a retire-only office save takes it', async () => {
      const f = await seedVisit();
      try {
        let retired = false;
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        const holder = mockPg.transaction(async (trx) => {
          await TermiteStations.lockStationRoster(trx, f.customerId, 'termite');
          await held;
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        const retire = officeRetire(f, f.stationIds[3]).then(() => { retired = true; });
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(retired).toBe(false);
        release();
        await holder;
        await retire;
        expect(retired).toBe(true);
      } finally { await cleanup(f); }
    });

    test('the check rows are stored by the completion itself: a station retired right after the commit keeps its row', async () => {
      const f = await seedVisit();
      const original = TermiteStations.syncStationsForCompletion;
      const spy = jest.spyOn(TermiteStations, 'syncStationsForCompletion');
      try {
        // The post-commit sync (the second call) is made to fail: the rows must
        // already be there from the completion's own transaction (the first).
        let calls = 0;
        spy.mockImplementation(async (...args) => {
          calls += 1;
          if (calls > 1) throw new Error('post-commit sync down');
          return original(...args);
        });
        const out = await complete(f, sheetBody(f, [null, 'activity', null, null], 'termite_bait_station', { ...TERMITE, stations_with_activity: '1', termite_activity: 'Active termites present', bait_consumption: 'Light feeding' }));
        expect(out).toMatchObject({ status: 200 });
        expect(calls).toBe(2);
        expect(await checksByNumber(f)).toEqual([[1, 'ok'], [2, 'activity'], [3, 'ok'], [4, 'ok']]);
      } finally { spy.mockRestore(); await cleanup(f); }
    });

    test('the full form\'s body is not written in the transaction: its sync stays post-commit', async () => {
      const f = await seedVisit();
      const spy = jest.spyOn(TermiteStations, 'syncStationsForCompletion');
      try {
        const out = await complete(f, fullFormBody(f, [], 'termite_bait_station', TERMITE));
        expect(out).toMatchObject({ status: 200 });
        expect(spy).toHaveBeenCalledTimes(1);
        expect(await checksByNumber(f)).toHaveLength(4);
      } finally { spy.mockRestore(); await cleanup(f); }
    });
  });

  // Codex P2 on #6205: the checks submitted must be exactly the roster the sheet
  // says it checked; otherwise the counts and report would claim more than is stored.
  describe('the submitted checks are bound to the validated roster', () => {
    const TERMITE = { total_stations: '4', stations_checked: '4', stations_inaccessible: '0', stations_with_activity: '0', termite_activity: 'None observed', bait_consumption: 'None — bait intact' };
    const withEntries = (f, termiteStations) => ({ ...sheetBody(f, [], 'termite_bait_station', TERMITE), termiteStations });
    const refusedClean = async (f, termiteStations) => {
      const out = await complete(f, withEntries(f, termiteStations));
      expect(out).toMatchObject({ status: 400, body: { code: 'termite_stations_invalid' } });
      expect(await checksByNumber(f)).toEqual([]);
      expect(await mockPg('service_records').where({ customer_id: f.customerId })).toEqual([]);
      expect((await mockPg('scheduled_services').where({ id: f.serviceId }).first()).status).toBe('confirmed');
    };

    test('a subset of the roster is refused, nothing written', async () => {
      const f = await seedVisit();
      try { await refusedClean(f, f.stationIds.slice(0, 2).map((id) => ({ id, status: 'ok' }))); } finally { await cleanup(f); }
    });

    test('a superset is refused, nothing written', async () => {
      const f = await seedVisit();
      try { await refusedClean(f, [...f.stationIds, randomUUID()].map((id) => ({ id, status: 'ok' }))); } finally { await cleanup(f); }
    });

    test('different ids are refused, nothing written', async () => {
      const f = await seedVisit();
      try { await refusedClean(f, [...f.stationIds.slice(0, 3), randomUUID()].map((id) => ({ id, status: 'ok' }))); } finally { await cleanup(f); }
    });

    test('the full set writes a row for every station', async () => {
      const f = await seedVisit();
      try {
        const out = await complete(f, withEntries(f, f.stationIds.map((id) => ({ id, status: 'ok' }))));
        expect(out).toMatchObject({ status: 200 });
        expect(await checksByNumber(f)).toHaveLength(4);
      } finally { await cleanup(f); }
    });
  });
});

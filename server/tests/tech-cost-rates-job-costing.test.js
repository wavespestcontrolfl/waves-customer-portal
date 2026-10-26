// L11a (GATE_TECH_COST_RATES): calculateJobCost with technician and vehicle cost cards.
// Gate off, or no card in effect = today's loaded_labor_rate x on-job hours and
// drive_cost_per_stop, to the cent. Synthetic ids and numbers only.
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/ad-attribution-sync', () => ({
  syncCustomerAdAttribution: jest.fn().mockResolvedValue({}),
}));

const jobCosting = require('../services/job-costing');

const { calculateJobCost } = jobCosting;
const GATE = 'GATE_TECH_COST_RATES';

// The decision-page W-2 card: $21.00 an hour -> $27.25 per worked hour. Vehicle: fixed
// $10,200 a year over 1,930 worked hours = $5.28 per worked hour, $0.23 per mile.
const W2_CARD = {
  id: 'card-w2',
  technician_id: 'tech-1',
  effective_date: '2026-01-01',
  created_at: '2026-01-01T00:00:00Z',
  kind: 'w2',
  imputed_hourly_rate: null,
  paid_hours_per_week: '40.00',
  paid_hours_per_day: '10.00',
  health_money_monthly: '200.00',
  retirement_pct: '2.00',
  workers_comp_pct: '4.00',
  paid_days_off_per_year: '15.0',
  vehicle_equipment_id: 'veh-1',
};
const VEHICLE_CARD = {
  id: 'card-veh',
  equipment_id: 'veh-1',
  effective_date: '2026-01-01',
  created_at: '2026-01-01T00:00:00Z',
  loss_of_value_per_year: '6000.00',
  insurance_per_year: '2400.00',
  loan_interest_per_year: '1200.00',
  other_fixed_per_year: '600.00',
  fuel_per_mile: '0.1500',
  upkeep_per_mile: '0.0800',
};
const imputedCard = (id, effectiveDate, rate) => ({
  ...W2_CARD, id, effective_date: effectiveDate, created_at: `${effectiveDate}T00:00:00Z`, kind: 'imputed', imputed_hourly_rate: rate, vehicle_equipment_id: null,
});

// One hour on site.
const SVC = {
  id: 'svc-1',
  customer_id: 'cust-1',
  technician_id: 'tech-1',
  service_type: 'Quarterly Pest Control Service',
  scheduled_date: '2026-10-26',
  status: 'completed',
  estimated_price: 129,
  actual_start_time: '2026-10-26T14:00:00Z',
  actual_end_time: '2026-10-26T15:00:00Z',
  service_time_minutes: null,
};
const RECORD = { id: 'rec-1', status: 'completed', structured_notes: { visitOutcome: 'completed' } };
const FIN = { loaded_labor_rate: 35, drive_cost_per_stop: 6 };

function fakeDb({
  svc = SVC,
  record = RECORD,
  technicianCards = [W2_CARD],
  vehicleCards = [VEHICLE_CARD],
  technicians = [{ id: 'tech-1', pay_rate: '21.00' }],
  legs = null, // null = the table does not exist; an array = the table with these rows
} = {}) {
  const SR_COLS = {
    scheduled_service_id: {}, status: {}, revenue: {}, material_cost: {}, labor_hours: {}, labor_cost: {}, drive_cost: {},
    total_job_cost: {}, gross_profit: {}, gross_margin_pct: {}, revenue_per_man_hour: {}, vehicle_fixed_cost: {},
  };
  const stores = {
    technician_cost_cards: technicianCards,
    vehicle_cost_cards: vehicleCards,
    technicians,
    visit_gps_legs: legs || [],
  };
  const writes = { jobCosts: [], serviceRecordUpdates: [], legQueries: 0, hasTableCalls: 0 };
  const db = (table) => {
    const predicates = [];
    const wheres = [];
    let orderSpec = [];
    const chain = {
      where: (...args) => {
        wheres.push(args[0]);
        const [a, op, val] = args;
        if (a && typeof a === 'object') predicates.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (args.length === 3 && op === '<=') predicates.push((r) => r[a] <= val);
        else if (args.length === 2) predicates.push((r) => r[a] === op);
        return chain;
      },
      whereNot: () => chain,
      whereNotNull: () => chain,
      whereBetween: () => chain,
      leftJoin: () => chain,
      // A store table answers distinct(col) with its matching rows' distinct values (the shared
      // vehicle read); any other table keeps chaining.
      distinct: (col) => {
        if (!stores[table]) return chain;
        const values = [...new Set(stores[table].filter((r) => predicates.every((p) => p(r))).map((r) => r[col]))];
        return Promise.resolve(values.map((value) => ({ [col]: value })));
      },
      orderBy: (spec, dir) => {
        orderSpec = Array.isArray(spec) ? spec : [{ column: spec, order: dir || 'asc' }];
        return chain;
      },
      limit: () => Promise.resolve(record ? [record] : []),
      columnInfo: () => Promise.resolve(SR_COLS),
      select: () => Promise.resolve([]),
      forUpdate: () => chain,
      first: (...cols) => {
        if (table === 'scheduled_services') return Promise.resolve(svc);
        if (table === 'service_records') return Promise.resolve(record);
        if (table === 'company_financials') return Promise.resolve(FIN);
        if (table === 'job_costs') return Promise.resolve(null);
        if (stores[table]) {
          if (table === 'visit_gps_legs') writes.legQueries += 1;
          const rows = stores[table].filter((r) => predicates.every((p) => p(r)));
          rows.sort((a, b) => {
            for (const { column, order, nulls } of orderSpec) {
              const av = a[column]; const bv = b[column];
              if (av === bv) continue;
              if (av == null || bv == null) return (av == null ? -1 : 1) * (nulls === 'last' ? -1 : 1);
              const cmp = av < bv ? -1 : 1;
              return order === 'desc' ? -cmp : cmp;
            }
            return 0;
          });
          const row = rows[0];
          if (!row) return Promise.resolve(undefined);
          return Promise.resolve(cols.length ? Object.fromEntries(cols.map((c) => [c, row[c]])) : row);
        }
        return Promise.resolve(null);
      },
      insert: (row) => { if (table === 'job_costs') writes.jobCosts.push(row); return Promise.resolve([1]); },
      update: (upd) => { if (table === 'service_records') writes.serviceRecordUpdates.push(upd); return Promise.resolve(1); },
    };
    return chain;
  };
  db.schema = {
    hasTable: async (name) => {
      if (name === 'visit_gps_legs') writes.hasTableCalls += 1;
      return name === 'visit_gps_legs' && legs !== null;
    },
  };
  db.transaction = async (fn) => fn(db);
  db.writes = writes;
  return db;
}

const marked = (ownerServiceId, allocatedMinutes) => ({
  ...RECORD,
  structured_notes: {
    visitOutcome: 'completed',
    visitDriveCostAllocation: { version: 1, packetId: 'packet-1', ownerServiceId },
    visitDurationAllocation: { version: 1, allocatedMinutes },
  },
});

describe('calculateJobCost with technician cost cards (GATE_TECH_COST_RATES)', () => {
  const OLD = process.env[GATE];
  beforeEach(() => {
    jobCosting._resetVisitGpsLegsCache();
    delete process.env[GATE];
  });
  afterAll(() => {
    if (OLD === undefined) delete process.env[GATE]; else process.env[GATE] = OLD;
  });

  describe('today: gate off, or no card in effect', () => {
    test('gate off: loaded_labor_rate x on-job hours and drive_cost_per_stop, even with a card on file', async () => {
      const db = fakeDb();
      const res = await calculateJobCost('svc-1', db);
      expect(res.labor_cost).toBe(35);
      expect(res.drive_cost).toBe(6);
      expect(res.total_cost).toBe(41);
      expect(res.costRates).toBeNull();
      expect(db.writes.serviceRecordUpdates[0].vehicle_fixed_cost).toBeNull();
      expect(db.writes.jobCosts[0]).not.toHaveProperty('vehicle_fixed_cost');
      // Nothing about cost cards is read at all.
      expect(db.writes.hasTableCalls).toBe(0);
      expect(db.writes.legQueries).toBe(0);
    });

    test('the gate is strict: "1", "TRUE" and "yes" do not turn it on', async () => {
      for (const value of ['1', 'TRUE', 'yes', '']) {
        process.env[GATE] = value;
        const res = await calculateJobCost('svc-1', fakeDb());
        expect(res.labor_cost).toBe(35);
        expect(res.drive_cost).toBe(6);
      }
    });

    test('gate on, technician has no card: exactly the gate-off numbers', async () => {
      const off = await calculateJobCost('svc-1', fakeDb({ technicianCards: [] }));
      process.env[GATE] = 'true';
      const db = fakeDb({ technicianCards: [] });
      const on = await calculateJobCost('svc-1', db);
      expect(on).toEqual(off);
      expect(db.writes.legQueries).toBe(0);
      expect(db.writes.hasTableCalls).toBe(0);
    });

    test('gate on, the only card belongs to another technician: today\'s numbers', async () => {
      process.env[GATE] = 'true';
      const res = await calculateJobCost('svc-1', fakeDb({ technicianCards: [{ ...W2_CARD, technician_id: 'tech-2' }] }));
      expect(res.labor_cost).toBe(35);
      expect(res.drive_cost).toBe(6);
    });

    test('gate on, a visit before the first card falls back (never the oldest card)', async () => {
      process.env[GATE] = 'true';
      const res = await calculateJobCost('svc-1', fakeDb({ svc: { ...SVC, scheduled_date: '2025-12-31' } }));
      expect(res.labor_cost).toBe(35);
      expect(res.drive_cost).toBe(6);
    });

    test('gate on, a W-2 card for a technician with no pay rate: today\'s numbers', async () => {
      process.env[GATE] = 'true';
      const res = await calculateJobCost('svc-1', fakeDb({ technicians: [{ id: 'tech-1', pay_rate: null }] }));
      expect(res.labor_cost).toBe(35);
      expect(res.drive_cost).toBe(6);
    });

    test('gate on, a visit with no technician: today\'s numbers', async () => {
      process.env[GATE] = 'true';
      const res = await calculateJobCost('svc-1', fakeDb({ svc: { ...SVC, technician_id: null } }));
      expect(res.labor_cost).toBe(35);
      expect(res.drive_cost).toBe(6);
    });
  });

  describe('gate on with a card in effect', () => {
    beforeEach(() => { process.env[GATE] = 'true'; });

    test('a matched GPS leg: its drive minutes and miles, charged with the on-site hour', async () => {
      const db = fakeDb({
        legs: [{ scheduled_service_id: 'svc-1', status: 'matched', drive_minutes: '20.00', drive_miles: '8.00' }],
      });
      const res = await calculateJobCost('svc-1', db);
      // 60 on site + 20 drive = 80 min = 1.3333 h.
      expect(res.labor_cost).toBe(36.33); // 27.25 x 1.3333
      expect(res.drive_cost).toBe(8.88); // 0.23 x 8 miles = 1.84, plus 5.28 x 1.3333 = 7.04
      expect(res.total_cost).toBe(45.21);
      expect(res.laborHours).toBe(1); // labor_hours stays the on-job hours
      expect(res.costRates).toMatchObject({ onJobMinutes: 60, driveMinutes: 20, driveMiles: 8, driveSource: 'gps_leg' });
      expect(db.writes.serviceRecordUpdates[0]).toMatchObject({ labor_cost: 36.33, drive_cost: 8.88, labor_hours: 1 });
      expect(db.writes.jobCosts[0]).toMatchObject({ labor_cost: 36.33, drive_cost: 8.88 });
      // The vehicle fixed part of drive_cost, kept beside it for the EBITDA bridge: 5.28 x 1.3333 h.
      expect(db.writes.serviceRecordUpdates[0].vehicle_fixed_cost).toBe(7.04);
      expect(res.costRates.vehicleFixedCost).toBe(7.04);
    });

    test('a stop shared by two physical visits splits its drive two ways', async () => {
      const res = await calculateJobCost('svc-1', fakeDb({
        legs: [{ scheduled_service_id: 'svc-1', status: 'matched', drive_minutes: '20.00', drive_miles: '8.00', shared_stop_count: 2, leg_group_key: 'svc-1' }],
      }));
      expect(res.costRates).toMatchObject({ driveMinutes: 10, driveMiles: 4, driveSource: 'gps_leg' });
      // 60 + 10 = 70 min.
      expect(res.labor_cost).toBe(31.79); // 27.25 x 70 / 60
    });

    test('a grouped visit with no closeout marker: its one leg goes to the lowest service id only', async () => {
      const legsOf = [
        { scheduled_service_id: 'svc-a', status: 'matched', drive_minutes: '20.00', drive_miles: '8.00', shared_stop_count: 1, leg_group_key: 'visit-1' },
        { scheduled_service_id: 'svc-b', status: 'matched', drive_minutes: '20.00', drive_miles: '8.00', shared_stop_count: 1, leg_group_key: 'visit-1' },
      ];
      const a = await calculateJobCost('svc-a', fakeDb({ svc: { ...SVC, id: 'svc-a' }, legs: legsOf }));
      const b = await calculateJobCost('svc-b', fakeDb({ svc: { ...SVC, id: 'svc-b' }, legs: legsOf }));
      expect(a.costRates).toMatchObject({ driveMinutes: 20, driveMiles: 8, driveSource: 'gps_leg' });
      expect(b.costRates).toMatchObject({ driveMinutes: 0, driveMiles: 0, driveSource: 'group_member' });
    });

    test('a grouped visit WITH a closeout marker: the marked owner carries the leg even when it is not the lowest id', async () => {
      const legsOf = [
        { scheduled_service_id: 'svc-a', status: 'matched', drive_minutes: '20.00', drive_miles: '8.00', shared_stop_count: 1, leg_group_key: 'visit-1' },
        { scheduled_service_id: 'svc-b', status: 'matched', drive_minutes: '20.00', drive_miles: '8.00', shared_stop_count: 1, leg_group_key: 'visit-1' },
      ];
      const b = await calculateJobCost('svc-b', fakeDb({ svc: { ...SVC, id: 'svc-b' }, record: marked('svc-b', 30), legs: legsOf }));
      const a = await calculateJobCost('svc-a', fakeDb({ svc: { ...SVC, id: 'svc-a' }, record: marked('svc-b', 30), legs: legsOf }));
      expect(b.costRates).toMatchObject({ driveMinutes: 20, driveMiles: 8, driveSource: 'gps_leg' });
      expect(a.costRates).toMatchObject({ driveMinutes: 0, driveMiles: 0, driveSource: 'none' });
    });

    test('the table exists but has no row for the visit: 24 minutes and 11 miles', async () => {
      const res = await calculateJobCost('svc-1', fakeDb({ legs: [] }));
      expect(jobCosting.DEFAULT_DRIVE_MINUTES_PER_STOP).toBe(24);
      expect(jobCosting.DEFAULT_DRIVE_MILES_PER_STOP).toBe(11);
      // 60 + 24 = 84 min = 1.4 h.
      expect(res.labor_cost).toBe(38.15); // 27.25 x 1.4
      expect(res.drive_cost).toBe(9.92); // 0.23 x 11 = 2.53, plus 5.28 x 1.4 = 7.392
      expect(res.costRates).toMatchObject({ driveMinutes: 24, driveMiles: 11, driveSource: 'default' });
    });

    test.each(['no_vehicle', 'no_destination', 'no_stop', 'ambiguous'])('a leg with status %s is not used: defaults', async (status) => {
      const res = await calculateJobCost('svc-1', fakeDb({
        legs: [{ scheduled_service_id: 'svc-1', status, drive_minutes: '5.00', drive_miles: '1.00' }],
      }));
      expect(res.labor_cost).toBe(38.15);
      expect(res.drive_cost).toBe(9.92);
    });

    test('the table does not exist (trip link not merged): defaults, no leg query, checked once and remembered when missing', async () => {
      const db = fakeDb({ legs: null });
      const first = await calculateJobCost('svc-1', db);
      const second = await calculateJobCost('svc-1', db);
      expect(first.labor_cost).toBe(38.15);
      expect(first.drive_cost).toBe(9.92);
      expect(second.drive_cost).toBe(9.92);
      expect(db.writes.legQueries).toBe(0);
      expect(db.writes.hasTableCalls).toBe(1); // the second visit reads the cached answer
    });

    test('an existing table is cached for good', async () => {
      const db = fakeDb({ legs: [] });
      await calculateJobCost('svc-1', db);
      await calculateJobCost('svc-1', db);
      expect(db.writes.hasTableCalls).toBe(1);
      expect(db.writes.legQueries).toBe(2);
    });

    test('a matched leg with no miles (a trip with no mileage log) takes the default miles', async () => {
      const res = await calculateJobCost('svc-1', fakeDb({
        legs: [{ scheduled_service_id: 'svc-1', status: 'matched', drive_minutes: '20.00', drive_miles: null }],
      }));
      expect(res.costRates).toMatchObject({ driveMinutes: 20, driveMiles: 11, driveSource: 'gps_leg' });
      expect(res.drive_cost).toBe(9.57); // 0.23 x 11 = 2.53, plus 5.28 x 1.3333 = 7.04
    });

    test('no vehicle on the card: per mile and fixed are 0, labor still uses the card', async () => {
      const res = await calculateJobCost('svc-1', fakeDb({
        technicianCards: [{ ...W2_CARD, vehicle_equipment_id: null }], legs: [],
      }));
      expect(res.drive_cost).toBe(0);
      expect(res.labor_cost).toBe(38.15);
    });

    test('a vehicle with no vehicle card yet counts as no vehicle', async () => {
      const res = await calculateJobCost('svc-1', fakeDb({ vehicleCards: [], legs: [] }));
      expect(res.drive_cost).toBe(0);
      expect(res.labor_cost).toBe(38.15);
    });

    test('a visit not completed yet has driven nowhere: no drive minutes, no miles', async () => {
      const res = await calculateJobCost('svc-1', fakeDb({ svc: { ...SVC, status: 'scheduled' }, legs: [] }));
      expect(res.costRates).toMatchObject({ driveMinutes: 0, driveMiles: 0 });
      expect(res.drive_cost).toBe(5.28); // fixed on the 60 on-site minutes only
    });

    test('an imputed card states the labor rate', async () => {
      const res = await calculateJobCost('svc-1', fakeDb({
        technicianCards: [imputedCard('imp', '2026-01-01', '30.00')], legs: [],
      }));
      expect(res.labor_cost).toBe(42); // 30.00 x 1.4
      expect(res.drive_cost).toBe(0);
    });
  });

  describe('combined closeout: the stop is driven once', () => {
    beforeEach(() => { process.env[GATE] = 'true'; });
    const legs = [];

    // Two visits at one stop: 36 and 24 allocated on-site minutes (60 in all), one 24-minute,
    // 11-mile drive. The marked drive-cost owner carries the drive minutes and miles; each
    // member carries labor and vehicle fixed cost for its own allocated minutes, so the stop
    // adds up to the stop's real 84 minutes (1.4 h) and nothing is counted twice.
    test('the marked owner carries the drive; its own minutes carry labor and fixed cost', async () => {
      const db = fakeDb({ svc: { ...SVC, id: 'svc-owner' }, record: marked('svc-owner', 36), legs });
      const res = await calculateJobCost('svc-owner', db);
      expect(res.costRates).toMatchObject({ onJobMinutes: 36, driveMinutes: 24, driveMiles: 11 });
      expect(res.labor_cost).toBe(27.25); // 27.25 x (36 + 24) / 60
      expect(res.drive_cost).toBe(7.81); // 0.23 x 11 = 2.53, plus 5.28 x 1 h
    });

    test('the other member has no drive: labor and fixed cost for its own minutes only', async () => {
      const db = fakeDb({ svc: { ...SVC, id: 'svc-other' }, record: marked('svc-owner', 24), legs });
      const res = await calculateJobCost('svc-other', db);
      expect(res.costRates).toMatchObject({ onJobMinutes: 24, driveMinutes: 0, driveMiles: 0, driveSource: 'none' });
      expect(res.labor_cost).toBe(10.9); // 27.25 x 24 / 60
      expect(res.drive_cost).toBe(2.11); // 5.28 x 0.4 h, no per-mile
      expect(db.writes.legQueries).toBe(0);
    });

    test('together the two members cost the stop once: 84 minutes of labor, vehicle and drive once', async () => {
      const owner = await calculateJobCost('svc-owner', fakeDb({ svc: { ...SVC, id: 'svc-owner' }, record: marked('svc-owner', 36), legs }));
      const other = await calculateJobCost('svc-other', fakeDb({ svc: { ...SVC, id: 'svc-other' }, record: marked('svc-owner', 24), legs }));
      expect(Math.round((owner.labor_cost + other.labor_cost) * 100) / 100).toBe(38.15); // one visit of 84 minutes
      expect(Math.round((owner.drive_cost + other.drive_cost) * 100) / 100).toBe(9.92); // 2.53 + 7.392
    });

    test('a record with no marker keeps the legacy rule: every visit is charged its own drive', async () => {
      const res = await calculateJobCost('svc-1', fakeDb({ legs }));
      expect(res.costRates).toMatchObject({ driveMinutes: 24, driveMiles: 11 });
    });

    test('gate off, the same two members get today\'s answer: owner one stop cost, other zero', async () => {
      delete process.env[GATE];
      const owner = await calculateJobCost('svc-owner', fakeDb({ svc: { ...SVC, id: 'svc-owner' }, record: marked('svc-owner', 36), legs }));
      const other = await calculateJobCost('svc-other', fakeDb({ svc: { ...SVC, id: 'svc-other' }, record: marked('svc-owner', 24), legs }));
      expect(owner.drive_cost).toBe(6);
      expect(other.drive_cost).toBe(0);
    });
  });

  describe('cards are dated: the visit date picks the card', () => {
    beforeEach(() => { process.env[GATE] = 'true'; });
    const cards = [imputedCard('a', '2026-01-01', '30.00'), imputedCard('b', '2026-09-01', '40.00')];

    test.each([
      ['2026-01-01', 42], // card a on its own first day: 30.00 x 1.4
      ['2026-08-31', 42],
      ['2026-09-01', 56], // card b from its effective date: 40.00 x 1.4
      ['2026-10-26', 56],
    ])('visit on %s costs labor %p', async (date, labor) => {
      const res = await calculateJobCost('svc-1', fakeDb({ svc: { ...SVC, scheduled_date: date }, technicianCards: cards, legs: [] }));
      expect(res.labor_cost).toBe(labor);
    });

    test('before the first card the company labor rate applies', async () => {
      const res = await calculateJobCost('svc-1', fakeDb({ svc: { ...SVC, scheduled_date: '2025-12-31' }, technicianCards: cards, legs: [] }));
      expect(res.labor_cost).toBe(35);
      expect(res.drive_cost).toBe(6);
    });

    test('a Date from the database reads as its calendar day (local midnight)', async () => {
      const res = await calculateJobCost('svc-1', fakeDb({ svc: { ...SVC, scheduled_date: new Date(2026, 7, 31) }, technicianCards: cards, legs: [] }));
      expect(res.labor_cost).toBe(42);
    });
  });
});

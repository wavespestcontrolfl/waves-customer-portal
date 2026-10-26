// L11a (GATE_TECH_COST_RATES): the pure rate math in services/tech-cost-rates.js.
// Pinned to the "Tech Cost per Hour" decision page. Synthetic numbers only.
const {
  computeTechnicianRate, computeVehicleRate, cardInEffect, loadVisitRates, dateString,
} = require('../services/tech-cost-rates');
const { RATES } = require('../services/payroll-calc');

// The decision page: $21.00 wage, 40 h/week, 10 h/day, $200 a month health money, 2% retirement,
// 4% workers' comp, 15 paid days off a year.
const PINNED = {
  kind: 'w2',
  paid_hours_per_week: '40.00',
  paid_hours_per_day: '10.00',
  health_money_monthly: '200.00',
  retirement_pct: '2.00',
  workers_comp_pct: '4.00',
  paid_days_off_per_year: '15.0',
};

const byKey = (rate) => Object.fromEntries(rate.lines.map((l) => [l.key, l]));

describe('computeTechnicianRate: the decision-page case', () => {
  const rate = computeTechnicianRate(PINNED, '21.00');

  test('paid hours 2,080 and worked hours 1,930 (15 days x 10 h off)', () => {
    expect(rate.ok).toBe(true);
    expect(rate.paidHoursPerYear).toBe(2080);
    expect(rate.workedHoursPerYear).toBe(1930);
  });

  test('every yearly line, in cents', () => {
    const lines = byKey(rate);
    expect(lines.wages.perYearCents).toBe(4368000); // 21.00 x 2,080
    expect(lines.health.perYearCents).toBe(240000); // 200 x 12
    expect(lines.social_medicare.perYearCents).toBe(352512); // 7.65% of 46,080.00
    expect(lines.futa.perYearCents).toBe(4200); // 0.6% of the first 7,000.00
    expect(lines.reemployment.perYearCents).toBe(18900); // 2.7% of the first 7,000.00
    expect(lines.workers_comp.perYearCents).toBe(184320); // 4% of 46,080.00
    expect(lines.retirement.perYearCents).toBe(92160); // 2% of 46,080.00
  });

  test('$52,601 a year, $25.29 per paid hour, $27.25 per worked hour', () => {
    // The page shows $52,601 because it rounds to whole dollars: the exact total is
    // $52,600.92 (5,260,092 cents). Per paid hour 52,600.92 / 2,080 = 25.2889 -> $25.29.
    // Per worked hour 52,600.92 / 1,930 = 27.2543 -> $27.25.
    expect(rate.totalPerYearCents).toBe(5260092);
    expect(Math.round(rate.totalPerYearCents / 100)).toBe(52601);
    expect(rate.laborPerPaidHourCents).toBe(2529);
    expect(rate.laborPerWorkedHourCents).toBe(2725);
  });

  test('each line also reports per paid hour and per worked hour', () => {
    const wages = byKey(rate).wages;
    expect(wages.perPaidHourCents).toBe(2100);
    expect(wages.perWorkedHourCents).toBe(2263); // 43,680 / 1,930 = 22.6321
  });

  test('FUTA and Florida reemployment read the payroll RATES and its $7,000 base', () => {
    const lines = byKey(rate);
    expect(lines.futa.perYearCents).toBe(Math.round((RATES.futaAndStateWageBaseCents * RATES.futaBp) / 10000));
    expect(lines.reemployment.perYearCents).toBe(Math.round((RATES.futaAndStateWageBaseCents * RATES.floridaNewEmployerBp) / 10000));
  });
});

describe('computeTechnicianRate: the $7,000 cap', () => {
  test('wages under $7,000 are taxed in full, wages over are capped', () => {
    // $2.00 x 2,080 h = $4,160: below the base, so the tax is on all of it.
    const low = byKey(computeTechnicianRate({ ...PINNED, health_money_monthly: '0', retirement_pct: '0', workers_comp_pct: '0' }, '2.00'));
    expect(low.wages.perYearCents).toBe(416000);
    expect(low.futa.perYearCents).toBe(2496); // 0.6% of 4,160.00
    expect(low.reemployment.perYearCents).toBe(11232); // 2.7% of 4,160.00
    // $100.00 x 2,080 h = $208,000: the tax stays at the first $7,000.
    const high = byKey(computeTechnicianRate({ ...PINNED, health_money_monthly: '0', retirement_pct: '0', workers_comp_pct: '0' }, '100.00'));
    expect(high.futa.perYearCents).toBe(4200);
    expect(high.reemployment.perYearCents).toBe(18900);
  });

  test('the cap is on wages only: health money does not move it', () => {
    const rate = byKey(computeTechnicianRate({ ...PINNED, health_money_monthly: '5000' }, '2.00'));
    expect(rate.futa.perYearCents).toBe(2496);
  });
});

describe('computeTechnicianRate: a W-2 card needs a pay rate', () => {
  test.each([null, undefined, '', '0', '0.00'])('pay rate %p gives no rate', (payRate) => {
    expect(computeTechnicianRate(PINNED, payRate)).toEqual({ ok: false, reason: 'no_pay_rate' });
  });

  test('no card gives no rate', () => {
    expect(computeTechnicianRate(null, '21.00')).toEqual({ ok: false, reason: 'no_card' });
  });

  test('a card that leaves no worked hours gives no rate', () => {
    const card = { ...PINNED, paid_days_off_per_year: '120.0', paid_hours_per_day: '24.00', paid_hours_per_week: '10.00' };
    expect(computeTechnicianRate(card, '21.00')).toEqual({ ok: false, reason: 'no_worked_hours' });
  });
});

describe('computeTechnicianRate: an imputed card', () => {
  const imputed = {
    kind: 'imputed',
    imputed_hourly_rate: '30.00',
    paid_hours_per_week: '40.00',
    paid_hours_per_day: '10.00',
    health_money_monthly: '0.00',
    retirement_pct: '0.00',
    workers_comp_pct: '0.00',
    paid_days_off_per_year: '10.0',
  };

  test('labor per worked hour is the stated rate; pay rate is not needed', () => {
    const rate = computeTechnicianRate(imputed, null);
    expect(rate.ok).toBe(true);
    expect(rate.laborPerWorkedHourCents).toBe(3000);
    expect(rate.workedHoursPerYear).toBe(1980); // 2,080 - 10 x 10
    expect(rate.totalPerYearCents).toBe(5940000); // 30.00 x 1,980
    expect(rate.laborPerPaidHourCents).toBe(2856); // 59,400 / 2,080 = 28.5577
  });

  test('a stated rate of zero or none gives no rate', () => {
    expect(computeTechnicianRate({ ...imputed, imputed_hourly_rate: null }, null)).toEqual({ ok: false, reason: 'no_imputed_rate' });
    expect(computeTechnicianRate({ ...imputed, imputed_hourly_rate: '0' }, null)).toEqual({ ok: false, reason: 'no_imputed_rate' });
  });
});

describe('computeVehicleRate', () => {
  const vehicle = {
    loss_of_value_per_year: '6000.00',
    insurance_per_year: '2400.00',
    loan_interest_per_year: '1200.00',
    other_fixed_per_year: '600.00',
    fuel_per_mile: '0.1500',
    upkeep_per_mile: '0.0800',
  };

  test('fixed per worked hour spreads the four fixed lines over the technician worked hours', () => {
    const tech = computeTechnicianRate(PINNED, '21.00');
    const rate = computeVehicleRate(vehicle, tech.workedHoursPerYearHundredths);
    expect(rate.ok).toBe(true);
    expect(rate.fixedPerYearCents).toBe(1020000);
    // 10,200 / 1,930 h = 5.28497 -> $5.28
    expect(rate.fixedPerWorkedHourCents).toBe(528);
    expect(rate.fixedLines.map((l) => l.perYearCents)).toEqual([600000, 240000, 120000, 60000]);
    expect(rate.spreadOverHoursPerYear).toBe(1930);
  });

  test('an imputed card spreads over its own worked hours the same way', () => {
    const tech = computeTechnicianRate({
      kind: 'imputed', imputed_hourly_rate: '30.00', paid_hours_per_week: '40.00', paid_hours_per_day: '10.00', paid_days_off_per_year: '10.0',
    }, null);
    const rate = computeVehicleRate(vehicle, tech.workedHoursPerYearHundredths);
    expect(rate.fixedPerWorkedHourCents).toBe(515); // 10,200 / 1,980 = 5.1515
  });

  test('per mile is fuel plus upkeep, kept to four decimals', () => {
    const rate = computeVehicleRate(vehicle, 193000);
    expect(rate.perMileTenThousandths).toBe(2300);
    expect(rate.perMile).toBe(0.23);
  });

  test('a vehicle no technician drives has no hours: fixed per hour is 0, per mile stays', () => {
    const rate = computeVehicleRate(vehicle, 0);
    expect(rate.fixedPerWorkedHourCents).toBe(0);
    expect(rate.spreadOverHoursPerYear).toBeNull();
    expect(rate.perMileTenThousandths).toBe(2300);
  });

  test('no card, no rate', () => {
    expect(computeVehicleRate(null, 193000)).toEqual({ ok: false, reason: 'no_card' });
  });
});

describe('dateString', () => {
  test('reads a local-midnight Date and a string alike', () => {
    expect(dateString(new Date(2026, 9, 26))).toBe('2026-10-26');
    expect(dateString('2026-10-26T00:00:00.000Z')).toBe('2026-10-26');
    expect(dateString(null)).toBeNull();
    expect(dateString('nope')).toBeNull();
  });
});

// A chainable knex fake for the two card tables: it applies the same where / orderBy the
// in-effect rule sends, so the rule itself (greatest effective date on or before the day,
// tie newest created_at then id, nothing before the first card) is what is tested.
function fakeCardDb(tables) {
  const db = (table) => {
    const wheres = [];
    let orderSpec = [];
    const chain = {
      where: (a, op, val) => {
        if (typeof a === 'object') wheres.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (op === '<=') wheres.push((r) => r[a] <= val);
        else wheres.push((r) => r[a] === op);
        return chain;
      },
      orderBy: (spec) => { orderSpec = spec; return chain; },
      first: (...cols) => {
        const rows = (tables[table] || []).filter((r) => wheres.every((w) => w(r)));
        rows.sort((a, b) => {
          for (const { column, order, nulls } of orderSpec) {
            const av = a[column]; const bv = b[column];
            if (av === bv) continue;
            if (av == null || bv == null) {
              const nullFirst = nulls !== 'last';
              return (av == null ? -1 : 1) * (nullFirst ? 1 : -1);
            }
            const cmp = av < bv ? -1 : 1;
            return order === 'desc' ? -cmp : cmp;
          }
          return 0;
        });
        const row = rows[0] || null;
        if (!row || !cols.length) return Promise.resolve(row || undefined);
        return Promise.resolve(Object.fromEntries(cols.map((c) => [c, row[c]])));
      },
    };
    return chain;
  };
  return db;
}

describe('the card in effect on a date', () => {
  const rows = [
    { id: 'a', technician_id: 't1', effective_date: '2026-03-01', created_at: '2026-03-01T10:00:00Z' },
    { id: 'b', technician_id: 't1', effective_date: '2026-06-01', created_at: '2026-06-01T10:00:00Z' },
    { id: 'c', technician_id: 't1', effective_date: '2026-06-01', created_at: '2026-06-02T10:00:00Z' },
    { id: 'd', technician_id: 't1', effective_date: '2026-06-01', created_at: null },
    { id: 'z', technician_id: 't2', effective_date: '2026-01-01', created_at: '2026-01-01T10:00:00Z' },
  ];
  const db = fakeCardDb({ technician_cost_cards: rows });
  const pick = async (date) => (await cardInEffect(db, 'technician_cost_cards', 'technician_id', 't1', date))?.id || null;

  test('the greatest effective date on or before the day wins', async () => {
    expect(await pick('2026-03-01')).toBe('a');
    expect(await pick('2026-05-31')).toBe('a');
    expect(await pick('2026-12-31')).toBe('c');
  });

  test('same effective date: newest created_at, a missing created_at last', async () => {
    expect(await pick('2026-06-01')).toBe('c');
  });

  test('same date and created_at: the greatest id', async () => {
    const tied = fakeCardDb({ technician_cost_cards: [
      { id: 'm', technician_id: 't1', effective_date: '2026-06-01', created_at: 'x' },
      { id: 'n', technician_id: 't1', effective_date: '2026-06-01', created_at: 'x' },
    ] });
    expect((await cardInEffect(tied, 'technician_cost_cards', 'technician_id', 't1', '2026-06-01')).id).toBe('n');
  });

  test('before the first card there is NO card (never the oldest card)', async () => {
    expect(await pick('2026-02-28')).toBeNull();
  });

  test('another technician has its own cards; no usable date or key gives none', async () => {
    expect((await cardInEffect(db, 'technician_cost_cards', 'technician_id', 't2', '2026-02-01')).id).toBe('z');
    expect(await cardInEffect(db, 'technician_cost_cards', 'technician_id', 't1', null)).toBeNull();
    expect(await cardInEffect(db, 'technician_cost_cards', 'technician_id', null, '2026-02-01')).toBeNull();
  });
});

describe('loadVisitRates', () => {
  const techCard = { id: 'tc1', technician_id: 't1', effective_date: '2026-01-01', created_at: '2026-01-01T00:00:00Z', vehicle_equipment_id: 'v1', ...PINNED };
  const vehicleCard = {
    id: 'vc1', equipment_id: 'v1', effective_date: '2026-01-01', created_at: '2026-01-01T00:00:00Z',
    loss_of_value_per_year: '6000.00', insurance_per_year: '2400.00', loan_interest_per_year: '1200.00', other_fixed_per_year: '600.00',
    fuel_per_mile: '0.1500', upkeep_per_mile: '0.0800',
  };
  const tables = (extra = {}) => ({
    technician_cost_cards: [techCard],
    vehicle_cost_cards: [vehicleCard],
    technicians: [{ id: 't1', pay_rate: '21.00' }],
    ...extra,
  });

  test('a W-2 card with a vehicle gives labor, per mile and fixed per worked hour', async () => {
    const rates = await loadVisitRates(fakeCardDb(tables()), 't1', '2026-10-26');
    expect(rates).toEqual({
      cardId: 'tc1',
      kind: 'w2',
      laborPerWorkedHourCents: 2725,
      vehicle: { cardId: 'vc1', equipmentId: 'v1', perMileTenThousandths: 2300, fixedPerWorkedHourCents: 528 },
    });
  });

  test('no vehicle on the card: vehicle is null', async () => {
    const t = tables({ technician_cost_cards: [{ ...techCard, vehicle_equipment_id: null }] });
    expect((await loadVisitRates(fakeCardDb(t), 't1', '2026-10-26')).vehicle).toBeNull();
  });

  test('a vehicle with no card yet: vehicle is null', async () => {
    const t = tables({ vehicle_cost_cards: [] });
    expect((await loadVisitRates(fakeCardDb(t), 't1', '2026-10-26')).vehicle).toBeNull();
  });

  test('a visit before the first card, or a W-2 card with no pay rate, gives null', async () => {
    expect(await loadVisitRates(fakeCardDb(tables()), 't1', '2025-12-31')).toBeNull();
    expect(await loadVisitRates(fakeCardDb(tables({ technicians: [{ id: 't1', pay_rate: null }] })), 't1', '2026-10-26')).toBeNull();
  });

  test('a read failure is "no rate", never a throw', async () => {
    const broken = () => { throw new Error('relation does not exist'); };
    expect(await loadVisitRates(broken, 't1', '2026-10-26')).toBeNull();
  });
});

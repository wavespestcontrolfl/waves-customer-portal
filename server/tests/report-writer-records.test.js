// Writer records (GATE_REPORT_WRITER_RULES, four-section report): approved
// expectations and how-it-works wording, the next booked visit, the service
// type and the reach-out date, plus the phrases the screen then allows.
const {
  SERVICE_EXPECTATIONS, writerExpectations, howItWorksLines, reachOutDate, loadNextSameLineVisit, buildWriterRecords,
} = require('../services/service-report/report-writer-records');

const TAURUS = { name: 'Taurus SC', epaReg: '53883-279', role: 'insect-control application', method: 'perimeter_spray', methodLabel: 'perimeter spray', applicationArea: 'Exterior perimeter', targets: ['Ghost ants'] };
const ADVION = { name: 'Advion Ant Bait Gel', epaReg: '352-746', role: 'bait application', method: 'bait_placement', methodLabel: 'bait placement', applicationArea: 'Kitchen', targets: ['Ghost ants'] };

describe('writer expectations', () => {
  test('pest product classes give the approved lines and the longest closing window', () => {
    const { lines, windowDays } = writerExpectations({ line: 'pest', applications: [TAURUS, ADVION] });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^Non-repellent products .*ants may show up more for a few days/);
    expect(lines[1]).toMatch(/^Ants that find the bait carry it back to the colony/);
    expect(windowDays).toBe(14);
  });

  test('bait alone sets no closing window', () => {
    expect(writerExpectations({ line: 'pest', applications: [ADVION] }).windowDays).toBeNull();
  });

  test('services without product classes use their own lines; others get none', () => {
    expect(writerExpectations({ line: 'rodent', findingsType: 'rodent_trapping' }).lines).toEqual([...SERVICE_EXPECTATIONS.rodent_trapping]);
    expect(writerExpectations({ line: 'termite', findingsType: 'termite_bait_station' }).lines).toEqual([...SERVICE_EXPECTATIONS.termite_bait_station]);
    expect(writerExpectations({ line: 'mosquito', applications: [{ name: 'Bifen I/T', method: 'foliar_spray' }] }).lines)
      .toEqual([...SERVICE_EXPECTATIONS.mosquito]);
    expect(writerExpectations({ line: 'lawn' }).lines).toEqual([]);
  });

  test('the mosquito leaf line needs a recorded foliar application; the standing-water line always applies', () => {
    expect(writerExpectations({ line: 'mosquito' }).lines).toEqual([SERVICE_EXPECTATIONS.mosquito[1]]);
    expect(writerExpectations({ line: 'mosquito', applications: [{ name: 'Larvicide', method: 'spot_treatment' }] }).lines)
      .toEqual([SERVICE_EXPECTATIONS.mosquito[1]]);
  });

  test('no service line promises a visit, a check, a result or a price', () => {
    for (const text of Object.values(SERVICE_EXPECTATIONS).flat()) {
      expect(text).not.toMatch(/\b(?:we(?:'ll| will)|keep checking|guarantee\w*|free|included|covered)\b/i);
    }
  });
});

describe('how-it-works lines', () => {
  test('come from the approved wording, labeled with the recorded work', () => {
    expect(howItWorksLines([TAURUS])).toEqual([
      expect.stringMatching(/^- insect-control application, perimeter spray, Exterior perimeter: Pests can.t detect it/),
    ]);
  });

  test('an unmatched product, or a mismatched EPA number, gets none', () => {
    expect(howItWorksLines([{ name: 'Unknown Product', epaReg: '999-999' }])).toEqual([]);
    expect(howItWorksLines([{ ...TAURUS, epaReg: '432-1348' }])).toEqual([]);
  });
});

describe('reach-out date', () => {
  test('is the service date plus the window, as a calendar day', () => {
    expect(reachOutDate('2026-09-30', 14)).toEqual({ full: 'Wednesday, October 14', monthDay: 'October 14' });
    expect(reachOutDate('2026-12-25', 14)).toEqual({ full: 'Friday, January 8', monthDay: 'January 8' });
  });

  test('needs a date and a window', () => {
    expect(reachOutDate('2026-09-30', null)).toBeNull();
    expect(reachOutDate('not a date', 14)).toBeNull();
  });
});

// The visit's own row (first) and the bookings list (await) answer
// separately; whereNot({ id }) leaves the visit out of the list.
const HOME = { service_address_line1: '123 Main St', service_address_city: 'Bradenton', service_address_zip: '34209' };
const RENTAL = { service_address_line1: '456 Oak Ave', service_address_city: 'Bradenton', service_address_zip: '34209' };
function knexFor({ reportVisit = { id: 's1', ...HOME }, rows = [], services = [], fail = false } = {}) {
  const calls = [];
  const knex = jest.fn((table) => {
    let excluded = null;
    const answer = () => {
      if (fail) return Promise.reject(new Error('lookup down'));
      if (table === 'services') return Promise.resolve(services);
      return Promise.resolve(rows.filter((row) => row.id !== excluded));
    };
    const builder = new Proxy({}, {
      get(_, prop) {
        if (prop === 'then') return (resolve, reject) => answer().then(resolve, reject);
        if (prop === 'first') return () => (fail ? Promise.reject(new Error('lookup down')) : Promise.resolve(reportVisit));
        return (...args) => {
          calls.push([prop, ...args]);
          if (prop === 'whereNot') excluded = args[0]?.id ?? null;
          if (prop === 'modify') args[0](builder);
          return builder;
        };
      },
    });
    return builder;
  });
  knex.calls = calls;
  return knex;
}

describe('next visit on the same line', () => {
  test('is the first booked visit after this one on the same line, at this property', async () => {
    const knex = knexFor({ rows: [
      { id: 'n1', service_type: 'Lawn Care Visit', ...HOME },
      { id: 'n2', service_type: 'Quarterly Pest Control', ...HOME },
    ] });
    await expect(loadNextSameLineVisit({ knex, customerId: 'c1', scheduledServiceId: 's1', serviceYmd: '2026-09-30', line: 'pest' }))
      .resolves.toEqual({ state: 'scheduled', serviceType: 'Quarterly Pest Control' });
    expect(knex.calls).toEqual(expect.arrayContaining([
      ['where', 'scheduled_date', '>=', '2026-09-30'],
      ['whereIn', 'status', ['pending', 'confirmed', 'en_route', 'on_site']],
      ['whereNot', { id: 's1' }],
    ]));
  });

  test("a booking at another of the customer's properties never counts", async () => {
    const knex = knexFor({ rows: [{ id: 'n1', service_type: 'Quarterly Pest Control', ...RENTAL }] });
    await expect(loadNextSameLineVisit({ knex, customerId: 'c1', scheduledServiceId: 's1', serviceYmd: '2026-09-30', line: 'pest' }))
      .resolves.toEqual({ state: 'none' });
  });

  test('an earlier same-line booking with no property, or a visit with none, is unknown', async () => {
    const unplaced = knexFor({ rows: [
      { id: 'n1', service_type: 'Quarterly Pest Control' },
      { id: 'n2', service_type: 'Quarterly Pest Control', ...HOME },
    ] });
    await expect(loadNextSameLineVisit({ knex: unplaced, customerId: 'c1', scheduledServiceId: 's1', serviceYmd: '2026-09-30', line: 'pest' }))
      .resolves.toEqual({ state: 'unknown' });
    const unplacedVisit = knexFor({ reportVisit: { id: 's1' }, rows: [{ id: 'n2', service_type: 'Quarterly Pest Control', ...HOME }] });
    await expect(loadNextSameLineVisit({ knex: unplacedVisit, customerId: 'c1', scheduledServiceId: 's1', serviceYmd: '2026-09-30', line: 'pest' }))
      .resolves.toEqual({ state: 'unknown' });
  });

  test('none booked on the line', async () => {
    const knex = knexFor({ rows: [{ id: 'n1', service_type: 'Lawn Care Visit', ...HOME }] });
    await expect(loadNextSameLineVisit({ knex, customerId: 'c1', scheduledServiceId: 's1', serviceYmd: '2026-09-30', line: 'pest' })).resolves.toEqual({ state: 'none' });
  });

  test('a failed lookup is unknown, never "none booked"', async () => {
    const knex = knexFor({ fail: true });
    await expect(loadNextSameLineVisit({ knex, customerId: 'c1', scheduledServiceId: 's1', serviceYmd: '2026-09-30', line: 'pest' })).resolves.toEqual({ state: 'unknown' });
  });
});

describe('writer records', () => {
  test('a re-service gets its booked visit, its type and a reach-out date the screen allows', async () => {
    const { sections, allowedPhrases } = await buildWriterRecords({
      knex: knexFor({ rows: [{ id: 'n1', service_type: 'Quarterly Pest Control', ...HOME }] }), customerId: 'c1', scheduledServiceId: 's1',
      serviceYmd: '2026-09-30', line: 'pest', serviceKind: 're_service', applications: [TAURUS, ADVION],
    });
    const text = sections.join('\n\n');
    expect(text).toContain('EXPECTATIONS (approved wording');
    expect(text).toContain('HOW IT WORKS (approved product wording');
    expect(text).toContain('NEXT VISIT FOR THIS SERVICE: Quarterly Pest Control is booked.');
    expect(text).toContain('SERVICE TYPE: re-service');
    expect(text).toContain('REACH-OUT DATE: Wednesday, October 14');
    expect(allowedPhrases).toEqual(expect.arrayContaining(['a few days', '1–2 weeks', 'Wednesday, October 14', 'October 14']));
  });

  test('a recurring plan visit gets no reach-out date', async () => {
    const { sections, allowedPhrases } = await buildWriterRecords({
      knex: knexFor(), customerId: 'c1', scheduledServiceId: 's1', serviceYmd: '2026-09-30', line: 'pest', serviceKind: 'recurring', applications: [TAURUS],
    });
    expect(sections.join('\n')).not.toContain('REACH-OUT DATE');
    expect(sections.join('\n')).toContain('NEXT VISIT FOR THIS SERVICE: none booked.');
    expect(allowedPhrases).not.toContain('October 14');
  });

  test('a failed next-visit lookup says nothing about booking', async () => {
    const { sections } = await buildWriterRecords({
      knex: knexFor({ fail: true }), customerId: 'c1', scheduledServiceId: 's1', serviceYmd: '2026-09-30', line: 'pest', serviceKind: 'one_time', applications: [TAURUS],
    });
    expect(sections.join('\n')).not.toContain('NEXT VISIT');
    expect(sections.join('\n')).toContain('REACH-OUT DATE: Wednesday, October 14');
  });
});

describe('next visit on a rodent report (shared catalog rule)', () => {
  const ORIGINAL = process.env.GATE_RODENT_REPORT_REFRESH;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.GATE_RODENT_REPORT_REFRESH;
    else process.env.GATE_RODENT_REPORT_REFRESH = ORIGINAL;
  });
  const exclusion = { id: 'n1', service_type: 'Exclusion Service', service_id: 'svc-excl', ...HOME };
  const catalog = [{ id: 'svc-excl', name: 'Rodent Exclusion', category: 'rodent' }];

  test('an exclusion visit linked to a rodent catalog service counts, as on the report', async () => {
    process.env.GATE_RODENT_REPORT_REFRESH = 'true';
    await expect(loadNextSameLineVisit({
      knex: knexFor({ rows: [exclusion], services: catalog }), customerId: 'c1', scheduledServiceId: 's1', serviceYmd: '2026-09-30', line: 'rodent',
    })).resolves.toEqual({ state: 'scheduled', serviceType: 'Exclusion Service' });
  });

  test('without the refresh gate the strict line match stands', async () => {
    delete process.env.GATE_RODENT_REPORT_REFRESH;
    await expect(loadNextSameLineVisit({
      knex: knexFor({ rows: [exclusion], services: catalog }), customerId: 'c1', scheduledServiceId: 's1', serviceYmd: '2026-09-30', line: 'rodent',
    })).resolves.toEqual({ state: 'none' });
  });
});

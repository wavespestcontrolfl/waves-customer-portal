// Writer records (GATE_REPORT_WRITER_RULES, four-section report): approved
// expectations and how-it-works wording, the next booked visit, the service
// type and the reach-out date, plus the phrases the screen then allows.
const {
  SERVICE_EXPECTATIONS, writerExpectations, howItWorksLines, reachOutDate, loadNextSameLineVisit, buildWriterRecords,
} = require('../services/service-report/report-writer-records');

const TAURUS = { name: 'Taurus SC', epaReg: '53883-279', role: 'insect-control application', method: 'perimeter_spray', methodLabel: 'perimeter spray', applicationArea: 'Exterior perimeter', targets: ['Ghost ants'] };
const ADVION = { name: 'Advion Ant Bait Gel', epaReg: '352-746', role: 'bait application', method: 'bait_placement', methodLabel: 'bait placement', applicationArea: 'Kitchen', targets: ['Ghost ants'] };

// Records every builder call; `rows` (or a rejection) answers the await.
function knexWith(rows, { fail = false } = {}) {
  const calls = [];
  const builder = new Proxy({}, {
    get(_, prop) {
      if (prop === 'then') return (resolve, reject) => (fail ? Promise.reject(new Error('lookup down')) : Promise.resolve(rows)).then(resolve, reject);
      return (...args) => {
        calls.push([prop, ...args]);
        if (prop === 'modify') args[0](builder);
        return builder;
      };
    },
  });
  const knex = jest.fn(() => builder);
  knex.calls = calls;
  return knex;
}

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

describe('next visit on the same line', () => {
  test('is the first booked visit after this one on the same line', async () => {
    const knex = knexWith([{ service_type: 'Lawn Care Visit' }, { service_type: 'Quarterly Pest Control' }]);
    await expect(loadNextSameLineVisit({ knex, customerId: 'c1', scheduledServiceId: 's1', serviceYmd: '2026-09-30', line: 'pest' }))
      .resolves.toEqual({ state: 'scheduled', serviceType: 'Quarterly Pest Control' });
    expect(knex.calls).toEqual(expect.arrayContaining([
      ['where', 'scheduled_date', '>', '2026-09-30'],
      ['whereIn', 'status', ['pending', 'confirmed', 'en_route', 'on_site']],
      ['whereNot', { id: 's1' }],
    ]));
  });

  test('none booked on the line', async () => {
    const knex = knexWith([{ service_type: 'Lawn Care Visit' }]);
    await expect(loadNextSameLineVisit({ knex, customerId: 'c1', serviceYmd: '2026-09-30', line: 'pest' })).resolves.toEqual({ state: 'none' });
  });

  test('a failed lookup is unknown, never "none booked"', async () => {
    const knex = knexWith([], { fail: true });
    await expect(loadNextSameLineVisit({ knex, customerId: 'c1', serviceYmd: '2026-09-30', line: 'pest' })).resolves.toEqual({ state: 'unknown' });
  });
});

describe('writer records', () => {
  test('a re-service gets its booked visit, its type and a reach-out date the screen allows', async () => {
    const { sections, allowedPhrases } = await buildWriterRecords({
      knex: knexWith([{ service_type: 'Quarterly Pest Control' }]), customerId: 'c1', scheduledServiceId: 's1',
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
      knex: knexWith([]), customerId: 'c1', serviceYmd: '2026-09-30', line: 'pest', serviceKind: 'recurring', applications: [TAURUS],
    });
    expect(sections.join('\n')).not.toContain('REACH-OUT DATE');
    expect(sections.join('\n')).toContain('NEXT VISIT FOR THIS SERVICE: none booked.');
    expect(allowedPhrases).not.toContain('October 14');
  });

  test('a failed next-visit lookup says nothing about booking', async () => {
    const { sections } = await buildWriterRecords({
      knex: knexWith([], { fail: true }), customerId: 'c1', serviceYmd: '2026-09-30', line: 'pest', serviceKind: 'one_time', applications: [TAURUS],
    });
    expect(sections.join('\n')).not.toContain('NEXT VISIT');
    expect(sections.join('\n')).toContain('REACH-OUT DATE: Wednesday, October 14');
  });
});

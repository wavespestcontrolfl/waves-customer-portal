// Writer records (GATE_REPORT_WRITER_RULES, four-section report): approved
// expectations and how-it-works wording, the next booked visit, the service
// type and the reach-out date, plus the phrases the screen then allows.
const {
  SERVICE_EXPECTATIONS, writerExpectations, howItWorksLines, reachOutDate, buildWriterRecords,
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

describe('writer records', () => {
  test('a re-service gets its type and a reach-out date the screen allows', () => {
    const { sections, allowedPhrases, allowedDates } = buildWriterRecords({
      serviceYmd: '2026-09-30', line: 'pest', serviceKind: 're_service', applications: [TAURUS, ADVION],
    });
    const text = sections.join('\n\n');
    expect(text).toContain('EXPECTATIONS (approved wording');
    expect(text).toContain('HOW IT WORKS (approved product wording');
    expect(text).toContain('SERVICE TYPE: re-service');
    expect(text).toContain('REACH-OUT DATE: Wednesday, October 14');
    expect(allowedPhrases).toEqual(expect.arrayContaining(['a few days', 'about 1–2 weeks']));
    expect(allowedDates).toEqual(['Wednesday, October 14', 'October 14']);
  });

  test('a recurring plan visit gets no reach-out date', () => {
    const { sections, allowedDates } = buildWriterRecords({
      serviceYmd: '2026-09-30', line: 'pest', serviceKind: 'recurring', applications: [TAURUS],
    });
    expect(sections.join('\n')).not.toContain('REACH-OUT DATE');
    expect(allowedDates).toEqual([]);
  });

  test("the technician's promise marks become the PROMISES record; none, no record", () => {
    const { sections } = buildWriterRecords({
      serviceYmd: '2026-09-30', line: 'pest', serviceKind: 're_service', applications: [TAURUS],
      promises: [
        { mark: 'done', description: 'Check under the dishwasher' },
        { mark: 'partly', description: 'Look at the gap under the garage door', stillLeft: 'the left side' },
      ],
    });
    const record = sections.find((section) => section.startsWith('PROMISES'));
    expect(record).toContain('mention only these, only as marked');
    expect(record).toContain('- Done today: Check under the dishwasher');
    expect(record).toContain('- Partly done today: Look at the gap under the garage door (still left: the left side)');
    const none = buildWriterRecords({ serviceYmd: '2026-09-30', line: 'pest', serviceKind: 're_service', applications: [TAURUS] });
    expect(none.sections.join('\n')).not.toContain('PROMISES');
  });

  test('carries no booking state: the report shows the next visit live', () => {
    const { sections } = buildWriterRecords({
      serviceYmd: '2026-09-30', line: 'pest', serviceKind: 'one_time', applications: [TAURUS],
    });
    expect(sections.join('\n')).not.toMatch(/NEXT VISIT|booked|scheduled/i);
  });
});

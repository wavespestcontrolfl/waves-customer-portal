/**
 * The technician's own note on every customer render (owner 2026-11-19).
 *
 * A completion will store structured_notes.reportNote = { v: 1, text, source }
 * and keep the raw note in technician_notes. These tests pin the renders,
 * which fail closed on such a record:
 *  - the web report's summary is the note, signed when it is the
 *    technician's own words, with no titled sections; when the note does
 *    not stand it is never the recap (written from the raw note) and never
 *    the notes column;
 *  - the note stands only on a visit with no typed card, and no card carries
 *    report text beside it;
 *  - the protocol lists hold only what the completion form recorded: the
 *    merged lists fold in the raw note's tagged lines and the parked lines;
 *  - the PDF key hashes the summary as printed, and the cache lookup and the
 *    render key it the same.
 */

const {
  visitReportCustomerCopy,
  summaryCopySignature,
  reportNoteRenderState,
} = require('../services/service-report/technician-report-copy');
const { buildReportV1Data } = require('../services/service-report/report-data');
const { applyReportIdentitySnapshot } = require('../services/service-report/report-identity-snapshot');

const keyOf = (text) => `-tr${require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 8)}`;

const NOTE = 'I found a fire ant hill near the back of the house and spot-treated it. I also swept the spider webs outside.';
const TITLED = 'WHAT WE DID\n\nWe treated the exterior perimeter.\n\nWHAT WE FOUND\n\nLight ant activity near the lanai.';
const UNSAFE = 'I treated the lanai. It is safe for pets now.';
const stored = (overrides = {}) => ({ reportNote: { v: 1, text: NOTE, source: 'cleaned', ...overrides } });

// The same minimal query double as report-technician-notes-egress.test.js.
function makeKnex(fixtures) {
  const knex = (table) => {
    let rows = [...(fixtures[table] || [])];
    const q = {
      select: () => q,
      leftJoin: () => q,
      modify(fn) { fn(q); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      where(a, b) {
        if (typeof a === 'function') return q;
        if (a && typeof a === 'object') rows = rows.filter((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        else if (arguments.length === 2) rows = rows.filter((r) => r[a] === b);
        return q;
      },
      andWhere: () => q,
      whereIn(col, vals) { rows = rows.filter((r) => vals.includes(r[col])); return q; },
      whereNot(criteria) {
        rows = rows.filter((r) => !Object.entries(criteria).every(([k, v]) => r[k] === v));
        return q;
      },
      whereNotNull(col) { rows = rows.filter((r) => r[col] != null); return q; },
      whereNull(col) { rows = rows.filter((r) => r[col] == null); return q; },
      orderBy: () => q,
      first: () => Promise.resolve(rows[0] || null),
      columnInfo: () => Promise.resolve({}),
      catch: () => Promise.resolve(rows),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return q;
  };
  knex.raw = (sql) => sql;
  return knex;
}

const RAW_NOTE = 'found fire ant hill out back spot treated it swept webs. Gate code 4471.';
const SERVICE = {
  id: 'svc-own-note-1',
  scheduled_service_id: 'ss-own-note',
  customer_id: 'cust-own-note',
  service_line: 'pest',
  service_type: 'Quarterly Pest Control Service',
  service_date: '2026-05-16',
  first_name: 'Test',
  last_name: 'Customer',
  technician_name: 'Jordan Rivers',
  areas_serviced: JSON.stringify(['Perimeter']),
  structured_notes: JSON.stringify(stored()),
  service_data: '{}',
  technician_notes: RAW_NOTE,
  pressure_index: 0,
};
const FIXTURES = {
  service_products: [], property_geometries: [], property_zones: [], service_findings: [], service_photos: [], scheduled_services: [],
};
const build = (overrides = {}, fixtures = {}) => buildReportV1Data({ ...SERVICE, ...overrides }, 'token-own-note', makeKnex({ ...FIXTURES, ...fixtures }));
const notes = (extra = {}) => JSON.stringify({ ...stored(), ...extra });
const typedCard = (todaysResult) => ({
  type: 'one_time_pest_treatment', visitSequence: 1, values: {},
  todaysResult: { headline: 'Service completed.', ...todaysResult },
});

describe('the report payload', () => {
  test("a cleaned note is the summary, signed with the technician's first name, with no titled sections", async () => {
    const data = await build();
    expect(data.summary).toBe(`${NOTE} — Jordan`);
    expect(data.summarySource).toBe('technician_report');
    // The page and the PDF print it as stored (printedVisitSummary).
    expect(data.summaryIsOwnNote).toBe(true);
    expect(data.reportSections).toBeUndefined();
    // The raw note stays internal.
    expect(JSON.stringify(data)).not.toContain('4471');
    expect(JSON.stringify(data)).not.toContain('out back');
  });

  test('the standard sentence is not signed', async () => {
    const fixed = 'Today we completed your Quarterly Pest Control Service. We treated Outside.';
    const data = await build({ structured_notes: JSON.stringify(stored({ text: fixed, source: 'fixed' })) });
    expect(data.summary).toBe(fixed);
    expect(data.summarySource).toBe('technician_report');
    expect(data.summaryIsOwnNote).toBe(true);
  });

  test("only the note is marked as the technician's own words: a titled report or a recap is not", async () => {
    const titled = await build({ technician_notes: TITLED, structured_notes: '{}' });
    expect(titled.summarySource).toBe('technician_report');
    expect(titled).not.toHaveProperty('summaryIsOwnNote');
    const recap = await build({ technician_notes: 'treated perimeter', structured_notes: JSON.stringify({ customerRecap: 'We treated the perimeter today.' }) });
    expect(recap).not.toHaveProperty('summaryIsOwnNote');
    const refused = await build({ structured_notes: JSON.stringify({ ...stored({ text: UNSAFE }), customerRecap: UNSAFE }) });
    expect(refused).not.toHaveProperty('summaryIsOwnNote');
  });

  test('a cleaned note that names a time figure is refused: no summary from it', async () => {
    // Any time figure on a note record (noteRecordCopyViolations): AGENTS.md
    // bans a fixed re-entry or drying time, in whatever form it is written.
    for (const [text, figure] of [
      ['I treated the perimeter. The spray dries in 30 minutes.', 'dries in 30'],
      ['I treated the perimeter. Allow a 30-minute drying period.', '30-minute drying'],
      ['I treated the lanai. Return to the treated area after 30+ minutes.', '30+ minutes'],
      ['I treated the lanai. Keep the dog in overnight.', 'overnight'],
      // A day word in a sentence about drying or re-entry.
      ['I treated the lawn edge. Keep pets off the treated grass for two days.', 'for two days'],
      ['I treated the perimeter. The spray dries in half a day.', 'half a day'],
      // An access code only the completion check names.
      ['I treated the yard. Side access 4417 for the yard.', '4417'],
    ]) {
      expect(visitReportCustomerCopy({ ...SERVICE, structured_notes: JSON.stringify(stored({ text })) }).body).toBeNull();
      const data = await build({ structured_notes: JSON.stringify(stored({ text })) });
      expect(data).not.toHaveProperty('summaryIsOwnNote');
      expect(JSON.stringify(data)).not.toContain(figure);
    }
  });

  test('a note with no technician name on the record is not signed', async () => {
    const data = await build({ technician_name: null });
    expect(data.summary).toBe(NOTE);
  });

  // The completion writes the recap from the raw note, so it can repeat a
  // refused note: the fixtures store the same text as both.
  test('a refused note, or one the completion rejected, leaves no summary: never the recap, never the notes column', async () => {
    const refused = await build({
      technician_notes: TITLED,
      structured_notes: JSON.stringify({ ...stored({ text: UNSAFE }), customerRecap: UNSAFE }),
    });
    expect(refused.summarySource).not.toBe('technician_report');
    expect(JSON.stringify(refused)).not.toContain('safe for pets');
    expect(JSON.stringify(refused)).not.toContain('Light ant activity near the lanai');

    const rejected = await build({
      structured_notes: notes({ customerRecap: NOTE }),
      service_data: '{"technicianReportBodyRejected":"trade_name"}',
    });
    expect(rejected.summarySource).not.toBe('technician_report');
    expect(JSON.stringify(rejected)).not.toContain('fire ant hill');
  });

  test('a note in another shape shows nothing, never the titled report in the notes column', async () => {
    const data = await build({ technician_notes: TITLED, structured_notes: JSON.stringify({ ...stored({ v: 2 }), customerRecap: NOTE }) });
    expect(data.summarySource).not.toBe('technician_report');
    expect(JSON.stringify(data)).not.toContain('Light ant activity near the lanai');
    expect(JSON.stringify(data)).not.toContain('fire ant hill');
  });

  test('stored notes that cannot be read count as a note: no summary, no report-text card body, no line of the notes column', async () => {
    const tagged = `${TITLED}\n[Found] Dog loose in the side yard`;
    const serviceData = JSON.stringify({ typedReportSnapshot: typedCard({ body: 'We treated the kitchen.', bodySource: 'technician_report' }) });
    // Decoded JSONB values that are not an object (carriesReportNote); the
    // report's own parse reads them as {}, which carries no note.
    for (const unreadable of ['"text"', 42, true, [stored()]]) {
      const data = await build({ technician_notes: tagged, structured_notes: unreadable });
      expect(data.summarySource).not.toBe('technician_report');
      expect(JSON.stringify(data)).not.toMatch(/Light ant activity near the lanai|side yard/);
      const typed = await build({ technician_notes: tagged, structured_notes: unreadable, service_data: serviceData });
      expect(typed.typedReport.todaysResult).toEqual({ headline: 'Service completed.' });
      expect(summaryCopySignature({ ...SERVICE, technician_notes: TITLED, structured_notes: unreadable })).toBe('-rn');
    }
  });

  test('a record with no note keeps its recap as the summary', async () => {
    const data = await build({ technician_notes: 'treated perimeter', structured_notes: JSON.stringify({ customerRecap: 'We treated the perimeter today.' }) });
    expect(data.summary).toBe('We treated the perimeter today.');
  });

  test('the protocol lists hold only what the completion form recorded', async () => {
    const tagged = '[Found] Dog loose in the side yard\n[Action] Skipped the shed per office\n[Next] Ask about the second lot';
    // The merged lists, as the completion stores them: the form's values,
    // the raw note's tagged lines and a parked [Next] line.
    const merged = {
      observations: ['Light ant activity', 'Dog loose in the side yard'],
      protocolActionsCompleted: ['Treated the perimeter', 'Skipped the shed per office'],
      recommendations: ['Trim shrubs back from the wall', 'Ask about the second lot', 'Call the office about the gate'],
    };
    // One value in each form list fails the complete customer-copy screen.
    const form = {
      formObservations: ['Light ant activity', 'Toxic mold by the AC unit'],
      formProtocolActions: ['Treated the perimeter', 'Treatment is safe for pets'],
      formRecommendations: ['Trim shrubs back from the wall', 'Use gate code 4471 next time', 'Water the potted plants for 20 minutes.'],
    };
    const serviceData = JSON.stringify({ protocol: { actions: ['Skipped the shed per office'], recommendations: ['Ask about the second lot'] } });
    for (const note of [stored(), stored({ v: 2 })]) {
      const data = await build({ technician_notes: tagged, structured_notes: JSON.stringify({ ...note, ...merged, ...form }), service_data: serviceData });
      expect(JSON.stringify(data.protocol)).not.toMatch(/side yard|the shed|second lot|the gate|toxic|safe for pets|4471|20 minutes/i);
      expect(data.protocol.actions).toEqual(['Treated the perimeter']);
      expect(data.protocol.observations).toEqual(['Light ant activity']);
      expect(data.protocol.recommendations).toEqual(['Trim shrubs back from the wall']);
      expect(data.protocol.structuredRecommendations).toEqual(['Trim shrubs back from the wall']);
    }
    // A record with no note keeps today's merged lists.
    const legacy = await build({ technician_notes: tagged, structured_notes: JSON.stringify({ ...merged, ...form }) });
    expect(legacy.protocol.observations).toContain('Dog loose in the side yard');
    expect(legacy.protocol.recommendations).toContain('Ask about the second lot');
  });

  test('findings drop a bare-title row, and the render adds no "no activity" row beside a note', async () => {
    const row = (title, detail = null) => ({
      id: `f-${title.length}`, service_record_id: SERVICE.id, category: 'observation', severity: 'low', title, detail, recommendation: null,
    });
    // A [Found] line of the raw note, saved as a bare title; a form label
    // the record proves; a finding with its own detail.
    // A row whose detail and recommendation are only spaces is bare too.
    const spaces = { ...row('Gate code 4471 at the side gate', '   '), recommendation: ' \n ' };
    // A form label the record proves, saved with a detail of only spaces,
    // takes the form detail like a bare one.
    const spacedLabel = row('Wasp nest under the eave', '  ');
    const findings = [row('Dog loose in the side yard'), row('Light ant activity'), row('Mulch against the slab', 'Mulch touches the slab by the lanai.'), spaces, spacedLabel];
    const structured = JSON.stringify({ ...stored(), formObservations: ['Light ant activity', 'Wasp nest under the eave'] });
    const data = await build({ structured_notes: structured }, { service_findings: findings });
    expect(data.findings.map((f) => f.title)).toEqual(['Light ant activity', 'Mulch against the slab', 'Wasp nest under the eave']);
    expect(data.findings[2].detail.trim()).not.toBe('');
    expect(JSON.stringify(data)).not.toContain('side yard');
    expect(JSON.stringify(data)).not.toContain('4471');
    // Only the bare row: nothing is left, and no "no activity" row is added.
    const bare = await build({}, { service_findings: [row('Dog loose in the side yard')] });
    expect(bare.findings).toEqual([]);
    expect((await build()).findings).toEqual([]);
    // A record with no note keeps every row, and its clean visit keeps the fallback.
    const legacy = await build({ structured_notes: '{}' }, { service_findings: findings });
    expect(legacy.findings.map((f) => f.title)).toContain('Dog loose in the side yard');
    expect((await build({ structured_notes: '{}' })).findings.map((f) => f.category)).toEqual(['no_activity']);
  });

  test('a stored row whose only text is the stock detail stands only when its label passes the screen; a refused title never prints', async () => {
    const { STRUCTURED_OBSERVATION_FINDING_DETAIL } = require('../../shared/service-completion-observations');
    // Completion saves each picked form label with the stock detail
    // (complete-scheduled-service.js). This snapshot lists a label the
    // customer-copy screen refuses.
    const row = (title) => ({
      id: `s-${title.length}`, service_record_id: SERVICE.id, category: 'observation', severity: 'low',
      title, detail: STRUCTURED_OBSERVATION_FINDING_DETAIL, recommendation: null,
    });
    // A title the screen refuses never prints, a recommendation beside it or not.
    const recommended = { ...row('Safe for pets after it dries'), detail: null, recommendation: 'Keep pets off the lawn until it dries.' };
    const findings = [row('Safe for pets once dry'), row('Light ant activity'), recommended];
    const form = { formObservations: ['Safe for pets once dry', 'Light ant activity'] };
    const data = await build({ structured_notes: JSON.stringify({ ...stored(), ...form }) }, { service_findings: findings });
    expect(data.findings.map((f) => f.title)).toEqual(['Light ant activity']);
    expect(JSON.stringify(data)).not.toContain('Safe for pets');
    expect(JSON.stringify(data)).not.toContain('Keep pets off');
    // A record with no note keeps every row, as today.
    const legacy = await build({ structured_notes: JSON.stringify(form) }, { service_findings: findings });
    expect(legacy.findings.map((f) => f.title)).toEqual(['Safe for pets once dry', 'Light ant activity', 'Safe for pets after it dries']);
  });

  test('beside a note, a finding detail or recommendation the screen refuses never prints, nor does the stored "no activity" row', async () => {
    const { buildNoActivityFinding } = require('../services/service-report/no-activity-finding');
    const row = (id, title, extra) => ({
      id, service_record_id: SERVICE.id, category: 'observation', severity: 'low', title, detail: null, recommendation: null, ...extra,
    });
    const findings = [
      row('f-gate', 'Ant trail by the lanai', { detail: 'A trail along the lanai door.', recommendation: 'Gate code 4417 for the next visit' }),
      row('f-toxic', 'Seal the slider', { detail: 'Toxic residue on the sill', recommendation: 'Replace the weatherstrip.' }),
      // A time figure counts too (noteRecordCopyViolations).
      row('f-time', 'Ant trail by the patio', { detail: 'A trail along the patio door.', recommendation: 'Stay off the patio for an hour.' }),
      // An access code with no code noun; a day word in a re-entry line.
      row('f-side', 'Ant trail by the pool cage', { detail: 'Side access 4418 for the yard.', recommendation: 'Seal the gap under the pool cage door.' }),
      row('f-days', 'Ant trail by the fence', { detail: 'A trail along the fence.', recommendation: 'Keep off the treated grass for two days.' }),
      // A gate is withheld wherever it stands: no word list tells a gate's
      // place from its lock (heldAccessCode), so the row leaves with its title.
      row('f-gatepost', 'Wasp nest on the gate post', { detail: 'A small nest under the cap.' }),
      { id: 'f-none', service_record_id: SERVICE.id, ...buildNoActivityFinding('pest') },
    ];
    const data = await build({ structured_notes: JSON.stringify(stored()) }, { service_findings: findings });
    expect(data.findings.map((f) => f.title)).toEqual(['Ant trail by the lanai', 'Seal the slider', 'Ant trail by the patio', 'Ant trail by the pool cage', 'Ant trail by the fence']);
    expect(JSON.stringify(data.findings)).toContain('A trail along the lanai door.');
    expect(JSON.stringify(data.findings)).toContain('Replace the weatherstrip.');
    expect(JSON.stringify(data.findings)).toContain('A trail along the patio door.');
    expect(JSON.stringify(data.findings)).toContain('Seal the gap under the pool cage door.');
    expect(JSON.stringify(data.findings)).toContain('A trail along the fence.');
    expect(JSON.stringify(data.findings)).not.toMatch(/were clear/);
    expect(JSON.stringify(data)).not.toMatch(/4417|4418|Toxic|for an hour|for two days|gate post|under the cap/);
    // A record with no note keeps every row, as today.
    const legacy = await build({ structured_notes: '{}' }, { service_findings: findings });
    expect(legacy.findings.map((f) => f.title).sort()).toEqual(['Ant trail by the fence', 'Ant trail by the lanai', 'Ant trail by the patio', 'Ant trail by the pool cage', 'No activity observed this visit', 'Seal the slider', 'Wasp nest on the gate post']);
  });

  test('beside a note, a customer concern never turns the stored "no activity" row into copy that prints', async () => {
    const { buildNoActivityFinding } = require('../services/service-report/no-activity-finding');
    const findings = [{ id: 'f-none', service_record_id: SERVICE.id, ...buildNoActivityFinding('pest') }];
    const concern = { customerConcernText: 'Ants keep coming in by the kitchen sink.' };
    const data = await build({ structured_notes: notes(concern) }, { service_findings: findings });
    expect(data.findings.filter((f) => f.category === 'no_activity')).toEqual([]);
    expect(JSON.stringify(data.findings)).not.toMatch(/no (?:confirmed )?pest activity|were clear/i);
    // A record with no note keeps the softened row, as today.
    const legacy = await build({ structured_notes: JSON.stringify(concern) }, { service_findings: findings });
    expect(legacy.findings.map((f) => f.title)).toContain('No pest activity confirmed this visit');
  });

  test('the PDF key hashes the summary the report prints', async () => {
    const data = await build();
    expect(summaryCopySignature(SERVICE)).toBe(`${keyOf(data.summary)}-rn`);
    // The PDF wait names the same digest (reportNoteRenderState).
    expect(reportNoteRenderState(SERVICE, data)).toBe(`shown:${keyOf(data.summary).slice('-tr'.length)}`);
  });
});

describe('the note stands only on a pest report', () => {
  // Phase 1: the lawn and tree & shrub reports take the note in their own
  // later step, with its own place on their page; termite, rodent, mosquito
  // and palm visits come with the typed visits.
  const RECAP = 'We completed your visit and checked the yard.';

  test('a record of any other line prints no note: no summary from it, never the recap, never the notes column', async () => {
    for (const line of ['lawn', 'tree_shrub', 'mosquito', 'termite', 'rodent', 'palm']) {
      const data = await build({ service_line: line, structured_notes: notes({ customerRecap: RECAP }) });
      expect(data.summarySource).not.toBe('technician_report');
      expect(data).not.toHaveProperty('summaryIsOwnNote');
      const payload = JSON.stringify(data);
      expect(payload).not.toContain('fire ant hill');
      expect(payload).not.toContain(RECAP);
      expect(payload).not.toContain('4471');
    }
  });

  test('the line is the one the report renders as: the service type when the record names no line, pest when it names neither', async () => {
    const lawn = await build({ service_line: null, service_type: 'Lawn Care' });
    expect(lawn.summarySource).not.toBe('technician_report');
    expect(JSON.stringify(lawn)).not.toContain('fire ant hill');
    const unnamed = await build({ service_line: null, service_type: null });
    expect(unnamed.summary).toBe(`${NOTE} — Jordan`);
  });

  test('the PDF key runs the same rule: another line keys the note record and no summary', () => {
    expect(summaryCopySignature({ ...SERVICE, service_line: 'lawn' })).toBe('-rn');
    expect(summaryCopySignature({ ...SERVICE, service_line: 'tree_shrub' })).toBe('-rn');
    expect(summaryCopySignature(SERVICE)).toBe(`${keyOf(`${NOTE} — Jordan`)}-rn`);
  });
});

describe('a visit that applied nothing never takes the note', () => {
  // inspection_only / customer_declined: a callback's report leads with the
  // outcome copy and its PDF prints no summary (ServiceReportDocument), so
  // the note is withheld on the page, in the PDF state and in the PDF key.
  const outcome = (visitOutcome) => ({ is_callback: true, service_data: JSON.stringify({ protocol: { visitOutcome } }) });
  let gate;
  beforeEach(() => {
    gate = process.env.GATE_RESERVICE_REPORT_COPY;
    process.env.GATE_RESERVICE_REPORT_COPY = 'true';
  });
  afterEach(() => {
    if (gate === undefined) delete process.env.GATE_RESERVICE_REPORT_COPY;
    else process.env.GATE_RESERVICE_REPORT_COPY = gate;
  });

  test('an inspection-only callback with an accepted note: no summary from it, the PDF state withheld, no summary in the key', async () => {
    const record = { ...SERVICE, ...outcome('inspection_only') };
    const data = await build(outcome('inspection_only'));
    expect(data.reserviceReport).toMatchObject({ outcome: 'inspection_only' });
    expect(data.summarySource).not.toBe('technician_report');
    expect(data).not.toHaveProperty('summaryIsOwnNote');
    expect(JSON.stringify(data)).not.toContain('fire ant hill');
    expect(reportNoteRenderState(record, data)).toBe('withheld');
    expect(summaryCopySignature(record)).toBe('-rn');
  });

  test('a declined visit withholds it too, the outcome read from the stored notes, callback or not', async () => {
    for (const overrides of [
      { is_callback: true, structured_notes: notes({ visitOutcome: 'customer_declined' }) },
      { is_callback: false, structured_notes: notes({ visitOutcome: 'customer_declined' }) },
      { service_data: JSON.stringify({ protocol: { visitOutcome: 'inspection_only' } }) },
    ]) {
      const data = await build(overrides);
      expect(data).not.toHaveProperty('summaryIsOwnNote');
      expect(JSON.stringify(data)).not.toContain('fire ant hill');
    }
  });

  test('a callback that treated keeps the note', async () => {
    const data = await build(outcome('treated'));
    expect(data.reserviceReport).toMatchObject({ outcome: 'treated' });
    expect(data.summary).toBe(`${NOTE} — Jordan`);
    expect(data.summaryIsOwnNote).toBe(true);
  });
});

describe('service data the reader cannot read withholds the note', () => {
  // A string that does not parse, or a value that is not an object, hides the
  // outcome and the frozen typed cards the note rule checks: the page, the
  // PDF state and the PDF key withhold the note, as the visit notes do
  // (customerSafeVisitNotes). Absent data reads as none.
  test('malformed or non-object service data: no summary from the note, the PDF state withheld, no summary in the key', async () => {
    for (const service_data of [
      '{"typedReportSnapshot": {', '[]', JSON.stringify(JSON.stringify({ a: 1 })), JSON.stringify({ protocol: '{"visitOutcome": ' }),
    ]) {
      const record = { ...SERVICE, service_data };
      const data = await build({ service_data });
      expect(data.summarySource).not.toBe('technician_report');
      expect(data).not.toHaveProperty('summaryIsOwnNote');
      expect(JSON.stringify(data)).not.toContain('fire ant hill');
      expect(reportNoteRenderState(record, data)).toBe('withheld');
      expect(summaryCopySignature(record)).toBe('-rn');
    }
  });

  test('absent service data reads as none: the note stands', async () => {
    for (const service_data of [null, '']) {
      const data = await build({ service_data });
      expect(data.summary).toBe(`${NOTE} — Jordan`);
      expect(data.summaryIsOwnNote).toBe(true);
    }
  });
});

describe('a typed visit never takes the note', () => {
  const companion = (delivery, todaysResult) => ({ ...typedCard(todaysResult), type: 'rodent_trapping', delivery });

  test('a primary card that froze report text keeps its headline only, and the note is not the summary', async () => {
    const serviceData = JSON.stringify({ typedReportSnapshot: typedCard({ body: NOTE, bodySource: 'technician_report', reconcileConfirmed: true }) });
    const data = await build({ service_data: serviceData });
    expect(data.summarySource).not.toBe('technician_report');
    expect(data).not.toHaveProperty('summaryIsOwnNote');
    expect(data.typedReport.todaysResult).toEqual({ headline: 'Service completed.' });
    expect(JSON.stringify(data)).not.toContain('fire ant hill');
  });

  test('a card with fixed wording keeps it, and the note still does not stand', async () => {
    const serviceData = JSON.stringify({ typedReportSnapshot: typedCard({ body: 'We completed the scheduled service.' }) });
    const data = await build({ service_data: serviceData });
    expect(data.typedReport.todaysResult.body).toBe('We completed the scheduled service.');
    expect(data.summarySource).not.toBe('technician_report');
    expect(JSON.stringify(data)).not.toContain('fire ant hill');
  });

  test('a companion card, customer-facing or internal, also blocks the note and drops its report text', async () => {
    for (const delivery of ['auto_send', 'internal_only']) {
      const serviceData = JSON.stringify({ companionReportSnapshots: [companion(delivery, { body: NOTE, bodySource: 'technician_report' })] });
      const data = await build({ service_data: serviceData });
      expect(data.summarySource).not.toBe('technician_report');
      expect(JSON.stringify(data)).not.toContain('fire ant hill');
    }
  });

  test('a record with no note keeps its typed card body', async () => {
    const serviceData = JSON.stringify({ typedReportSnapshot: typedCard({ body: 'We treated the kitchen.', bodySource: 'technician_report' }) });
    const data = await build({ technician_notes: 'treated kitchen', structured_notes: '{}', service_data: serviceData });
    expect(data.typedReport.todaysResult.body).toBe('We treated the kitchen.');
  });
});

describe('summaryCopySignature: the PDF key follows the note', () => {
  // A pest row as the PDF queue reads it: the render reads service_records.*,
  // and the cache lookup names the line columns.
  const raw = (overrides = {}) => ({
    service_line: 'pest', service_type: 'Quarterly Pest Control',
    technician_notes: 'found fire ant hill out back spot treated', technician_name: 'Jordan Rivers', structured_notes: stored(), ...overrides,
  });

  test('a note changes the key, and a changed note changes it again', () => {
    const sig = summaryCopySignature(raw());
    expect(sig).toBe(`${keyOf(`${NOTE} — Jordan`)}-rn`);
    expect(summaryCopySignature(raw({ structured_notes: stored({ text: 'I spot-treated outside.' }) }))).not.toBe(sig);
    expect(summaryCopySignature({ technician_notes: raw().technician_notes })).toBe('');
  });

  test('the signature keys the PDF: the same text as fixed or as cleaned, or signed by another name, keys apart', () => {
    const signed = summaryCopySignature(raw());
    expect(summaryCopySignature(raw({ structured_notes: stored({ source: 'fixed' }) }))).toBe(`${keyOf(NOTE)}-rn`);
    expect(summaryCopySignature(raw({ technician_name: 'Casey Rivers' }))).not.toBe(signed);
    // A titled report keeps the key it had: its body alone.
    const titled = visitReportCustomerCopy({ technician_notes: TITLED }).body;
    expect(summaryCopySignature({ technician_notes: TITLED, technician_name: 'Jordan Rivers' })).toBe(keyOf(titled));
  });

  test("the key runs the report's own rule: a typed visit, the completion's rejection and a refused note key no summary, but still key the note", () => {
    const typed = JSON.stringify({ typedReportSnapshot: typedCard({ body: 'We treated the kitchen.', bodySource: 'technician_report' }) });
    expect(summaryCopySignature(raw({ service_data: typed }))).toBe('-rn');
    // The same typed record without a note prints the card's report text, so
    // it keys apart (pre-push P1 on 00e28dd712).
    expect(summaryCopySignature(raw({ service_data: typed, structured_notes: '{}' }))).toBe('');
    expect(summaryCopySignature(raw({ service_data: '{"technicianReportBodyRejected":"trade_name"}' }))).toBe('-rn');
    expect(summaryCopySignature(raw({ structured_notes: stored({ text: UNSAFE }) }))).toBe('-rn');
    // A refused note never falls back to a titled report in the notes column.
    expect(summaryCopySignature(raw({ technician_notes: TITLED, structured_notes: stored({ v: 2 }) }))).toBe('-rn');
  });

  test('the cache lookup and the render key a signed note the same, by the name the identity snapshot froze', () => {
    // renderAndStore's row carries the joined name with the snapshot applied;
    // the cache lookup's row carries the joined name as stored.
    const frozen = JSON.stringify({ reportIdentitySnapshot: { version: 1, technicianName: 'Jordan Rivers' } });
    const lookupRow = raw({ technician_name: 'Casey Rivers', service_data: frozen });
    const renderRow = applyReportIdentitySnapshot({ ...lookupRow });
    expect(summaryCopySignature(lookupRow)).toBe(summaryCopySignature(renderRow));
    expect(summaryCopySignature(lookupRow)).toBe(`${keyOf(`${NOTE} — Jordan`)}-rn`);
  });
});

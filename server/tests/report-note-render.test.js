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
const build = (overrides = {}) => buildReportV1Data({ ...SERVICE, ...overrides }, 'token-own-note', makeKnex(FIXTURES));
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
    const form = {
      formObservations: ['Light ant activity'],
      formProtocolActions: ['Treated the perimeter'],
      formRecommendations: ['Trim shrubs back from the wall'],
    };
    const serviceData = JSON.stringify({ protocol: { actions: ['Skipped the shed per office'], recommendations: ['Ask about the second lot'] } });
    for (const note of [stored(), stored({ v: 2 })]) {
      const data = await build({ technician_notes: tagged, structured_notes: JSON.stringify({ ...note, ...merged, ...form }), service_data: serviceData });
      expect(JSON.stringify(data.protocol)).not.toMatch(/side yard|the shed|second lot|the gate/i);
      expect(data.protocol.actions).toEqual(['Treated the perimeter']);
      expect(data.protocol.observations).toEqual(['Light ant activity']);
      expect(data.protocol.recommendations).toEqual(['Trim shrubs back from the wall']);
    }
    // A record with no note keeps today's merged lists.
    const legacy = await build({ technician_notes: tagged, structured_notes: JSON.stringify({ ...merged, ...form }) });
    expect(legacy.protocol.observations).toContain('Dog loose in the side yard');
    expect(legacy.protocol.recommendations).toContain('Ask about the second lot');
  });

  test('the PDF key hashes the summary the report prints', async () => {
    const data = await build();
    expect(summaryCopySignature(SERVICE)).toBe(`${keyOf(data.summary)}-rn`);
  });
});

describe('a typed visit never takes the note', () => {
  const companion = (delivery, todaysResult) => ({ ...typedCard(todaysResult), type: 'rodent_trapping', delivery });

  test('a primary card that froze report text keeps its headline only, and the note is not the summary', async () => {
    const serviceData = JSON.stringify({ typedReportSnapshot: typedCard({ body: NOTE, bodySource: 'technician_report', reconcileConfirmed: true }) });
    const data = await build({ service_data: serviceData });
    expect(data.summarySource).not.toBe('technician_report');
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
  const raw = (overrides = {}) => ({
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

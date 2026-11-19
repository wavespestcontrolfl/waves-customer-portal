/**
 * The technician's own note as report copy (owner 2026-11-19).
 *
 * A completion may store structured_notes.reportNote = { v: 1, text, source }:
 * the customer text of a report whose summary is the technician's note. These
 * tests pin the read side:
 *  - only that exact shape reads as customer copy, and the customer-copy
 *    screens run on every read;
 *  - a record with a note, refused or in any other shape, never falls back
 *    to its raw notes column, its tagged lines included;
 *  - the report signs a 'cleaned' note with the technician's first name, on
 *    the summary and on the Today's Result card that carries it, and leaves
 *    a 'fixed' one unsigned, with no titled sections either way;
 *  - a card that carries the summary never shows a body the note's reading
 *    turns down, or one frozen at completion that differs from it;
 *  - the PDF key hashes the summary as printed, and the cache lookup and the
 *    render key it the same.
 */

const {
  reportNoteCustomerCopy,
  visitReportCustomerCopy,
  summaryCopySignature,
  MAX_REPORT_NOTE_CHARS,
} = require('../services/service-report/technician-report-copy');
const { buildReportV1Data } = require('../services/service-report/report-data');
const { applyReportIdentitySnapshot } = require('../services/service-report/report-identity-snapshot');

const keyOf = (text) => `-tr${require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 8)}`;

const NOTE = 'I found a fire ant hill near the back of the house and spot-treated it. I also swept the spider webs outside.';
const TITLED = 'WHAT WE DID\n\nWe treated the exterior perimeter.\n\nWHAT WE FOUND\n\nLight ant activity near the lanai.';
const stored = (overrides = {}) => ({ reportNote: { v: 1, text: NOTE, source: 'cleaned', ...overrides } });
// What a record that carries a note in any other shape reads as: no text.
const SHAPELESS = { body: null, violations: ['report_note_shape'], source: null };
const MALFORMED = [
  { reportNote: null },
  { reportNote: NOTE },
  { reportNote: [] },
  stored({ v: 2 }),
  stored({ source: 'edited' }),
  stored({ text: '   ' }),
  stored({ text: 42 }),
  stored({ text: 'x'.repeat(MAX_REPORT_NOTE_CHARS + 1) }),
  stored({ text: `${NOTE}\nGate code 4471.` }),
];

describe('reportNoteCustomerCopy: the stored shape', () => {
  test('reads the note from an object or a JSON string', () => {
    expect(reportNoteCustomerCopy(stored())).toEqual({ body: NOTE, violations: [], source: 'cleaned' });
    expect(reportNoteCustomerCopy(JSON.stringify(stored({ source: 'fixed' })))).toEqual({ body: NOTE, violations: [], source: 'fixed' });
  });

  test('a record with no note reads as null, so the titled report may stand', () => {
    expect(reportNoteCustomerCopy(null)).toBeNull();
    expect(reportNoteCustomerCopy('{not json')).toBeNull();
    expect(reportNoteCustomerCopy({})).toBeNull();
    expect(reportNoteCustomerCopy({ reportNote: undefined })).toBeNull();
  });

  test('a note in any other shape reads as no text, a second line included', () => {
    MALFORMED.forEach((notes) => expect(reportNoteCustomerCopy(notes)).toEqual(SHAPELESS));
    expect(reportNoteCustomerCopy(stored({ text: `  ${NOTE}  ` }))?.body).toBe(NOTE);
  });

  test('the customer-copy screens run on every read', () => {
    const unsafe = reportNoteCustomerCopy(stored({ text: 'I treated the lanai. It is safe for pets now.' }));
    expect(unsafe.body).toBeNull();
    expect(unsafe.violations.length).toBeGreaterThan(0);
    expect(reportNoteCustomerCopy(stored({ text: 'I treated the garage. The gate code is 4471.' })).body).toBeNull();
  });
});

describe('visitReportCustomerCopy: one rule for a record', () => {
  test('the note wins over a titled report in the notes column', () => {
    expect(visitReportCustomerCopy({ technician_notes: TITLED, structured_notes: stored() }).body).toBe(NOTE);
  });

  test('a record with no note keeps the titled report', () => {
    const parsed = visitReportCustomerCopy({ technician_notes: TITLED, structured_notes: '{}' });
    expect(parsed.body).toBe('We treated the exterior perimeter. Light ant activity near the lanai.');
    expect(parsed.source).toBeUndefined();
    expect(visitReportCustomerCopy({ technician_notes: 'treated lanai, gate code 4471' })).toBeNull();
    expect(visitReportCustomerCopy(null)).toBeNull();
  });

  test('a refused note never falls back to the notes column', () => {
    const refused = stored({ text: 'I treated the lanai. It is safe for pets now.' });
    expect(visitReportCustomerCopy({ technician_notes: TITLED, structured_notes: refused }).body).toBeNull();
  });

  test('a note in any other shape never falls back to a titled report in the notes column', () => {
    MALFORMED.forEach((notes) => expect(visitReportCustomerCopy({ technician_notes: TITLED, structured_notes: notes }).body).toBeNull());
  });
});

describe('summaryCopySignature: the PDF key follows the note', () => {
  test('a note changes the key, and a changed note changes it again', () => {
    const raw = { technician_notes: 'found fire ant hill out back spot treated', structured_notes: stored() };
    const sig = summaryCopySignature(raw);
    expect(sig).toMatch(/^-tr[0-9a-f]{8}$/);
    expect(summaryCopySignature({ ...raw, structured_notes: stored({ text: 'I spot-treated outside.' }) })).not.toBe(sig);
    expect(summaryCopySignature({ technician_notes: raw.technician_notes })).toBe('');
  });

  test('the signature keys the PDF: the same text as fixed or as cleaned, or signed by another name, keys apart', () => {
    const raw = { technician_notes: 'found fire ant hill out back spot treated', technician_name: 'Jordan Rivers', structured_notes: stored() };
    const signed = summaryCopySignature(raw);
    expect(summaryCopySignature({ ...raw, structured_notes: stored({ source: 'fixed' }) })).not.toBe(signed);
    expect(summaryCopySignature({ ...raw, technician_name: 'Casey Rivers' })).not.toBe(signed);
    expect(summaryCopySignature({ ...raw, technician_first_name: 'Jo' })).not.toBe(signed);
    // A titled report keeps the key it had: its body alone.
    const titled = visitReportCustomerCopy({ technician_notes: TITLED }).body;
    expect(summaryCopySignature({ technician_notes: TITLED, technician_name: 'Jordan Rivers' })).toBe(keyOf(titled));
  });

  test('the cache lookup and the render key a signed note the same, by the name the identity snapshot froze', () => {
    // renderAndStore's row carries the joined name with the snapshot applied;
    // the cache lookup's row carries the joined name as stored.
    const frozen = JSON.stringify({ reportIdentitySnapshot: { version: 1, technicianName: 'Jordan Rivers' } });
    const lookupRow = { structured_notes: stored(), technician_name: 'Casey Rivers', service_data: frozen };
    const renderRow = applyReportIdentitySnapshot({ ...lookupRow });
    expect(summaryCopySignature(lookupRow)).toBe(summaryCopySignature(renderRow));
    expect(summaryCopySignature(lookupRow)).toBe(keyOf(`${NOTE} — Jordan`));
  });
});

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
  structured_notes: JSON.stringify({ ...stored(), customerRecap: NOTE }),
  service_data: '{}',
  technician_notes: RAW_NOTE,
  pressure_index: 0,
};
const FIXTURES = {
  service_products: [], property_geometries: [], property_zones: [], service_findings: [], service_photos: [], scheduled_services: [],
};
const build = (overrides = {}) => buildReportV1Data({ ...SERVICE, ...overrides }, 'token-own-note', makeKnex(FIXTURES));

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

  test('a refused note, or one the completion rejected, is not the summary', async () => {
    const unsafe = 'I treated the lanai. It is safe for pets now.';
    const refused = await build({ structured_notes: JSON.stringify(stored({ text: unsafe })) });
    expect(String(refused.summary || '')).not.toContain('safe for pets');
    expect(refused.summarySource).not.toBe('technician_report');
    expect(JSON.stringify(refused)).not.toContain('4471');

    const rejected = await build({ service_data: '{"technicianReportBodyRejected":"trade_name"}' });
    expect(rejected.summarySource).not.toBe('technician_report');
    expect(String(rejected.summary || '')).not.toContain('— Jordan');
  });

  test('a note in another shape shows nothing, never the titled report in the notes column', async () => {
    const data = await build({ technician_notes: TITLED, structured_notes: JSON.stringify(stored({ v: 2 })) });
    expect(data.summarySource).not.toBe('technician_report');
    expect(JSON.stringify(data)).not.toContain('Light ant activity near the lanai');
  });

  test("the raw note's tagged lines stay internal on a record that carries a note, in any shape", async () => {
    const tagged = '[Found] Dog loose in the side yard\n[Action] Skipped the shed per office\n[Next] Ask about the second lot';
    for (const notes of [stored(), stored({ v: 2 })]) {
      const data = await build({ technician_notes: tagged, structured_notes: JSON.stringify(notes) });
      expect(JSON.stringify(data.protocol)).not.toMatch(/side yard|the shed|second lot/);
    }
    // A record with no note keeps today's tagged lines.
    const legacy = await build({ technician_notes: tagged, structured_notes: '{}' });
    expect(legacy.protocol.observations).toContain('Dog loose in the side yard');
  });

  test('the PDF key hashes the summary the report prints', async () => {
    const data = await build();
    expect(summaryCopySignature(SERVICE)).toBe(keyOf(data.summary));
  });
});

describe("a typed report whose Today's Result card carries the note", () => {
  // The page prints that card's body in place of the summary
  // (ReportViewPage todaysResultCarriesSummary), so the card signs it.
  const card = (body) => ({ headline: 'Service completed.', body, bodySource: 'technician_report' });
  const typed = (todaysResult) => JSON.stringify({
    typedReportSnapshot: {
      type: 'one_time_pest', typeLabel: 'One-Time Pest', serviceLabel: 'One-Time Pest', schemaVersion: 2, visitSequence: 1,
      values: { target_pest: 'Ants' }, findings: [], nextStepChips: [], todaysResult,
    },
  });

  test('the card prints the note signed', async () => {
    const data = await build({ service_data: typed(card(NOTE)) });
    expect(data.summary).toBe(`${NOTE} — Jordan`);
    expect(data.typedReport.todaysResult).toEqual({ ...card(NOTE), body: `${NOTE} — Jordan` });
  });

  test('a card that froze another body prints the note, as the summary does', async () => {
    const other = 'Ghost ants were trailing. We placed bait.';
    const data = await build({ service_data: typed(card(other)) });
    expect(data.typedReport.todaysResult).toEqual({ ...card(NOTE), body: `${NOTE} — Jordan` });

    // A four-section body: the note replaces it while GATE_REPORT_WRITER_RULES
    // is on. When off, the gate's kill switch still drops it first, and a
    // typed story whose card carries no report text keeps the note out of
    // the summary, as it keeps a titled report out (Codex P2 #2709).
    const fourSection = typed({ ...card(other), bodyFormat: 'four_section' });
    const before = process.env.GATE_REPORT_WRITER_RULES;
    try {
      process.env.GATE_REPORT_WRITER_RULES = 'true';
      expect((await build({ service_data: fourSection })).typedReport.todaysResult).toEqual({ ...card(NOTE), body: `${NOTE} — Jordan` });
      process.env.GATE_REPORT_WRITER_RULES = 'false';
      const dark = await build({ service_data: fourSection });
      expect(dark.typedReport.todaysResult).toEqual({ headline: 'Service completed.' });
      expect(dark.summarySource).not.toBe('technician_report');
      expect(JSON.stringify(dark)).not.toContain(other);
    } finally {
      if (before === undefined) delete process.env.GATE_REPORT_WRITER_RULES;
      else process.env.GATE_REPORT_WRITER_RULES = before;
    }
  });

  test('a note the screens refuse, or in another shape, leaves the card its headline and no body', async () => {
    const unsafe = 'I treated the garage. The gate code is 4471.';
    for (const notes of [stored({ text: unsafe }), stored({ v: 2, text: unsafe })]) {
      const data = await build({ structured_notes: JSON.stringify(notes), service_data: typed(card(unsafe)) });
      expect(data.typedReport.todaysResult).toEqual({ headline: 'Service completed.' });
      expect(JSON.stringify(data)).not.toContain('4471');
    }
  });

  test('a note the completion rejected leaves the card no body either', async () => {
    const data = await build({ service_data: JSON.stringify({ ...JSON.parse(typed(card(NOTE))), technicianReportBodyRejected: 'trade_name' }) });
    expect(data.summarySource).not.toBe('technician_report');
    expect(data.typedReport.todaysResult).toEqual({ headline: 'Service completed.' });
  });

  test('a fixed sentence on the card stays unsigned', async () => {
    const fixed = 'Today we completed your Quarterly Pest Control Service. We treated Outside.';
    const data = await build({ structured_notes: JSON.stringify(stored({ text: fixed, source: 'fixed' })), service_data: typed(card(fixed)) });
    expect(data.typedReport.todaysResult.body).toBe(fixed);
  });

  test('a companion card that carries the note prints it signed too, and drops a refused one', async () => {
    const companion = (body) => ({
      type: 'one_time_pest', typeLabel: 'One-Time Pest', delivery: 'auto_send', schemaVersion: 2, visitSequence: 1,
      findings: [], nextStepChips: [], todaysResult: card(body),
    });
    const data = await build({ service_data: JSON.stringify({ companionReportSnapshots: [companion(NOTE)] }) });
    expect(data.companionReports[0].todaysResult.body).toBe(`${NOTE} — Jordan`);

    const unsafe = 'I treated the garage. The gate code is 4471.';
    const refused = await build({
      structured_notes: JSON.stringify(stored({ text: unsafe })),
      service_data: JSON.stringify({ companionReportSnapshots: [companion(unsafe)] }),
    });
    expect(refused.companionReports[0].todaysResult).toEqual({ headline: 'Service completed.' });
    expect(JSON.stringify(refused)).not.toContain('4471');
  });
});

const { buildWdoReportPDFBuffer, _private } = require('../services/pdf/wdo-report-pdf');

describe('wdo-report-pdf', () => {
  const baseProject = {
    id: 'p1',
    project_type: 'wdo_inspection',
    tech_name: 'Adam Tech',
    created_at: '2026-05-20',
    findings: {
      property_address: '456 Palm Dr, Sarasota, FL 34236',
      structures_inspected: 'Main home and attached garage',
      requested_by: 'Jane Buyer, (941) 555-0101',
      report_sent_to: 'ABC Title Co.',
      wdo_finding: 'Visible evidence of WDO observed',
      live_wdo: 'Subterranean termites — east wall',
      wdo_evidence: 'Mud tubes at garage slab',
      wdo_damage: 'Surface galleries in door framing',
      inaccessible_areas: 'Attic — insulation; Crawlspace — no hatch',
      previous_treatment_evidence: 'Yes',
      treated_at_inspection: 'No',
      organism_treated: ['Subterranean termites'],
      pesticide_used: 'Termidor SC',
      treatment_method: 'Spot treatment',
      comments: 'Recommend full treatment.',
      applicator_fdacs_id: 'JF12345',
    },
  };
  const customer = { address_line1: '456 Palm Dr', city: 'Sarasota', state: 'FL', zip: '34236' };

  test('splitCompanyAddress splits street from city/state/zip', () => {
    const out = _private.splitCompanyAddress('13649 Luxe Ave #110, Bradenton, FL 34211');
    expect(out.street).toBe('13649 Luxe Ave #110');
    expect(out.cityStateZip).toBe('Bradenton, FL 34211');
  });

  test('resolveApplicator prefers structured findings, falls back to tech name', () => {
    expect(_private.resolveApplicator({ project: baseProject, findings: baseProject.findings }))
      .toEqual({ name: 'Adam Tech', idCardNo: 'JF12345' });
    expect(_private.resolveApplicator({
      project: {},
      findings: { inspector_name: 'Pat Inspector', applicator_fdacs_id: 'JF999' },
    })).toEqual({ name: 'Pat Inspector', idCardNo: 'JF999' });
  });

  test('buildTextValues maps findings to FDACS field names with company header', () => {
    const vals = _private.buildTextValues({
      findings: baseProject.findings,
      customer,
      project: baseProject,
      applicator: { name: 'Adam Tech', idCardNo: 'JF12345' },
    });
    expect(vals['Inspection Company Name']).toBe('Waves Pest Control, LLC');
    expect(vals['Business License Number']).toBe('JB351547');
    expect(vals['Address of Property Inspected']).toBe('456 Palm Dr, Sarasota, FL 34236');
    expect(vals['Structures on Property Inspected']).toBe('Main home and attached garage');
    expect(vals['Name and Contact Information']).toBe('Jane Buyer, (941) 555-0101');
    expect(vals['Print Name']).toBe('Adam Tech');
    expect(vals['ID Card No']).toBe('JF12345');
    expect(vals['pesticideused']).toBe('Termidor SC');
    // Signature line is intentionally NOT populated (licensee signs before filing).
    expect(vals['signaturelicensee']).toBeUndefined();
  });

  test('notice locations land in their own distinct FDACS blanks', () => {
    const vals = _private.buildTextValues({
      findings: {
        notice_location: 'Front entry door frame',
        treatment_notice_location: 'Electrical panel, garage',
      },
      customer,
      project: baseProject,
      applicator: { name: 'Adam Tech', idCardNo: 'JF12345' },
    });
    // "A Notice of Inspection has been affixed to the structure at: ___" —
    // the field is auto-named from the sentence that FOLLOWS the blank.
    expect(vals['should be contacted for information on treatment history and any warranty or service agreement which may be in place'])
      .toBe('Front entry door frame');
    // "Specify Treatment Notice Location: ___"
    expect(vals['undefined_9']).toBe('Electrical panel, garage');
    // The "Spot treatment: ___" description blank must NOT inherit either
    // notice location (no findings field collects a spot description).
    expect(vals['locationtreatment']).toBeUndefined();
  });

  test('every mapped field name exists in the real FDACS template', async () => {
    const fs = require('fs');
    const path = require('path');
    const { PDFDocument } = require('pdf-lib');
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'assets', 'forms', 'fdacs-13645-fillable.pdf'));
    const doc = await PDFDocument.load(bytes);
    const form = doc.getForm();
    const vals = _private.buildTextValues({
      findings: baseProject.findings,
      customer,
      project: baseProject,
      applicator: { name: 'Adam Tech', idCardNo: 'JF12345' },
    });
    const names = [
      ...Object.keys(vals),
      ...Object.keys(_private.FITTED_FIELDS),
      ...Object.values(_private.LINE_POOLS).flatMap((p) => p.fields),
    ];
    for (const name of names) {
      expect(() => form.getTextField(name)).not.toThrow();
    }
  });

  test('sanitizeText strips emoji and converts smart punctuation', () => {
    expect(_private.sanitizeText('Mud tubes 🐜 at “garage” — café')).toBe('Mud tubes  at "garage" - cafe');
    expect(_private.sanitizeText('line1\r\nline2\rline3')).toBe('line1\nline2\nline3');
  });

  test('the PDF input path scrubs internal keys and fee cues from findings', () => {
    // The filled FDACS PDF is emailed and archived — a fee typed into the
    // free-text comments must not print into Section 5 (codex #2817).
    const safe = _private.customerSafeFindings({
      wdo_finding: 'No visible signs of WDO observed',
      comments: 'Inspection fee $250 collected at closing.',
      inspection_fee: '250',
    });
    expect(safe.inspection_fee).toBeUndefined();
    expect(safe.comments).toBe('Inspection fee [fee removed] collected at closing.');
    expect(safe.wdo_finding).toBe('No visible signs of WDO observed');
  });

  test('emoji and unicode in findings do not make the report unsendable', async () => {
    const project = {
      ...baseProject,
      findings: {
        ...baseProject.findings,
        wdo_evidence: 'Mud tubes 🐜🏠 at “garage” slab — très bad…',
        comments: 'Recommend full treatment ✔️ ASAP',
        notice_location: 'Front door 🚪',
      },
    };
    const buf = await buildWdoReportPDFBuffer({ project, customer });
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('long findings flow onto a continuation page instead of clipping', async () => {
    const { PDFDocument } = require('pdf-lib');
    const longDamage = Array.from({ length: 120 }, (_, i) => `Damage item ${i + 1} subfloor joist segment with frass accumulation;`).join(' ');
    const project = {
      ...baseProject,
      findings: { ...baseProject.findings, wdo_damage: longDamage, comments: longDamage },
    };
    const buf = await buildWdoReportPDFBuffer({ project, customer });
    const doc = await PDFDocument.load(buf);
    // 2 FDACS form pages + at least one continuation page.
    expect(doc.getPageCount()).toBeGreaterThan(2);
  });

  test('short findings add no continuation page', async () => {
    const { PDFDocument } = require('pdf-lib');
    const buf = await buildWdoReportPDFBuffer({ project: baseProject, customer });
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(2);
  });

  test('cutToFit with a plain suffix never promises an attached page', async () => {
    const { PDFDocument, StandardFonts } = require('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const long = 'A very long property address line that cannot possibly fit in a narrow footer blank '.repeat(3);
    const plain = _private.cutToFit(long, font, 150, ['...']);
    expect(plain.endsWith('...')).toBe(true);
    expect(plain).not.toMatch(/attached page|cont\./);
    const marked = _private.cutToFit(long, font, 300, ['... (continued on attached page)', '... (see attached page)', '... (cont.)']);
    expect(marked).toMatch(/attached page|cont\./);
  });

  // The footer address duplicate (addrofpropinspected, ~217pt) is much
  // narrower than the main Section 1 address line (~420pt). An address that
  // fits the main line but not the footer must NOT mint a continuation page
  // (the footer truncates plainly; only labeled fields record entries).
  test('address fitting the main line but not the footer duplicate adds no continuation page', async () => {
    const { PDFDocument } = require('pdf-lib');
    const project = {
      ...baseProject,
      findings: {
        ...baseProject.findings,
        property_address: '12345 Longwood Park Boulevard Apartment 221B, Lakewood Ranch, FL 34211',
      },
    };
    const buf = await buildWdoReportPDFBuffer({ project, customer });
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(2);
  });

  test('flatten succeeds with minimal findings (no radios selected)', async () => {
    const project = {
      ...baseProject,
      findings: { property_address: '456 Palm Dr, Sarasota, FL 34236' },
    };
    const buf = await buildWdoReportPDFBuffer({ project, customer });
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('buildWdoReportPDFBuffer returns a valid PDF buffer', async () => {
    const buf = await buildWdoReportPDFBuffer({ project: baseProject, customer });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(10000);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('buildWdoReportPDFBuffer throws without a project', async () => {
    await expect(buildWdoReportPDFBuffer({})).rejects.toThrow(/project required/);
  });

  const ONE_PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

  test('appends a photo addendum (2 photos per page)', async () => {
    const { PDFDocument } = require('pdf-lib');
    const buffer = Buffer.from(ONE_PX_PNG, 'base64');
    const photos = [
      { buffer, contentType: 'image/png', caption: 'Photo A' },
      { buffer, contentType: 'image/png', caption: 'Photo B' },
      { buffer, contentType: 'image/png', caption: 'Photo C' },
    ];
    const out = await buildWdoReportPDFBuffer({ project: baseProject, customer, photos });
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(4); // 2 FDACS form pages + 2 addendum pages (3 photos)
  });

  test('stamps a signature without throwing', async () => {
    const out = await buildWdoReportPDFBuffer({
      project: baseProject,
      customer,
      signature: { image: `data:image/png;base64,${ONE_PX_PNG}`, contentType: 'image/png', signerName: 'Adam Benetti' },
    });
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('decodeImageInput handles data URLs and raw base64', () => {
    const fromDataUrl = _private.decodeImageInput(`data:image/png;base64,${ONE_PX_PNG}`);
    const fromRaw = _private.decodeImageInput(ONE_PX_PNG);
    expect(Buffer.isBuffer(fromDataUrl)).toBe(true);
    expect(fromDataUrl.equals(fromRaw)).toBe(true);
  });
});

// Section 3 used to print EVERY category's text on the Attic row, because the
// line pool targeted only that row's three fields while the checkboxes were
// keyword-detected independently. A form could tick Interior/Exterior and then
// print those limitations on the Attic line — misattributing where the
// inspector could not see.
describe('wdo-report-pdf Section 3 row distribution', () => {
  const { splitInaccessibleAreas, INACCESSIBLE_ROWS } = _private;
  const keys = (t) => [...splitInaccessibleAreas(t).ticked].sort();

  test('labelled segments route to their own rows', () => {
    const { rows, ticked } = splitInaccessibleAreas(
      'Attic: concealed by insulation. Interior: wall and ceiling voids. Exterior: enclosed soffits.'
    );
    expect(rows.attic).toBe('concealed by insulation.');
    expect(rows.interior).toBe('wall and ceiling voids.');
    expect(rows.exterior).toBe('enclosed soffits.');
    expect(rows.crawlspace).toBeUndefined();
    expect([...ticked].sort()).toEqual(['attic', 'exterior', 'interior']);
  });

  test('REGRESSION: a category the text never mentions gets neither text nor a tick', () => {
    const { rows, ticked } = splitInaccessibleAreas(
      'Crawlspace: skirting closed, no access. Interior: wall voids. Exterior: soffit wrap.'
    );
    // The whole point: nothing lands on the Attic row and Attic stays unticked.
    expect(rows.attic).toBeUndefined();
    expect(ticked.has('attic')).toBe(false);
    expect(rows.crawlspace).toBe('skirting closed, no access.');
    expect(ticked.has('crawlspace')).toBe(true);
  });

  test('em-dash and semicolon separated labels split (legacy findings style)', () => {
    const { rows } = splitInaccessibleAreas('Attic — insulation; Crawlspace — no hatch');
    expect(rows.attic).toBe('insulation');
    expect(rows.crawlspace).toBe('no hatch');
  });

  test('crawl space spelling variants all map to the Crawlspace row', () => {
    for (const label of ['Crawl space:', 'Crawlspace:', 'Crawl Spaces:', 'crawl:']) {
      expect(keys(`${label} no hatch`)).toEqual(['crawlspace']);
    }
  });

  test('unlabelled text lands on the first row it matches, not the Attic row', () => {
    const { rows, ticked } = splitInaccessibleAreas('Areas of the interior were blocked by stored goods');
    expect(rows.attic).toBeUndefined();
    expect(rows.interior).toContain('stored goods');
    expect([...ticked]).toEqual(['interior']);
  });

  test('text matching no category is disclosed under Other', () => {
    const { rows, ticked } = splitInaccessibleAreas('Locked utility shed was not opened');
    expect([...ticked]).toEqual(['other']);
    expect(rows.other).toBe('Locked utility shed was not opened');
  });

  test('preamble before the first label is kept, not dropped', () => {
    const { rows } = splitInaccessibleAreas('Not inspected. Interior: wall voids.');
    expect(rows.interior).toBe('Not inspected. wall voids.');
  });

  test('empty findings tick nothing', () => {
    expect(keys('')).toEqual([]);
    expect(keys(undefined)).toEqual([]);
  });

  // Compliance guard: a renamed/typo'd field would silently drop a whole row's
  // text off the official filing, which is exactly the class of bug this fixes.
  test('every mapped Section 3 field exists in the bundled FDACS template', async () => {
    const fs = require('fs');
    const path = require('path');
    const { PDFDocument } = require('pdf-lib');
    const tpl = path.join(__dirname, '..', 'assets', 'forms', 'fdacs-13645-fillable.pdf');
    const doc = await PDFDocument.load(fs.readFileSync(tpl));
    const form = doc.getForm();
    const names = new Set(form.getFields().map((f) => f.getName()));
    for (const row of INACCESSIBLE_ROWS) {
      expect(names.has(row.checkbox)).toBe(true);
      for (const f of row.fields) expect(names.has(f)).toBe(true);
    }
  });

  test('no writing line is shared between two rows', () => {
    const all = INACCESSIBLE_ROWS.flatMap((r) => r.fields);
    expect(new Set(all).size).toBe(all.length);
  });

  test('renders with all five categories populated', async () => {
    const { PDFDocument } = require('pdf-lib');
    const project = {
      id: 'p1',
      project_type: 'wdo_inspection',
      tech_name: 'Adam Tech',
      created_at: '2026-05-20',
      findings: {
        wdo_finding: 'No visible signs of WDO observed',
        inaccessible_areas: 'Attic: insulation. Interior: wall voids. Exterior: soffits. Crawlspace: skirting closed. Other: locked shed.',
      },
    };
    const buf = await buildWdoReportPDFBuffer({ project, customer: {} });
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(buf)).getPageCount()).toBe(2);
  });
});

// Codex #3188 P1: the property-intelligence emitter
// (client/src/lib/wdoProfileToFindings.js) appends whole LINES where a filler
// word sits between the category and the dash. With a separator-required-only
// parser, such a note folded into the preceding labelled segment and its box
// never ticked — reintroducing the exact misattribution this PR fixes.
describe('wdo-report-pdf Section 3 — generated property-intelligence notes', () => {
  const { splitInaccessibleAreas } = _private;

  // Verbatim strings emitted by applyProfileToWdoFindings().
  const CRAWL_PRESENT = 'Crawlspace present — verify access and clearance on site.';
  const CRAWL_SLAB = 'Crawlspace: N/A — slab-on-grade foundation.';

  test('generated crawlspace note keeps its own row alongside a tech label', () => {
    const { rows, ticked } = splitInaccessibleAreas(`Attic: concealed by insulation.\n${CRAWL_PRESENT}`);
    expect(rows.attic).toBe('concealed by insulation.');
    // sanitizeText normalises the em-dash to WinAnsi before it reaches the form.
    expect(rows.crawlspace).toBe('present - verify access and clearance on site.');
    expect(ticked.has('crawlspace')).toBe(true);
    expect([...ticked].sort()).toEqual(['attic', 'crawlspace']);
  });

  test('generated slab note keeps its own row alongside a tech label', () => {
    const { rows, ticked } = splitInaccessibleAreas(`Interior: wall voids.\n${CRAWL_SLAB}`);
    expect(rows.interior).toBe('wall voids.');
    expect(rows.crawlspace).toBe('N/A - slab-on-grade foundation.');
    expect([...ticked].sort()).toEqual(['crawlspace', 'interior']);
  });

  test('generated note alone still routes to Crawlspace', () => {
    const { rows, ticked } = splitInaccessibleAreas(CRAWL_PRESENT);
    expect([...ticked]).toEqual(['crawlspace']);
    expect(rows.crawlspace).toBe('present - verify access and clearance on site.');
  });

  test('a bare category word mid-sentence still does NOT split a segment', () => {
    // "interior" here is prose, not a label — it must not start a new row.
    const { rows, ticked } = splitInaccessibleAreas('Attic: areas of the interior hatch were blocked.');
    expect(rows.attic).toBe('areas of the interior hatch were blocked.');
    expect([...ticked]).toEqual(['attic']);
  });

  test('multiple generated lines each keep their own row', () => {
    const { ticked } = splitInaccessibleAreas(
      `Attic: insulation.\n${CRAWL_PRESENT}\nExterior soffit wrap conceals the fascia.`
    );
    expect([...ticked].sort()).toEqual(['attic', 'crawlspace', 'exterior']);
  });
});

// Codex #3188 round 2.
describe('wdo-report-pdf Section 3 — multi-category and hyphen handling', () => {
  const { splitInaccessibleAreas } = _private;

  // P1: the findings textarea is documented as holding several categories at
  // once, and the old checkbox matcher ticked every one it saw. Selecting a
  // single row would silently drop a disclosed limitation off a signed filing.
  test('unlabelled text mentioning several categories ticks and states ALL of them', () => {
    const text = 'Areas of the interior and exterior were blocked by stored goods';
    const { rows, ticked } = splitInaccessibleAreas(text);
    expect([...ticked].sort()).toEqual(['exterior', 'interior']);
    expect(rows.interior).toBe(text);
    expect(rows.exterior).toBe(text);
  });

  test('unlabelled text naming all four named categories ticks all four', () => {
    const { ticked } = splitInaccessibleAreas(
      'Attic, interior, exterior and crawlspace areas were not fully accessible'
    );
    expect([...ticked].sort()).toEqual(['attic', 'crawlspace', 'exterior', 'interior']);
  });

  // P2: a bare hyphen inside a compound must not read as a label separator.
  test('hyphenated compounds do not split a segment', () => {
    const { rows, ticked } = splitInaccessibleAreas(
      'Attic: inaccessible at exterior-facing eaves due to insulation'
    );
    expect([...ticked]).toEqual(['attic']);
    expect(rows.attic).toBe('inaccessible at exterior-facing eaves due to insulation');
    expect(rows.exterior).toBeUndefined();
  });

  test('spaced dashes still separate labels', () => {
    const { rows } = splitInaccessibleAreas('Attic - insulation. Exterior - soffit wrap.');
    expect(rows.attic).toBe('insulation.');
    expect(rows.exterior).toBe('soffit wrap.');
  });

  test('slab-on-grade compound survives inside a labelled segment', () => {
    const { rows, ticked } = splitInaccessibleAreas('Crawlspace: N/A — slab-on-grade foundation.');
    expect([...ticked]).toEqual(['crawlspace']);
    expect(rows.crawlspace).toBe('N/A - slab-on-grade foundation.');
  });
});

// Codex #3188 round 3.
describe('wdo-report-pdf Section 3 — mixed syntax and decimal safety', () => {
  const { splitInaccessibleAreas } = _private;

  // P1: an explicit label followed by prose naming other categories.
  test('prose categories after an explicit label are still ticked', () => {
    const { rows, ticked } = splitInaccessibleAreas('Attic: insulation; interior and exterior were blocked');
    expect([...ticked].sort()).toEqual(['attic', 'exterior', 'interior']);
    expect(rows.attic).toBe('insulation');
    expect(rows.interior).toBe('interior and exterior were blocked');
    expect(rows.exterior).toBe('interior and exterior were blocked');
  });

  // P2: a leading decimal point is data, not separator noise. Stripping it
  // turns ".5-inch" into "5-inch" — a tenfold error on a signed filing.
  test('leading decimal point is preserved in row text', () => {
    const { rows } = splitInaccessibleAreas('Interior: .5-inch opening was inaccessible');
    expect(rows.interior).toBe('.5-inch opening was inaccessible');
  });

  test('leading separator punctuation is still stripped', () => {
    const { rows } = splitInaccessibleAreas('Interior: . wall voids');
    expect(rows.interior).toBe('wall voids');
  });

  // An unlabelled clause naming NO category continues the previous claim
  // rather than opening an Other row.
  test('semicolon continuation stays on the labelled row and keeps its semicolon', () => {
    const { rows, ticked } = splitInaccessibleAreas(
      'Crawlspace: skirting was closed at the time of inspection; the area beneath was not inspected.'
    );
    expect([...ticked]).toEqual(['crawlspace']);
    expect(rows.crawlspace).toBe(
      'skirting was closed at the time of inspection; the area beneath was not inspected.'
    );
  });

  test('hyphenated category adjective still does not tick its category', () => {
    const { ticked } = splitInaccessibleAreas('Attic: inaccessible at exterior-facing eaves due to insulation');
    expect([...ticked]).toEqual(['attic']);
  });
});

// Caught by rendering the PDF, not by the unit tests above: when a clause has
// BOTH a continuation preamble and later inline labels, the preamble belongs
// to the previous clause's row, not to the first label in this one.
describe('wdo-report-pdf Section 3 — continuation before a later label', () => {
  const { splitInaccessibleAreas } = _private;

  test('continuation sentence stays with the previous row when a label follows', () => {
    const { rows, ticked } = splitInaccessibleAreas(
      'Crawlspace: skirting was closed at the time of inspection; the area beneath was not inspected. '
      + 'Interior: wall and ceiling voids. Exterior: soffit and fascia wrap.'
    );
    expect([...ticked].sort()).toEqual(['crawlspace', 'exterior', 'interior']);
    expect(rows.crawlspace).toBe(
      'skirting was closed at the time of inspection; the area beneath was not inspected.'
    );
    expect(rows.interior).toBe('wall and ceiling voids.');
    expect(rows.exterior).toBe('soffit and fascia wrap.');
  });

  test('with no previous row the preamble still attaches to the first label', () => {
    const { rows } = splitInaccessibleAreas('Not inspected. Interior: wall voids.');
    expect(rows.interior).toBe('Not inspected. wall voids.');
  });
});

// Codex #3188 round 4.
describe('wdo-report-pdf Section 3 — category lists, wrapped lines, crawl-space spelling', () => {
  const { splitInaccessibleAreas } = _private;

  // P1: the repo's OWN placeholder shape. Only "other:" is an explicit label,
  // so routing the preamble to it alone left four categories unticked.
  test("the repo's placeholder shape ticks every category it lists", () => {
    const { ticked } = splitInaccessibleAreas(
      'Attic, interior, exterior, crawlspace, other: specific areas and reasons'
    );
    expect([...ticked].sort()).toEqual(['attic', 'crawlspace', 'exterior', 'interior', 'other']);
  });

  // P2: a wrapped reason must not split across two rows.
  test('a manual line break inside one reason stays on the same row', () => {
    const { rows, ticked } = splitInaccessibleAreas('Attic: North side blocked by insulation\nand HVAC ductwork');
    expect([...ticked]).toEqual(['attic']);
    expect(rows.attic).toBe('North side blocked by insulation and HVAC ductwork');
    expect(rows.other).toBeUndefined();
  });

  test('a labelled later line still overrides the carried row', () => {
    const { rows, ticked } = splitInaccessibleAreas(
      'Attic: insulation\nand ductwork\nInterior: wall voids'
    );
    expect([...ticked].sort()).toEqual(['attic', 'interior']);
    expect(rows.attic).toBe('insulation and ductwork');
    expect(rows.interior).toBe('wall voids');
  });

  // P2: "Crawl-space" is a common spelling; the old includes('crawl') caught it.
  test.each(['Crawl-space: no hatch', 'crawl-space was inaccessible', 'Crawl space: no hatch'])(
    'crawl-space spelling %p routes to Crawlspace, not Other',
    (input) => {
      const { ticked } = splitInaccessibleAreas(input);
      expect([...ticked]).toEqual(['crawlspace']);
    }
  );

  test('hyphenated adjective guard still holds for other categories', () => {
    const { ticked } = splitInaccessibleAreas('Attic: inaccessible at exterior-facing eaves due to insulation');
    expect([...ticked]).toEqual(['attic']);
  });
});

// Codex #3188 round 5.
describe('wdo-report-pdf Section 3 — shared reasons, standalone adjectives, paragraph breaks', () => {
  const { splitInaccessibleAreas } = _private;

  // P1: ticking a row whose FDACS line states no limitation is not a disclosure.
  test('a listed category gets the shared REASON, not the category name list', () => {
    const { rows, ticked } = splitInaccessibleAreas(
      'Attic, interior, exterior, crawlspace, other: blocked by stored goods'
    );
    expect([...ticked].sort()).toEqual(['attic', 'crawlspace', 'exterior', 'interior', 'other']);
    for (const key of ['attic', 'interior', 'exterior', 'crawlspace', 'other']) {
      expect(rows[key]).toBe('blocked by stored goods');
    }
  });

  // P2: a hyphenated category IS the classification when it stands alone.
  test('standalone hyphenated description classifies by its category', () => {
    const { rows, ticked } = splitInaccessibleAreas('Exterior-facing eaves were inaccessible');
    expect([...ticked]).toEqual(['exterior']);
    expect(rows.exterior).toBe('Exterior-facing eaves were inaccessible');
  });

  // ...but inside an explicit label it is still just prose. This holds
  // structurally: a labelled body never reaches the mention matcher.
  test('hyphenated adjective inside a labelled row still does not tick its category', () => {
    const { rows, ticked } = splitInaccessibleAreas('Attic: inaccessible at exterior-facing eaves due to insulation');
    expect([...ticked]).toEqual(['attic']);
    expect(rows.attic).toBe('inaccessible at exterior-facing eaves due to insulation');
  });

  // P2: a blank line separates entries; only a single wrapped line continues.
  test('a blank line ends the carried row', () => {
    const { rows, ticked } = splitInaccessibleAreas('Attic: blocked by insulation\n\nLocked utility shed was not inspected');
    expect([...ticked].sort()).toEqual(['attic', 'other']);
    expect(rows.attic).toBe('blocked by insulation');
    expect(rows.other).toBe('Locked utility shed was not inspected');
  });

  test('a single wrapped line still continues the row', () => {
    const { rows } = splitInaccessibleAreas('Attic: blocked by insulation\nand HVAC ductwork');
    expect(rows.attic).toBe('blocked by insulation and HVAC ductwork');
    expect(rows.other).toBeUndefined();
  });
});

// Codex #3188 round 6: a label may name SEVERAL categories sharing one
// separator. Matching only the last one appended the rest to the previous row.
describe('wdo-report-pdf Section 3 — grouped labels', () => {
  const { splitInaccessibleAreas } = _private;

  test('a grouped label gives its reason to every category it names', () => {
    const { rows, ticked } = splitInaccessibleAreas(
      'Attic: insulation. Interior and exterior: blocked by stored goods'
    );
    expect([...ticked].sort()).toEqual(['attic', 'exterior', 'interior']);
    expect(rows.attic).toBe('insulation.');
    expect(rows.interior).toBe('blocked by stored goods');
    expect(rows.exterior).toBe('blocked by stored goods');
  });

  test.each([
    ['Interior, exterior: blocked', ['exterior', 'interior']],
    ['Interior & exterior: blocked', ['exterior', 'interior']],
    ['Attic, interior, and crawlspace: blocked', ['attic', 'crawlspace', 'interior']],
  ])('grouped label %p ticks every member', (input, expected) => {
    const { ticked } = splitInaccessibleAreas(input);
    expect([...ticked].sort()).toEqual(expected);
  });

  test('a comma list terminated by one label still shares the reason', () => {
    const { rows, ticked } = splitInaccessibleAreas(
      'Attic, interior, exterior, crawlspace, other: blocked by stored goods'
    );
    expect([...ticked].sort()).toEqual(['attic', 'crawlspace', 'exterior', 'interior', 'other']);
    for (const k of ['attic', 'interior', 'exterior', 'crawlspace', 'other']) {
      expect(rows[k]).toBe('blocked by stored goods');
    }
  });

  test('an unlabelled category list is still not a label', () => {
    const { rows, ticked } = splitInaccessibleAreas('Interior and exterior were blocked by stored goods');
    expect([...ticked].sort()).toEqual(['exterior', 'interior']);
    expect(rows.interior).toBe('Interior and exterior were blocked by stored goods');
  });
});

// Codex #3188 round 7.
describe('wdo-report-pdf Section 3 — sentence delimiters and grouped continuations', () => {
  const { splitInaccessibleAreas } = _private;

  // P1: a limitation is delimited by an ordinary sentence period too, not only
  // by a semicolon.
  test('a period-delimited category claim routes independently', () => {
    const { rows, ticked } = splitInaccessibleAreas(
      'Attic: insulation. Interior and exterior were blocked by stored goods'
    );
    expect([...ticked].sort()).toEqual(['attic', 'exterior', 'interior']);
    expect(rows.attic).toBe('insulation.');
    expect(rows.interior).toBe('Interior and exterior were blocked by stored goods');
    expect(rows.exterior).toBe('Interior and exterior were blocked by stored goods');
  });

  // P2: a grouped label keeps ALL its rows active for continuations.
  test('a continuation after a grouped label reaches every row in the group', () => {
    const { rows } = splitInaccessibleAreas(
      'Interior and exterior: blocked by stored goods; shelving prevented access'
    );
    expect(rows.interior).toBe('blocked by stored goods; shelving prevented access');
    expect(rows.exterior).toBe('blocked by stored goods; shelving prevented access');
  });

  test('a wrapped-line continuation also reaches every row in the group', () => {
    const { rows } = splitInaccessibleAreas('Interior and exterior: blocked by stored goods\nand shelving');
    expect(rows.interior).toBe('blocked by stored goods and shelving');
    expect(rows.exterior).toBe('blocked by stored goods and shelving');
  });

  // The sentence splitter must never treat a decimal point as a boundary.
  test('a decimal point is not a sentence boundary', () => {
    const { rows } = splitInaccessibleAreas('Interior: .5-inch opening was inaccessible');
    expect(rows.interior).toBe('.5-inch opening was inaccessible');
    expect(rows.other).toBeUndefined();
  });

  test('a lead-in sentence still attaches to the first label on its line', () => {
    const { rows, ticked } = splitInaccessibleAreas('Not inspected. Interior: wall voids.');
    expect([...ticked]).toEqual(['interior']);
    expect(rows.interior).toBe('Not inspected. wall voids.');
  });

  // The real inspection text this branch exists for.
  test('a full real-world Section 3 entry routes to three distinct rows', () => {
    const { rows, ticked } = splitInaccessibleAreas(
      'Crawlspace: skirting was closed at the time of inspection; the area beneath was not inspected. '
      + 'Interior: wall and ceiling voids. Exterior: soffit and fascia wrap.'
    );
    expect([...ticked].sort()).toEqual(['crawlspace', 'exterior', 'interior']);
    expect(rows.crawlspace).toBe('skirting was closed at the time of inspection; the area beneath was not inspected.');
    expect(rows.interior).toBe('wall and ceiling voids.');
    expect(rows.exterior).toBe('soffit and fascia wrap.');
    expect(rows.attic).toBeUndefined();
  });
});

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

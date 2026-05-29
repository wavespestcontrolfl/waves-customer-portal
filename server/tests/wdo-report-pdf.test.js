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

  test('buildWdoReportPDFBuffer returns a valid PDF buffer', async () => {
    const buf = await buildWdoReportPDFBuffer({ project: baseProject, customer });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(10000);
    expect(buf.slice(0, 5).toString()).toBe('%PDF-');
  });

  test('buildWdoReportPDFBuffer throws without a project', async () => {
    await expect(buildWdoReportPDFBuffer({})).rejects.toThrow(/project required/);
  });
});

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));

const projectsRouter = require('../routes/admin-projects');
const db = require('../models/db');

const {
  canAccessProject,
  hasProjectAccess,
  detectedImageMime,
  validateUploadedImage,
  evaluateProjectSendReadiness,
  dropStaleCertTreatmentDate,
  resolveWdoInspectionFee,
  wdoFeeIsExplicitZero,
} = projectsRouter._private;

describe('admin project route guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('admins can access any project and techs only access their own project', () => {
    expect(canAccessProject(
      { techRole: 'admin', technicianId: 'admin-1' },
      { created_by_tech_id: 'tech-1' },
    )).toBe(true);

    expect(canAccessProject(
      { techRole: 'technician', technicianId: 'tech-1' },
      { created_by_tech_id: 'tech-1' },
    )).toBe(true);

    expect(canAccessProject(
      { techRole: 'technician', technicianId: 'tech-2' },
      { created_by_tech_id: 'tech-1' },
    )).toBe(false);
  });

  test('techs can access projects linked to their assigned service or schedule', async () => {
    const serviceQuery = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: 'service-1' }),
    };
    db.mockImplementation((table) => {
      if (table === 'service_records') return serviceQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await expect(hasProjectAccess(
      { techRole: 'technician', technicianId: 'tech-2' },
      { created_by_tech_id: 'admin-1', service_record_id: 'service-1' },
    )).resolves.toBe(true);
    expect(serviceQuery.where).toHaveBeenCalledWith({ id: 'service-1', technician_id: 'tech-2' });

    const scheduledQuery = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: 'schedule-1' }),
    };
    db.mockImplementation((table) => {
      if (table === 'service_records') return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
      if (table === 'scheduled_services') return scheduledQuery;
      throw new Error(`Unexpected table query: ${table}`);
    });

    await expect(hasProjectAccess(
      { techRole: 'technician', technicianId: 'tech-2' },
      { created_by_tech_id: 'admin-1', service_record_id: 'service-1', scheduled_service_id: 'schedule-1' },
    )).resolves.toBe(true);
    expect(scheduledQuery.where).toHaveBeenCalledWith({ id: 'schedule-1', technician_id: 'tech-2' });
  });

  test('detects supported image payload signatures', () => {
    expect(detectedImageMime(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]))).toBe('image/jpeg');
    expect(detectedImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]))).toBe('image/png');
    expect(detectedImageMime(Buffer.from('GIF89a000000', 'ascii'))).toBe('image/gif');
    expect(detectedImageMime(Buffer.from('RIFF0000WEBP', 'ascii'))).toBe('image/webp');
  });

  test('rejects mismatched or unsupported upload content', () => {
    expect(validateUploadedImage({
      mimetype: 'image/png',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]),
    })).toBe('image/png');

    expect(() => validateUploadedImage({
      mimetype: 'image/jpeg',
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]),
    })).toThrow(/does not match/);

    expect(() => validateUploadedImage({
      mimetype: 'image/png',
      buffer: Buffer.from('<svg></svg>'),
    })).toThrow(/not a supported image/);
  });

  test('send readiness does not require photos or recommendations for project report types', () => {
    const cases = [
      {
        project_type: 'wdo_inspection',
        findings: {
          property_address: '123 Main St, Bradenton, FL 34202',
          wdo_finding: 'No visible signs of WDO observed',
          inspection_scope: 'Interior, garage, attic access, and exterior perimeter.',
        },
      },
      {
        project_type: 'termite_inspection',
        findings: {
          areas_inspected: 'Garage, foundation, attic access, and exterior perimeter.',
          // Phase-3 compliance content is required on the project path too.
          areas_not_inspected: 'None',
          inspection_notice_affixed: 'Yes',
        },
      },
      {
        project_type: 'pest_inspection',
        findings: { areas_inspected: 'Kitchen, bathrooms, garage, and exterior entry points.' },
      },
      {
        project_type: 'flea',
        findings: { areas_inspected: 'Pet resting areas, living room rug, bedrooms, and shaded yard areas.' },
      },
      {
        project_type: 'rodent_exclusion',
        findings: { entry_points_found: 'Gap at garage door seal and pipe penetration on north wall.' },
      },
      {
        project_type: 'bed_bug',
        findings: { rooms_treated: 'Master bedroom and living room couch.' },
      },
      {
        project_type: 'pre_treatment_termite_certificate',
        findings: {
          treatment_address: '123 Main St, Bradenton, FL 34202',
          treatment_method: 'Soil barrier (chemical)',
          product_name: 'Termidor SC',
          active_ingredient: 'fipronil',
          concentration_pct: '0.060',
          square_footage: '1800',
          gallons_applied: '90',
          applicator_name: 'Adam Benetti',
          applicator_fdacs_id: 'JF123456',
          applicator_attestation: 'I am the licensed Florida applicator who performed the treatment described above, and I certify the information is true and complete (FBC 1816.1.7 / FDACS Rule 5E-14.106).',
        },
      },
    ];

    for (const report of cases) {
      const readiness = evaluateProjectSendReadiness({
        project: {
          id: `project-${report.project_type}`,
          customer_id: 'customer-1',
          project_date: '2026-05-18',
          ...report,
        },
        customer: { id: 'customer-1' },
      });

      expect(readiness.missing).toEqual([]);
      expect(readiness.required.map((item) => item.key)).not.toContain('photos');
      expect(readiness.required.map((item) => item.key)).not.toContain('recommendations');
    }
  });

  test('certificate send readiness requires a finished-solution concentration only for liquid soil barriers', () => {
    const baseCertFindings = {
      treatment_address: '123 Main St, Bradenton, FL 34202',
      applicator_name: 'Adam Benetti',
      applicator_fdacs_id: 'JF123456',
      applicator_attestation: 'I am the licensed Florida applicator who performed the treatment described above, and I certify the information is true and complete (FBC 1816.1.7 / FDACS Rule 5E-14.106).',
    };
    const evaluate = (findings) => evaluateProjectSendReadiness({
      project: {
        id: 'project-cert',
        customer_id: 'customer-1',
        project_date: '2026-05-18',
        project_type: 'pre_treatment_termite_certificate',
        findings,
      },
      customer: { id: 'customer-1' },
    });

    // Bait system: no finished solution exists — neither concentration nor
    // gallons may block the send (the create form leaves both blank).
    const bait = evaluate({
      ...baseCertFindings,
      treatment_method: 'Bait system',
      product_name: 'Trelona ATBB',
      active_ingredient: 'novaluron',
      linear_feet: '180',
    });
    expect(bait.missing).toEqual([]);

    // Wood treatment: same — measured by treated area only.
    const wood = evaluate({
      ...baseCertFindings,
      treatment_method: 'Wood treatment (borate)',
      product_name: 'Bora-Care',
      active_ingredient: 'disodium octaborate tetrahydrate',
      square_footage: '2200',
    });
    expect(wood.missing).toEqual([]);

    // Liquid soil barrier still requires the dilution.
    const soil = evaluate({
      ...baseCertFindings,
      treatment_method: 'Soil barrier (chemical)',
      product_name: 'Termidor SC',
      active_ingredient: 'fipronil',
      square_footage: '1800',
      gallons_applied: '180',
    });
    expect(soil.missing.map((item) => item.key)).toContain('cert_active_ingredient');
  });

  test('termite project sends enforce the Phase-3 compliance content (Codex P1 r2 on #2703)', () => {
    const evaluate = (project_type, findings) => evaluateProjectSendReadiness({
      project: {
        id: `project-${project_type}`,
        customer_id: 'customer-1',
        project_date: '2026-07-13',
        project_type,
        findings,
      },
      customer: { id: 'customer-1' },
    });

    // Inspection: blank compliance answers block the send; 'No' on the
    // notice is a blocking exception, not a sendable answer.
    const blankInspection = evaluate('termite_inspection', {
      areas_inspected: 'Garage, foundation, exterior perimeter.',
    });
    expect(blankInspection.missing.map((item) => item.key))
      .toEqual(expect.arrayContaining(['ti_areas_not_inspected', 'ti_inspection_notice_affixed']));

    const noticeNo = evaluate('termite_inspection', {
      areas_inspected: 'Garage, foundation, exterior perimeter.',
      areas_not_inspected: 'None',
      inspection_notice_affixed: 'No',
    });
    expect(noticeNo.missing.map((item) => item.key)).toContain('ti_inspection_notice_affixed');
    // Compliance blockers are hard — the send routes 422 on hardMissing
    // BEFORE the override_reason escape is even consulted (Codex P1 r3).
    expect(noticeNo.hardMissing.map((item) => item.key)).toContain('ti_inspection_notice_affixed');

    // A blank treatment method must not silently skip the method-derived
    // rules (Codex P1 r3) — it is itself a hard blocker.
    const methodBlank = evaluate('termite_treatment', {
      target_termite: 'Subterranean termites',
      products_used: 'Termidor SC',
      linear_feet_or_stations: '180 linear ft',
      gallons_or_amount: '72 gal',
      epa_registration: '7969-210',
      posted_notice: 'Not applicable',
    });
    expect(methodBlank.hardMissing.map((item) => item.key)).toContain('tt_treatment_method');

    // Treatment: perimeter methods demand a 'Yes' posted notice and the
    // dilution; bait work needs neither the dilution nor a posted notice
    // beyond an explicit answer.
    const treatmentBase = {
      target_termite: 'Subterranean termites',
      areas_treated: 'Exterior perimeter',
      products_used: 'Termidor SC',
      linear_feet_or_stations: '180 linear ft',
      gallons_or_amount: '72 gal',
    };
    const perimeterBlank = evaluate('termite_treatment', {
      ...treatmentBase,
      treatment_method: 'Liquid perimeter',
      posted_notice: 'Not applicable',
    });
    expect(perimeterBlank.missing.map((item) => item.key))
      .toEqual(expect.arrayContaining(['tt_epa_registration', 'tt_posted_notice', 'tt_percent_solution']));
    expect(perimeterBlank.hardMissing.map((item) => item.key))
      .toEqual(expect.arrayContaining(['tt_epa_registration', 'tt_posted_notice', 'tt_percent_solution']));

    const perimeterComplete = evaluate('termite_treatment', {
      ...treatmentBase,
      treatment_method: 'Liquid perimeter',
      percent_solution: '0.06%',
      epa_registration: '7969-210',
      posted_notice: 'Yes',
    });
    expect(perimeterComplete.missing.map((item) => item.key))
      .not.toEqual(expect.arrayContaining(['tt_epa_registration', 'tt_posted_notice', 'tt_percent_solution']));

    const baitComplete = evaluate('termite_treatment', {
      ...treatmentBase,
      treatment_method: 'Bait station setup',
      epa_registration: '100-1503',
      posted_notice: 'Not applicable',
    });
    expect(baitComplete.missing.map((item) => item.key))
      .not.toEqual(expect.arrayContaining(['tt_epa_registration', 'tt_posted_notice', 'tt_percent_solution']));
  });

  test('certificate send readiness validates each additional application like the primary', () => {
    const completePrimary = {
      treatment_address: '123 Main St, Bradenton, FL 34202',
      treatment_method: 'Soil barrier (chemical)',
      product_name: 'Termidor SC',
      active_ingredient: 'fipronil',
      concentration_pct: '0.060',
      square_footage: '1800',
      gallons_applied: '180',
      applicator_name: 'Adam Benetti',
      applicator_fdacs_id: 'JF123456',
      applicator_attestation: 'I am the licensed Florida applicator who performed the treatment described above, and I certify the information is true and complete (FBC 1816.1.7 / FDACS Rule 5E-14.106).',
    };
    const evaluate = (findings) => evaluateProjectSendReadiness({
      project: {
        id: 'project-cert-multi',
        customer_id: 'customer-1',
        project_date: '2026-05-18',
        project_type: 'pre_treatment_termite_certificate',
        findings,
      },
      customer: { id: 'customer-1' },
    });

    // Combined job: complete soil-barrier primary + complete wood-treatment
    // row sends clean. Wood treatments need area but no concentration/gallons.
    const combined = evaluate({
      ...completePrimary,
      additional_applications: [{
        treatment_method: 'Wood treatment (borate)',
        product_name: 'Bora-Care',
        epa_registration: '64405-1',
        active_ingredient: 'disodium octaborate tetrahydrate',
        square_footage: '2200',
      }],
    });
    expect(combined.missing).toEqual([]);

    // A row with content must be as complete as the primary — missing pieces
    // block the send under Application-2 keys.
    const incomplete = evaluate({
      ...completePrimary,
      additional_applications: [{ treatment_method: 'Soil barrier (chemical)' }],
    });
    expect(incomplete.missing.map((item) => item.key)).toEqual(expect.arrayContaining([
      'cert_app2_product',
      'cert_app2_active_ingredient',
      'cert_app2_coverage',
    ]));

    // Rows added but never touched (accidental "Add") are ignored, and
    // non-array garbage can't crash the gate.
    expect(evaluate({ ...completePrimary, additional_applications: [{}] }).missing).toEqual([]);
    expect(evaluate({ ...completePrimary, additional_applications: 'oops' }).missing).toEqual([]);
  });

  test('editing a certificate project date drops the stale legacy findings treatment_date', () => {
    const legacyProject = {
      project_type: 'pre_treatment_termite_certificate',
      project_date: '2026-06-18',
      findings: { treatment_date: '2026-06-20', treatment_method: 'Soil barrier (chemical)' },
    };

    // Date actually changed → the hidden legacy key is dropped so the date
    // the editor saw is what prints (findings echoed back by the client).
    const changed = {
      project_date: '2026-06-25',
      findings: { treatment_date: '2026-06-20', treatment_method: 'Soil barrier (chemical)' },
    };
    dropStaleCertTreatmentDate(legacyProject, changed);
    expect(changed.findings.treatment_date).toBeUndefined();
    expect(changed.findings.treatment_method).toBe('Soil barrier (chemical)');

    // Date changed on a findings-less update → legacy key stripped from the
    // STORED findings so the edit still takes effect on the certificate.
    const dateOnly = { project_date: '2026-06-25' };
    dropStaleCertTreatmentDate(legacyProject, dateOnly);
    expect(dateOnly.findings.treatment_date).toBeUndefined();
    expect(dateOnly.findings.treatment_method).toBe('Soil barrier (chemical)');

    // Untouched date → the attested legacy findings date keeps rendering.
    const unchanged = {
      project_date: '2026-06-18',
      findings: { treatment_date: '2026-06-20' },
    };
    dropStaleCertTreatmentDate(legacyProject, unchanged);
    expect(unchanged.findings.treatment_date).toBe('2026-06-20');

    // Date cleared → never drop the only date the certificate has left.
    const cleared = { project_date: null, findings: { treatment_date: '2026-06-20' } };
    dropStaleCertTreatmentDate(legacyProject, cleared);
    expect(cleared.findings.treatment_date).toBe('2026-06-20');

    // Non-certificate projects are never touched.
    const wdo = { project_date: '2026-06-25', findings: { treatment_date: '2026-06-20' } };
    dropStaleCertTreatmentDate({ ...legacyProject, project_type: 'wdo_inspection' }, wdo);
    expect(wdo.findings.treatment_date).toBe('2026-06-20');
  });
});

describe('WDO inspection fee resolution (no-charge rule)', () => {
  test('a positive fee entry always wins, in any reasonable format', () => {
    expect(resolveWdoInspectionFee({ inspection_fee: '175' })).toBe(175);
    expect(resolveWdoInspectionFee({ inspection_fee: '$187.50' })).toBe(187.5);
    expect(resolveWdoInspectionFee({ inspection_fee: '1,250' })).toBe(1250);
  });

  test('an explicit $0 entry resolves 0 — the no-charge statement', () => {
    expect(resolveWdoInspectionFee({ inspection_fee: '0' })).toBe(0);
    expect(resolveWdoInspectionFee({ inspection_fee: '$0.00' })).toBe(0);
    expect(resolveWdoInspectionFee({ inspection_fee: '0 — comped' })).toBe(0);
    // Explicit zero beats the sqft tier — the entry always wins.
    expect(resolveWdoInspectionFee({ inspection_fee: '0', structure_sqft: '2200' })).toBe(0);
  });

  test('blank or digit-free entries keep the owner-ruled $250 flat default', () => {
    expect(resolveWdoInspectionFee({ inspection_fee: '' })).toBe(250);
    expect(resolveWdoInspectionFee({})).toBe(250);
    expect(resolveWdoInspectionFee(null)).toBe(250);
    // "waived" carries no number — that is NOT an explicit zero.
    expect(resolveWdoInspectionFee({ inspection_fee: 'waived' })).toBe(250);
    expect(resolveWdoInspectionFee({ inspection_fee: '', structure_sqft: '2200' })).toBe(250);
  });

  test('wdoFeeIsExplicitZero only fires on a leading numeric zero', () => {
    expect(wdoFeeIsExplicitZero('0')).toBe(true);
    expect(wdoFeeIsExplicitZero('$0.00')).toBe(true);
    expect(wdoFeeIsExplicitZero('')).toBe(false);
    expect(wdoFeeIsExplicitZero('waived')).toBe(false);
    expect(wdoFeeIsExplicitZero('175')).toBe(false);
    expect(wdoFeeIsExplicitZero(null)).toBe(false);
  });
});

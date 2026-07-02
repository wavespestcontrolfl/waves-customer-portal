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
        findings: { areas_inspected: 'Garage, foundation, attic access, and exterior perimeter.' },
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
});

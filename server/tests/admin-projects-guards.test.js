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
});

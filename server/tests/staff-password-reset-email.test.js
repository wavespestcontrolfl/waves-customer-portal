jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ messageId: 'msg-1' })),
}));
jest.mock('../services/logger', () => ({ info: jest.fn() }));

const sendgrid = require('../services/sendgrid-mail');
const {
  PRODUCTION_STAFF_RESET_ORIGIN,
  isProductionStaffResetEnvironment,
  sendStaffPasswordResetEmail,
  staffPasswordResetOrigin,
  staffPasswordResetUrl,
} = require('../services/staff-password-reset-email');

describe('staff password reset email', () => {
  const originalOrigin = process.env.STAFF_PASSWORD_RESET_ORIGIN;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.STAFF_PASSWORD_RESET_ORIGIN = 'https://staff.example.test/';
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (originalOrigin === undefined) delete process.env.STAFF_PASSWORD_RESET_ORIGIN;
    else process.env.STAFF_PASSWORD_RESET_ORIGIN = originalOrigin;
    process.env.NODE_ENV = originalNodeEnv;
  });

  test('uses the configured portal origin and keeps the credential in the URL fragment', () => {
    expect(staffPasswordResetUrl('secret-token')).toBe(
      'https://staff.example.test/admin/reset-password#token=secret-token',
    );
  });

  test('pins production reset credentials to the canonical HTTPS portal', () => {
    expect(staffPasswordResetOrigin({ NODE_ENV: 'production' })).toBe(
      PRODUCTION_STAFF_RESET_ORIGIN,
    );
    expect(() => staffPasswordResetOrigin({
      NODE_ENV: 'production',
      STAFF_PASSWORD_RESET_ORIGIN: 'https://preview-attacker.example',
    })).toThrow(/must use https:\/\/portal\.wavespestcontrol\.com/);
    expect(() => staffPasswordResetOrigin({
      NODE_ENV: 'production',
      STAFF_PASSWORD_RESET_ORIGIN: 'http://portal.wavespestcontrol.com',
    })).toThrow(/must use HTTPS/);
  });

  test('treats the Railway production environment as production even when NODE_ENV is mis-set', () => {
    const railwayProduction = {
      NODE_ENV: 'development',
      RAILWAY_ENVIRONMENT_NAME: ' Production ',
    };

    expect(isProductionStaffResetEnvironment(railwayProduction)).toBe(true);
    expect(staffPasswordResetOrigin(railwayProduction)).toBe(
      PRODUCTION_STAFF_RESET_ORIGIN,
    );
    expect(() => staffPasswordResetOrigin({
      ...railwayProduction,
      STAFF_PASSWORD_RESET_ORIGIN: 'https://preview-attacker.example',
    })).toThrow(/must use https:\/\/portal\.wavespestcontrol\.com/);
    expect(() => staffPasswordResetOrigin({
      ...railwayProduction,
      STAFF_PASSWORD_RESET_ORIGIN: 'http://localhost:5173',
    })).toThrow(/must use HTTPS/);
  });

  test('marks an invalid reset origin as definitely not queued', async () => {
    process.env.NODE_ENV = 'production';
    process.env.STAFF_PASSWORD_RESET_ORIGIN = 'https://preview-attacker.example';

    await expect(sendStaffPasswordResetEmail({
      technicianId: 'tech-1',
      email: 'admin@example.test',
      token: 'secret-token',
    })).rejects.toMatchObject({
      definitelyNotQueued: true,
      message: expect.stringMatching(/must use https:\/\/portal\.wavespestcontrol\.com/),
    });
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('allows HTTP only for loopback development and rejects URL decorations', () => {
    expect(staffPasswordResetOrigin({
      NODE_ENV: 'development',
      STAFF_PASSWORD_RESET_ORIGIN: 'http://localhost:5173',
    })).toBe('http://localhost:5173');
    expect(() => staffPasswordResetOrigin({
      NODE_ENV: 'test',
      STAFF_PASSWORD_RESET_ORIGIN: 'https://staff.example.test/path',
    })).toThrow(/only an origin/);
    expect(() => staffPasswordResetOrigin({
      NODE_ENV: 'test',
      STAFF_PASSWORD_RESET_ORIGIN: 'http://staff.example.test',
    })).toThrow(/must use HTTPS/);
  });

  test('sends as transactional mail without a suppression group', async () => {
    await sendStaffPasswordResetEmail({
      technicianId: 'tech-1',
      email: 'admin@example.test',
      token: 'secret-token',
    });

    expect(sendgrid.sendOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'admin@example.test',
      asmGroupId: 0,
      suppressErrorLog: true,
      disableTracking: true,
      categories: ['staff_password_reset'],
      text: expect.stringContaining('#token=secret-token'),
    }));
  });
});

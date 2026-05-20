/**
 * I2: every caller of sendgrid.sendOne should declare its sender identity
 * explicitly instead of inheriting sendgrid-mail's `newsletter@` default.
 *
 * Pin the two sites this audit fixed:
 *   - newsletter-confirm: legitimately uses `newsletter@` — declare it.
 *   - service-report/email-delivery: transactional, must NOT inherit the
 *     newsletter default. Use `contact@`.
 */

jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  sendOne: jest.fn(async () => ({ messageId: 'sg-1' })),
  sendBatch: jest.fn(),
  sendBroadcast: jest.fn(),
  newsletterGroupId: () => 101,
  serviceGroupId: () => 202,
}));

const sendgrid = require('../services/sendgrid-mail');

describe('newsletter-confirm', () => {
  beforeEach(() => jest.clearAllMocks());

  test('sendConfirmationEmail passes newsletter@ explicitly', async () => {
    const { sendConfirmationEmail } = require('../services/newsletter-confirm');
    await sendConfirmationEmail({
      id: 'sub-1',
      email: 'lead@example.com',
      first_name: 'Pat',
      confirmation_token: 'token-abc',
    });
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    const args = sendgrid.sendOne.mock.calls[0][0];
    expect(args.fromEmail).toBe('newsletter@wavespestcontrol.com');
    expect(args.fromName).toBe('The Waves Newsletter');
    // Still bypasses suppression (asmGroupId: 0) — that's the existing
    // contract; this test guards it as a side effect of pinning the args.
    expect(args.asmGroupId).toBe(0);
  });
});

describe('service-report email delivery from-address (regression guard)', () => {
  // We don't fully exercise the send path here — that's the
  // service-report-v1 suite — just confirm the literal arguments
  // are present in the file so a future refactor can't silently
  // drop the explicit identity and re-introduce the bug.
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'service-report', 'email-delivery.js'),
    'utf8',
  );

  test("passes fromEmail: 'contact@wavespestcontrol.com' to sendgrid.sendOne", () => {
    expect(src).toMatch(/fromEmail:\s*['"]contact@wavespestcontrol\.com['"]/);
  });

  test("passes fromName: 'Waves Pest Control' to sendgrid.sendOne", () => {
    expect(src).toMatch(/fromName:\s*['"]Waves Pest Control['"]/);
  });
});

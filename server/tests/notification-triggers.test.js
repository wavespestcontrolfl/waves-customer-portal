const { __private } = require('../services/notification-triggers');

describe('notification trigger push tags', () => {
  test('SMS replies get unique tags so iOS does not silently replace prior alerts', () => {
    const payload = { threadId: 'customer-123', fromPhone: '+19415551234' };

    const first = __private.pushTagFor('sms_reply', payload);
    const second = __private.pushTagFor('sms_reply', payload);

    expect(first).toMatch(/^waves-sms_reply-customer-123-/);
    expect(second).toMatch(/^waves-sms_reply-customer-123-/);
    expect(first).not.toBe(second);
    expect(first).not.toContain(payload.fromPhone);
    expect(second).not.toContain(payload.fromPhone);
  });

  test('non-SMS triggers keep collapsing by trigger key', () => {
    expect(__private.pushTagFor('payment_failed', {})).toBe('waves-payment_failed');
  });
});

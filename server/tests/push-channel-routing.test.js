// Push channel routing decision rules. The pure decision must fail toward
// SMS on every uncertainty: gate off, no customer, media present,
// operator-authored, or an unlisted template. Conversational and
// link-critical templates must never appear in the policy table.

const {
  decidePushRoute,
  PUSH_ROUTING_POLICY,
  _test,
} = require('../services/messaging/push-channel-routing');

const base = {
  gateOn: true,
  customerId: 'c-1',
  messageType: 'appointment_reminder',
  hasMedia: false,
  humanAuthored: false,
  operatorInitiated: false,
};

describe('decidePushRoute', () => {
  it('is sms_only while the gate is off', () => {
    expect(decidePushRoute({ ...base, gateOn: false })).toBe('sms_only');
  });

  it('is sms_only without a customer id', () => {
    expect(decidePushRoute({ ...base, customerId: null })).toBe('sms_only');
  });

  it('is sms_only when the message carries media', () => {
    expect(decidePushRoute({ ...base, hasMedia: true })).toBe('sms_only');
  });

  it('is sms_only for operator-authored messages', () => {
    expect(decidePushRoute({ ...base, humanAuthored: true })).toBe('sms_only');
  });

  it('is sms_only when the operator explicitly initiated the send', () => {
    // Admin receipt routes accept via:'sms' with operatorInitiated:true —
    // the operator chose the channel; push must not override it.
    expect(decidePushRoute({ ...base, messageType: 'receipt', operatorInitiated: true })).toBe('sms_only');
  });

  it('routes critical templates to both channels', () => {
    for (const t of ['appointment_reminder', 'reminder_72h', 'billing_reminder', 'payment_failure', 'autopay']) {
      expect(decidePushRoute({ ...base, messageType: t })).toBe('push_and_sms');
    }
  });

  it('routes low-stakes informational templates push-first', () => {
    expect(decidePushRoute({ ...base, messageType: 'tech_en_route' })).toBe('push_first');
    expect(decidePushRoute({ ...base, messageType: 'receipt' })).toBe('push_first');
  });

  it('defaults every unlisted template to sms_only', () => {
    for (const t of ['manual', 'ai_assistant', 'review_request', 'payment_link', 'invoice', 'internal_alert', 'made_up_type', undefined]) {
      expect(decidePushRoute({ ...base, messageType: t })).toBe('sms_only');
    }
  });
});

describe('policy table hygiene', () => {
  it('never lists conversational or tokenized-link templates', () => {
    for (const t of ['manual', 'ai_assistant', 'review_request', 'payment_link', 'internal_alert']) {
      expect(PUSH_ROUTING_POLICY[t]).toBeUndefined();
    }
  });

  it('maps every policy type to a notification_prefs channel column', () => {
    // A saved customer channel choice must always be able to veto routing —
    // a policy type without a prefs mapping would silently skip that veto.
    for (const type of Object.keys(PUSH_ROUTING_POLICY)) {
      expect(typeof _test.PREF_CHANNEL_COLUMN[type]).toBe('string');
    }
  });

  it('normalizes phones to their last ten digits for the recipient-identity check', () => {
    expect(_test.normalizeDigits('+1 (941) 555-0123')).toBe('9415550123');
    expect(_test.normalizeDigits('19415550123')).toBe('9415550123');
    expect(_test.normalizeDigits('')).toBe('');
  });

  it('presentation titles carry no emoji and every policy type has a portal link', () => {
    const emoji = /\p{Extended_Pictographic}/u;
    for (const type of Object.keys(PUSH_ROUTING_POLICY)) {
      const p = _test.pushPresentation(type);
      expect(emoji.test(p.title)).toBe(false);
      expect(p.link.startsWith('/')).toBe(true);
    }
    const fallback = _test.pushPresentation('unknown_type');
    expect(fallback.title).toBe('Waves Pest Control');
    expect(fallback.link).toBe('/');
  });
});

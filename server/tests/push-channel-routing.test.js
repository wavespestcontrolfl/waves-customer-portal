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

  it('is sms_only for admin-attributed sends (IB tools stamp adminUserId only)', () => {
    expect(decidePushRoute({ ...base, messageType: 'billing_reminder', adminAttributed: true })).toBe('sms_only');
  });

  it('routes critical templates to both channels', () => {
    for (const t of ['appointment_reminder', 'reminder_72h', 'billing_reminder', 'payment_failure', 'autopay']) {
      expect(decidePushRoute({ ...base, messageType: t })).toBe('push_and_sms');
    }
  });

  it('keeps operator-triggered appointment actions out of the policy', () => {
    // admin-schedule/admin-dispatch fire these via shared helpers that carry
    // no operatorInitiated provenance — they must stay sms_only.
    expect(decidePushRoute({ ...base, messageType: 'appointment_confirmation' })).toBe('sms_only');
    expect(decidePushRoute({ ...base, messageType: 'appointment_cancelled' })).toBe('sms_only');
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

describe('pushEligibleRuntime', () => {
  // Minimal chainable knex stub. A fixture value may be an object (row), an
  // Error (throwing lookup), or a function of the LAST where() arg — the
  // function form lets `customers` serve both the phone lookup (where by id)
  // and the primary-profile resolver (where by account_id).
  const stubKnex = (tables) => (name) => {
    let lastWhere;
    return {
      where(arg) { lastWhere = arg; return this; },
      async first() {
        let v = tables[name];
        if (typeof v === 'function') v = v(lastWhere);
        if (v instanceof Error) throw v;
        return v;
      },
    };
  };

  it('routes when the recipient is the account holder and prefs sit at the seeded sms default', async () => {
    const knex = stubKnex({
      customers: { phone: '+1 (941) 555-0123', account_id: null },
      notification_prefs: { en_route_channel: 'sms' },
    });
    await expect(_test.pushEligibleRuntime('c-1', '9415550123', 'tech_en_route', knex)).resolves.toBe(true);
  });

  it('routes when no prefs row exists at all', async () => {
    const knex = stubKnex({ customers: { phone: '9415550123', account_id: null }, notification_prefs: undefined });
    await expect(_test.pushEligibleRuntime('c-1', '+19415550123', 'tech_en_route', knex)).resolves.toBe(true);
  });

  it('vetoes on an explicit non-default channel choice (email/both)', async () => {
    for (const value of ['email', 'both']) {
      const knex = stubKnex({
        customers: { phone: '9415550123', account_id: null },
        notification_prefs: { en_route_channel: value },
      });
       
      await expect(_test.pushEligibleRuntime('c-1', '9415550123', 'tech_en_route', knex)).resolves.toBe(false);
    }
  });

  it('reads BILLING/receipt choices from the charged profile own row, never the primary', async () => {
    // routes/notifications.js deliberately keeps billing_channel +
    // payment_receipt_channel per charged customer row — a secondary
    // profile's explicit 'both' must veto even when the primary sits at
    // the seeded default.
    const knex = stubKnex({
      customers: (where) => (where && where.account_id
        ? { id: 'primary-1' }
        : { phone: '9415550123', account_id: 'acct-1' }),
      notification_prefs: (where) => (where && where.customer_id === 'primary-1'
        ? { payment_receipt_channel: 'sms' } // primary at default
        : { payment_receipt_channel: 'both' }), // charged profile's explicit choice
    });
    await expect(_test.pushEligibleRuntime('c-2', '9415550123', 'receipt', knex)).resolves.toBe(false);
  });

  it('reads the channel choice from the account PRIMARY profile, not the selected property', async () => {
    const knex = stubKnex({
      customers: (where) => (where && where.account_id
        ? { id: 'primary-1' } // resolver: primary profile of the account
        : { phone: '9415550123', account_id: 'acct-1' }),
      notification_prefs: (where) => (where && where.customer_id === 'primary-1'
        ? { en_route_channel: 'both' } // primary profile's explicit choice
        : { en_route_channel: 'sms' }),
    });
    await expect(_test.pushEligibleRuntime('c-2', '9415550123', 'tech_en_route', knex)).resolves.toBe(false);
  });

  it('vetoes when the primary-profile lookup FAILS (unknown ownership ≠ fallback)', async () => {
    // The route resolver's default swallows errors and falls back to the
    // current profile — routing must instead fail closed to SMS, or a
    // transient failure could override the primary profile's explicit choice.
    const knex = stubKnex({
      customers: (where) => {
        if (where && where.account_id) throw new Error('db down');
        return { phone: '9415550123', account_id: 'acct-1' };
      },
      notification_prefs: { en_route_channel: 'sms' },
    });
    await expect(_test.pushEligibleRuntime('c-2', '9415550123', 'tech_en_route', knex)).resolves.toBe(false);
  });

  it('vetoes secondary-contact recipients (to is not the account holder phone)', async () => {
    const knex = stubKnex({ customers: { phone: '9415550123', account_id: null }, notification_prefs: undefined });
    await expect(_test.pushEligibleRuntime('c-1', '9415559999', 'tech_en_route', knex)).resolves.toBe(false);
  });

  it('vetoes on customer or prefs lookup failure', async () => {
    const bad = stubKnex({ customers: new Error('db down') });
    await expect(_test.pushEligibleRuntime('c-1', '9415550123', 'tech_en_route', bad)).resolves.toBe(false);
    const badPrefs = stubKnex({ customers: { phone: '9415550123', account_id: null }, notification_prefs: new Error('db down') });
    await expect(_test.pushEligibleRuntime('c-1', '9415550123', 'tech_en_route', badPrefs)).resolves.toBe(false);
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

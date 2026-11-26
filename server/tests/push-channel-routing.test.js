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
    for (const t of ['billing_reminder', 'payment_failure', 'autopay']) {
      expect(decidePushRoute({ ...base, messageType: t })).toBe('push_and_sms');
    }
  });

  it('keeps operator-triggered appointment actions out of the policy', () => {
    // admin-schedule/admin-dispatch fire these via shared helpers that carry
    // no operatorInitiated provenance — they must stay sms_only.
    expect(decidePushRoute({ ...base, messageType: 'appointment_confirmation' })).toBe('sms_only');
    expect(decidePushRoute({ ...base, messageType: 'appointment_cancelled' })).toBe('sms_only');
  });

  it('on-the-way notices and receipts go by text (they were push-first before 2026-11-20)', () => {
    for (const t of ['tech_en_route', 'receipt', 'deposit_receipt']) {
      expect(decidePushRoute({ ...base, messageType: t })).toBe('sms_only');
    }
  });

  it('defaults every unlisted template to sms_only', () => {
    for (const t of ['manual', 'ai_assistant', 'review_request', 'payment_link', 'invoice', 'internal_alert', 'made_up_type', undefined]) {
      expect(decidePushRoute({ ...base, messageType: t })).toBe('sms_only');
    }
  });
});

// Owner 2026-11-20: "lets revert to text, if they want to setup app notifications,
// let them do it on their own". The 2026-11-04 app-first rule is withdrawn.
describe('decidePushRoute: a routed notice never replaces its text (owner 2026-11-20)', () => {
  // The types the 2026-11-04 rule sent to the app instead of a text.
  const WAS_APP_FIRST = [
    'appointment_reminder', 'reminder_72h', 'tech_arrived', 'service_complete', 'service_complete_paid_receipt',
    'service_complete_prepaid', 'service_complete_annual_prepay', 'service_complete_annual_prepay_after_first_visit',
    'service_report_v1', 'lawn_watering_instruction',
  ];
  const WAS_PUSH_FIRST = ['tech_en_route', 'receipt', 'deposit_receipt'];
  const REMINDERS = ['appointment_reminder', 'reminder_72h'];
  const BILLING = [
    'billing_reminder', 'payment_failure', 'payment_failed', 'late_payment', 'payment_expiry', 'autopay',
    'autopay_pre_charge', 'autopay_charge_failed', 'autopay_retry_failed', 'autopay_retry_final_failed',
    'ach_retry_notice', 'ach_card_fallback', 'ach_suspended', 'bank_verification_incomplete', 'bank_verification_failed',
  ];
  const STAYS_TEXT = [
    'service_complete_with_invoice', 'service_report_v1_with_invoice', 'review_request', 'invoice', 'payment_link',
    'manual', 'ai_assistant', 'appointment_confirmation', 'appointment_cancelled', 'internal_alert',
  ];

  it('no policy entry is push_first: only a customer\'s own App choice replaces a text', () => {
    expect(Object.values(PUSH_ROUTING_POLICY)).not.toContain('push_first');
    expect([...new Set(Object.values(PUSH_ROUTING_POLICY))]).toEqual(['push_and_sms']);
  });

  it('only billing and payment notices keep the app alert after the text', () => {
    expect(Object.keys(PUSH_ROUTING_POLICY).sort()).toEqual([...BILLING].sort());
  });

  it('no message type routes push_first, with or without the technician\'s customer-channel mark', () => {
    const types = [...WAS_APP_FIRST, ...WAS_PUSH_FIRST, ...BILLING, ...STAYS_TEXT, ...Object.keys(_test.PREF_CHANNEL_COLUMN), 'made_up_type', undefined];
    for (const t of types) {
      expect(decidePushRoute({ ...base, messageType: t })).not.toBe('push_first');
      expect(decidePushRoute({ ...base, messageType: t, operatorInitiated: true, useCustomerChannel: true })).not.toBe('push_first');
    }
  });

  it('every withdrawn type sends the text alone, the two reminders included', () => {
    // A reminder text carries the visit's links. A companion alert would repeat that text on
    // every phone and browser of the account, so a reminder has no companion (pre-push audit, 2026-11-20).
    for (const t of [...WAS_APP_FIRST, ...WAS_PUSH_FIRST]) {
      expect(decidePushRoute({ ...base, messageType: t })).toBe('sms_only');
    }
    for (const t of REMINDERS) expect(PUSH_ROUTING_POLICY[t]).toBeUndefined();
  });

  it('billing, payment-failure, autopay and ACH types stay push_and_sms', () => {
    for (const t of BILLING) expect(decidePushRoute({ ...base, messageType: t })).toBe('push_and_sms');
  });

  it('invoice-carrying completions, review asks, links and staff helpers stay text only', () => {
    for (const t of [...STAYS_TEXT, 'made_up_type', undefined]) {
      expect(decidePushRoute({ ...base, messageType: t })).toBe('sms_only');
    }
  });

  it('staff, human, media, bundled-review and missing-customer sends still go as text', () => {
    for (const t of [...REMINDERS, ...BILLING]) {
      const input = { ...base, messageType: t };
      expect(decidePushRoute({ ...input, hasMedia: true })).toBe('sms_only');
      expect(decidePushRoute({ ...input, humanAuthored: true })).toBe('sms_only');
      expect(decidePushRoute({ ...input, operatorInitiated: true })).toBe('sms_only');
      expect(decidePushRoute({ ...input, adminAttributed: true })).toBe('sms_only');
      expect(decidePushRoute({ ...input, bundledReview: true })).toBe('sms_only');
      expect(decidePushRoute({ ...input, customerId: null })).toBe('sms_only');
      expect(decidePushRoute({ ...input, gateOn: false })).toBe('sms_only');
    }
  });

  it('every withdrawn type keeps its preference column and presentation, for the customer\'s own App choice', () => {
    for (const type of [...WAS_APP_FIRST, ...WAS_PUSH_FIRST]) {
      expect(typeof _test.PREF_CHANNEL_COLUMN[type]).toBe('string');
      expect(_test.pushPresentation(type).link.startsWith('/')).toBe(true);
      expect(_test.pushPresentation(type).title).not.toBe('Waves Pest Control');
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

  // Completion/report pushes FALL BACK to Documents (customer-wide) like the
  // lifecycle "Service completed" bell — never Visits, which is property-scoped
  // and fails closed for a house retired since the visit (uncapped codex r1z
  // P1). With a visit id, resolvePushDestination opens the report itself
  // (push-channel-routing-deep-link.test.js).
  it('completion and report pushes fall back to Documents, not Visits', () => {
    for (const type of ['service_complete', 'service_complete_with_invoice', 'service_report_v1']) {
      const p = _test.pushPresentation(type);
      expect(p.link).toBe('/?tab=documents');
      expect(p.title).toBe('Your service report is ready');
    }
  });

  it('the lawn watering text follows the completion notice channel choice and opens Documents', () => {
    expect(require('../services/messaging/push-channel-routing').APP_FIRST_TYPES.has('lawn_watering_instruction')).toBe(true);
    expect(_test.PREF_CHANNEL_COLUMN.lawn_watering_instruction).toBe('service_complete_channel');
    expect(_test.PREF_CHANNEL_COLUMN.lawn_watering_instruction).toBe(_test.PREF_CHANNEL_COLUMN.service_report_v1);
    const p = _test.pushPresentation('lawn_watering_instruction');
    expect(p).toEqual({ title: 'Watering after today’s visit', link: '/?tab=documents', category: 'service' });
  });
});

describe("a technician's On-my-way tap keeps the customer's channel (useCustomerChannel)", () => {
  // sendTechEnRoute marks a manual tap operatorInitiated (send-window marker) AND
  // metadata.useCustomerChannel. The mark lifts the operator text lock, so the notice
  // follows the policy. Since 2026-11-20 (owner: "lets revert to text") the policy for
  // an on-the-way notice is text; the customer's own App choice goes through
  // wantsAppFirst, which honors the same mark.
  const route = (overrides = {}) => decidePushRoute({
    gateOn: true, customerId: 'c-1', messageType: 'tech_en_route', hasMedia: false, humanAuthored: false,
    operatorInitiated: true, useCustomerChannel: true, ...overrides,
  });

  it('a tapped en-route notice goes by text, like an automated one', () => {
    expect(route()).toBe('sms_only');
    expect(route({ operatorInitiated: false, useCustomerChannel: false })).toBe('sms_only');
  });

  it('a marked reminder follows the policy too: the text alone', () => {
    expect(route({ messageType: 'appointment_reminder' })).toBe('sms_only');
  });

  it('an operator send WITHOUT the mark still stays a text (staff chose Text)', () => {
    expect(route({ useCustomerChannel: undefined })).toBe('sms_only');
    expect(route({ useCustomerChannel: 'true' })).toBe('sms_only');
    expect(route({ messageType: 'billing_reminder', useCustomerChannel: false })).toBe('sms_only');
  });

  it('an admin-attributed send with the mark follows the policy; without it, a text', () => {
    expect(route({ operatorInitiated: false, adminAttributed: true, messageType: 'billing_reminder' })).toBe('push_and_sms');
    expect(route({ operatorInitiated: false, adminAttributed: true, messageType: 'billing_reminder', useCustomerChannel: false })).toBe('sms_only');
  });

  it('the mark never lifts the other text-only rules', () => {
    expect(route({ humanAuthored: true })).toBe('sms_only');
    expect(route({ hasMedia: true })).toBe('sms_only');
    expect(route({ bundledReview: true, messageType: 'service_complete' })).toBe('sms_only');
    expect(route({ messageType: 'appointment_confirmation' })).toBe('sms_only');
    expect(route({ gateOn: false })).toBe('sms_only');
  });
});

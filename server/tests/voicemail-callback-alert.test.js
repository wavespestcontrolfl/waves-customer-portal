/**
 * GATE_VOICEMAIL_CALLBACK_ALERT — service-request voicemails that the
 * workable-lead gate declined (existing customer match, or a non-lead
 * call_type veto) must surface a callback bell instead of ending silent.
 * Root incident: a WDO-closing voicemail (May 2026) dead-ended terminal and
 * the lead survived only via a manual re-key that minted a duplicate account.
 */

const { _test } = require('../services/call-recording-processor');
const { TRIGGER_REGISTRY } = require('../services/notification-triggers');

const { voicemailCallbackAlertPlan } = _test;

// Synthetic caller only — no real customer data in fixtures (AGENTS.md).
const TEST_PHONE = '+15005550006';

function wdoVoicemail(overrides = {}) {
  return {
    is_voicemail: true,
    is_spam: false,
    is_lead: false,
    call_type: 'voicemail',
    first_name: 'sam',
    last_name: 'example',
    matched_service: 'WDO Inspection',
    requested_service: 'wdo',
    ...overrides,
  };
}

describe('voicemailCallbackAlertPlan', () => {
  test('service-request voicemail declined by the lead path produces an alert plan', () => {
    const plan = voicemailCallbackAlertPlan({
      extracted: wdoVoicemail(),
      voicemailChannel: true,
      voicemailLeadPath: false,
      vmPhone: TEST_PHONE,
    });
    expect(plan).toEqual({
      name: 'Sam Example',
      service: 'WDO Inspection',
      phone: TEST_PHONE,
    });
  });

  test('nameless caller still alerts with a null name', () => {
    const plan = voicemailCallbackAlertPlan({
      extracted: wdoVoicemail({ first_name: null, last_name: null }),
      voicemailChannel: true,
      voicemailLeadPath: false,
      vmPhone: TEST_PHONE,
    });
    expect(plan).toMatchObject({ name: null, service: 'WDO Inspection' });
  });

  test('no alert when the workable lead path already took the voicemail', () => {
    expect(voicemailCallbackAlertPlan({
      extracted: wdoVoicemail(),
      voicemailChannel: true,
      voicemailLeadPath: true,
      vmPhone: TEST_PHONE,
    })).toBeNull();
  });

  test('unknown caller without service intent stays bell-free (solicitor/robocall voicemails)', () => {
    expect(voicemailCallbackAlertPlan({
      extracted: wdoVoicemail({ matched_service: null, requested_service: null }),
      voicemailChannel: true,
      voicemailLeadPath: false,
      vmPhone: TEST_PHONE,
      knownCustomer: false,
      transcript: 'hey give me a call back when you can',
    })).toBeNull();
  });

  test('KNOWN customer without service intent rings the bell (owner ruling 2026-07-30)', () => {
    const plan = voicemailCallbackAlertPlan({
      extracted: wdoVoicemail({ matched_service: null, requested_service: null }),
      voicemailChannel: true,
      voicemailLeadPath: false,
      vmPhone: TEST_PHONE,
      knownCustomer: true,
      transcript: 'hey Adam, call me back when you can',
    });
    expect(plan).toMatchObject({ name: 'Sam Example', service: null, phone: TEST_PHONE });
  });

  test('known customer dead-air voicemail never rings (pocket dial)', () => {
    expect(voicemailCallbackAlertPlan({
      extracted: wdoVoicemail({ matched_service: null, requested_service: null, first_name: null, last_name: null }),
      voicemailChannel: true,
      voicemailLeadPath: false,
      vmPhone: TEST_PHONE,
      knownCustomer: true,
      transcript: '[VOICEMAIL] [NO SPEECH]',
    })).toBeNull();
  });

  test('no alert for an outbound call that reached the customer voicemail', () => {
    // Our own recorded message can name the service — that must not ring a
    // "callback needed" bell.
    expect(voicemailCallbackAlertPlan({
      extracted: wdoVoicemail(),
      voicemailChannel: true,
      voicemailLeadPath: false,
      vmPhone: TEST_PHONE,
      outbound: true,
    })).toBeNull();
  });

  test('no alert for spam, non-voicemail channel, or missing callback number', () => {
    expect(voicemailCallbackAlertPlan({
      extracted: wdoVoicemail({ is_spam: true }),
      voicemailChannel: true,
      voicemailLeadPath: false,
      vmPhone: TEST_PHONE,
    })).toBeNull();
    expect(voicemailCallbackAlertPlan({
      extracted: wdoVoicemail(),
      voicemailChannel: false,
      voicemailLeadPath: false,
      vmPhone: TEST_PHONE,
    })).toBeNull();
    expect(voicemailCallbackAlertPlan({
      extracted: wdoVoicemail(),
      voicemailChannel: true,
      voicemailLeadPath: false,
      vmPhone: null,
    })).toBeNull();
  });
});

describe('customer_voicemail_callback trigger registry entry', () => {
  const entry = TRIGGER_REGISTRY.customer_voicemail_callback;

  test('is registered with a Communication-group high-priority bell', () => {
    expect(entry).toBeTruthy();
    expect(entry.category).toBe('voicemail_callback');
    expect(entry.priority).toBe('high');
    expect(entry.group).toBe('Communication');
  });

  test('build links to the Calls tab with a banner-first title and the real callback number', () => {
    // Owner ruling 2026-07-30: the WHO leads the title (banners truncate)
    // and the callback number is shown unmasked — a masked number is
    // undialable. The trigger is allowContactDetails for exactly this.
    expect(entry.allowContactDetails).toBe(true);
    const built = entry.build({
      name: 'Sam Example',
      service: 'WDO Inspection',
      phone: TEST_PHONE,
      customerId: 'cust-1',
    });
    expect(built.title).toBe('Voicemail — Sam Example');
    expect(built.body).toContain('Sam Example');
    expect(built.body).toContain('WDO Inspection');
    expect(built.body).toContain(TEST_PHONE);
    // Voicemails render under the Calls tab — ?thread= would open the SMS
    // view instead.
    expect(built.link).toBe('/admin/communications#tab=calls');

    const anon = entry.build({ phone: TEST_PHONE });
    expect(anon.title).toBe(`Voicemail — ${TEST_PHONE}`);
    expect(anon.link).toBe('/admin/communications#tab=calls');
  });

  test('push tag is unique per call so one caller cannot hide another', () => {
    const { __private } = require('../services/notification-triggers');
    const tagA = __private.pushTagFor('customer_voicemail_callback', { callLogId: 'call-a' });
    const tagB = __private.pushTagFor('customer_voicemail_callback', { callLogId: 'call-b' });
    expect(tagA).not.toBe(tagB);
    expect(tagA).toContain('call-a');
    // Same call re-push keeps a stable tag (replaces itself, not others).
    expect(__private.pushTagFor('customer_voicemail_callback', { callLogId: 'call-a' })).toBe(tagA);
  });
});

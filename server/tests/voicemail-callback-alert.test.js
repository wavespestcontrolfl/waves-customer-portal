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

function wdoVoicemail(overrides = {}) {
  return {
    is_voicemail: true,
    is_spam: false,
    is_lead: false,
    call_type: 'voicemail',
    first_name: 'melody',
    last_name: 'woodfield',
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
      vmPhone: '+16788186060',
    });
    expect(plan).toEqual({
      name: 'Melody Woodfield',
      service: 'WDO Inspection',
      phone: '+16788186060',
    });
  });

  test('nameless caller still alerts with a null name', () => {
    const plan = voicemailCallbackAlertPlan({
      extracted: wdoVoicemail({ first_name: null, last_name: null }),
      voicemailChannel: true,
      voicemailLeadPath: false,
      vmPhone: '+16788186060',
    });
    expect(plan).toMatchObject({ name: null, service: 'WDO Inspection' });
  });

  test('no alert when the workable lead path already took the voicemail', () => {
    expect(voicemailCallbackAlertPlan({
      extracted: wdoVoicemail(),
      voicemailChannel: true,
      voicemailLeadPath: true,
      vmPhone: '+16788186060',
    })).toBeNull();
  });

  test('no alert without service intent (plain call-me-back voicemail)', () => {
    expect(voicemailCallbackAlertPlan({
      extracted: wdoVoicemail({ matched_service: null, requested_service: null }),
      voicemailChannel: true,
      voicemailLeadPath: false,
      vmPhone: '+16788186060',
    })).toBeNull();
  });

  test('no alert for spam, non-voicemail channel, or missing callback number', () => {
    expect(voicemailCallbackAlertPlan({
      extracted: wdoVoicemail({ is_spam: true }),
      voicemailChannel: true,
      voicemailLeadPath: false,
      vmPhone: '+16788186060',
    })).toBeNull();
    expect(voicemailCallbackAlertPlan({
      extracted: wdoVoicemail(),
      voicemailChannel: false,
      voicemailLeadPath: false,
      vmPhone: '+16788186060',
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

  test('build links to the customer thread when known and masks the phone', () => {
    const built = entry.build({
      name: 'Melody Woodfield',
      service: 'WDO Inspection',
      phone: '+16788186060',
      customerId: 'cust-1',
    });
    expect(built.title).toBe('Voicemail callback needed');
    expect(built.body).toContain('Melody Woodfield');
    expect(built.body).toContain('WDO Inspection');
    expect(built.body).not.toContain('6788186060');
    expect(built.link).toBe('/admin/communications?thread=cust-1');

    const anon = entry.build({ phone: '+16788186060' });
    expect(anon.link).toBe('/admin/communications');
    expect(anon.body).not.toContain('6788186060');
  });
});

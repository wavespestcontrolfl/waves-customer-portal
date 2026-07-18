/**
 * Ask-the-customer loop (GATE_ESTIMATE_CLARIFY_ASKS).
 *
 * Pins: the gate (fail-closed), the askable-missing filter ('phone' and
 * free-text uncertainties never ask), the usable-phone requirement, the
 * phone-scoped open/recent dedupe, the draft insert shape (intent
 * 'estimate_clarify', status pending, NO campaign_type so the campaign
 * guard skips, flags.toPhone for lead-only recipients), the deterministic
 * copy variants, and that a bell failure never unparks the draft.
 */

let mockState;
jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const builder = {
      where() { return builder; },
      whereIn() { return builder; },
      whereNull() { return builder; },
      whereNotNull() { return builder; },
      orWhere() { return builder; },
      orderBy() { return builder; },
      orderByRaw() { return builder; },
      whereRaw() { return builder; },
      first: async () => (mockState.firstQueue.length ? mockState.firstQueue.shift() : mockState.existingDraft),
      update: async (payload) => {
        mockState.updates.push({ table, payload });
        return 1;
      },
      insert: (payload) => ({
        returning: async () => {
          if (mockState.insertError) throw mockState.insertError;
          mockState.inserts.push(payload);
          return [{ id: 'draft-1' }];
        },
      }),
    };
    return builder;
  };
  const dbMock = jest.fn((table) => makeBuilder(table));
  // withClarifyLock: transaction executor doubles as the query builder; the
  // advisory-lock raw() is a no-op here.
  const trx = Object.assign((table) => makeBuilder(table), { raw: async () => ({}) });
  dbMock.transaction = async (callback) => callback(trx);
  dbMock.raw = async () => ({});
  return dbMock;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockIsEnabled = jest.fn();
jest.mock('../config/feature-gates', () => ({
  isEnabled: (key) => mockIsEnabled(key),
}));


const mockNotifyAdmin = jest.fn();
jest.mock('../services/notification-service', () => ({
  notifyAdmin: (...args) => mockNotifyAdmin(...args),
}));

const mockStartSmsThreadDraft = jest.fn();
const mockSmsThreadDraftsEnabled = jest.fn();
jest.mock('../services/estimator-engine/sms-thread', () => ({
  smsThreadDraftsEnabled: () => mockSmsThreadDraftsEnabled(),
  startSmsThreadDraft: (...args) => mockStartSmsThreadDraft(...args),
}));

// Service replies are classifier-gated; the regex leg of the real
// classifier accepts obvious service words and rejects chit-chat.
jest.mock('../services/sms-service-intent', () => ({
  classifyServiceIntent: async (text) => (/pest|lawn|mosquito|termite/i.test(String(text))
    ? { interest: 'pest', confidence: 0.9, method: 'regex' }
    : null),
}));

const {
  parkClarifyAsk,
  handleClarifyReply,
  recordClarifyAnswer,
  clarifyAsksEnabled,
  _private,
} = require('../services/estimate-clarify-asks');

beforeEach(() => {
  jest.clearAllMocks();
  mockState = { existingDraft: null, firstQueue: [], inserts: [], updates: [] };
  mockIsEnabled.mockImplementation((key) => key === 'estimateClarifyAsks');
  mockNotifyAdmin.mockResolvedValue({ id: 'bell-1' });
});

describe('clarifyAsksEnabled', () => {
  test('reads the estimateClarifyAsks gate', () => {
    expect(clarifyAsksEnabled()).toBe(true);
    mockIsEnabled.mockReturnValue(false);
    expect(clarifyAsksEnabled()).toBe(false);
  });
});

describe('parkClarifyAsk', () => {
  const BASE = {
    missing: ['street_address'],
    phone: '(941) 555-0142',
    firstName: 'Pat',
    leadId: 'lead-1',
    source: 'estimator_engine_red',
  };

  test('gate off parks nothing', async () => {
    mockIsEnabled.mockReturnValue(false);
    const result = await parkClarifyAsk(BASE);
    expect(result).toEqual({ parked: false, skipped: 'gate_off' });
    expect(mockState.inserts).toHaveLength(0);
  });

  test('unaskable missing items park nothing — phone cannot be asked for by SMS', async () => {
    const result = await parkClarifyAsk({ ...BASE, missing: ['phone'] });
    expect(result.skipped).toBe('nothing_askable');
    expect(mockState.inserts).toHaveLength(0);
  });

  test('only real US destinations queue — 10 digits or 11 with leading 1, nothing else', async () => {
    // Shorter fragments, extension suffixes, and non-US lengths all fail at
    // Twilio AFTER the owner approved — reject at park time instead.
    for (const bad of ['555-01', '941555', '9415550142 ext 9', '+44 20 7946 0958', '', null]) {
      const result = await parkClarifyAsk({ ...BASE, phone: bad });
      expect(result.skipped).toBe('no_usable_phone');
    }
    expect(mockState.inserts).toHaveLength(0);

    const ok = await parkClarifyAsk({ ...BASE, phone: '+1 (941) 555-0142' });
    expect(ok.parked).toBe(true);
    expect(JSON.parse(mockState.inserts[0].flags).toPhone).toBe('+19415550142');
  });

  test('a unique-index conflict is a fail-soft anomaly, never a bell', async () => {
    // The clarify lock serializes every producer, so the partial unique
    // index can only fire for an out-of-band writer — the transaction
    // rolls back into the fail-soft catch and the standing draft covers
    // the phone.
    mockState.insertError = Object.assign(new Error('duplicate key'), { code: '23505' });
    const result = await parkClarifyAsk(BASE);
    expect(result.parked).toBe(false);
    expect(result.skipped).toMatch(/^error:/);
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('a recently sent clarify dedupes without touching the row', async () => {
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'sent',
      flags: JSON.stringify({ missing: ['street_address'] }),
    };
    const result = await parkClarifyAsk(BASE);
    expect(result).toEqual({ parked: false, skipped: 'open_or_recent_clarify', draftId: 'draft-0', covers: ['street_address'] });
    expect(mockState.inserts).toHaveLength(0);
    expect(mockState.updates).toHaveLength(0);
  });

  test('the cooldown yields when a partially answered ask leaves this item unanswered', async () => {
    // Address answered, service still open: the resumed pipeline's re-ask
    // for the remainder must not be silenced for seven days.
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'sent',
      flags: JSON.stringify({ missing: ['specific_service'], answer_recorded: ['street_address'] }),
    };
    const result = await parkClarifyAsk({ ...BASE, missing: ['specific_service'] });
    expect(result.parked).toBe(true);
    expect(mockState.inserts).toHaveLength(1);
  });

  test('a same-items pending dedupe still refreshes linkage to the newest request', async () => {
    // The old request's closed lead must not kill a question the NEW
    // request still needs — every pending dedupe hit rewrites linkage.
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'pending',
      flags: JSON.stringify({ missing: ['street_address'], lead_id: 'old-lead' }),
    };
    const result = await parkClarifyAsk({ ...BASE, channelProvenance: 'sms' });
    expect(result).toEqual({ parked: false, skipped: 'merged_into_open_clarify', draftId: 'draft-0', covers: ['street_address'] });
    const flags = JSON.parse(mockState.updates[0].payload.flags);
    expect(flags.missing).toEqual(['street_address']);
    expect(flags.lead_id).toBe('lead-1');
    expect(flags.channel_provenance).toBe('sms');
  });


  test('a new missing item MERGES into the open pending draft instead of being discarded', async () => {
    // Service-only draft open, address-only request arrives: dropping it
    // would leave the address never asked once service resolves.
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'pending',
      flags: JSON.stringify({ missing: ['specific_service'], toPhone: '+19415550142' }),
    };
    const result = await parkClarifyAsk({ ...BASE, channelProvenance: 'voice' });
    expect(result).toEqual({ parked: false, skipped: 'merged_into_open_clarify', draftId: 'draft-0', covers: ['specific_service', 'street_address'] });
    expect(mockState.inserts).toHaveLength(0);
    const update = mockState.updates[0].payload;
    const flags = JSON.parse(update.flags);
    expect(flags.missing.sort()).toEqual(['specific_service', 'street_address']);
    // The newest request owns the linkage the approval guard judges by.
    expect(flags.lead_id).toBe('lead-1');
    expect(flags.source).toBe('estimator_engine_red');
    expect(flags.channel_provenance).toBe('voice');
    expect(update.draft_response).toContain('service address');
    expect(update.draft_response).toContain('which service');
  });

  test('claimed (approved) drafts are never rewritten by a merge', async () => {
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'approved',
      flags: JSON.stringify({ missing: ['specific_service'] }),
    };
    const result = await parkClarifyAsk(BASE);
    expect(result.skipped).toBe('open_or_recent_clarify');
    expect(mockState.updates).toHaveLength(0);
  });

  test('parks a pending estimate_clarify draft with lead-only recipient in flags', async () => {
    const result = await parkClarifyAsk({ ...BASE, missing: ['street_address', 'specific_service', 'phone'] });
    expect(result.parked).toBe(true);
    expect(mockNotifyAdmin).toHaveBeenCalledWith(
      'lead',
      expect.stringContaining('Clarifying question drafted'),
      expect.any(String),
      expect.objectContaining({ link: '/admin/communications' }),
    );
    const insert = mockState.inserts[0];
    expect(insert.intent).toBe('estimate_clarify');
    expect(insert.status).toBe('pending');
    expect(insert.source_ref).toBe('clarify:9415550142');
    // NO campaign_type: guardCampaignSend must skip these drafts entirely.
    expect(insert.campaign_type).toBeUndefined();
    expect(insert.customer_id).toBeNull();
    const flags = JSON.parse(insert.flags);
    expect(flags.toPhone).toBe('+19415550142');
    expect(flags.missing).toEqual(['street_address', 'specific_service']);
    expect(flags.lead_id).toBe('lead-1');
    expect(insert.draft_response).toContain('Waves Pest Control');
    expect(insert.draft_response).toContain('service address');
    expect(insert.draft_response).toContain('which service');
  });

  test('a bell failure never unparks the draft', async () => {
    mockNotifyAdmin.mockRejectedValueOnce(new Error('notifications down'));
    const result = await parkClarifyAsk(BASE);
    expect(result.parked).toBe(true);
    expect(mockState.inserts).toHaveLength(1);
  });
});

describe('handleClarifyReply', () => {
  const AWAITING = (missing, extra = {}) => ({
    id: 'sent-1',
    customer_id: null,
    sent_at: '2026-07-18T12:00:00Z',
    flags: JSON.stringify({ missing, lead_id: 'lead-1', ...extra }),
  });

  beforeEach(() => {
    mockSmsThreadDraftsEnabled.mockReturnValue(true);
    mockStartSmsThreadDraft.mockResolvedValue({ started: true });
  });

  test('no awaiting clarify — not handled, nothing touched', async () => {
    const result = await handleClarifyReply({ phone: '+19415550142', body: '123 Main St' });
    expect(result.handled).toBe(false);
    expect(mockState.updates).toHaveLength(0);
    expect(mockStartSmsThreadDraft).not.toHaveBeenCalled();
  });

  test('an address-only reply records onto the lead and resumes with gate + cooldown bypassed', async () => {
    mockState.existingDraft = AWAITING(['street_address']);
    const result = await handleClarifyReply({ phone: '+19415550142', body: "It's 123 Main St, Sarasota" });
    expect(result.handled).toBe(true);
    const leadUpdate = mockState.updates.find((u) => u.table === 'leads');
    expect(leadUpdate.payload.address).toBe('123 Main St, Sarasota');
    const bookkeeping = mockState.updates.find((u) => u.table === 'message_drafts');
    expect(JSON.parse(bookkeeping.payload.flags).answer_recorded).toEqual(['street_address']);
    expect(mockStartSmsThreadDraft).toHaveBeenCalledWith(expect.objectContaining({
      skipIntentGate: true,
      skipCooldown: true,
    }));
  });

  test('a combined reply to a both-items ask records address AND service', async () => {
    mockState.existingDraft = AWAITING(['street_address', 'specific_service']);
    const result = await handleClarifyReply({ phone: '9415550142', body: 'Quarterly pest control, 123 Main St, Sarasota' });
    expect(result.handled).toBe(true);
    const leadUpdates = mockState.updates.filter((u) => u.table === 'leads');
    expect(leadUpdates.some((u) => u.payload.address === '123 Main St, Sarasota')).toBe(true);
    expect(leadUpdates.some((u) => u.payload.service_interest === 'Quarterly pest control')).toBe(true);
  });

  test('an unrecognizable reply is not handled — the normal inbox flow owns it', async () => {
    mockState.existingDraft = AWAITING(['street_address']);
    const result = await handleClarifyReply({ phone: '9415550142', body: 'ok thanks' });
    expect(result.handled).toBe(false);
    expect(mockState.updates).toHaveLength(0);
  });

  test('a partial answer keeps the ask alive for the remaining item', async () => {
    mockState.existingDraft = AWAITING(['street_address', 'specific_service']);
    const result = await handleClarifyReply({ phone: '9415550142', body: '123 Main St, Sarasota' });
    expect(result.handled).toBe(true);
    const bookkeeping = mockState.updates.find((u) => u.table === 'message_drafts');
    const flags = JSON.parse(bookkeeping.payload.flags);
    expect(flags.missing).toEqual(['specific_service']);
    expect(flags.answer_recorded).toEqual(['street_address']);
    expect(flags.answered_at).toBeUndefined();
  });

  test('chit-chat never records as the service — the classifier is the bar', async () => {
    mockState.existingDraft = AWAITING(['specific_service']);
    const result = await handleClarifyReply({ phone: '9415550142', body: 'thanks, sounds good' });
    expect(result.handled).toBe(false);
    expect(mockState.updates).toHaveLength(0);
  });

  test('a fully answered ask is stamped consumed', async () => {
    mockState.existingDraft = AWAITING(['street_address']);
    await handleClarifyReply({ phone: '9415550142', body: '123 Main St, Sarasota' });
    const bookkeeping = mockState.updates.find((u) => u.table === 'message_drafts');
    const flags = JSON.parse(bookkeeping.payload.flags);
    expect(flags.missing).toEqual([]);
    expect(flags.answered_at).toBeTruthy();
  });

  test('SMS engine lane off: the answer is still recorded, no resume fires', async () => {
    mockSmsThreadDraftsEnabled.mockReturnValue(false);
    mockState.existingDraft = AWAITING(['street_address']);
    const result = await handleClarifyReply({ phone: '9415550142', body: '123 Main St, Sarasota' });
    expect(result.handled).toBe(true);
    expect(mockState.updates.find((u) => u.table === 'leads')).toBeTruthy();
    expect(mockStartSmsThreadDraft).not.toHaveBeenCalled();
  });

  test('clarify gate off — replies flow through untouched', async () => {
    mockIsEnabled.mockReturnValue(false);
    mockState.existingDraft = AWAITING(['street_address']);
    const result = await handleClarifyReply({ phone: '9415550142', body: '123 Main St' });
    expect(result.handled).toBe(false);
  });
});

describe('recordClarifyAnswer', () => {
  test('stamps a sent ask when another flow captured the item', async () => {
    mockState.existingDraft = {
      id: 'sent-1',
      sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['street_address', 'specific_service'] }),
    };
    const result = await recordClarifyAnswer({ phone: '9415550142', items: ['street_address'] });
    expect(result.recorded).toBe(true);
    const flags = JSON.parse(mockState.updates[0].payload.flags);
    expect(flags.missing).toEqual(['specific_service']);
    expect(flags.answer_recorded).toEqual(['street_address']);
    expect(flags.answered_at).toBeUndefined();
  });

  test('irrelevant items or no awaiting ask record nothing', async () => {
    expect((await recordClarifyAnswer({ phone: '9415550142', items: ['street_address'] })).recorded).toBe(false);
    mockState.existingDraft = {
      id: 'sent-1',
      sent_at: '2026-07-18T12:00:00Z',
      flags: JSON.stringify({ missing: ['specific_service'] }),
    };
    expect((await recordClarifyAnswer({ phone: '9415550142', items: ['street_address'] })).recorded).toBe(false);
    expect(mockState.updates).toHaveLength(0);
  });
});

describe('_private.composeClarifyBody', () => {
  test('address-only, service-only, and combined variants', () => {
    const address = _private.composeClarifyBody({ missing: ['street_address'], firstName: 'Pat' });
    expect(address).toMatch(/^Hi Pat, /);
    expect(address).toContain('service address');
    expect(address).not.toContain('which service');

    const service = _private.composeClarifyBody({ missing: ['specific_service'], firstName: null });
    expect(service).toMatch(/^Hi, /);
    expect(service).toContain('Which service');

    const both = _private.composeClarifyBody({ missing: ['street_address', 'specific_service'], firstName: 'Unknown' });
    expect(both).toMatch(/^Hi, /);
    expect(both).toContain('service address');
    expect(both).toContain('which service');
    // SMS-sized: the longest variant stays well under two segments.
    expect(both.length).toBeLessThan(300);
  });

  test('company name is always the full legal marketing name', () => {
    for (const missing of [['street_address'], ['specific_service'], ['street_address', 'specific_service']]) {
      expect(_private.composeClarifyBody({ missing, firstName: 'A' })).toContain('Waves Pest Control');
    }
  });
});

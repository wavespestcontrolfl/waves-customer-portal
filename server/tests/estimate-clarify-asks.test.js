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
  const makeBuilder = () => {
    const builder = {
      where() { return builder; },
      whereIn() { return builder; },
      orWhere() { return builder; },
      first: async () => mockState.existingDraft,
      update: async (payload) => {
        mockState.updates.push(payload);
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
  return jest.fn(() => makeBuilder());
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

const {
  parkClarifyAsk,
  clarifyAsksEnabled,
  _private,
} = require('../services/estimate-clarify-asks');

beforeEach(() => {
  jest.clearAllMocks();
  mockState = { existingDraft: null, inserts: [], updates: [] };
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

  test('a lost insert race (23505 on the partial unique index) is the deduped outcome', async () => {
    mockState.insertError = Object.assign(new Error('duplicate key'), { code: '23505' });
    const result = await parkClarifyAsk(BASE);
    expect(result).toEqual({ parked: false, skipped: 'open_or_recent_clarify' });
    expect(mockNotifyAdmin).not.toHaveBeenCalled();
  });

  test('an open or recently sent clarify covering the same items dedupes', async () => {
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'pending',
      flags: JSON.stringify({ missing: ['street_address'] }),
    };
    const result = await parkClarifyAsk(BASE);
    expect(result).toEqual({ parked: false, skipped: 'open_or_recent_clarify', draftId: 'draft-0' });
    expect(mockState.inserts).toHaveLength(0);
    expect(mockState.updates).toHaveLength(0);
  });

  test('a new missing item MERGES into the open pending draft instead of being discarded', async () => {
    // Service-only draft open, address-only request arrives: dropping it
    // would leave the address never asked once service resolves.
    mockState.existingDraft = {
      id: 'draft-0',
      status: 'pending',
      flags: JSON.stringify({ missing: ['specific_service'], toPhone: '+19415550142' }),
    };
    const result = await parkClarifyAsk(BASE);
    expect(result).toEqual({ parked: false, skipped: 'merged_into_open_clarify', draftId: 'draft-0' });
    expect(mockState.inserts).toHaveLength(0);
    const update = mockState.updates[0];
    expect(JSON.parse(update.flags).missing.sort()).toEqual(['specific_service', 'street_address']);
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

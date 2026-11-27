'use strict';

// Verifies that all 5 previously unrecordable customer_visible direct_sdk lanes
// (pest_id, lawn_assess, tree_shrub, voice_relay_collections, lawn_diag_writer)
// plus contact_dictation record every provider call under their laneId and flip
// rejected responses via ledgerCallRejected / rejectCall.

const { LANES } = require('../services/model-switchboard');
const { policyFor } = require('../services/agent-control/lane-policies');

describe('customer_visible direct_sdk ledger closure', () => {
  test('zero customer_visible lanes remain unrecordable due to direct_sdk', () => {
    const remaining = LANES
      .map((l) => ({ id: l.id, policy: policyFor(l.id) }))
      .filter(({ policy }) => policy.side_effect_class === 'customer_visible' && policy.ledger === 'unrecordable' && policy.unrecordable_reason === 'direct_sdk')
      .map(({ id }) => id);
    expect(remaining).toEqual([]);
  });

  test('all 6 migrated lanes declare ledger: call', () => {
    for (const id of ['voice_relay_collections', 'pest_id', 'lawn_assess', 'tree_shrub', 'lawn_diag_writer', 'contact_dictation']) {
      expect(policyFor(id).ledger).toBe('call');
    }
  });

  describe('pest_id Gemini leg + schema rejection', () => {
    const origKey = process.env.GEMINI_API_KEY;
    const origFetch = global.fetch;

    afterEach(() => {
      if (origKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = origKey;
      global.fetch = origFetch;
      jest.resetModules();
    });

    test('records Gemini attempt under laneId pest_id and rejects invalid schema', async () => {
      process.env.GEMINI_API_KEY = 'test-gemini';
      jest.resetModules();
      const mockLedgerCall = jest.fn((p, m, fn) => fn());
      const mockLedgerCallRejected = jest.fn();
      jest.doMock('../services/llm-dispatch-metrics', () => ({
        ledgerCall: mockLedgerCall,
        ledgerCallRejected: mockLedgerCallRejected,
        recordCall: jest.fn(() => null),
        failCall: jest.fn(),
        recordDispatch: jest.fn(),
        recordedPolicyLabel: jest.fn(() => 'photoIdVision'),
      }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: JSON.stringify({ not_valid: true }) }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
        }),
      }));

      const pest = require('../services/pest-identification');
      const res = await pest.analyzePhoto('AA==', 'image/jpeg');
      expect(res.gemini).toBeNull();
      expect(mockLedgerCall).toHaveBeenCalledWith('gemini', expect.any(String), expect.any(Function), { laneId: 'pest_id' });
      expect(mockLedgerCallRejected).toHaveBeenCalledWith(expect.objectContaining({ usageMetadata: expect.any(Object) }), 'schema_invalid');
    });
  });

  describe('lawn_assess Gemini + Claude legs', () => {
    const origGem = process.env.GEMINI_API_KEY;
    const origAnth = process.env.ANTHROPIC_API_KEY;
    const origFetch = global.fetch;

    afterEach(() => {
      if (origGem === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = origGem;
      if (origAnth === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origAnth;
      global.fetch = origFetch;
      jest.resetModules();
    });

    test('records Gemini HTTP failure and Claude fallback under laneId lawn_assess', async () => {
      process.env.GEMINI_API_KEY = 'test-gemini';
      process.env.ANTHROPIC_API_KEY = 'test-anth';
      jest.resetModules();
      const mockLedgerCall = jest.fn((p, m, fn) => fn());
      const mockLedgerCallRejected = jest.fn();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            turf_density: 82, weed_coverage: 6, color_health: 8,
            fungal_activity: 'none', insect_damage: 'none', drought_stress: 'none', mechanical_damage: 'none',
            thatch_visibility: 'low', grass_type: 'st_augustine', overwatering_signal: false,
            observations: 'Healthy, uniform green turf with no visible stress.',
          }),
        }],
        stop_reason: 'end_turn',
      });
      jest.doMock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
      jest.doMock('../services/llm-dispatch-metrics', () => ({ ledgerCall: mockLedgerCall, ledgerCallRejected: mockLedgerCallRejected }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      global.fetch = jest.fn(async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' }));

      const lawn = require('../services/lawn-assessment');
      const result = await lawn.analyzePhoto('AA==', 'image/jpeg');
      expect(result.claude).toBeTruthy();
      expect(mockLedgerCall).toHaveBeenCalledWith('gemini', expect.any(String), expect.any(Function), { laneId: 'lawn_assess' });
      expect(mockLedgerCall).toHaveBeenCalledWith('anthropic', expect.any(String), expect.any(Function), { laneId: 'lawn_assess' });
      expect(mockLedgerCallRejected).not.toHaveBeenCalled();
    });
  });

  describe('tree_shrub Gemini + Claude legs', () => {
    const origGem = process.env.GEMINI_API_KEY;
    const origAnth = process.env.ANTHROPIC_API_KEY;
    const origFetch = global.fetch;

    afterEach(() => {
      if (origGem === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = origGem;
      if (origAnth === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origAnth;
      global.fetch = origFetch;
      jest.resetModules();
    });

    test('records Gemini miss and Claude fallback under laneId tree_shrub', async () => {
      process.env.GEMINI_API_KEY = 'test-gemini';
      process.env.ANTHROPIC_API_KEY = 'test-anth';
      jest.resetModules();
      const mockLedgerCall = jest.fn((p, m, fn) => fn());
      const mockLedgerCallRejected = jest.fn();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{
          type: 'text',
          text: JSON.stringify({
            foliage_fullness: 85, leaf_color_vigor: 80,
            pest_signals: 'none', disease_signals: 'none', water_heat_stress: 'none', pruning_mechanical: 'none',
            observations: 'Full, vibrant hedges with no visible pest or disease signals.',
          }),
        }],
        stop_reason: 'end_turn',
      });
      jest.doMock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
      jest.doMock('../services/llm-dispatch-metrics', () => ({ ledgerCall: mockLedgerCall, ledgerCallRejected: mockLedgerCallRejected }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }),
      }));

      const ts = require('../services/tree-shrub-assessment');
      const result = await ts.analyzePhoto('AA==', 'image/jpeg');
      expect(result.claude).toBeTruthy();
      expect(mockLedgerCall).toHaveBeenCalledWith('gemini', expect.any(String), expect.any(Function), { laneId: 'tree_shrub' });
      expect(mockLedgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
      expect(mockLedgerCall).toHaveBeenCalledWith('anthropic', expect.any(String), expect.any(Function), { laneId: 'tree_shrub' });
    });
  });

  describe('voice_relay_collections streamed rounds', () => {
    afterEach(() => { jest.resetModules(); });

    test('records finished and failed Anthropic stream rounds via recordStreamedMessage', async () => {
      jest.resetModules();
      const mockRecordStreamed = jest.fn();
      const mockStream = jest.fn();
      jest.doMock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
        messages: { stream: mockStream },
      })));
      jest.doMock('../services/llm-dispatch-metrics', () => ({
        recordStreamedMessage: mockRecordStreamed,
      }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

      const { CollectionsConversation } = require('../services/collections/outbound-voice/collections-conversation');
      const mkConvo = () => {
        const c = new CollectionsConversation({ callSid: 'CA-col-1', send: jest.fn(), endSession: jest.fn() });
        c._ctx = { customer: { first_name: 'Pat' }, register: 'routine' };
        c._state = 'RIGHT_PARTY';
        c.say = jest.fn();
        return c;
      };

      const msg = { id: 'msg_1', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Hi Pat.' }], usage: { input_tokens: 120, output_tokens: 12 } };
      mockStream.mockReturnValueOnce({ finalMessage: async () => msg });
      await mkConvo()._modelTurn();
      expect(mockRecordStreamed).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'anthropic',
        laneId: 'voice_relay_collections',
        message: msg,
        errorCode: null,
      }));

      mockStream.mockReturnValueOnce({ finalMessage: async () => { throw Object.assign(new Error('529'), { status: 529 }); } });
      await mkConvo()._modelTurn();
      expect(mockRecordStreamed).toHaveBeenLastCalledWith(expect.objectContaining({
        provider: 'anthropic',
        laneId: 'voice_relay_collections',
        message: null,
        errorCode: 'anthropic_529',
      }));
    });
  });

  describe('contact_dictation laneId', () => {
    afterEach(() => { jest.resetModules(); });

    test('passes laneId contact_dictation to dispatchWithFallback', async () => {
      jest.resetModules();
      const mockDispatchWithFallback = jest.fn().mockResolvedValue({
        ok: true,
        json: { emails: [], addresses: [], names: [] },
      });
      jest.doMock('../services/llm/call', () => ({ dispatchWithFallback: mockDispatchWithFallback }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

      const { decodeDictatedContacts } = require('../services/contact-dictation');
      await decodeDictatedContacts({ transcript: 'Caller: my email is test at gmail dot com' });
      expect(mockDispatchWithFallback).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'contactDecoder' }),
        expect.objectContaining({ laneId: 'contact_dictation' }),
        expect.any(Object),
      );
    });
  });
});

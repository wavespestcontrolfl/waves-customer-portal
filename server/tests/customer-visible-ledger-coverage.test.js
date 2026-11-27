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
    afterEach(() => {
      jest.dontMock('../services/llm/call');
      jest.dontMock('../services/logger');
      jest.resetModules();
    });

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

  describe('provider verdicts and JSON-null rejection in ledgerCall', () => {
    const origGem = process.env.GEMINI_API_KEY;
    const origAnth = process.env.ANTHROPIC_API_KEY;
    const origFetch = global.fetch;
    const origGate = process.env.GATE_LLM_CALL_LEDGER;
    const origGemModel = process.env.GEMINI_VISION_MODEL;
    const origModelGem = process.env.MODEL_GEMINI_VISION;
    const origModelGemFallback = process.env.MODEL_GEMINI_VISION_FALLBACK;

    afterEach(() => {
      if (origGem === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = origGem;
      if (origAnth === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origAnth;
      if (origGate === undefined) delete process.env.GATE_LLM_CALL_LEDGER;
      else process.env.GATE_LLM_CALL_LEDGER = origGate;
      if (origGemModel === undefined) delete process.env.GEMINI_VISION_MODEL;
      else process.env.GEMINI_VISION_MODEL = origGemModel;
      if (origModelGem === undefined) delete process.env.MODEL_GEMINI_VISION;
      else process.env.MODEL_GEMINI_VISION = origModelGem;
      if (origModelGemFallback === undefined) delete process.env.MODEL_GEMINI_VISION_FALLBACK;
      else process.env.MODEL_GEMINI_VISION_FALLBACK = origModelGemFallback;
      global.fetch = origFetch;
      jest.dontMock('@anthropic-ai/sdk');
      jest.dontMock('../services/llm-dispatch-metrics');
      jest.dontMock('../services/llm/call');
      jest.dontMock('../services/logger');
      jest.dontMock('../models/db');
      jest.resetModules();
    });

    test('lawn_assess records JSON null replies as schema_invalid on both Gemini and Claude', async () => {
      process.env.GEMINI_API_KEY = 'test-gemini';
      process.env.ANTHROPIC_API_KEY = 'test-anth';
      delete process.env.GEMINI_VISION_MODEL;
      delete process.env.MODEL_GEMINI_VISION;
      delete process.env.MODEL_GEMINI_VISION_FALLBACK;
      jest.resetModules();
      const mockLedgerCall = jest.fn((p, m, fn) => fn());
      const mockLedgerCallRejected = jest.fn();
      const mockCreate = jest.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'null' }],
        stop_reason: 'end_turn',
      });
      jest.doMock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockCreate } })));
      jest.doMock('../services/llm-dispatch-metrics', () => ({ ledgerCall: mockLedgerCall, ledgerCallRejected: mockLedgerCallRejected }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
      global.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'null' }] } }] }),
      }));

      const lawn = require('../services/lawn-assessment');
      const result = await lawn.analyzePhoto('AA==', 'image/jpeg');
      expect(result).toBeNull();
      expect(mockLedgerCallRejected).toHaveBeenCalledTimes(2);
      expect(mockLedgerCallRejected).toHaveBeenNthCalledWith(1, expect.anything(), 'schema_invalid');
      expect(mockLedgerCallRejected).toHaveBeenNthCalledWith(2, expect.anything(), 'schema_invalid');
    });

    test('Gemini MAX_TOKENS is treated as a miss in pest_id, lawn_assess, and tree_shrub even with schema-valid JSON', async () => {
      process.env.GEMINI_API_KEY = 'test-gemini';
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GEMINI_VISION_MODEL;
      delete process.env.MODEL_GEMINI_VISION;
      delete process.env.MODEL_GEMINI_VISION_FALLBACK;
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
          responseId: 'gem_trunc_1',
          candidates: [{
            finishReason: 'MAX_TOKENS',
            content: {
              parts: [{
                text: JSON.stringify({
                  pest_key: 'fire_ant',
                  category: 'ants',
                  confidence: 'high',
                  confidence_score: 0.92,
                  visual_notes: 'Red ants visible.',
                  turf_density: 82,
                  weed_coverage: 6,
                  color_health: 8,
                  fungal_activity: 'none',
                  insect_damage: 'none',
                  drought_stress: 'none',
                  mechanical_damage: 'none',
                  thatch_visibility: 'low',
                  grass_type: 'st_augustine',
                  overwatering_signal: false,
                  foliage_fullness: 85,
                  leaf_color_vigor: 80,
                  pest_signals: 'none',
                  disease_signals: 'none',
                  water_heat_stress: 'none',
                  pruning_mechanical: 'none',
                  observations: 'Healthy lawn with no visible stress.',
                }),
              }],
            },
          }],
        }),
      }));

      const pest = require('../services/pest-identification');
      const lawn = require('../services/lawn-assessment');
      const ts = require('../services/tree-shrub-assessment');
      expect((await pest.analyzePhoto('AA==', 'image/jpeg')).gemini).toBeNull();
      expect(await lawn.analyzePhoto('AA==', 'image/jpeg')).toBeNull();
      expect(await ts.analyzePhoto('AA==', 'image/jpeg')).toBeNull();
      expect(mockLedgerCallRejected).not.toHaveBeenCalled();
    });

    test('real ledgerCall preserves gemini_refusal, gemini_incomplete, openai_incomplete, openai_refusal, and Gemini responseId without overwriting on ledgerCallRejected', async () => {
      process.env.GATE_LLM_CALL_LEDGER = 'true';
      jest.resetModules();
      const inserted = [];
      const updated = [];
      const mockDb = jest.fn(() => ({
        insert: (row) => {
          inserted.push(row);
          return { returning: async () => [{ id: inserted.length }] };
        },
        where: () => ({
          update: async (patch) => {
            updated.push(patch);
            return 1;
          },
        }),
      }));
      jest.doMock('../models/db', () => mockDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

      const { ledgerCall, ledgerCallRejected } = require('../services/llm-dispatch-metrics');

      const blocked = await ledgerCall('gemini', 'gemini-3.8-flash', async () => ({
        responseId: 'gem_resp_blocked',
        candidates: [{ finishReason: 'SAFETY' }],
      }), { laneId: 'pest_id' });
      ledgerCallRejected(blocked, 'empty_text');

      const truncated = await ledgerCall('gemini', 'gemini-3.8-flash', async () => ({
        responseId: 'gem_resp_trunc',
        candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"best_match":' }] } }],
      }), { laneId: 'pest_id' });
      ledgerCallRejected(truncated, 'invalid_json');

      const oaiIncomplete = await ledgerCall('openai', 'gpt-5.5', async () => ({
        id: 'resp_inc',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output_text: '{"customer_summary":"partial"}',
      }), { laneId: 'lawn_diag_writer' });
      ledgerCallRejected(oaiIncomplete, 'invalid_output');

      const oaiRefusal = await ledgerCall('openai', 'gpt-5.5', async () => ({
        id: 'resp_ref',
        status: 'completed',
        output: [{ content: [{ type: 'refusal', refusal: 'Cannot answer' }] }],
      }), { laneId: 'lawn_diag_writer' });
      ledgerCallRejected(oaiRefusal, 'invalid_json');

      await new Promise((r) => setImmediate(r));
      expect(inserted.map((r) => ({ ok: r.ok, error_code: r.error_code, provider_ref: r.provider_ref }))).toEqual([
        { ok: false, error_code: 'gemini_refusal', provider_ref: 'gem_resp_blocked' },
        { ok: false, error_code: 'gemini_incomplete', provider_ref: 'gem_resp_trunc' },
        { ok: false, error_code: 'openai_incomplete', provider_ref: 'resp_inc' },
        { ok: false, error_code: 'openai_refusal', provider_ref: 'resp_ref' },
      ]);
      // None of the already-classified provider failures should be overwritten by ledgerCallRejected.
      expect(updated).toEqual([]);
    });
  });
});

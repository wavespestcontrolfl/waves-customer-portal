const segments = require('../services/voice-agent/relay-segments');
const { composeRelaySegment } = require('../services/voice-agent/relay-transfer');

describe('relay segment storage representation', () => {
  test('retains the issued references and search context in the serialized record', () => {
    const slot = { date: '2026-01-02', startMinutes: 840, timeOfDay: 'afternoon', duration: 90 };
    const record = JSON.parse(JSON.stringify(segments.buildSegment({
      generation: 2, sessionKey: 'second', text: 'Caller: Please use that time.',
      slotRefs: [['S1-1', slot]], lookupRefs: [['C1-1', 'fixture-account']],
      promises: [{ kind: 'send_estimate', verdict: true }],
    })));
    expect(record.slot_refs).toEqual([['S1-1', slot]]);
    expect(record.lookup_refs).toEqual([['C1-1', 'fixture-account']]);
    expect(record.promises).toEqual([{ kind: 'send_estimate', verdict: true, expectation: null, at: null }]);
    expect(record.reservice_filed).toBe(false);
    expect(record.hold_open).toBe(false);
  });

  test('recording composition reads all relay segments in generation order', () => {
    const row = { metadata: { relay_reconnects: 1, relay_segments: [
      segments.buildSegment({ generation: 2, text: 'Caller: second' }),
      segments.buildSegment({ generation: 1, text: 'Caller: first' }),
    ] } };
    const composed = composeRelaySegment(row);
    expect(composed.text).toContain('Caller: first\n\n[Reconnected]\nCaller: second');
    expect(segments.callerTurnsFromText(composed.text)).toEqual(['first', 'second']);
  });

  // Unresolved #3910 review finding 3940598420. This split preserves the
  // reviewed behavior; the prerequisite stays DRAFT until the privacy fix.
  test.todo('scrub PAN fragments across socket segments before persistence and composition');
});

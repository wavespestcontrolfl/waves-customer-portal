const segments = require('../services/voice-agent/relay-segments');

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
    const composed = { text: segments.segmentsText(row.metadata.relay_segments) };
    expect(composed.text).toContain('Caller: first\n\n[Reconnected]\nCaller: second');
    expect(segments.callerTurnsFromText(composed.text)).toEqual(['first', 'second']);
  });

  test('scrubs caller fragments across sockets despite intervening agent speech', () => {
    const input = [
      segments.buildSegment({ generation: 2, sessionKey: 'second', text: 'Agent: I can send a payment link.\nCaller: 1111 1111' }),
      segments.buildSegment({ generation: 1, sessionKey: 'first', text: 'Caller: 4111 1111\nAgent: Please do not read your card.' }),
    ];
    const scrubbed = segments.scrubStoredSegments(input);
    expect(scrubbed.map((s) => s.session_key)).toEqual(['first', 'second']);
    expect(segments.segmentsText(scrubbed)).toContain('[card ending 1111]');
    expect(JSON.stringify(scrubbed)).not.toContain('4111 1111');
    expect(JSON.stringify(scrubbed)).not.toContain('1111 1111');
  });
});

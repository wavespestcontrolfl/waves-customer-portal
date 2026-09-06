const segments = require('../services/voice-agent/relay-segments');

describe('relay segment storage representation', () => {
  test('whole-call telemetry recomputes percentiles from samples and excludes raw utterances', () => {
    const { storedTurnStats, summarizeTurnStats } = require('../services/voice-agent/relay-transcript');
    const makeLeg = (key, sendTimes) => {
      const stats = sendTimes.map((firstSendAt) => ({ promptAt: 0, firstSendAt, toolMs: 20,
        modelMs: 80, toolCount: 1, rounds: 1, renderer: 'block', effort: 'low', playedSource: 'assumed',
        agentEntries: [{ text: 'NEVER STORE RAW UTTERANCES HERE' }],
      }));
      return segments.buildSegment({ sessionKey: key, turnStats: storedTurnStats(stats),
        turnCounts: { caller_turns: stats.length, agent_turns: stats.length, tool_calls: stats.length },
        latency: summarizeTurnStats(stats) });
    };
    const earlier = makeLeg('earlier', Array(20).fill(100));
    const later = makeLeg('later', [10000]);
    const summary = segments.summarizeSegments({ relay_segment_owners: ['earlier', 'later'], relay_segments: [later, earlier] });
    expect(summary).toMatchObject({ caller_turns: 21, agent_turns: 21, tool_calls: 21,
      latency: { turns: 21, prompt_to_first_send_p50: 100, prompt_to_first_send_p95: 100,
        audio_metric_turns: 0, stop_to_first_audio_p95: null, model_ms_total: 1680, tool_ms_total: 420,
        effort_counts: { low: 21 }, played_sources: { assumed: 21 } },
      segments: { count: 2, complete: true, telemetry_complete: true },
    });
    expect(JSON.stringify(earlier)).not.toContain('NEVER STORE');
    expect(segments.summarizeSegments({ relay_segment_owners: ['earlier', 'later'], relay_segments: [earlier] })).toMatchObject({ caller_turns: null, latency: null, segments: { complete: false, telemetry_complete: false } });
  });

  test('legacy segments keep unknown aggregate metrics instead of claiming zero or averaging percentiles', () => {
    expect(segments.summarizeSegments({ relay_segment_owners: ['legacy'], relay_segments: [
      { session_key: 'legacy', text: 'Caller: ants', latency: { turns: 5, prompt_to_first_send_p95: 700 } },
    ] })).toMatchObject({ caller_turns: null, tool_calls: null, latency: null,
      segments: { complete: true, telemetry_complete: false } });
  });

  test.each([20000, 70000])('composite budget preserves all %s recorded characters and both headers', (recordedChars) => {
    const { composeRelayTranscript, MAX_TRANSCRIPT_CHARS } = require('../services/voice-agent/relay-transcript');
    const recorded = '\n\n[Voicemail segment]\n' + '🌊'.repeat(recordedChars);
    const ai = '🌊'.repeat(MAX_TRANSCRIPT_CHARS);
    const composite = composeRelayTranscript(ai, recorded);
    expect(composite.startsWith('[AI segment]\n')).toBe(true);
    expect(composite.endsWith('[AI transcript truncated]' + recorded)).toBe(true);
    expect(Array.from(composite)).toHaveLength(Math.max(MAX_TRANSCRIPT_CHARS,
      Array.from('[AI segment]\n\n[AI transcript truncated]' + recorded).length));
    expect(composeRelayTranscript('Caller: hello', '\n\n[Staff segment]\nStaff: hello'))
      .toBe('[AI segment]\nCaller: hello\n\n[Staff segment]\nStaff: hello');
  });

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

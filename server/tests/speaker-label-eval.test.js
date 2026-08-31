const fs = require('fs');
const path = require('path');

const {
  canonicalRawTranscript,
  goldWordStream,
  loadFixture,
  modelWordStream,
  runScore,
  scoreLabeling,
  sha256,
  suggestedLineSpeakers,
} = require('../scripts/speaker-label-eval');

const FIXTURE_PATH = path.join(__dirname, '../fixtures/call-extraction-eval/speaker-labels.json');

const SEGMENTS = {
  segments: [
    { speaker: 'A', text: 'Thanks for calling Waves Pest Control, how can I help?' },
    { speaker: 'B', text: 'Hi, I have   ants in\nthe kitchen.' },
    { speaker: 'A', text: 'We can get you scheduled.' },
  ],
};

function canonical() {
  return canonicalRawTranscript(SEGMENTS);
}

describe('speaker label eval', () => {
  test('canonical raw transcript is deterministic: first-appearance speaker names, collapsed whitespace', () => {
    const built = canonical();
    expect(built.lines).toEqual([
      'Speaker 1: Thanks for calling Waves Pest Control, how can I help?',
      'Speaker 2: Hi, I have ants in the kitchen.',
      'Speaker 1: We can get you scheduled.',
    ]);
    expect(built.distinctSpeakers).toBe(2);
    expect(built.text).toBe(built.lines.join('\n'));
    // Byte-identical rebuild -> stable sha pin.
    expect(sha256(built.text)).toBe(sha256(canonicalRawTranscript(SEGMENTS).text));
    expect(canonicalRawTranscript({ segments: [] })).toBeNull();
    expect(canonicalRawTranscript(null)).toBeNull();
  });

  test('scores word- and line-level accuracy through a relabeled transcript', () => {
    const built = canonical();
    const gold = goldWordStream(built.lines, ['agent', 'caller', 'agent']);
    const relabeled = [
      'Agent: Thanks for calling Waves Pest Control, how can I help?',
      'Caller: Hi, I have ants in the kitchen.',
      'Agent: We can get you scheduled.',
    ].join('\n');
    expect(scoreLabeling(gold, modelWordStream(relabeled), 3)).toMatchObject({
      status: 'scored',
      wordAccuracy: 1,
      lineAccuracy: 1,
      misLines: [],
    });

    // One turn attributed to the wrong speaker -> that line is a miss.
    const flipped = relabeled.replace('Agent: We can', 'Caller: We can');
    const miss = scoreLabeling(gold, modelWordStream(flipped), 3);
    expect(miss.misLines).toEqual([2]);
    expect(miss.wordAccuracy).toBeLessThan(1);
    expect(miss.lineAccuracy).toBe(0.6667);
  });

  test('reflowed turns still score when the word sequence is preserved', () => {
    const built = canonical();
    const gold = goldWordStream(built.lines, ['agent', 'caller', 'agent']);
    // Model merged the caller turn into a wrapped continuation line.
    const reflowed = [
      'Agent: Thanks for calling Waves Pest Control, how can I help?',
      'Caller: Hi, I have ants in',
      'the kitchen.',
      'Agent: We can get you scheduled.',
    ].join('\n');
    expect(scoreLabeling(gold, modelWordStream(reflowed), 3)).toMatchObject({ status: 'scored', wordAccuracy: 1 });

    // Different words (dropped token) -> unscored, never positional guessing.
    const dropped = reflowed.replace(' ants', '');
    expect(scoreLabeling(gold, modelWordStream(dropped), 3)).toEqual({ status: 'word_sequence_mismatch' });
  });

  test('gold stream refuses a label array that does not match the transcript lines', () => {
    const built = canonical();
    expect(() => goldWordStream(built.lines, ['agent', 'caller'])).toThrow(/3 lines/);
  });

  test('modelWordStream maps labels: agent/caller/customer recognized, everything else is other', () => {
    const words = modelWordStream('Agent: hello there\nCustomer: hi\nSpeaker 1: mystery words');
    expect(words.map((w) => w.speaker)).toEqual(['agent', 'agent', 'caller', 'other', 'other']);
  });

  test('committed fixture loads, and its schema rejects PII-shaped or malformed cases', () => {
    const doc = loadFixture(FIXTURE_PATH);
    expect(doc.schemaVersion).toBe('call-speaker-labels.v1');
    // Committed content stays PII-free: labels, uuids, and hashes only
    // (loadFixture already rejects any line_speakers value outside the enum).
    const blob = JSON.stringify(doc);
    expect(blob).not.toMatch(/@/);
    expect(blob).not.toMatch(/\d{7,}/);

    const tmp = path.join(__dirname, 'fixtures', 'tmp-speaker-labels.json');
    const write = (cases) => {
      fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 'call-speaker-labels.v1', cases }));
      return tmp;
    };
    try {
      expect(() => loadFixture(write([{ id: 'x', call_log_id: 'c', transcript_sha256: 'nope', line_speakers: ['agent'] }])))
        .toThrow(/transcript_sha256/);
      expect(() => loadFixture(write([{ id: 'x', call_log_id: 'c', transcript_sha256: 'a'.repeat(64), line_speakers: ['agent', 'VERIFY'] }])))
        .toThrow(/line_speakers/);
      expect(() => loadFixture(write([{ id: 'x', call_log_id: 'c', transcript_sha256: 'a'.repeat(64), line_speakers: [] }])))
        .toThrow(/line_speakers/);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  test('sheet suggestions come from the stored transcript and null out on drift or ties', () => {
    const built = canonical();
    const stored = [
      'Agent: Thanks for calling Waves Pest Control, how can I help?',
      'Caller: Hi, I have ants in the kitchen.',
      'Agent: We can get you scheduled.',
    ].join('\n');
    expect(suggestedLineSpeakers(built.lines, stored)).toEqual(['agent', 'caller', 'agent']);
    // Stored transcript with different words (re-transcribed) -> no suggestions.
    expect(suggestedLineSpeakers(built.lines, 'Agent: entirely different call')).toEqual([null, null, null]);
  });

  test('runScore: drift is unscored, guard-null is labeling_failed, live path scores', async () => {
    const row = (id) => ({
      id,
      created_at: '2026-08-01',
      direction: 'inbound',
      transcription: 'stored',
      transcript_structured: JSON.stringify(SEGMENTS),
    });
    const goodSha = sha256(canonical().text);
    const fixtureDoc = {
      schemaVersion: 'call-speaker-labels.v1',
      cases: [
        { id: 'ok', call_log_id: 'call-1', transcript_sha256: goodSha, line_speakers: ['agent', 'caller', 'agent'] },
        { id: 'drift', call_log_id: 'call-2', transcript_sha256: 'b'.repeat(64), line_speakers: ['agent', 'caller', 'agent'] },
        { id: 'guard', call_log_id: 'call-3', transcript_sha256: goodSha, line_speakers: ['agent', 'caller', 'agent'] },
        { id: 'missing', call_log_id: 'call-4', transcript_sha256: goodSha, line_speakers: ['agent'] },
      ],
    };
    const tmp = path.join(__dirname, 'fixtures', 'tmp-speaker-score.json');
    fs.writeFileSync(tmp, JSON.stringify(fixtureDoc));

    const db = () => ({
      select: () => ({
        whereIn: async () => [row('call-1'), row('call-2'), row('call-3')],
      }),
    });
    const labelTranscript = async (text, opts) => {
      expect(opts.call.id).toMatch(/^call-/);
      if (opts.call.id === 'call-3') return null; // production guard tripped
      return text
        .replace(/^Speaker 1:/gm, 'Agent:')
        .replace(/^Speaker 2:/gm, 'Caller:');
    };

    try {
      const summary = await runScore({ fixturePath: tmp }, { db, labelTranscript });
      expect(summary.scored).toBe(1);
      expect(summary.wordAccuracy).toBe(1);
      expect(summary.lineAccuracy).toBe(1);
      expect(summary.unscored).toEqual([
        { caseId: 'drift', status: 'transcript_drift' },
        { caseId: 'guard', status: 'labeling_failed' },
        { caseId: 'missing', status: 'call_not_found' },
      ]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  test('runScore with an empty fixture reports no_cases instead of a vacuous pass', async () => {
    const summary = await runScore({ fixturePath: FIXTURE_PATH }, {
      db: () => { throw new Error('db must not be touched with no cases'); },
      labelTranscript: async () => { throw new Error('no LLM call with no cases'); },
    });
    if (loadFixture(FIXTURE_PATH).cases.length === 0) {
      expect(summary.status).toBe('no_cases');
    } else {
      expect(summary.status).toBe('scored');
    }
  });
});

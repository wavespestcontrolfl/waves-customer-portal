const fs = require('fs');
const path = require('path');
const { etDateString } = require('../utils/datetime-et');

const {
  CASE_KEYS,
  assertMatchesProductionNormalizer,
  buildSheet,
  canonicalRawTranscript,
  expectedCaseId,
  goldWordStream,
  loadFixture,
  modelWordStream,
  runScore,
  runSheet,
  scoreLabeling,
  sha256,
  suggestedSegmentSpeakers,
  writePrivateSheet,
} = require('../scripts/speaker-label-eval');

const FIXTURE_PATH = path.join(__dirname, '../fixtures/call-extraction-eval/speaker-labels.json');
const TMP_DIR = path.join(__dirname, 'fixtures');

// Mirror of call-recording-processor.normalizeOpenAITranscript's segment
// branch (trim + first-appearance "Speaker N" + "\n" join). The runtime guard
// compares the rebuild against the REAL function; this stand-in keeps the
// unit tests hermetic (the processor module opens a DB pool on require).
function prodNormalize(data) {
  const speakerLabels = new Map();
  const text = data.segments
    .map((segment) => {
      const speaker = segment.speaker || segment.speaker_id || segment.speaker_label;
      const body = String(segment.text || '').trim();
      if (!body) return null;
      if (!speaker) return body;
      if (!speakerLabels.has(speaker)) speakerLabels.set(speaker, `Speaker ${speakerLabels.size + 1}`);
      return `${speakerLabels.get(speaker)}: ${body}`;
    })
    .filter(Boolean)
    .join('\n');
  return text.trim() || null;
}

const SEGMENTS = {
  segments: [
    { speaker: 'A', text: ' Thanks for calling Waves Pest Control, how can I help? ' },
    { speaker: 'B', text: 'Hi, I have ants in\nthe kitchen.' },
    { speaker: 'A', text: '' },
    { speaker: 'A', text: 'We can get you scheduled.' },
  ],
};
const UUID = '11111111-1111-4111-8111-111111111111';

function canonical() {
  return canonicalRawTranscript(SEGMENTS);
}

function relabel(text) {
  return text.replace(/^Speaker 1:/gm, 'Agent:').replace(/^Speaker 2:/gm, 'Caller:');
}

describe('speaker label eval', () => {
  test('rebuilds the raw transcript exactly like the production normalizer (trim only, embedded newlines kept)', () => {
    const built = canonical();
    expect(built.renders).toEqual([
      'Speaker 1: Thanks for calling Waves Pest Control, how can I help?',
      'Speaker 2: Hi, I have ants in\nthe kitchen.',
      'Speaker 1: We can get you scheduled.',
    ]);
    expect(built.distinctSpeakers).toBe(2);
    expect(built.text).toBe(prodNormalize(SEGMENTS));
    expect(() => assertMatchesProductionNormalizer(SEGMENTS, built, prodNormalize)).not.toThrow();
    // A normalizer that collapses whitespace differently would be a different
    // replay input — the guard must refuse it.
    expect(() => assertMatchesProductionNormalizer(SEGMENTS, built, () => built.text.replace('\n', ' ')))
      .toThrow(/diverged from normalizeOpenAITranscript/);
    expect(sha256(built.text)).toBe(sha256(canonicalRawTranscript(SEGMENTS).text));
    expect(canonicalRawTranscript({ segments: [] })).toBeNull();
    expect(canonicalRawTranscript(null)).toBeNull();
  });

  test('scores word- and segment-level accuracy through a relabeled transcript', () => {
    const built = canonical();
    const gold = goldWordStream(built.renders, ['agent', 'caller', 'agent']);
    const relabeled = relabel(built.text);
    expect(scoreLabeling(gold, modelWordStream(relabeled), 3)).toMatchObject({
      status: 'scored',
      wordAccuracy: 1,
      segmentAccuracy: 1,
      misSegments: [],
    });

    // The continuation line "the kitchen." inherits Caller on the model side
    // and belongs to segment 1 on the gold side — a wrapped segment scores whole.
    const flipped = relabeled.replace('Agent: We can', 'Caller: We can');
    const miss = scoreLabeling(gold, modelWordStream(flipped), 3);
    expect(miss.misSegments).toEqual([2]);
    expect(miss.wordAccuracy).toBeLessThan(1);
    expect(miss.segmentAccuracy).toBe(0.6667);
  });

  test('reflowed turns still score when the word sequence is preserved; changed words are unscored', () => {
    const built = canonical();
    const gold = goldWordStream(built.renders, ['agent', 'caller', 'agent']);
    const reflowed = [
      'Agent: Thanks for calling Waves Pest Control, how can I help?',
      'Caller: Hi, I have ants',
      'in the kitchen.',
      'Agent: We can get you scheduled.',
    ].join('\n');
    expect(scoreLabeling(gold, modelWordStream(reflowed), 3)).toMatchObject({ status: 'scored', wordAccuracy: 1 });
    expect(scoreLabeling(gold, modelWordStream(reflowed.replace(' ants', '')), 3))
      .toEqual({ status: 'word_sequence_mismatch' });
  });

  test('a 50/50 word split on a segment is a miss, never credit', () => {
    const gold = goldWordStream(['Speaker 1: hello world'], ['caller']);
    const score = scoreLabeling(gold, modelWordStream('Caller: hello\nAgent: world'), 1);
    expect(score.misSegments).toEqual([0]);
    expect(score.segmentAccuracy).toBe(0);
  });

  test('gold stream refuses a label array that does not match the segment count', () => {
    expect(() => goldWordStream(canonical().renders, ['agent', 'caller'])).toThrow(/3 segments/);
  });

  test('modelWordStream maps labels: agent/caller/customer recognized, everything else is other', () => {
    const words = modelWordStream('Agent: hello there\nCustomer: hi\nSpeaker 1: mystery words');
    expect(words.map((w) => w.speaker)).toEqual(['agent', 'agent', 'caller', 'other', 'other']);
  });

  test('fixture: committed file loads; cases are an exact key allowlist with typed fields', () => {
    const doc = loadFixture(FIXTURE_PATH);
    expect(doc.schemaVersion).toBe('call-speaker-labels.v1');
    for (const item of doc.cases) {
      expect(Object.keys(item).every((k) => CASE_KEYS.has(k))).toBe(true);
    }

    const tmp = path.join(TMP_DIR, 'tmp-speaker-labels.json');
    const valid = {
      id: 'label-11111111',
      call_log_id: UUID,
      labeled_at: '2026-08-31',
      labeled_by: 'owner',
      transcript_sha256: 'a'.repeat(64),
      segment_speakers: ['agent', 'caller'],
    };
    const write = (cases, extraTop = {}) => {
      fs.writeFileSync(tmp, JSON.stringify({ schemaVersion: 'call-speaker-labels.v1', description: 'test', cases, ...extraTop }));
      return tmp;
    };
    try {
      expect(loadFixture(write([valid])).cases).toHaveLength(1);
      // Top-level keys and case ids are locked too — no authored free text anywhere.
      expect(() => loadFixture(write([valid], { notes: 'called Pat back' }))).toThrow(/unsupported top-level key "notes"/);
      expect(() => loadFixture(write([{ ...valid, id: 'jane-doe' }]))).toThrow(/generated form label-11111111/);
      // Extra fields are where PII would sneak in — rejected by name, not by regex.
      expect(() => loadFixture(write([{ ...valid, note: 'spoke with Pat Example' }]))).toThrow(/unsupported key "note"/);
      expect(() => loadFixture(write([{ ...valid, transcript: 'Agent: hi' }]))).toThrow(/unsupported key "transcript"/);
      expect(() => loadFixture(write([{ ...valid, call_log_id: 'call-1' }]))).toThrow(/uuid/);
      expect(() => loadFixture(write([{ ...valid, transcript_sha256: 'nope' }]))).toThrow(/transcript_sha256/);
      expect(() => loadFixture(write([{ ...valid, segment_speakers: ['agent', 'VERIFY'] }]))).toThrow(/segment_speakers/);
      expect(() => loadFixture(write([{ ...valid, segment_speakers: [] }]))).toThrow(/segment_speakers/);
      expect(() => loadFixture(write([{ ...valid, labeled_by: 'model' }]))).toThrow(/labeled_by/);
      expect(() => loadFixture(write([valid, valid]))).toThrow(/duplicate case id/);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  test('sheet suggestions come from the stored transcript and null out on drift or ties', () => {
    const built = canonical();
    expect(suggestedSegmentSpeakers(built.renders, relabel(built.text))).toEqual(['agent', 'caller', 'agent']);
    expect(suggestedSegmentSpeakers(built.renders, 'Agent: entirely different call')).toEqual([null, null, null]);
  });

  test('sheet file is created exclusively with 0600; stdout stays PII-free', async () => {
    const built = canonical();
    const row = { id: UUID, created_at: '2026-08-30', direction: 'inbound', transcription: relabel(built.text) };
    const sheet = buildSheet([{ row, canonical: built }]);
    expect(sheet).toContain('CONTAINS TRANSCRIPT TEXT (PII)');
    expect(sheet).toContain('[  0] (agent) Speaker 1:');
    expect(sheet).toContain(`"transcript_sha256": "${sha256(built.text)}"`);
    expect(sheet).toContain(`"labeled_at": "${etDateString()}"`); // ET calendar date, not UTC

    const out = path.join(TMP_DIR, 'tmp-speaker-sheet.txt');
    fs.rmSync(out, { force: true });
    const logged = [];
    const spy = jest.spyOn(console, 'log').mockImplementation((line) => logged.push(String(line)));
    try {
      const db = () => ({
        select: () => ({ whereIn: async () => [{ ...row, transcript_structured: JSON.stringify(SEGMENTS) }] }),
      });
      await runSheet({ ids: [UUID], limit: 10, out }, { db, normalizeTranscript: prodNormalize });
      expect(logged.join('\n')).not.toMatch(/ants|kitchen|scheduled/i);
      const written = fs.readFileSync(out, 'utf8');
      expect(written).toContain('Hi, I have ants in');
      expect(written).toContain('        the kitchen.'); // continuation line kept, indented under its segment
      if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);
      // Existing path (file or symlink) is refused — never overwritten or widened.
      expect(() => writePrivateSheet(out, 'again')).toThrow(/EEXIST/);
      // No --out: a fresh private mkdtemp path.
      const auto = writePrivateSheet(null, 'x');
      expect(path.basename(path.dirname(auto))).toMatch(/^speaker-label-sheet-/);
      fs.rmSync(path.dirname(auto), { recursive: true, force: true });
    } finally {
      spy.mockRestore();
      fs.rmSync(out, { force: true });
    }
  });

  test('runScore: drift is unscored, guard-null is labeling_failed, live path scores', async () => {
    const ids = ['aaaaaaaa-1111-4111-8111-111111111111', 'bbbbbbbb-1111-4111-8111-111111111111', 'cccccccc-1111-4111-8111-111111111111', 'dddddddd-1111-4111-8111-111111111111'];
    const row = (id) => ({ id, created_at: '2026-08-01', direction: 'inbound', transcription: 'stored', transcript_structured: JSON.stringify(SEGMENTS) });
    const goodSha = sha256(canonical().text);
    const mk = (callId, sha, speakers = ['agent', 'caller', 'agent']) => ({
      id: expectedCaseId(callId), call_log_id: callId, labeled_at: '2026-08-31', labeled_by: 'owner', transcript_sha256: sha, segment_speakers: speakers,
    });
    const tmp = path.join(TMP_DIR, 'tmp-speaker-score.json');
    fs.writeFileSync(tmp, JSON.stringify({
      schemaVersion: 'call-speaker-labels.v1',
      description: 'test',
      cases: [mk(ids[0], goodSha), mk(ids[1], 'b'.repeat(64)), mk(ids[2], goodSha), mk(ids[3], goodSha, ['agent'])],
    }));
    const db = () => ({ select: () => ({ whereIn: async () => [row(ids[0]), row(ids[1]), row(ids[2])] }) });
    const labelTranscript = async (text, opts) => {
      expect(opts.call.id).toBe(opts.call.id);
      if (opts.call.id === ids[2]) return null; // production guard tripped
      return relabel(text);
    };
    try {
      const summary = await runScore({ fixturePath: tmp }, { db, labelTranscript, normalizeTranscript: prodNormalize, labelModel: 'resolved-by-processor' });
      // Attribution comes from the processor's resolved constant, not re-derived env.
      expect(summary.model).toBe('resolved-by-processor');
      expect(summary.scored).toBe(1);
      expect(summary.wordAccuracy).toBe(1);
      expect(summary.segmentAccuracy).toBe(1);
      expect(summary.unscored).toEqual([
        { caseId: 'label-bbbbbbbb', status: 'transcript_drift' },
        { caseId: 'label-cccccccc', status: 'labeling_failed' },
        { caseId: 'label-dddddddd', status: 'call_not_found' },
      ]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  test('runScore with an empty fixture reports no_cases instead of a vacuous pass', async () => {
    const summary = await runScore({ fixturePath: FIXTURE_PATH }, {
      db: () => { throw new Error('db must not be touched with no cases'); },
      labelTranscript: async () => { throw new Error('no LLM call with no cases'); },
      normalizeTranscript: prodNormalize,
    });
    if (loadFixture(FIXTURE_PATH).cases.length === 0) {
      expect(summary.status).toBe('no_cases');
    } else {
      expect(summary.status).toBe('scored');
    }
  });
});

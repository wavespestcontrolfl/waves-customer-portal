/**
 * Regression: #2814 moved WORKHORSE from claude-opus-4-8 to claude-sonnet-5
 * (2026-07-18). On real feed-sized inputs that model can lead with a thinking
 * block, which has no `.text` — so `response.content[0].text` read as '' and
 * extractEventsWithClaude threw "Claude did not return parseable JSON" while a
 * complete extraction sat in content[1].
 *
 * Effect in prod: every Claude-backed event source failed 7 consecutive days
 * (10 sources, last good pull 2026-07-17), which starved the newsletter
 * autopilot to 1 eligible event and skipped the week of 07-21. Only the ical
 * sources — which never call Claude — kept succeeding.
 */

const mockCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => {
  return jest.fn().mockImplementation(() => ({
    messages: { create: mockCreate },
  }));
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());
// Keep the real ledgerCall (GATE_LLM_CALL_LEDGER is unset in tests, so it's
// already a real no-DB no-op) but spy on ledgerCallRejected so the "answered
// nothing usable" tests below can assert the ledger row gets flipped.
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const { extractEventsWithClaude } = require('../services/event-ingestion');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');

const SOURCE = { id: 'src-1', name: 'Manatee Chamber — Upcoming Events', coverage_geo: ['bradenton'] };
const OPTS = { mode: 'articles', maxEvents: 15 };
const EVENTS_JSON = JSON.stringify({
  events: [
    { name: 'Business After Hours', start_date: '2026-08-05', city: 'Bradenton' },
    { name: 'Chamber Breakfast', start_date: '2026-08-12', city: 'Bradenton' },
  ],
});

describe('event extraction: thinking-block tolerance', () => {
  const OLD_KEY = process.env.ANTHROPIC_API_KEY;
  beforeAll(() => { process.env.ANTHROPIC_API_KEY = 'test-key'; });
  afterAll(() => { process.env.ANTHROPIC_API_KEY = OLD_KEY; });
  beforeEach(() => jest.clearAllMocks());

  test('extracts when the model leads with a thinking block (the 07-18 regression)', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'thinking', thinking: 'Let me scan the feed for dated events…' },
        { type: 'text', text: EVENTS_JSON },
      ],
    });

    const events = await extractEventsWithClaude(SOURCE, '<item>…</item>', OPTS);
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe('Business After Hours');
  });

  test('redacted_thinking is tolerated the same way', async () => {
    mockCreate.mockResolvedValue({
      content: [
        { type: 'redacted_thinking', data: 'xxx' },
        { type: 'text', text: EVENTS_JSON },
      ],
    });

    await expect(extractEventsWithClaude(SOURCE, '<item>…</item>', OPTS)).resolves.toHaveLength(2);
  });

  test('a plain text-first response is unchanged', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: EVENTS_JSON }] });

    await expect(extractEventsWithClaude(SOURCE, '<item>…</item>', OPTS)).resolves.toHaveLength(2);
  });

  test('a genuinely unusable response still throws (the guard is not swallowing failures)', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'I could not find any events.' }],
    });

    await expect(extractEventsWithClaude(SOURCE, '<item>…</item>', OPTS))
      .rejects.toThrow('Claude did not return parseable JSON for event extraction');
  });

  test('an empty-but-valid extraction is not an error', async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: 'thinking', thinking: 'nothing dated here' }, { type: 'text', text: '{"events": []}' }],
    });

    await expect(extractEventsWithClaude(SOURCE, '<item>…</item>', OPTS)).resolves.toEqual([]);
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });

  // Codex r8 on #4884: {"events":[{}]} used to pass as a successful ledger
  // call even though upsertExtractedEvents (event-ingestion.js ~705) drops
  // every entry that fails normalizeExtractedEvent — a nonempty batch that
  // answers nothing usable must record a failure, not a success.
  describe('nonempty-but-unusable batches (Codex r8 on #4884)', () => {
    test('a batch of bare objects normalizes to nothing and is flagged as a failure', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"events":[{},{}]}' }] });

      const events = await extractEventsWithClaude(SOURCE, '<item>…</item>', OPTS);
      // Behavior for the caller is unchanged — upsertExtractedEvents still
      // gets the raw (unusable) entries and drops them itself.
      expect(events).toEqual([{}, {}]);
      expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
    });

    test('a batch with at least one usable entry is NOT flagged, even if others are junk', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '{"events":[{},{"title":"Sunset Market"}]}' }],
      });

      const events = await extractEventsWithClaude(SOURCE, '<item>…</item>', OPTS);
      expect(events).toHaveLength(2);
      expect(ledgerCallRejected).not.toHaveBeenCalled();
    });

    test('requireStart (news-RSS contract): a title-only entry with no date is unusable under that contract', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"events":[{"title":"Some Article"}]}' }] });

      const events = await extractEventsWithClaude(SOURCE, '<item>…</item>', { ...OPTS, requireStart: true });
      expect(events).toHaveLength(1); // still returned — the caller's upsertExtractedEvents drops it
      expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'schema_invalid');
    });

    test('requireStart: the SAME title-only entry is usable in page mode (no requireStart)', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"events":[{"title":"Some Article"}]}' }] });

      const events = await extractEventsWithClaude(SOURCE, '<item>…</item>', { mode: 'page', maxEvents: 15 });
      expect(events).toHaveLength(1);
      expect(ledgerCallRejected).not.toHaveBeenCalled();
    });
  });
});

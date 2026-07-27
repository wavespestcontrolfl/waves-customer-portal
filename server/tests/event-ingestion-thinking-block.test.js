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

const { extractEventsWithClaude } = require('../services/event-ingestion');

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
  });
});

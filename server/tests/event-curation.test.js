/**
 * Event auto-curation — the approval step of the autonomous newsletter
 * lane. Pure pieces only: prompt construction, response parsing
 * (fail-closed), kill switch.
 */

const {
  buildCurationPrompt,
  parseCurationResponse,
  curationEnabled,
} = require('../services/event-curation');

const EVENTS = [
  {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    title: 'Karaoke with Fitz',
    description: 'Weekly karaoke night at The Freckled Fin.',
    start_at: '2026-06-15T23:30:00.000Z',
    venue_name: 'The Freckled Fin',
    city: 'anna-maria',
    source_name: 'Anna Maria Island Chamber — Island Events',
  },
  {
    id: 'aaaaaaaa-0000-0000-0000-000000000002',
    title: 'City Council Regular Agenda',
    description: 'Regular agenda for the city council meeting.',
    start_at: '2026-06-16T14:00:00.000Z',
    venue_name: null,
    city: 'tampa',
    source_name: 'City of Tampa — All Events',
  },
];
const IDS = EVENTS.map((e) => e.id);

describe('event-curation buildCurationPrompt', () => {
  const prompt = buildCurationPrompt(EVENTS, '2026-06-11');

  test('carries the editorial approve/reject rules and fail-closed instruction', () => {
    expect(prompt).toContain('Fresh This Week');
    expect(prompt).toContain('APPROVE events a local reader would actually go to');
    expect(prompt).toContain('Government/civic process');
    expect(prompt).toContain('When unsure, approve: false');
    expect(prompt).toContain("Today's date: 2026-06-11");
  });

  test('lists every event with its exact id, date, venue, and source', () => {
    for (const e of EVENTS) {
      expect(prompt).toContain(`id: ${e.id}`);
      expect(prompt).toContain(`title: ${e.title}`);
    }
    expect(prompt).toContain('The Freckled Fin (anna-maria)');
  });

  test('flattens whitespace and truncates long descriptions', () => {
    const long = buildCurationPrompt([
      { ...EVENTS[0], description: `line1\nline2\t${'x'.repeat(500)}` },
    ], '2026-06-11');
    expect(long).toContain('line1 line2');
    expect(long).not.toContain('x'.repeat(301));
  });
});

describe('event-curation parseCurationResponse', () => {
  test('accepts valid decisions and clamps notes', () => {
    const decisions = parseCurationResponse(JSON.stringify({
      decisions: [
        { id: IDS[0], approve: true, note: 'live music night' },
        { id: IDS[1], approve: false, note: 'n'.repeat(500) },
      ],
    }), IDS);
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toEqual({ id: IDS[0], approve: true, note: 'live music night' });
    expect(decisions[1].approve).toBe(false);
    expect(decisions[1].note).toHaveLength(200);
  });

  test('drops unknown and duplicate ids (hallucination guard)', () => {
    const decisions = parseCurationResponse(JSON.stringify({
      decisions: [
        { id: 'ffffffff-dead-beef-0000-000000000000', approve: true },
        { id: IDS[0], approve: true },
        { id: IDS[0], approve: false },
      ],
    }), IDS);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ id: IDS[0], approve: true });
  });

  test('approve must be literal true — anything else fails closed', () => {
    const decisions = parseCurationResponse(JSON.stringify({
      decisions: [
        { id: IDS[0], approve: 'true' },
        { id: IDS[1], approve: 1 },
      ],
    }), IDS);
    expect(decisions.every((d) => d.approve === false)).toBe(true);
  });

  test('tolerates prose around the JSON but throws when none is present', () => {
    const wrapped = `Here you go:\n${JSON.stringify({ decisions: [{ id: IDS[0], approve: true }] })}`;
    expect(parseCurationResponse(wrapped, IDS)).toHaveLength(1);
    expect(() => parseCurationResponse('no json here', IDS)).toThrow(/JSON/);
  });
});

describe('event-curation kill switch', () => {
  const prev = process.env.EVENT_AUTO_CURATION;
  afterEach(() => {
    if (prev === undefined) delete process.env.EVENT_AUTO_CURATION;
    else process.env.EVENT_AUTO_CURATION = prev;
  });

  test('defaults ON; only the literal string false disables it', () => {
    delete process.env.EVENT_AUTO_CURATION;
    expect(curationEnabled()).toBe(true);
    process.env.EVENT_AUTO_CURATION = 'false';
    expect(curationEnabled()).toBe(false);
    process.env.EVENT_AUTO_CURATION = 'true';
    expect(curationEnabled()).toBe(true);
  });
});

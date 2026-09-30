jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({})),
}));
jest.mock('../models/db', () => {
  const qb = () => { throw new Error('db must not be touched when loadRows is injected'); };
  return qb;
});

const logger = require('../services/logger');
const sendgrid = require('../services/sendgrid-mail');
const {
  runAgentGapDigest,
  _private: { composeAgentGapDigest, dedupeKeyFor, BELL_BODY, gapLine, SOURCE_LABELS },
} = require('../services/agent-gap-digest');

function gapRow(overrides = {}) {
  return {
    id: 1,
    source: 'intelligence-bar',
    kind: 'missing_capability',
    domain: 'ops',
    summary: 'Add a second service address to a customer',
    attempted: null,
    closest_tool: null,
    occurrences: 1,
    seen_in_window: 1,
    status: 'new',
    first_seen_at: '2026-09-22T00:00:00.000Z',
    last_seen_at: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sendgrid.isConfigured.mockReturnValue(true);
  delete process.env.AGENT_GAP_DIGEST_EMAIL;
  delete process.env.AGENT_GAP_REPORTS;
});

describe('composeAgentGapDigest', () => {
  test('no gaps composes nothing', () => {
    expect(composeAgentGapDigest([])).toBeNull();
    expect(composeAgentGapDigest(null)).toBeNull();
  });

  test('an ACT subject counts the gaps and the body lists each one', () => {
    const rows = [gapRow({ id: 1, seen_in_window: 3, occurrences: 40 }), gapRow({ id: 2, summary: 'Second gap', closest_tool: 'send_sms', attempted: 'tried the sms tool' })];
    const composed = composeAgentGapDigest(rows);
    expect(composed.text).toContain('gap #1 (new, ops, bar): seen 3x this week, 40x total');
    // The description is model-written and stays in the bar, never the email.
    expect(composed.text).not.toContain('Add a second service address');
    expect(composed.subject).toBe("ACT: 2 things the bar couldn't do this week");
    expect(composed.count).toBe(2);
    expect(composed.text).toContain('gap #1');
    expect(composed.text).toContain('gap #2');
    expect(composed.text).toContain('closest tool send_sms');
    expect(composed.text).not.toContain('tried the sms tool');
  });

  test('singular subject for exactly one gap', () => {
    const composed = composeAgentGapDigest([gapRow()]);
    expect(composed.subject).toBe("ACT: 1 thing the bar couldn't do this week");
  });
});

describe('gapLine source labels', () => {
  test('each known source gets its short label', () => {
    expect(gapLine(gapRow({ source: 'intelligence-bar' }))).toContain('(new, ops, bar)');
    expect(gapLine(gapRow({ source: 'tech-bar' }))).toContain('(new, ops, tech bar)');
    expect(gapLine(gapRow({ source: 'texting-ai' }))).toContain('(new, ops, texting AI)');
    expect(gapLine(gapRow({ source: 'phone-agent' }))).toContain('(new, ops, phone agent)');
  });

  test('an unrecognized source falls back to its raw value, never dropped', () => {
    expect(gapLine(gapRow({ source: 'some-future-source' }))).toContain('(new, ops, some-future-source)');
    expect(Object.keys(SOURCE_LABELS)).toEqual(['intelligence-bar', 'tech-bar', 'texting-ai', 'phone-agent']);
  });
});

describe('bell body', () => {
  test('the fixed bell body stays at or under 110 characters (owner ruling 2026-09-28)', () => {
    expect(BELL_BODY.length).toBeLessThanOrEqual(110);
  });

  test('the bell body never grows with the gap count — it is a fixed instruction, not the list', () => {
    const rows = Array.from({ length: 12 }, (_, i) => gapRow({ id: i + 1, summary: `Gap number ${i + 1}` }));
    // composeAgentGapDigest's `text` (the email body) is allowed to be long;
    // the bell body passed to deliverOpsDigest is always the fixed constant.
    composeAgentGapDigest(rows);
    expect(BELL_BODY.length).toBeLessThanOrEqual(110);
  });
});

describe('dedupeKeyFor', () => {
  test('two instants in the same ET week produce the same key', () => {
    const monday = new Date('2026-09-28T13:00:00.000Z'); // Monday ET morning
    const laterInWeek = new Date('2026-10-02T23:00:00.000Z'); // Friday ET evening
    expect(dedupeKeyFor(monday)).toBe(dedupeKeyFor(laterInWeek));
  });

  test('the next ET week produces a different key', () => {
    const thisWeek = new Date('2026-09-28T13:00:00.000Z');
    const nextWeek = new Date('2026-10-05T13:00:00.000Z');
    expect(dedupeKeyFor(thisWeek)).not.toBe(dedupeKeyFor(nextWeek));
  });

  test('the key is namespaced under agent-gap-digest', () => {
    expect(dedupeKeyFor(new Date('2026-09-28T13:00:00.000Z'))).toMatch(/^agent-gap-digest:/);
  });
});

describe('runAgentGapDigest', () => {
  const rows = [gapRow({ id: 5 })];
  // Injected so these cases never reach the real ops_email_send_state marker.
  let stampSendMarker;
  const run = (opts = {}) => runAgentGapDigest({ sentRecently: async () => false, stampSendMarker, ...opts });
  beforeEach(() => { stampSendMarker = jest.fn(async () => {}); });

  test('the AGENT_GAP_REPORTS=off kill switch skips before reading anything', async () => {
    process.env.AGENT_GAP_REPORTS = 'off';
    const loadRows = jest.fn(async () => rows);
    const result = await run({ loadRows });
    expect(result.skipped).toBe('disabled');
    expect(loadRows).not.toHaveBeenCalled();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('a digest already delivered in the last six days is not sent again (deploy-overlap tick)', async () => {
    const result = await run({ loadRows: async () => rows, sentRecently: async () => true });
    expect(result.skipped).toBe('recent_send');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(stampSendMarker).not.toHaveBeenCalled();
  });

  test('a successful delivery stamps the weekly send marker once', async () => {
    const result = await run({ loadRows: async () => rows });
    expect(result.sent).toBe(true);
    expect(stampSendMarker).toHaveBeenCalledTimes(1);
  });

  test('empty window skips without sending', async () => {
    const result = await run({ loadRows: async () => [] });
    expect(result.skipped).toBe('empty');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('sends the ACT email to the internal default recipient with the full list, and a short bell body', async () => {
    const result = await run({ loadRows: async () => rows });
    expect(result.sent).toBe(true);
    expect(sendgrid.sendOne).toHaveBeenCalledTimes(1);
    const args = sendgrid.sendOne.mock.calls[0][0];
    expect(args.to).toBe('contact@wavespestcontrol.com');
    expect(args.subject).toMatch(/^ACT: /);
    expect(args.categories).toEqual(['ops', 'agent-gap-digest']);
    expect(args.text).toContain('gap #5');
  });

  test('mailer not configured skips the send (delivery-blocking preflight)', async () => {
    sendgrid.isConfigured.mockReturnValue(false);
    const result = await run({ loadRows: async () => rows });
    expect(result.skipped).toBe('unconfigured');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('fails closed on a non-internal recipient (delivery-blocking preflight)', async () => {
    process.env.AGENT_GAP_DIGEST_EMAIL = 'stranger@example.com';
    const result = await run({ loadRows: async () => rows });
    expect(result.skipped).toBe('recipient');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not an internal address'));
  });

  test('query failure is reported, never thrown', async () => {
    const result = await run({ loadRows: async () => { throw new Error('boom'); } });
    expect(result.skipped).toBe('query_failed');
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('send failure reports error without throwing', async () => {
    sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 500 }));
    const result = await run({ loadRows: async () => rows });
    expect(result.sent).toBe(false);
    expect(result.error).toBe(true);
    expect(stampSendMarker).not.toHaveBeenCalled();
  });
});

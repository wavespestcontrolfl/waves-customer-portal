// Guards phase F of the agronomic-brain program: the weekly yellow-digest
// email to the owner.
//  - weekly cadence via a knowledge_update_log 'yellow_digest' marker
//    (daily invocation, self-healing — same pattern as kb_sync)
//  - an empty week sends nothing AND stamps no marker
//  - dark-ship gate: GATE_WIKI_YELLOW_DIGEST off → shadow-log only
//  - fail-closed recipient guard: internal addresses only
//  - a failed send logs an *_error row and never stamps the success marker

jest.mock('../models/db', () => {
  const fn = (table) => global.__digestDbMock(table);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn() }));

const logger = require('../services/logger');
const { sendYellowDigestIfDue, composeYellowDigest } = require('../services/wiki-yellow-digest');

function makeDb(responses = {}) {
  const state = { responses, calls: {}, inserts: {} };
  const dbFn = (table) => {
    const rec = { table, ops: [] };
    (state.calls[table] = state.calls[table] || []).push(rec);
    const resolveRows = () => {
      const conf = state.responses[table];
      if (typeof conf === 'function') return conf(rec) || [];
      if (Array.isArray(conf)) return conf;
      return [];
    };
    const b = {};
    for (const m of ['where', 'andWhere', 'whereIn', 'whereNotNull', 'orderBy', 'limit', 'select']) {
      b[m] = (...args) => {
        rec.ops.push([m, args]);
        if (typeof args[0] === 'function') args[0].call(b);
        return b;
      };
    }
    b.first = async (...args) => { rec.ops.push(['first', args]); return resolveRows()[0] ?? null; };
    b.insert = (row) => {
      rec.ops.push(['insert', [row]]);
      (state.inserts[table] = state.inserts[table] || []).push(row);
      return { then: (res, rej) => Promise.resolve([1]).then(res, rej) };
    };
    b.then = (res, rej) => {
      let rows;
      try { rows = resolveRows(); } catch (err) { return Promise.reject(err).then(res, rej); }
      return Promise.resolve(rows).then(res, rej);
    };
    return b;
  };
  dbFn.state = state;
  return dbFn;
}

function useDb(responses) {
  const dbFn = makeDb(responses);
  global.__digestDbMock = dbFn;
  return dbFn.state;
}

const yellowPage = (over = {}) => ({
  slug: 'lawn/dollar-spot', title: 'Dollar Spot', category: 'disease',
  confidence: 'moderate', review_tier: 'yellow', review_status: 'auto',
  risk_flags: [], updated_at: new Date(), ...over,
});
const redPage = (over = {}) => ({
  slug: 'compliance/2,4-d', title: '2,4-D label rules', category: 'compliance',
  confidence: 'low', review_tier: 'red', review_status: 'pending_review',
  risk_flags: ['compliance_content'], updated_at: new Date(), ...over,
});

const mockWiki = (queue) => ({ getReviewQueue: jest.fn(async () => queue) });
const mockMailer = (impl) => ({ isConfigured: () => true, sendOne: jest.fn(impl || (async () => ({}))) });

const ENV_KEYS = ['GATE_WIKI_YELLOW_DIGEST', 'WIKI_DIGEST_EMAIL', 'SENDGRID_FROM_EMAIL', 'ADMIN_PORTAL_URL'];
const savedEnv = {};

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  process.env.GATE_WIKI_YELLOW_DIGEST = 'true';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('sendYellowDigestIfDue — weekly guard', () => {
  test('skips without touching the queue when a digest ran in the last 6 days', async () => {
    const state = useDb({ knowledge_update_log: [{ id: 7 }] });
    const wiki = mockWiki({ pending: [redPage()], blocked: [], recentYellow: [] });
    const mailer = mockMailer();

    const result = await sendYellowDigestIfDue({ wiki, sendgrid: mailer });

    expect(result).toEqual({ skipped: true });
    expect(wiki.getReviewQueue).not.toHaveBeenCalled();
    expect(mailer.sendOne).not.toHaveBeenCalled();
    expect(state.inserts.knowledge_update_log).toBeUndefined();
  });

  test('an empty week sends nothing and stamps NO marker (next exception reports next morning)', async () => {
    const state = useDb({ knowledge_update_log: [] });
    const mailer = mockMailer();

    const result = await sendYellowDigestIfDue({
      wiki: mockWiki({ pending: [], blocked: [redPage({ review_status: 'blocked' })], recentYellow: [] }),
      sendgrid: mailer,
    });

    expect(result).toEqual({ skipped: 'empty' });
    expect(mailer.sendOne).not.toHaveBeenCalled();
    expect(state.inserts.knowledge_update_log).toBeUndefined();
  });
});

describe('sendYellowDigestIfDue — dark-ship gate', () => {
  test('gate off: shadow-logs the would-be send, no email, no marker', async () => {
    process.env.GATE_WIKI_YELLOW_DIGEST = 'false';
    const state = useDb({ knowledge_update_log: [] });
    const mailer = mockMailer();

    const result = await sendYellowDigestIfDue({
      wiki: mockWiki({ pending: [redPage()], blocked: [], recentYellow: [yellowPage()] }),
      sendgrid: mailer,
    });

    expect(result.skipped).toBe('gated');
    expect(mailer.sendOne).not.toHaveBeenCalled();
    expect(state.inserts.knowledge_update_log).toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('gated OFF'));
  });
});

describe('sendYellowDigestIfDue — send path', () => {
  test('sends to the internal recipient and stamps the yellow_digest marker', async () => {
    const state = useDb({ knowledge_update_log: [] });
    const mailer = mockMailer();

    const result = await sendYellowDigestIfDue({
      wiki: mockWiki({ pending: [redPage()], blocked: [], recentYellow: [yellowPage(), yellowPage({ slug: 'lawn/rust', title: 'Lawn Rust' })] }),
      sendgrid: mailer,
    });

    expect(result).toEqual({ sent: true, yellowCount: 2, pendingCount: 1 });
    expect(mailer.sendOne).toHaveBeenCalledTimes(1);
    const msg = mailer.sendOne.mock.calls[0][0];
    expect(msg.to).toBe('contact@wavespestcontrol.com');
    expect(msg.subject).toContain('1 blocked');
    expect(msg.subject).toContain('2 yellow');
    expect(msg.html).toContain('Dollar Spot');
    expect(msg.html).toContain('/admin/kb');
    const markers = state.inserts.knowledge_update_log;
    expect(markers).toHaveLength(1);
    expect(markers[0].trigger_type).toBe('yellow_digest');
  });

  test('a failed send logs a yellow_digest_error row and never the success marker', async () => {
    const state = useDb({ knowledge_update_log: [] });
    const mailer = mockMailer(async () => { const err = new Error('SendGrid 400: bad'); err.status = 400; throw err; });

    const result = await sendYellowDigestIfDue({
      wiki: mockWiki({ pending: [], blocked: [], recentYellow: [yellowPage()] }),
      sendgrid: mailer,
    });

    expect(result).toEqual({ sent: false, error: true });
    const markers = state.inserts.knowledge_update_log || [];
    expect(markers.map((m) => m.trigger_type)).toEqual(['yellow_digest_error']);
    // guard only matches 'yellow_digest', so tomorrow's run retries
  });

  test('fail-closed: a non-internal recipient skips the send entirely', async () => {
    process.env.WIKI_DIGEST_EMAIL = 'someone@gmail.com';
    const state = useDb({ knowledge_update_log: [] });
    const mailer = mockMailer();

    const result = await sendYellowDigestIfDue({
      wiki: mockWiki({ pending: [redPage()], blocked: [], recentYellow: [] }),
      sendgrid: mailer,
    });

    expect(result).toEqual({ skipped: 'recipient' });
    expect(mailer.sendOne).not.toHaveBeenCalled();
    expect(state.inserts.knowledge_update_log).toBeUndefined();
  });

  test('unconfigured mailer skips without a marker', async () => {
    useDb({ knowledge_update_log: [] });
    const mailer = { isConfigured: () => false, sendOne: jest.fn() };

    const result = await sendYellowDigestIfDue({
      wiki: mockWiki({ pending: [redPage()], blocked: [], recentYellow: [] }),
      sendgrid: mailer,
    });

    expect(result).toEqual({ skipped: 'unconfigured' });
    expect(mailer.sendOne).not.toHaveBeenCalled();
  });
});

describe('composeYellowDigest', () => {
  test('returns null when nothing needs judgment', () => {
    expect(composeYellowDigest({ pending: [], blocked: [], recentYellow: [] })).toBeNull();
  });

  test('escapes HTML in page titles and parses stringified risk_flags', () => {
    const composed = composeYellowDigest({
      pending: [],
      blocked: [],
      recentYellow: [yellowPage({ title: 'Chinch <script>alert(1)</script>', risk_flags: '["open_contradiction"]' })],
    });
    expect(composed.html).not.toContain('<script>');
    expect(composed.html).toContain('&lt;script&gt;');
    expect(composed.html).toContain('open_contradiction');
  });
});

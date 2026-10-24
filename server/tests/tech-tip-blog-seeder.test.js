/**
 * tech-tip-blog-seeder — the blog post behind a tech tip, or the topic that
 * writes one (owner 2026-10-24, "tips with facts").
 *
 *  - A tip whose post is live writes nothing; a gap sends its topic through
 *    the office's own "Suggest a post" path, with the tip id on the row.
 *  - Two tips on one topic queue it once; a dry run and the gate off write
 *    nothing and say so.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockLive = jest.fn();
const mockSuggest = jest.fn();
jest.mock('../services/service-report/report-blog-post', () => ({ liveBlogPostsByPath: (...args) => mockLive(...args) }));
jest.mock('../services/service-report/report-blog-suggestion', () => ({ suggestReportBlogPost: (...args) => mockSuggest(...args) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { TIPS } = require('../services/service-report/tip-library');
const { scan, seedAll } = require('../services/service-report/tech-tip-blog-seeder');
const { suggestionRow } = jest.requireActual('../services/service-report/report-blog-suggestion');

const knex = {};
const linking = TIPS.filter((tip) => tip.blog);
const mice = linking.find((tip) => tip.id === 'seal_door_sweeps');
const post = { id: '11111111-1111-4111-8111-111111111111', title: 'Mice', url: `https://www.wavespestcontrol.com${mice.blog.path}` };

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_TECH_TIP_SOURCES;
});

test('scan reads every linking tip\'s path once and pairs the live ones', async () => {
  mockLive.mockResolvedValue(new Map([[mice.blog.path, post]]));
  const rows = await scan(knex);
  expect(mockLive).toHaveBeenCalledWith(knex, linking.map((tip) => tip.blog.path));
  expect(rows.find((row) => row.tipId === 'seal_door_sweeps')).toEqual({ tipId: 'seal_door_sweeps', path: mice.blog.path, topic: mice.blog.topic, post });
  // every tip on that path pairs with the same post; no other tip pairs
  const sharing = linking.filter((tip) => tip.blog.path === mice.blog.path).map((tip) => tip.id).sort();
  expect(rows.filter((row) => row.post).map((row) => row.tipId).sort()).toEqual(sharing);
});

test('gate on: each gap\'s topic is suggested once with the tip id, a live post is left alone', async () => {
  process.env.GATE_TECH_TIP_SOURCES = 'true';
  mockLive.mockResolvedValue(new Map([[mice.blog.path, post]]));
  mockSuggest.mockResolvedValue({ status: 'queued' });
  const { rows, summary } = await seedAll(knex);
  const live = rows.filter((row) => row.post);
  const gaps = rows.filter((row) => !row.post);
  const topics = new Set(gaps.map((row) => row.topic.toLowerCase()));
  expect(mockSuggest).toHaveBeenCalledTimes(topics.size);
  for (const [, args] of mockSuggest.mock.calls) {
    expect(args).toEqual({ phrase: expect.any(String), tipId: expect.any(String) });
    expect(args.actorId).toBeUndefined(); // no person: no daily cap, no advisory lock
  }
  expect(live.every((row) => row.outcome === 'live')).toBe(true);
  expect(gaps.every((row) => row.outcome === 'queued')).toBe(true);
  expect(summary).toEqual({ scanned: linking.length, live: live.length, gaps: gaps.length, queued: gaps.length });
});

test('the suggestion service\'s own answers ride through (already_queued, covered, declined, an error)', async () => {
  process.env.GATE_TECH_TIP_SOURCES = 'true';
  mockLive.mockResolvedValue(new Map());
  const answers = [{ status: 'already_queued' }, { status: 'covered' }, { status: 'declined' }, { error: 'not_a_topic' }];
  mockSuggest.mockImplementation(async () => answers.shift() || { status: 'queued' });
  const { rows } = await seedAll(knex);
  const seen = new Set(rows.map((row) => row.outcome));
  for (const outcome of ['already_queued', 'covered', 'declined', 'not_a_topic', 'queued']) expect(seen.has(outcome)).toBe(true);
});

test('a dry run, and the gate off, write nothing', async () => {
  mockLive.mockResolvedValue(new Map());
  let result = await seedAll(knex, { dryRun: true });
  expect(mockSuggest).not.toHaveBeenCalled();
  expect(result.rows.every((row) => row.outcome === 'dry_run')).toBe(true);
  result = await seedAll(knex);
  expect(mockSuggest).not.toHaveBeenCalled();
  expect(result.rows.every((row) => row.outcome === 'gate_off')).toBe(true);
  expect(result.summary.queued).toBe(0);
});

test('the queue row a tip writes carries the tip id beside the office suggestion\'s own fields', () => {
  const row = suggestionRow('porch lights that attract fewer bugs', { tipId: 'light_warm_bulbs', now: new Date('2026-10-24T12:00:00Z') });
  expect(row.signal_metadata).toMatchObject({ source: 'tech_blog_search', operator_pinned: true, tech_tip_id: 'light_warm_bulbs', suggested_by: null });
  expect(suggestionRow('palmetto bugs', { now: new Date() }).signal_metadata).not.toHaveProperty('tech_tip_id');
});

/**
 * The post a tip's subject still lacks, queued by an operator's hand-pick
 * (tech-tip-blog-seeder; tips with facts, owner 2026-10-24, decisions 2 and
 * 3): a dry run by default, at most five tips a write, each through the
 * office's own "Suggest a post", and only with GATE_BLOG_SEARCH_SUGGEST on.
 */
const POST = { id: 'post-1', title: 'How to Get Rid of Mice in Southwest Florida', url: 'https://www.wavespestcontrol.com/pest-control/get-rid-of-mice/' };

jest.mock('../services/service-report/tip-library', () => ({
  TIPS: [
    { id: 'seal_door_sweeps', blog: { path: '/pest-control/get-rid-of-mice/', topic: 'door sweeps and mice' } },
    { id: 'water_gutters', blog: { topic: 'clogged gutters and mosquitoes' } },
    { id: 'water_floor_mats', blog: { topic: 'standing water under outdoor mats' } },
    { id: 'water_floor_mats_twin', blog: { topic: 'Standing water under outdoor mats' } },
    { id: 'moisture_ac_drip', blog: { topic: 'ac drain line and ants' } },
    { id: 'interior_pet_bowls', blog: { topic: 'pet food bowls and ants' } },
    { id: 'termite_wood_soil', blog: { topic: 'wood touching soil and termites' } },
    { id: 'lawn_water_morning', blog: { path: '/lawn-care/overwatering-lawn-vs-underwatering/' } },
    { id: 'ts_mulch_trunk' },
  ],
}));
jest.mock('../services/service-report/report-blog-post', () => ({ liveBlogPostsByPath: jest.fn() }));
jest.mock('../services/service-report/report-blog-suggestion', () => ({ suggestReportBlogPost: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ blogSearchSuggestLive: jest.fn(() => true) }));

const { liveBlogPostsByPath } = require('../services/service-report/report-blog-post');
const { suggestReportBlogPost } = require('../services/service-report/report-blog-suggestion');
const featureGates = require('../config/feature-gates');
const { seedTechTipBlogs, MAX_PICKS } = require('../services/service-report/tech-tip-blog-seeder');

const db = { name: 'db' };
beforeEach(() => {
  jest.clearAllMocks();
  liveBlogPostsByPath.mockResolvedValue(new Map([['/pest-control/get-rid-of-mice/', POST]]));
  suggestReportBlogPost.mockImplementation(async (_knex, { dryRun }) => ({ status: dryRun ? 'would_queue' : 'queued' }));
  featureGates.blogSearchSuggestLive.mockReturnValue(true);
});

describe('seedTechTipBlogs', () => {
  test('a dry run lists every tip with a topic, asks the queue without writing, and asks a shared topic once', async () => {
    const rows = await seedTechTipBlogs(db);
    expect(liveBlogPostsByPath).toHaveBeenCalledWith(db, ['/pest-control/get-rid-of-mice/']);
    expect(rows.map((row) => [row.tipId, row.outcome])).toEqual([
      ['seal_door_sweeps', 'live'],
      ['water_gutters', 'would_queue'],
      ['water_floor_mats', 'would_queue'],
      ['water_floor_mats_twin', 'would_queue'],
      ['moisture_ac_drip', 'would_queue'],
      ['interior_pet_bowls', 'would_queue'],
      ['termite_wood_soil', 'would_queue'],
    ]);
    expect(rows[0].post).toEqual(POST);
    expect(suggestReportBlogPost).toHaveBeenCalledTimes(5);
    for (const [, args] of suggestReportBlogPost.mock.calls) expect(args.dryRun).toBe(true);
    expect(suggestReportBlogPost).toHaveBeenCalledWith(db, { phrase: 'clogged gutters and mosquitoes', tipId: 'water_gutters', dryRun: true });
  });

  test('a hand-pick writes only those tips, each through Suggest a post with its tip id, and reports the queue\'s answer', async () => {
    suggestReportBlogPost.mockResolvedValueOnce({ status: 'queued' }).mockResolvedValueOnce({ error: 'not_a_topic' });
    const rows = await seedTechTipBlogs(db, { only: ['water_gutters', 'moisture_ac_drip', 'water_gutters'], execute: true });
    expect(rows.map((row) => [row.tipId, row.outcome])).toEqual([['water_gutters', 'queued'], ['moisture_ac_drip', 'not_a_topic']]);
    expect(suggestReportBlogPost.mock.calls.map(([, args]) => args)).toEqual([
      { phrase: 'clogged gutters and mosquitoes', tipId: 'water_gutters', dryRun: false },
      { phrase: 'ac drain line and ants', tipId: 'moisture_ac_drip', dryRun: false },
    ]);
  });

  test('a picked tip whose post is live writes nothing', async () => {
    const rows = await seedTechTipBlogs(db, { only: ['seal_door_sweeps'], execute: true });
    expect(rows.map((row) => row.outcome)).toEqual(['live']);
    expect(suggestReportBlogPost).not.toHaveBeenCalled();
  });

  test(`at most ${MAX_PICKS} tips a run; a write needs a hand-pick and the queue's own switch; a pick needs a topic`, async () => {
    const six = ['water_gutters', 'water_floor_mats', 'water_floor_mats_twin', 'moisture_ac_drip', 'interior_pet_bowls', 'termite_wood_soil'];
    await expect(seedTechTipBlogs(db, { only: six })).rejects.toThrow(/at most 5/);
    await expect(seedTechTipBlogs(db, { execute: true })).rejects.toThrow(/--only/);
    featureGates.blogSearchSuggestLive.mockReturnValue(false);
    await expect(seedTechTipBlogs(db, { only: ['water_gutters'], execute: true })).rejects.toThrow(/GATE_BLOG_SEARCH_SUGGEST/);
    featureGates.blogSearchSuggestLive.mockReturnValue(true);
    await expect(seedTechTipBlogs(db, { only: ['lawn_water_morning'] })).rejects.toThrow(/no topic on tip\(s\) lawn_water_morning/);
    await expect(seedTechTipBlogs(db, { only: ['ts_mulch_trunk'] })).rejects.toThrow(/no topic/);
    expect(suggestReportBlogPost).not.toHaveBeenCalled();
  });

  test('the gate off still allows a dry run, which writes nothing', async () => {
    featureGates.blogSearchSuggestLive.mockReturnValue(false);
    const rows = await seedTechTipBlogs(db, { only: ['water_gutters'] });
    expect(rows.map((row) => row.outcome)).toEqual(['would_queue']);
    expect(suggestReportBlogPost.mock.calls[0][1].dryRun).toBe(true);
  });
});

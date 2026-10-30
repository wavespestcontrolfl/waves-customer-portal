/**
 * The read-only replay script's pure core: what the same-question rule would
 * have decided for past new-blog runs, against the live corpus, without
 * counting a post that did not exist yet or the run's own post.
 */

const { replay, candidateOf } = require('../scripts/same-question-replay');

function post(url, title, keyword, date) {
  return { url, path: `src/content/blog${url.replace(/\/$/, '')}.mdx`, body: `---\ntitle: "${title}"\nslug: ${url}\nprimary_keyword: ${keyword}\ndate: ${date}\ncategory: pest-control\n---\n\nBody.\n` };
}
const FIRST = post('/pest-control/millipede-vs-centipede-southwest-florida/', 'Millipede vs Centipede in Southwest Florida', 'millipede vs centipede', '2026-10-20');
const SECOND = post('/pest-control/florida-millipedes-southwest-florida/', 'Florida Millipedes in Southwest Florida', 'florida millipede', '2026-10-28');
const OTHER = post('/pest-control/ghost-ants-in-the-kitchen/', 'Ghost Ants in the Kitchen', 'ghost ants', '2026-09-01');

const RUN_FIRST = { id: 'r1', claimed_at: '2026-10-20T09:00:00Z', outcome: 'published', published_url: 'https://www.wavespestcontrol.com/pest-control/millipede-vs-centipede-southwest-florida/', target_keyword: 'millipede vs centipede', voice_constraints: {} };
const RUN_SECOND = { id: 'r2', claimed_at: '2026-10-28T09:00:00Z', outcome: 'published', published_url: 'https://www.wavespestcontrol.com/pest-control/florida-millipedes-southwest-florida/', target_keyword: 'florida millipede', voice_constraints: {} };

test('the 10-28 millipede run would have been blocked, naming the 10-20 post as the owner', () => {
  const [, second] = replay([RUN_FIRST, RUN_SECOND], [FIRST, SECOND, OTHER]);
  expect(second.would_block).toBe(true);
  expect(second.owner_url).toBe('/pest-control/millipede-vs-centipede-southwest-florida/');
  expect(second.tokens).toEqual(['millipede']);
});

test('the 10-20 run is not blocked by a post that did not exist yet, nor by its own post', () => {
  const [first] = replay([RUN_FIRST, RUN_SECOND], [FIRST, SECOND, OTHER]);
  expect(first.would_block).toBe(false);
  expect(first.reason).toBe('no_owner');
});

test('a run with no brief falls back to the queue row query; the operator working title and slug are the next fallbacks', () => {
  const noBrief = { id: 'r3', claimed_at: '2026-10-29T09:00:00Z', opp_query: 'millipedes in sarasota', voice_constraints: null };
  expect(candidateOf(noBrief).query).toBe('millipedes in sarasota');
  const pinned = { id: 'r4', claimed_at: '2026-10-29T09:00:00Z', target_keyword: 'best tips', voice_constraints: JSON.stringify({ operator_brief: { working_title: 'Millipedes at Home', slug: '/pest-control/millipedes-at-home/' } }) };
  const c = candidateOf(pinned);
  expect(c.title).toBe('Millipedes at Home');
  const [row] = replay([pinned], [FIRST, OTHER]);
  expect(row.would_block).toBe(true);
  expect(row.owner_url).toBe('/pest-control/millipede-vs-centipede-southwest-florida/');
});

test('an unrelated run is left alone', () => {
  const [row] = replay([{ id: 'r5', claimed_at: '2026-10-29T09:00:00Z', target_keyword: 'termite swarm season', voice_constraints: {} }], [FIRST, SECOND, OTHER]);
  expect(row.would_block).toBe(false);
});

test('the script only issues SELECT-style reads (no write verbs in its source)', () => {
  const src = require('fs').readFileSync(require.resolve('../scripts/same-question-replay'), 'utf8');
  expect(src).not.toMatch(/\.(insert|update|del|delete|truncate)\(|\bINSERT\s+INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b/i);
});

/**
 * registry.settleRetiredPlacements — the ONE placement transition (split of
 * #3687): a placement follows a superseded path to its live successor
 * (whole chain, bounded), takes the successor's lane, is left unclassified,
 * has an unsent draft cleared, keeps target_url only when the successor has
 * a URL, and is never moved while locked (sending / sent / send_error / a
 * sent stamp) or leased. The UPDATE is optimistic on everything the
 * decision read. In-memory knex-shaped store.
 */
const { settleRetiredPlacements } = require('../services/seo/link-registry');

function makeDb(seed) {
  const tables = { seo_link_attempts: [], seo_link_prospects: [], seo_link_acquisition_paths: [], ...seed };
  const builder = (table) => {
    const preds = [];
    const get = (row, col) => row[col];
    const eq = (l, r) => (l instanceof Date && r instanceof Date ? l.getTime() === r.getTime() : l === r);
    const rows = () => tables[table].filter((row) => preds.every((p) => p(row)));
    const q = {
      where(a, b) { if (typeof a === 'object') preds.push((row) => Object.entries(a).every(([k, v]) => eq(get(row, k), v))); else preds.push((row) => eq(get(row, a), b)); return q; },
      whereIn(col, arr) { preds.push((row) => arr.includes(get(row, col))); return q; },
      whereNull(col) { preds.push((row) => get(row, col) == null); return q; },
      whereNotNull(col) { preds.push((row) => get(row, col) != null); return q; },
      select() { return q; },
      forUpdate() { return q; },
      skipLocked() { return q; },
      orderBy() { return q; },
      async first() { return rows()[0] ? { ...rows()[0] } : undefined; },
      async update(patch) { const hit = rows(); for (const r of hit) Object.assign(r, patch); return hit.length; },
      then(res, rej) { return Promise.resolve(rows().map((r) => ({ ...r }))).then(res, rej); },
    };
    return q;
  };
  const db = (t) => builder(t);
  db._tables = tables;
  return db;
}
const NOW = new Date('2026-09-02T00:00:00Z');

test('follows the whole retirement chain, moves the execution URL, leaves leased and already-live rows alone', async () => {
  const old = { id: 'p-old', submission_url: 'https://example.com/old', superseded_by: 'p-mid', link_type: 'directory' };
  const mid = { id: 'p-mid', submission_url: 'https://example.com/mid', superseded_by: 'p-live', link_type: 'directory' };
  const live = { id: 'p-live', submission_url: 'https://example.com/join', superseded_by: null, link_type: 'directory', revision: 1, confidence: 0.7 };
  const released = { id: 'r1', path_id: 'p-old', claimed_at: null, link_type: 'directory', target_url: 'https://example.com/old', automation_policy: 'submit_free', last_classified_at: NOW, outreach_status: null, outreach_sent_at: null, outreach_send_token: null };
  const leased = { id: 'r2', path_id: 'p-old', claimed_at: NOW, link_type: 'directory', target_url: 'https://example.com/old', automation_policy: 'submit_free' };
  const onLive = { id: 'r3', path_id: 'p-live', claimed_at: null, link_type: 'directory', target_url: 'https://example.com/join', automation_policy: 'submit_free', leased_path_revision: 1 };
  const db = makeDb({ seo_link_acquisition_paths: [old, mid, live], seo_link_prospects: [released, leased, onLive] });
  expect(await settleRetiredPlacements(db, { prospectIds: ['r1', 'r2', 'r3'], now: NOW })).toBe(1);
  expect(released).toMatchObject({ path_id: 'p-live', target_url: 'https://example.com/join', automation_policy: null, last_classified_at: null, updated_at: NOW });
  expect(leased.path_id).toBe('p-old');
  expect(onLive.updated_at).toBeUndefined();
});

test('investigator mode: lane follows the successor, drafts are cleared, locked outreach never moves, URL-less successor clears target_url', async () => {
  const old = { id: 'p-old', submission_url: null, link_type: 'editorial', superseded_by: null };
  const signup = { id: 'p-new', submission_url: 'https://example.com/add', link_type: 'directory', superseded_by: null };
  old.superseded_by = signup.id;
  const base = { path_id: 'p-old', claimed_at: null, link_type: 'editorial', target_url: null, automation_policy: null };
  const drafted = { ...base, id: 'd1', outreach_status: 'drafted', outreach_to_email: 'ed@example.com', outreach_subject: 'Pitch', outreach_body: 'Hi', outreach_send_token: 'tok' };
  const sending = { ...base, id: 'd2', outreach_status: 'sending' };
  const sent = { ...base, id: 'd3', outreach_status: 'none', outreach_sent_at: NOW };
  const fresh = { ...base, id: 'd4', outreach_status: 'none' };
  const db = makeDb({ seo_link_acquisition_paths: [old, signup], seo_link_prospects: [drafted, sending, sent, fresh] });
  expect(await settleRetiredPlacements(db, { pathIds: ['p-old'], successor: signup, now: NOW })).toBe(2);
  expect(drafted).toMatchObject({ path_id: 'p-new', link_type: 'directory', target_url: 'https://example.com/add', outreach_status: 'none', outreach_to_email: null, outreach_send_token: null });
  expect(fresh).toMatchObject({ path_id: 'p-new', link_type: 'directory' });
  expect(sending.path_id).toBe('p-old'); expect(sent.path_id).toBe('p-old');
  // URL-bearing predecessor → URL-less outreach successor: the retired route is cleared, not kept for the drafter
  const dead = { id: 'p-dead', submission_url: 'https://example.com/dead', link_type: 'directory', superseded_by: 'p-out' };
  const outreach = { id: 'p-out', submission_url: null, link_type: 'editorial', superseded_by: null };
  const pl = { id: 'x1', path_id: 'p-dead', claimed_at: null, link_type: 'directory', target_url: 'https://example.com/dead', automation_policy: 'submit_free', outreach_status: null };
  const db2 = makeDb({ seo_link_acquisition_paths: [dead, outreach], seo_link_prospects: [pl] });
  await settleRetiredPlacements(db2, { pathIds: ['p-dead'], successor: outreach, now: NOW });
  expect(pl).toMatchObject({ path_id: 'p-out', link_type: 'editorial', target_url: null });
});

test('the move is optimistic on the outreach state it read — a send starting in between makes it miss', async () => {
  const old = { id: 'p-old', submission_url: null, link_type: 'editorial', superseded_by: 'p-new' };
  const next = { id: 'p-new', submission_url: null, link_type: 'resource', superseded_by: null };
  const drafted = { id: 'd1', path_id: 'p-old', claimed_at: null, link_type: 'editorial', outreach_status: 'drafted', outreach_send_token: 'tok-9', outreach_to_email: 'ed@example.com', outreach_sent_at: null };
  const inner = makeDb({ seo_link_acquisition_paths: [old, next], seo_link_prospects: [drafted] });
  const db = (t) => { const q = inner(t); if (t === 'seo_link_prospects') { const then = q.then.bind(q); q.then = (res, rej) => then((rows) => { if (drafted.outreach_status === 'drafted') drafted.outreach_status = 'sending'; return res(rows); }, rej); } return q; };
  expect(await settleRetiredPlacements(db, { pathIds: ['p-old'], successor: next, now: NOW })).toBe(0);
  expect(drafted).toMatchObject({ path_id: 'p-old', outreach_status: 'sending', outreach_send_token: 'tok-9' });
});

test('a same-path reconcile at release fires ONCE per lease, syncs the execution URL (even to null), and clears the stamp', async () => {
  const live = { id: 'p-live', submission_url: null, superseded_by: null, link_type: 'editorial', revision: 3, confidence: 0.7 };
  const row = { id: 'r1', path_id: 'p-live', claimed_at: null, link_type: 'editorial', target_url: 'https://example.com/old-form', automation_policy: null, leased_path_revision: 2, outreach_status: 'drafted', outreach_send_token: 'tok', outreach_to_email: 'ed@example.com', outreach_sent_at: null };
  const db = makeDb({ seo_link_acquisition_paths: [live], seo_link_prospects: [row] });
  expect(await settleRetiredPlacements(db, { prospectIds: ['r1'], now: NOW })).toBe(1);
  expect(row).toMatchObject({ target_url: null, leased_path_revision: null, outreach_status: 'none', outreach_send_token: null }); // URL synced to the path's (none); draft for the old route cleared
  expect(await settleRetiredPlacements(db, { prospectIds: ['r1'], now: NOW })).toBe(0); // stamp consumed — no second transition, no path_moved loop
  // a row never leased on the path (no stamp) is not reconciled by a same-path change
  const idle = { id: 'r2', path_id: 'p-live', claimed_at: null, link_type: 'editorial', target_url: 'https://example.com/pitch-page', automation_policy: null, leased_path_revision: null, outreach_status: 'none' };
  db._tables.seo_link_prospects.push(idle);
  expect(await settleRetiredPlacements(db, { prospectIds: ['r2'], now: NOW })).toBe(0);
  expect(idle.target_url).toBe('https://example.com/pitch-page');
});

test('a NULL confidence during the lease is a disproof at release — same predicate as the claim and the send valve (Codex #3720 r7 P1)', async () => {
  const live = { id: 'p-live', submission_url: 'https://example.com/pitch', superseded_by: null, link_type: 'editorial', revision: 2, confidence: null };
  const row = { id: 'r1', path_id: 'p-live', claimed_at: null, link_type: 'editorial', target_url: 'https://example.com/pitch', automation_policy: null, leased_path_revision: 2, outreach_status: 'drafted', outreach_send_token: 'tok', outreach_sent_at: null };
  const db = makeDb({ seo_link_acquisition_paths: [live], seo_link_prospects: [row] });
  expect(await settleRetiredPlacements(db, { prospectIds: ['r1'], now: NOW })).toBe(1);
  expect(row).toMatchObject({ outreach_status: 'none', outreach_send_token: null, leased_path_revision: null }); // the draft on an unassessed route is cleared
});

test('an in-place LANE change on an UNLEASED placement is reconciled at the next settlement even without a stamp (Codex #3720 r7 P1)', async () => {
  const live = { id: 'p-live', submission_url: null, superseded_by: null, link_type: 'editorial', revision: 2, confidence: 0.7 };
  // a directory row whose path the investigator re-laned to editorial while the row sat unleased: no stamp to compare
  const row = { id: 'r1', path_id: 'p-live', claimed_at: null, link_type: 'directory', target_url: 'https://example.com/add', automation_policy: 'submit_free', last_classified_at: NOW, leased_path_revision: null, outreach_status: 'none', outreach_sent_at: null, outreach_send_token: null };
  const db = makeDb({ seo_link_acquisition_paths: [live], seo_link_prospects: [row] });
  expect(await settleRetiredPlacements(db, { prospectIds: ['r1'], now: NOW })).toBe(1);
  expect(row).toMatchObject({ link_type: 'editorial', target_url: null, automation_policy: null, last_classified_at: null }); // lane follows the path; the old lane's route and policy are gone
  expect(await settleRetiredPlacements(db, { prospectIds: ['r1'], now: NOW })).toBe(0); // lanes agree now — no loop
});

test('a supersession CYCLE is never a silent no-op — settlement throws so the caller\'s transaction fails loudly', async () => {
  const a = { id: 'p-a', submission_url: null, superseded_by: 'p-b', link_type: 'editorial' };
  const bb = { id: 'p-b', submission_url: null, superseded_by: 'p-a', link_type: 'editorial' };
  const row = { id: 'r1', path_id: 'p-a', claimed_at: null, link_type: 'editorial', outreach_status: null };
  const db = makeDb({ seo_link_acquisition_paths: [a, bb], seo_link_prospects: [row] });
  await expect(settleRetiredPlacements(db, { prospectIds: ['r1'], now: NOW })).rejects.toThrow(/supersession cycle/);
  // …while a long (legitimate) chain resolves to its end
  const chain = Array.from({ length: 12 }, (_, i) => ({ id: `c-${i}`, submission_url: `https://example.com/v${i}`, superseded_by: i < 11 ? `c-${i + 1}` : null, link_type: 'directory', revision: 1 }));
  const far = { id: 'r2', path_id: 'c-0', claimed_at: null, link_type: 'directory', target_url: 'https://example.com/v0', automation_policy: 'submit_free', outreach_status: null };
  const db2 = makeDb({ seo_link_acquisition_paths: chain, seo_link_prospects: [far] });
  expect(await settleRetiredPlacements(db2, { prospectIds: ['r2'], now: NOW })).toBe(1);
  expect(far).toMatchObject({ path_id: 'c-11', target_url: 'https://example.com/v11' });
});



test.each(['release', 'investigator', 'rerank'])('an ambiguous submission is pinned during %s settlement', async mode => {
  const row = { id: 'held', path_id: 'old', claimed_at: null, outreach_status: 'none', link_type: 'directory', leased_path_revision: 1 };
  const next = { id: 'next', link_type: 'directory', confidence: 0.9, revision: 1 };
  const db = makeDb({ seo_link_prospects: [row], seo_link_acquisition_paths: [{ id: 'old', superseded_by: 'next' }, next], seo_link_attempts: [{ prospect_id: row.id, action: 'submit', outcome: 'submit_ambiguous' }] });
  const opts = mode === 'release' ? { prospectIds: [row.id] } : mode === 'investigator' ? { pathIds: ['old'], successor: next } : { prospectIds: [row.id], successor: next };
  expect(await settleRetiredPlacements(db, opts)).toBe(0);
  expect(row.path_id).toBe('old');
  db._tables.seo_link_attempts[0].outcome = 'slot_released';
  expect(await settleRetiredPlacements(db, opts)).toBe(1);
  expect(row.path_id).toBe('next');
});

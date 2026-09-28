/**
 * upsertExtractedEvents' legacy-key migration, against a real PostgreSQL
 * connection: changing the scrape/news-RSS dedup key shape (full UTC
 * instant → ET calendar day + ET wall-clock time, see
 * extractedEventDedupKeys in server/services/event-ingestion.js) must NOT
 * mint a duplicate row purely from the key-format change. A row already
 * stored under the OLD key shape for the identical title+start+url is
 * renamed onto the new shape before the insert/merge, so the SAME row is
 * updated in place (id + created_at preserved) instead of a sibling being
 * inserted.
 *
 * DB-backed, self-skips without DATABASE_URL (same convention as
 * accept-path-service-identity.test.js). upsertExtractedEvents reads the
 * shared db singleton directly (no injectable connection), so this writes
 * a fully synthetic, uniquely-named event_sources row (and its cascaded
 * events_raw rows) against the REAL tables rather than an isolated schema
 * — cleaned up in afterAll regardless of pass/fail. No customer data is
 * touched; event_sources/events_raw carry no PII.
 */

const { randomUUID } = require('crypto');

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

// Near-today date literals bit-rot (AGENTS.md: "compute relative dates for
// anything a freshness check validates") — upsertExtractedEvents drops
// anything more than FORWARD_WINDOW_DAYS (90) out or more than 24h in the
// past (server/services/event-ingestion.js), against the REAL clock, with no
// injectable reference. A fixed November 2026 literal reads as safely future
// today but silently starts failing (dropped instead of upserted) the moment
// the real calendar passes it. Anchored to Date.now() + N days instead, well
// inside that window, with an explicit UTC offset so the instant is
// unambiguous regardless of which side of a DST transition "N days from now"
// falls on.
function daysFromNowIso(days, hourUtc = 18) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  d.setUTCHours(hourUtc, 0, 0, 0);
  return d.toISOString();
}

describeOrSkip('upsertExtractedEvents — legacy dedup-key migration on real PostgreSQL', () => {
  jest.setTimeout(30000);

  const db = require('../models/db');
  const { upsertExtractedEvents, extractedEventDedupKeys, parseExtractedStartAt } = require('../services/event-ingestion');

  const feedUrl = `https://test.invalid/event-ingestion-tz-migration/${randomUUID()}`;
  let sourceId;

  beforeAll(async () => {
    const [row] = await db('event_sources').insert({
      name: `TEST event-ingestion-tz-migration ${randomUUID()}`,
      url: 'https://test.invalid/',
      feed_url: feedUrl,
      feed_type: 'scrape',
      enabled: false, // never picked up by the real cron
      coverage_geo: '{}', // pg text[] literal, same convention as the seed migration
    }).returning('id');
    sourceId = row.id || row;
  });

  afterAll(async () => {
    if (sourceId) {
      // CASCADE (migration 20260427000003) removes the events_raw rows too.
      await db('event_sources').where({ id: sourceId }).del();
    }
    await db.destroy();
  });

  test('a legacy-shaped row is renamed onto the new key and updated in place, not duplicated', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Legacy Key Migration Event';
    const url = 'https://test.invalid/legacy-migration-event/';
    const startIso = daysFromNowIso(30);
    const start = parseExtractedStartAt(startIso);
    const { externalId: newKey, legacyExternalId: legacyKey } = extractedEventDedupKeys(title, start, url);
    expect(newKey).not.toBe(legacyKey); // the two shapes really do differ

    // Seed a row under the OLD (pre-fix) key shape, as if pulled before
    // this change shipped, with a distinguishing description so the test
    // can prove the SAME row was updated (not a fresh insert).
    const [seeded] = await db('events_raw').insert({
      source_id: sourceId,
      external_id: legacyKey,
      title,
      description: 'seeded under the legacy key shape',
      start_at: start,
      event_url: url,
    }).returning(['id', 'created_at']);

    // Re-run the extraction path as if this were the next scheduled pull —
    // this is what a source cron does after the fix ships, with Claude
    // extracting the identical event.
    const { upserted, dropped } = await upsertExtractedEvents(source, [
      { title, startAt: startIso, eventUrl: url, description: 'updated on re-pull' },
    ]);
    expect(upserted).toBe(1);
    expect(dropped).toBe(0);

    const rows = await db('events_raw').where({ source_id: sourceId });
    expect(rows).toHaveLength(1); // no duplicate minted
    expect(rows[0].id).toBe(seeded.id); // the SAME row, renamed in place
    expect(rows[0].external_id).toBe(newKey);
    expect(rows[0].description).toBe('updated on re-pull');
  });

  test('Codex P2 (2026-09-27): when BOTH the legacy and new-key rows already exist (rolling deploy), the legacy row is merged into the new-key row instead of surviving forever', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Both Keys Present Event';
    const url = 'https://test.invalid/both-keys-present-event/';
    const startIso = daysFromNowIso(32);
    const start = parseExtractedStartAt(startIso);
    const { externalId: newKey, legacyExternalId: legacyKey } = extractedEventDedupKeys(title, start, url);

    // Simulate the rolling-deploy race: a straggler pre-fix instance
    // re-inserted a legacy-shaped row AFTER an earlier pull already renamed
    // the original onto the new key shape — so both rows exist for the
    // identical identity.
    const [newKeyRow] = await db('events_raw').insert({
      source_id: sourceId,
      external_id: newKey,
      title,
      description: 'the current, new-key-shaped row',
      start_at: start,
      event_url: url,
    }).returning(['id']);
    const [legacyRow] = await db('events_raw').insert({
      source_id: sourceId,
      external_id: legacyKey,
      title,
      description: 'a straggler re-inserted under the legacy key shape',
      start_at: start,
      event_url: url,
      times_featured: 1, // history that must survive the merge, not be deleted
    }).returning(['id']);
    const newKeyId = newKeyRow.id || newKeyRow;
    const legacyId = legacyRow.id || legacyRow;

    const { upserted, dropped } = await upsertExtractedEvents(source, [
      { title, startAt: startIso, eventUrl: url, description: 'updated on re-pull' },
    ]);
    expect(upserted).toBe(1);
    expect(dropped).toBe(0);

    const rows = await db('events_raw').where({ source_id: sourceId, title });
    expect(rows).toHaveLength(2); // BOTH rows preserved — nothing deleted
    const survivor = rows.find((r) => r.id === newKeyId);
    const retired = rows.find((r) => r.id === legacyId);
    expect(survivor).toBeTruthy();
    expect(retired).toBeTruthy();
    // The new-key row got this pull's fresh content.
    expect(survivor.description).toBe('updated on re-pull');
    // The legacy row is retired into it — same mechanism cross-source dedup
    // uses (event-dedup.js's mergeEvents): merged_into set, rejected, and
    // its own history (times_featured) left on the row rather than deleted.
    expect(retired.merged_into).toBe(newKeyId);
    expect(retired.admin_status).toBe('rejected');
    expect(retired.times_featured).toBe(1);

    // Idempotent: a second pull is a no-op on the already-merged legacy row.
    const second = await upsertExtractedEvents(source, [
      { title, startAt: startIso, eventUrl: url, description: 'second re-pull' },
    ]);
    expect(second.upserted).toBe(1);
    const rowsAfterSecond = await db('events_raw').where({ source_id: sourceId, title });
    expect(rowsAfterSecond).toHaveLength(2);
    expect(rowsAfterSecond.find((r) => r.id === legacyId).merged_into).toBe(newKeyId);
  });

  test('retiring the legacy row carries its backfilled image onto the surviving row', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Legacy Row Holds The Image Event';
    const url = 'https://test.invalid/legacy-row-holds-image-event/';
    const image = 'https://test.invalid/legacy-row-holds-image.jpg';
    const startIso = daysFromNowIso(34);
    const start = parseExtractedStartAt(startIso);
    const { externalId: newKey, legacyExternalId: legacyKey } = extractedEventDedupKeys(title, start, url);

    const [newKeyRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: newKey, title, start_at: start, event_url: url, admin_status: 'approved',
    }).returning(['id']);
    const [legacyRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: legacyKey, title, start_at: start, event_url: url, admin_status: 'pending',
      image_url: image,
    }).returning(['id']);
    const newKeyId = newKeyRow.id || newKeyRow;
    const legacyId = legacyRow.id || legacyRow;

    await upsertExtractedEvents(source, [{ title, startAt: startIso, eventUrl: url, description: 'no image on this pull' }]);

    const survivor = await db('events_raw').where({ id: newKeyId }).first();
    const retired = await db('events_raw').where({ id: legacyId }).first();
    expect(retired.merged_into).toBe(newKeyId);
    expect(survivor.merged_into).toBeNull();
    expect(survivor.admin_status).toBe('approved');
    expect(survivor.image_url).toBe(image);
  });

  test('when the legacy row carries the stronger editorial decision, it survives and takes over the new key', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Approved Legacy Row Event';
    const url = 'https://test.invalid/approved-legacy-row-event/';
    const startIso = daysFromNowIso(33);
    const start = parseExtractedStartAt(startIso);
    const { externalId: newKey, legacyExternalId: legacyKey } = extractedEventDedupKeys(title, start, url);

    const [newKeyRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: newKey, title, start_at: start, event_url: url, admin_status: 'pending',
    }).returning(['id']);
    const [legacyRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: legacyKey, title, start_at: start, event_url: url, admin_status: 'approved',
    }).returning(['id']);
    const newKeyId = newKeyRow.id || newKeyRow;
    const legacyId = legacyRow.id || legacyRow;

    await upsertExtractedEvents(source, [
      { title, startAt: startIso, eventUrl: url, description: 'updated on re-pull' },
    ]);

    const rows = await db('events_raw').where({ source_id: sourceId, title });
    const survivor = rows.find((r) => r.id === legacyId);
    const retired = rows.find((r) => r.id === newKeyId);
    expect(survivor.admin_status).toBe('approved');
    expect(survivor.merged_into).toBeNull();
    expect(survivor.external_id).toBe(newKey);
    expect(survivor.description).toBe('updated on re-pull');
    expect(retired.merged_into).toBe(legacyId);
    expect(retired.external_id).toBe(`retired:${newKeyId}`);
  });

  test('a live legacy row follows an already-merged new-key row to its survivor, and the pull continues', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Merged New Key Event';
    const url = 'https://test.invalid/merged-new-key-event/';
    const startIso = daysFromNowIso(34);
    const start = parseExtractedStartAt(startIso);
    const { externalId: newKey, legacyExternalId: legacyKey } = extractedEventDedupKeys(title, start, url);

    const [survivorRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: `other-feed-${Date.now()}`, title, start_at: start, event_url: url,
    }).returning(['id']);
    const survivorId = survivorRow.id || survivorRow;
    await db('events_raw').insert({
      source_id: sourceId, external_id: newKey, title, start_at: start, event_url: url,
      merged_into: survivorId, admin_status: 'rejected',
    });
    const [legacyRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: legacyKey, title, start_at: start, event_url: url,
    }).returning(['id']);
    const legacyId = legacyRow.id || legacyRow;

    const otherTitle = 'TEST Second Event In Same Pull';
    const { upserted } = await upsertExtractedEvents(source, [
      { title, startAt: startIso, eventUrl: url },
      { title: otherTitle, startAt: daysFromNowIso(35), eventUrl: 'https://test.invalid/second-event/' },
    ]);
    expect(upserted).toBe(2);
    const legacy = await db('events_raw').where({ id: legacyId }).first();
    expect(legacy.merged_into).toBe(survivorId);
    expect(await db('events_raw').where({ source_id: sourceId, title: otherTitle })).toHaveLength(1);
  });

  test('a legacy row follows a two-hop merge chain to the final survivor', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Two Hop Merge Chain';
    const url = 'https://test.invalid/two-hop-merge-chain/';
    const startIso = daysFromNowIso(38);
    const start = parseExtractedStartAt(startIso);
    const { externalId: newKey, legacyExternalId: legacyKey } = extractedEventDedupKeys(title, start, url);

    const [finalRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: `final-${Date.now()}`, title, start_at: start, event_url: url,
    }).returning(['id']);
    const finalId = finalRow.id || finalRow;
    const [middleRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: `middle-${Date.now()}`, title, start_at: start, event_url: url,
      merged_into: finalId, admin_status: 'rejected',
    }).returning(['id']);
    const middleId = middleRow.id || middleRow;
    await db('events_raw').insert({
      source_id: sourceId, external_id: newKey, title, start_at: start, event_url: url,
      merged_into: middleId, admin_status: 'rejected',
    });
    const [legacyRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: legacyKey, title, start_at: start, event_url: url,
    }).returning(['id']);
    const legacyId = legacyRow.id || legacyRow;

    await upsertExtractedEvents(source, [{ title, startAt: startIso, eventUrl: url }]);

    const legacy = await db('events_raw').where({ id: legacyId }).first();
    expect(legacy.merged_into).toBe(finalId);
  });

  test('an approved matinee whose correct key equals the evening show\'s shifted key is never touched, even when only the evening is pulled', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Matinee And Evening';
    const url = 'https://test.invalid/matinee-and-evening/';
    // Evening at 23:00Z; its timezone-dropped key embeds the ET wall clock as
    // UTC, which is exactly the matinee's correct instant on the same day.
    const eveningIso = daysFromNowIso(39, 23);
    const evening = parseExtractedStartAt(eveningIso);
    // The pre-fix bug would have stored the evening at its ET wall clock read
    // as UTC — which is exactly this matinee's correct instant.
    const shifted = evening.toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T');
    const matineeIso = `${shifted}Z`;
    const matinee = parseExtractedStartAt(matineeIso);
    const { legacyExternalId: matineeLegacyKey } = extractedEventDedupKeys(title, matinee, url);

    // Pulled days ago, so the pull below does not refresh it.
    const [matineeRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: matineeLegacyKey, title, start_at: matinee, event_url: url,
      admin_status: 'approved', pulled_at: new Date(Date.now() - 2 * 24 * 3600 * 1000),
    }).returning(['id']);
    const matineeId = matineeRow.id || matineeRow;

    // Even when a pull returns only the evening show (a capped or partial
    // extraction), the matinee row must not be matched, moved or rejected.
    await upsertExtractedEvents(source, [
      { title, startAt: eveningIso, eventUrl: url },
    ]);

    const live = await db('events_raw').where({ source_id: sourceId, title }).whereNull('merged_into');
    expect(live).toHaveLength(2);
    const kept = live.find((r) => r.id === matineeId);
    expect(kept.external_id).toBe(matineeLegacyKey);
    expect(kept.admin_status).toBe('approved');
    expect(kept.approved_via).toBeNull();
    expect(new Date(kept.start_at).toISOString()).toBe(matinee.toISOString());
  });

  test('when the live survivor is the legacy row, the current key moves onto it', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Legacy Row Survives Dedup';
    const url = 'https://test.invalid/legacy-row-survives/';
    const startIso = daysFromNowIso(40);
    const start = parseExtractedStartAt(startIso);
    const { externalId: newKey, legacyExternalId: legacyKey } = extractedEventDedupKeys(title, start, url);

    const [legacyRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: legacyKey, title, start_at: start, event_url: url,
    }).returning(['id']);
    const legacyId = legacyRow.id || legacyRow;
    const [deadRow] = await db('events_raw').insert({
      source_id: sourceId, external_id: newKey, title, start_at: start, event_url: url,
      merged_into: legacyId, admin_status: 'rejected',
    }).returning(['id']);
    const deadId = deadRow.id || deadRow;

    await upsertExtractedEvents(source, [{ title, startAt: startIso, eventUrl: url, description: 'fresh copy' }]);

    const legacy = await db('events_raw').where({ id: legacyId }).first();
    const dead = await db('events_raw').where({ id: deadId }).first();
    expect(legacy.external_id).toBe(newKey);
    expect(legacy.description).toBe('fresh copy');
    expect(dead.external_id).toBe(`retired:${deadId}`);
  });

  test('a pre-fix row stored at the shifted time is quarantined (rejected with a reason), not moved or deleted', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Shifted Pre Fix Row';
    const url = 'https://test.invalid/shifted-pre-fix-row/';
    const startIso = daysFromNowIso(41, 23);
    const start = parseExtractedStartAt(startIso);
    const shifted = start.toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T');
    const shiftedIso = `${shifted.slice(0, 16)}:00.000Z`;
    const shiftedKey = `${title.toLowerCase()}|${shiftedIso}|${url}`;
    const [stale] = await db('events_raw').insert({
      source_id: sourceId, external_id: shiftedKey, title, start_at: new Date(shiftedIso), event_url: url,
      admin_status: 'pending', freshness_status: 'needs_review', normalized_at: null,
      pulled_at: new Date(Date.now() - 2 * 24 * 3600 * 1000),
    }).returning(['id']);
    const staleId = stale.id || stale;

    await upsertExtractedEvents(source, [{ title, startAt: startIso, eventUrl: url }]);

    const old = await db('events_raw').where({ id: staleId }).first();
    // Durable even for an unnormalized row: rejection survives normalization.
    expect(old.admin_status).toBe('rejected');
    expect(old.suppression_reason).toMatch(/time-shifted duplicate/);

    // The operator decides it is a real showtime and re-approves it; the next
    // pull (still listing only the evening) must not reject it again, nor
    // after the operator later returns it to pending.
    await db('events_raw').where({ id: staleId }).update({ admin_status: 'approved', suppression_reason: null });
    await upsertExtractedEvents(source, [{ title, startAt: startIso, eventUrl: url }]);
    const kept = await db('events_raw').where({ id: staleId }).first();
    expect(kept.admin_status).toBe('approved');
    await db('events_raw').where({ id: staleId }).update({ admin_status: 'pending', pulled_at: new Date(Date.now() - 2 * 24 * 3600 * 1000) });
    await upsertExtractedEvents(source, [{ title, startAt: startIso, eventUrl: url }]);
    expect((await db('events_raw').where({ id: staleId }).first()).admin_status).toBe('pending');
    expect(new Date(old.start_at).toISOString()).toBe(shiftedIso);
    const fresh = await db('events_raw').where({ source_id: sourceId, title }).whereNot({ id: staleId });
    expect(fresh).toHaveLength(1);
    expect(new Date(fresh[0].start_at).toISOString()).toBe(start.toISOString());
  });

  test.each([
    ['whole seconds', ':00:45.000Z', 42],
    ['fractional seconds', ':00:45.123Z', 43],
  ])('a pre-fix row whose time carried %s is quarantined too', async (label, suffix, days) => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = `TEST Shifted Pre Fix Row With ${label}`;
    const url = `https://test.invalid/shifted-pre-fix-row-${days}/`;
    const startIso = daysFromNowIso(days, 23).replace(':00:00.000Z', suffix);
    const start = parseExtractedStartAt(startIso);
    const shifted = start.toLocaleString('sv-SE', { timeZone: 'America/New_York' }).replace(' ', 'T');
    const shiftedIso = `${shifted}${suffix.slice(6)}`; // the old parser kept seconds and milliseconds
    expect(shiftedIso.endsWith(suffix.slice(3))).toBe(true);
    const [stale] = await db('events_raw').insert({
      source_id: sourceId, external_id: `${title.toLowerCase()}|${shiftedIso}|${url}`, title,
      start_at: new Date(shiftedIso), event_url: url, admin_status: 'pending',
      pulled_at: new Date(Date.now() - 2 * 24 * 3600 * 1000),
    }).returning(['id']);
    const staleId = stale.id || stale;

    await upsertExtractedEvents(source, [{ title, startAt: startIso, eventUrl: url }]);

    const old = await db('events_raw').where({ id: staleId }).first();
    expect(old.admin_status).toBe('rejected');
    expect(old.approved_via).toBe('tz_shift_quarantine');
  });

  test('with no legacy row present, a fresh pull inserts once under the new key', async () => {
    const source = { id: sourceId, coverage_geo: [] };
    const title = 'TEST Fresh Pull Event';
    const url = 'https://test.invalid/fresh-pull-event/';
    const startAt = daysFromNowIso(31, 13);

    const first = await upsertExtractedEvents(source, [
      { title, startAt, eventUrl: url },
    ]);
    expect(first.upserted).toBe(1);

    const second = await upsertExtractedEvents(source, [
      { title, startAt, eventUrl: url },
    ]);
    expect(second.upserted).toBe(1);

    const rows = await db('events_raw').where({ source_id: sourceId, title });
    expect(rows).toHaveLength(1);
  });
});

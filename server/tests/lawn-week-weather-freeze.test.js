// Freezing the week's weather onto the record (owner ruling 2026-08-03).
//
// Keying the weather fetch to the service date already made a report stable
// across renders — but only while the ANSWER for that date stayed the same.
// Flipping GATE_RAIN_MRMS changed the provider underneath and issued reports
// silently restated their rainfall: a live token went 1.15" to 3.23" for a
// visit days earlier. A report token is a permanent, shareable customer
// document, so the first successful render freezes the week and every later
// render replays it.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const { freezeLawnWeekWeather } = require('../services/service-report/report-data');

const WEEK = {
  rainInches: 3.23,
  et0Inches: 1.4,
  dailyRain: [{ date: '2026-07-30', inches: 1.1 }],
  rainConfidence: 'high',
  rainSource: 'mrms',
  frozenAt: '2026-08-03T04:00:00.000Z',
};

// knex stub capturing the UPDATE and its predicate. `stored` is what a
// read-back finds when this writer LOSES the conditional update.
function makeKnex({ matched = 1, stored = null } = {}) {
  const state = { wheres: [], raws: [], patches: [], reads: 0 };
  const knex = jest.fn((table) => {
    expect(table).toBe('service_records');
    const chain = {
      where: jest.fn((c) => { state.wheres.push(c); return chain; }),
      whereRaw: jest.fn((sql) => { state.raws.push(sql); return chain; }),
      update: jest.fn(async (patch) => { state.patches.push(patch); return matched; }),
      first: jest.fn(async () => {
        state.reads += 1;
        return stored ? { structured_notes: { lawnWeekWeather: stored } } : { structured_notes: {} };
      }),
    };
    return chain;
  });
  knex.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return { knex, state };
}

describe('freezeLawnWeekWeather', () => {
  test('writes the week under lawnWeekWeather via an ATOMIC jsonb merge', async () => {
    const { knex, state } = makeKnex();
    // Winning returns OUR week — the value the record is now frozen to.
    await expect(freezeLawnWeekWeather('svc-1', WEEK, knex)).resolves.toEqual(WEEK);

    expect(state.wheres[0]).toEqual({ id: 'svc-1' });
    const patch = state.patches[0];
    // Never a whole-column rewrite: structured_notes also carries completion SMS
    // state and the frozen lawn synthesis, and a read-modify-write here would
    // clobber a concurrent write to those.
    expect(patch.structured_notes.__raw).toContain('||');
    expect(patch.structured_notes.__raw).toContain('jsonb');
    expect(JSON.parse(patch.structured_notes.bindings[0])).toEqual({ lawnWeekWeather: WEEK });
  });

  // The race this closes: a live view and a PDF render can render the same
  // record concurrently and — mid provider-flip — resolve DIFFERENT weeks. A
  // read-then-write would let the later one overwrite what the customer was
  // already shown.
  test('FIRST WRITER WINS — the guard is in the UPDATE predicate, not a prior read', async () => {
    const { knex, state } = makeKnex();
    await freezeLawnWeekWeather('svc-1', WEEK, knex);

    expect(state.raws).toHaveLength(1);
    expect(state.raws[0]).toMatch(/lawnWeekWeather/);
    expect(state.raws[0]).toMatch(/IS NULL/i);
    // No SELECT preceded it — the predicate IS the guard.
    expect(state.wheres).toHaveLength(1);
  });

  // THE race this exists to close, appearing inside the mechanism itself: a
  // live view and a PDF render resolve DIFFERENT weeks mid provider-flip. The
  // loser must adopt the winner's value, not carry on with its own — otherwise
  // two different versions of a supposedly permanent report go out.
  test('LOSING the race returns the WINNER\'s week, not ours', async () => {
    const WINNER = { ...WEEK, rainInches: 1.15, rainSource: 'open_meteo' };
    const { knex, state } = makeKnex({ matched: 0, stored: WINNER });

    const canonical = await freezeLawnWeekWeather('svc-1', WEEK, knex);

    expect(canonical).toEqual(WINNER);
    expect(canonical.rainInches).not.toBe(WEEK.rainInches);
    expect(state.reads).toBe(1); // read back only after losing
  });

  test('losing with nothing readable yields null rather than a wrong week', async () => {
    const { knex } = makeKnex({ matched: 0, stored: null });
    await expect(freezeLawnWeekWeather('svc-1', WEEK, knex)).resolves.toBeNull();
  });

  // A failed freeze must never fail a report view; the next render retries.
  test('a write error is swallowed and reported, not thrown', async () => {
    const knex = jest.fn(() => ({
      where: () => ({ whereRaw: () => ({ update: async () => { throw new Error('deadlock'); } }) }),
    }));
    knex.raw = jest.fn(() => ({}));
    await expect(freezeLawnWeekWeather('svc-1', WEEK, knex)).resolves.toBeNull();
    expect(require('../services/logger').warn).toHaveBeenCalled();
  });

  test('nothing to freeze is a no-op', async () => {
    const { knex, state } = makeKnex();
    await expect(freezeLawnWeekWeather(null, WEEK, knex)).resolves.toBeNull();
    await expect(freezeLawnWeekWeather('svc-1', null, knex)).resolves.toBeNull();
    expect(state.patches).toHaveLength(0);
  });
});

describe('freeze contract in the render path', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../services/service-report/report-data.js'), 'utf8');

  test('a frozen week SHORT-CIRCUITS the live weather fetch', () => {
    // If the fetch still ran, the report would keep drifting with the provider
    // and the freeze would be decorative.
    expect(source).toMatch(/frozenWeekWeather[\s\S]{0,1200}?fetchServiceWeekWeather/);
    expect(source).toMatch(/const frozenWeekWeather = parseJsonObject\(service\.structured_notes\)\.lawnWeekWeather/);
  });

  test('the render ADOPTS the canonical week, winner or loser', () => {
    // Ignoring the return value would let a losing render publish its own
    // numbers — a second version of a permanent report.
    expect(source).toMatch(/const canonicalWeek = await freezeLawnWeekWeather\(/);
    expect(source).toMatch(/if \(canonicalWeek\) \{[\s\S]{0,600}?completionRainfall7dInches = canonicalWeek\.rainInches/);
  });

  // A PDF cached BEFORE the freeze keeps its pre-freeze rainfall forever, while
  // /data freezes and shows a different number — the emailed attachment and the
  // live report disagreeing, which is the failure class this lane exists to
  // close. The strategy marker in the storage key forces one fresh render.
  test('the render-strategy marker was BUMPED so pre-freeze PDFs regenerate', () => {
    const { LAWN_RENDER_STRATEGY } = require('../services/service-report/report-data');
    // p1 shipped with #3174 (canonical pinning). The freeze changes render
    // output again, so it must not reuse p1's keys.
    expect(LAWN_RENDER_STRATEGY).not.toBe('p1');
    expect(source).toMatch(/LAWN_RENDER_STRATEGY = 'p2'/);
  });

  test('a pre-freeze cached key cannot collide with a post-freeze one', async () => {
    const { resolveCanonicalLawnRender } = require('../services/service-report/report-data');
    const knex = (table) => {
      expect(table).toBe('lawn_assessments');
      const chain = {
        where: () => chain, orderBy: () => chain,
        first: async () => ({ id: 'assess-A', customer_id: 'c1', confirmed_by_tech: true, service_record_id: 'svc-1' }),
      };
      return chain;
    };
    const { signature } = await resolveCanonicalLawnRender(
      { id: 'svc-1', customer_id: 'c1', service_line: 'lawn' }, knex,
    );
    // Every pre-freeze lawn key carried -lap1…; none can match -lap2….
    expect(signature.startsWith('-lap2')).toBe(true);
    expect(signature.startsWith('-lap1')).toBe(false);
  });

  // Fail-closed on CACHING, fail-soft on VIEWING. An unresolved freeze still
  // renders — a customer should see their report — but a durably cached copy
  // would keep those numbers forever while a later view freezes different
  // provider data, and no future PDF request would retry.
  test('an UNFROZEN render is served but never cached — both PDF paths', () => {
    const pdfQueue = fs.readFileSync(path.join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
    const reportsPublic = fs.readFileSync(path.join(__dirname, '../routes/reports-public.js'), 'utf8');
    for (const src of [pdfQueue, reportsPublic]) {
      expect(src).toMatch(/weekWeatherUncacheable/);
    }
    // pdf-queue returns the bytes with no key rather than storing.
    expect(pdfQueue).toMatch(/weekWeatherUncacheable[\s\S]{0,900}?uncached: true/);
    // reports-public branches AROUND the putReportPdf call.
    expect(reportsPublic).toMatch(/weekWeatherUncacheable[\s\S]{0,400}?\} else if/);
  });

  // The worst case: an emailed attachment is the one copy that can never be
  // corrected. The delivery branch returns EARLY, so the cache guard alone
  // never sees it — the check has to come first.
  test('a DELIVERY render fails retryably when the week could not be frozen', () => {
    const pdfQueue = fs.readFileSync(path.join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
    // Ordering is the whole point: the unfrozen check must precede the
    // delivery-pin early return, or emailed PDFs bypass it.
    const guardAt = pdfQueue.indexOf('weekWeatherUnfrozen && isDeliveryPin');
    const deliveryReturnAt = pdfQueue.indexOf('if (isDeliveryPin) {');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(deliveryReturnAt);
    // Retryable so email-delivery DEFERS rather than dropping the send.
    expect(pdfQueue).toMatch(/lawn_week_weather_unfrozen[\s\S]{0,200}?retryable = true/);
  });

  // An uncached render is not a completed job: the job exists to populate the
  // cache, so marking it succeeded would retire it with nothing stored and no
  // retry — the condition that made it unstorable never gets another attempt.
  // An open window is the one uncacheable condition that RETRYING cannot fix:
  // the ladder runs out in about half an hour, hours before the ET day ends. A
  // failed job there is retired before it can ever perform the freeze it exists
  // for, and pages someone about a terminal failure that was really "not yet".
  test('an OPEN-WINDOW job waits for ET midnight instead of burning retries', () => {
    const pdfQueue = fs.readFileSync(path.join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
    expect(pdfQueue).toMatch(/uncachedReason: reason,/);
    expect(pdfQueue).toMatch(/weekWeatherPendingReason \|\| 'unfrozen'/);
    // Deferred, not failed — and the branch precedes the failure path.
    const deferAt = pdfQueue.indexOf("result.uncachedReason && result.uncachedReason !== 'unfrozen'");
    const failAt = pdfQueue.indexOf('pdf_render_uncacheable');
    expect(deferAt).toBeGreaterThan(-1);
    expect(deferAt).toBeLessThan(failAt);
    expect(pdfQueue).toMatch(/deferPdfRenderJob\(job, until,/);
    // The claim's attempt is handed back, so a deferral cannot exhaust the job.
    expect(pdfQueue).toMatch(/attempts: Math\.max\(0, Number\(job\.attempts \|\| 1\) - 1\)/);
    // And it never touches failed_at / the terminal alert.
    const defer = pdfQueue.slice(pdfQueue.indexOf('async function deferPdfRenderJob'), pdfQueue.indexOf('async function markPdfRenderJobFailed'));
    expect(defer).not.toMatch(/failed_at|emitPdfRenderTerminalFailure|alertServiceReportPdfFailed/);
  });

  test('the deferral target survives BOTH DST boundaries', () => {
    const { nextEtMidnight } = require('../services/service-report/application-conditions');
    const et = (d) => d.toLocaleString('en-CA', { timeZone: 'America/New_York' });
    // Spring forward (23-hour ET day) and fall back (25-hour ET day) — the
    // cases fixed -4/-5 offset arithmetic lands an hour wrong on.
    for (const iso of ['2027-03-13T20:00:00Z', '2026-11-01T02:00:00Z']) {
      const next = nextEtMidnight(new Date(iso));
      // Lands in the NEXT ET calendar day, just past midnight.
      expect(et(next)).toMatch(/12:0\d:\d\d a\.m\./);
      expect(next.getTime()).toBeGreaterThan(new Date(iso).getTime());
      expect(next.getTime() - new Date(iso).getTime()).toBeLessThan(26 * 60 * 60 * 1000);
    }
  });

  test('an UNCACHED render is not treated as a successful store', () => {
    const pdfQueue = fs.readFileSync(path.join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
    // The render JOB retries instead of succeeding.
    expect(pdfQueue).toMatch(/if \(result\?\.uncached\)[\s\S]{0,1400}?markPdfRenderJobFailed/);
    // The correction marker is RETAINED — nothing was stored, so the canonical
    // cached PDF is still whatever it was.
    expect(pdfQueue).toMatch(/correctionPending && !rendered\.storageFailed && !rendered\.pinned && !rendered\.uncached/);
    // And the state is propagated so callers can tell "no key by design" from
    // "no key because storage failed".
    expect(pdfQueue).toMatch(/uncached: !!rendered\.uncached/);
  });

  // The two suppressions are NOT the same thing, and conflating them breaks a
  // different customer each way: gate delivery on an open window and nearly
  // every same-day lawn email stops; gate caching on failure alone and a blank
  // or partial PDF is served forever under a key a later freeze still matches.
  test('DELIVERY blocks only on failure; CACHING blocks on the superset', () => {
    const pdfQueue = fs.readFileSync(path.join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
    expect(pdfQueue).toMatch(/weekWeatherUnfrozen && isDeliveryPin/);
    // The delivery guard must NOT see the open-window state.
    expect(pdfQueue).not.toMatch(/weekWeatherUncacheable && isDeliveryPin/);
    expect(source).toMatch(/weekWeatherUncacheable: weekWeatherUnfrozen \|\| !!weekWeatherPendingReason/);
  });

  // Freezing on the service day pins a FORECAST. The same-day read is
  // deliberately short-lived (30-minute cache, full-day forecast for the
  // remainder) so afternoon convection still lands; persisting it makes the
  // permanent record of the week a guess about hours that had not happened.
  // This is also what completion-time synthesis hits — it runs on the service
  // day, through the same builder.
  test('an OPEN window is never frozen, and is not treated as a failure', () => {
    expect(source).toMatch(/if \(!weekWeather\.windowClosed\) \{[\s\S]{0,1200}?weekWeatherPendingReason = 'open_window';/);
    // The freeze sits in the else-branch, so it cannot run on an open window.
    expect(source).toMatch(/weekWeatherPendingReason = 'open_window';[\s\S]{0,200}?\} else if \(completionRainfall7dInches != null\) \{\s*\n\s*const canonicalWeek = await freezeLawnWeekWeather\(/);
  });

  // The trap in the previous round's own fix: recomputing closure on the cached
  // path meant an entry written at 11:50pm with partial days and a forecast tail
  // was served after midnight labelled SETTLED — and frozen permanently. Rolling
  // over the ET day does not turn a forecast into an observation.
  test('a cache entry written on an OPEN window is never promoted to closed', () => {
    const conditions = fs.readFileSync(path.join(__dirname, '../services/service-report/application-conditions.js'), 'utf8');
    // The entry records the state it was written under…
    expect(conditions).toMatch(/_rainCache\.set\(key, \{ at: Date\.now\(\), ttlMs: effectiveTtlMs, value, windowClosed \}\)/);
    // …and open→closed invalidates rather than relabels.
    expect(conditions).toMatch(/if \(cacheFresh && !\(windowClosed && cached\.windowClosed === false\)\)/);
    expect(conditions).toMatch(/windowClosed: cached\.windowClosed \?\? windowClosed/);
    // The discarded approach must not come back.
    expect(conditions).not.toMatch(/return \{ \.\.\.cached\.value, windowClosed \}/);
  });

  // Number(null), Number(undefined) and Number('') are all 0, so an ungeocoded
  // property read as a perfectly valid coordinate at the equator — and the week
  // fetched for the Gulf of Guinea would now be FROZEN onto the record.
  test('missing coordinates never coerce to 0,0', () => {
    const { toCoordinate } = require('../services/service-report/application-conditions');
    for (const empty of [null, undefined, '', 'abc', NaN]) expect(toCoordinate(empty)).toBeNull();
    // A literal 0 from the database still parses — it is rejected as a PAIR.
    expect(toCoordinate(0)).toBe(0);
    expect(toCoordinate('27.4989')).toBeCloseTo(27.4989);
    const conditions = fs.readFileSync(path.join(__dirname, '../services/service-report/application-conditions.js'), 'utf8');
    expect(conditions).toMatch(/lat == null \|\| lon == null \|\| !range \|\| \(lat === 0 && lon === 0\)/);
    // report-data classifies with the same rule, or its "settled blank" and
    // "transient failure" branches split on a different definition than the
    // fetch actually used.
    expect(source).toMatch(/const hasCoordinates = latN != null && lonN != null && !\(latN === 0 && lonN === 0\)/);
    expect(source).not.toMatch(/Number\.isFinite\(Number\(latitude\)\)/);
  });

  test('the fetch reports whether the window has SETTLED, on every path', () => {
    const conditions = fs.readFileSync(path.join(__dirname, '../services/service-report/application-conditions.js'), 'utf8');
    expect(conditions).toMatch(/const windowClosed = !!range && range\.end < etTodayYmd\(\)/);
    // Early return (no coordinates / no range) carries it too.
    expect(conditions).toMatch(/return \{ \.\.\.empty, windowClosed \}/);
    expect(conditions).toMatch(/return \{ \.\.\.value, windowClosed \}/);
  });

  // "No geocode" is NOT a settled answer: the hourly backstop sweep retries
  // coordinate-less customers and writes their coordinates later, after which
  // /data freezes a real week. The PDF key encodes neither coordinates nor
  // freeze state, so a blank PDF cached now would keep being downloaded long
  // after the live report showed real rainfall.
  test('a blank week with NO COORDINATES is PENDING — uncacheable, still deliverable', () => {
    expect(source).toMatch(/const hasCoordinates = latN != null && lonN != null/);
    expect(source).toMatch(/\} else if \(!hasCoordinates\) \{[\s\S]{0,900}?weekWeatherPendingReason = 'no_coordinates';/);
    // Pending, never unfrozen — an address that never geocodes must not hold
    // the report email forever.
    expect(source).not.toMatch(/!hasCoordinates\) \{[\s\S]{0,900}?weekWeatherUnfrozen = true;/);
  });

  // Every pending reason waits; only a real failure spends the ladder.
  test('the queue defers on ANY pending reason, not just an open window', () => {
    const pdfQueue = fs.readFileSync(path.join(__dirname, '../services/service-report/pdf-queue.js'), 'utf8');
    expect(pdfQueue).toMatch(/result\.uncachedReason && result\.uncachedReason !== 'unfrozen'/);
    // A new pending reason must not need a matching queue change to be honoured.
    expect(pdfQueue).not.toMatch(/uncachedReason === 'open_window'/);
  });

  test('a closed window we tried and FAILED to resolve is uncacheable', () => {
    // Persisting the null would lock in "no rainfall known" forever; caching it
    // would serve the empty water card after a later view froze the real week.
    expect(source).toMatch(/\} catch \(e\) \{[\s\S]{0,300}?weekWeatherUnfrozen = true;/);
    expect(source).toMatch(/let weekWeatherUnfrozen = false;/);
    expect(source).toMatch(/let weekWeatherPendingReason = null;/);
  });

  test('only a RESOLVED week is frozen', () => {
    expect(source).toMatch(/\} else if \(completionRainfall7dInches != null\) \{\s*\n\s*const canonicalWeek = await freezeLawnWeekWeather\(/);
  });

  // Both renders claim to use the frozen snapshot, so they must hold the SAME
  // snapshot — nulls included. A `??` fallback on a field the winner left null
  // (MRMS supplied rain, an Open-Meteo outage left ET₀ null) lets the loser keep
  // its own ET₀ and render a different watering target from the same week.
  test('the winner\'s snapshot is copied EXACTLY, nulls included', () => {
    expect(source).toMatch(/completionEt0Inches = canonicalWeek\.et0Inches \?\? null;/);
    expect(source).toMatch(/completionRainConfidence = canonicalWeek\.rainConfidence \?\? null;/);
    expect(source).toMatch(/completionRainSource = canonicalWeek\.rainSource \?\? null;/);
    expect(source).toMatch(/completionDailyRain = Array\.isArray\(canonicalWeek\.dailyRain\) \? canonicalWeek\.dailyRain : null;/);
    // No field may fall back to this render's independently fetched value.
    expect(source).not.toMatch(/canonicalWeek\.\w+ \?\? completion/);
  });
});

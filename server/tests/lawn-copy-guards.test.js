// Lawn copy guards (lawn report rebuild P11). Pure checks for model-written
// lawn copy; nothing is wired into a live path yet (P14). The accept/reject
// strings come from the rebuild scope appendix: fable-plan-review.md (guards
// G1-G10 and the W1 hand-off) and W5-plan.json (tests[2], tests[3]).
// Synthetic text only.

const { execFileSync } = require('child_process');
const path = require('path');

const guards = require('../services/service-report/lawn-copy-guards');
const { WATERING_WORDS } = require('../services/service-report/lawn-report-lead');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');

const {
  checkLawnModelCopy,
  checkNumericWhitelist,
  checkWaterMowDeny,
  checkWeekdayClockDeny,
  checkProgressCoupling,
  checkReentryPattern,
  checkBannedCopy,
  checkOverpromise,
  checkBannerCopy,
  KEEP_OFF_REJECT,
  BANNER_COPY_ACCEPT,
} = guards;

const rules = (result) => result.reasons.map((r) => r.rule);
const rejects = (text, rule, facts) => {
  const result = checkLawnModelCopy(text, facts);
  expect(result.ok).toBe(false);
  expect(rules(result)).toContain(rule);
};
const accepts = (text, facts) => {
  const result = checkLawnModelCopy(text, facts);
  expect(result.reasons).toEqual([]);
  expect(result.ok).toBe(true);
};

const ROW = { allowedText: ['Most turf shows a response in 3 to 7 days.'] };

describe('module purity', () => {
  test('requiring it does not load models/db.js', () => {
    const script = `
      require(${JSON.stringify(path.join(__dirname, '../services/service-report/lawn-copy-guards'))});
      const loaded = Object.keys(require.cache).filter((k) => /[\\\\/]models[\\\\/]db\\.js$/.test(k));
      process.stdout.write(JSON.stringify(loaded));
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual([]);
  });

  test('exports the entry point and every individual check', () => {
    ['checkLawnModelCopy', 'checkNumericWhitelist', 'checkWaterMowDeny', 'checkWeekdayClockDeny',
      'checkProgressCoupling', 'checkReentryPattern', 'checkBannedCopy', 'checkOverpromise'].forEach((name) => {
      expect(typeof guards[name]).toBe('function');
    });
  });

  test('empty or non-string copy is not ok', () => {
    [undefined, null, '', '   ', 42].forEach((v) => {
      expect(checkLawnModelCopy(v, ROW)).toEqual({ ok: false, reasons: [{ rule: 'empty', match: '' }] });
    });
  });

  test('clean prose with no numbers passes', () => {
    accepts('Your turf looks even, with a few thin spots along the fence line that we will keep an eye on.', {});
  });
});

describe('numeric whitelist (G3)', () => {
  test('accepts "3 to 7 days" only when a row carries it', () => {
    accepts('Most turf shows a response in 3 to 7 days.', ROW);
    rejects('Most turf shows a response in 3 to 7 days.', 'numeric', {});
    rejects('Most turf shows a response in 3 to 7 days.', 'numeric', { allowedText: ['Turf responds in 2 to 4 weeks.'] });
  });

  test.each([
    ['10 days', 'Expect a change in 10 days.'],
    ['a couple of days', 'Expect a change in a couple of days.'],
    ['a few days', 'You may notice it in a few days.'],
    ['overnight', 'The color shift happens overnight.'],
    ['within a week', 'You should see it within a week.'],
  ])('rejects %s when no row carries it', (_, text) => {
    rejects(text, 'numeric', ROW);
  });

  test('a row that carries a vague phrase licenses that same phrase', () => {
    accepts('You may notice it in a few days.', { allowedText: ['Color can return in a few days.'] });
    rejects('You may notice it in a few weeks.', 'numeric', { allowedText: ['Color can return in a few days.'] });
  });

  test('ranges: en dash, hyphen and "to" are the same token', () => {
    ['3–7 days', '3-7 days', '3 to 7 days', '3 — 7 days'].forEach((r) => {
      accepts(`Expect a response in ${r}.`, ROW);
    });
  });

  test('no unit conversion and no range splitting', () => {
    rejects('Expect a response in 7 days.', 'numeric', ROW);
    rejects('Expect a response in 3 days.', 'numeric', ROW);
    rejects('Expect a response in 5 days.', 'numeric', ROW);
    rejects('Expect a response in 1 week.', 'numeric', { allowedText: ['Response in 7 days.'] });
  });

  test('spelled numbers next to a unit count the same as digits', () => {
    rejects('Expect a change in two weeks.', 'numeric', ROW);
    accepts('Expect a change in two weeks.', { allowedText: ['Turf responds in 2 weeks.'] });
    accepts('Expect a change in 2 weeks.', { allowedText: ['Turf responds in two weeks.'] });
    accepts('Expect a response in three to seven days.', ROW);
    rejects('Expect a response in twenty-four hours.', 'numeric', ROW);
  });

  // Pre-push audit regressions: the allowlist key is the WHOLE normalized
  // timing phrase (cadence + complete quantity + unit).
  describe('allowlist keys keep the whole timing phrase', () => {
    const allow = (row) => ({ allowedText: [row] });

    test('every distinct vague word is its own key', () => {
      const vague = ['several', 'a couple of', 'couple of', 'a few', 'few', 'a handful of', 'a number of'];
      vague.forEach((licensed) => {
        vague.forEach((used) => {
          const result = checkNumericWhitelist(`Expect a change in ${used} days.`, allow(`Color can return in ${licensed} days.`));
          expect(result.length).toBe(used === licensed ? 0 : 1);
        });
      });
    });

    test("'several days' does not license 'a couple of days' (and the reverse)", () => {
      rejects('Expect a change in a couple of days.', 'numeric', allow('Color can return in several days.'));
      rejects('Expect a change in several days.', 'numeric', allow('Color can return in a couple of days.'));
      accepts('Expect a change in several days.', allow('Color can return in several days.'));
    });

    test("'every other week' does not license 'every week' (and the reverse)", () => {
      rejects('We check every week.', 'numeric', allow('We check every other week.'));
      rejects('We check every other week.', 'numeric', allow('We check every week.'));
      rejects('We check each week.', 'numeric', allow('We check every week.'));
      accepts('We check every other week.', allow('We check every other week.'));
      accepts('We check every week.', allow('We check every week.'));
    });

    test('a cadence key is not a plain-quantity key', () => {
      rejects('Expect a change in 2 weeks.', 'numeric', allow('We check every 2 weeks.'));
      rejects('We check every 2 weeks.', 'numeric', allow('Expect a change in 2 weeks.'));
      accepts('We check every 2 weeks.', allow('We check every two weeks.'));
    });

    test("'two hundred days' is not licensed by 'one hundred days' (no suffix match)", () => {
      rejects('Expect a change in two hundred days.', 'numeric', allow('A change shows in one hundred days.'));
      rejects('Expect a change in 200 days.', 'numeric', allow('A change shows in one hundred days.'));
      accepts('Expect a change in two hundred days.', allow('A change shows in 200 days.'));
      accepts('Expect a change in 100 days.', allow('A change shows in one hundred days.'));
      accepts('Expect a change in a hundred days.', allow('A change shows in 100 days.'));
    });

    test("compound spelled numbers are read in full: 'twenty-one days' is 21, not 'one'", () => {
      rejects('Expect a change in twenty-one days.', 'numeric', allow('A change shows in 1 day.'));
      rejects('Expect a change in twenty-one days.', 'numeric', allow('A change shows in one day.'));
      rejects('Expect a change in twenty-one days.', 'numeric', allow('A change shows in 20 days.'));
      accepts('Expect a change in twenty-one days.', allow('A change shows in 21 days.'));
      accepts('Expect a change in twenty one days.', allow('A change shows in twenty-one days.'));
      accepts('Expect a change in one thousand two hundred and five days.', allow('A change shows in 1205 days.'));
      accepts('Expect a change in two dozen days.', allow('A change shows in 24 days.'));
    });

    test('a spelled quantity the parser cannot read in full is rejected, even when a row repeats it', () => {
      const unreadable = [
        'twenty twenty days',
        'one two days',
        'twenty hundred days',
        'a couple hundred days',
        'several hundred days',
        'one and a half hours',
        'one and half hours',
        'a three days',
        'two dozen and one days',
      ];
      unreadable.forEach((phrase) => {
        const sentence = `Expect a change in ${phrase}.`;
        const tokens = guards.extractNumericTokens(sentence);
        expect(tokens.some((t) => t.kind === 'unparsed')).toBe(true);
        rejects(sentence, 'numeric', {});
        // a row that repeats the same unreadable phrase still never licenses it
        rejects(sentence, 'numeric', { allowedText: [sentence] });
      });
    });

    test('the tail of a longer quantity is never matched on its own', () => {
      rejects('Expect a change in one and a half hours.', 'numeric', allow('Check again in a half hour.'));
      rejects('Expect a change in one and a half hours.', 'numeric', allow('Check again in half an hour.'));
      rejects('Expect a change in 3 hundred days.', 'numeric', allow('A change shows in 100 days.'));
    });

    test('digits and spelled numbers are the only values normalized together', () => {
      accepts('Expect a change in 3 to 7 days.', allow('A change shows in three to seven days.'));
      accepts('Expect a change in 3–7 days.', allow('A change shows in 3 - 7 days.'));
      accepts('Expect a change in HALF AN HOUR.', allow('A change shows in half an hour.'));
      rejects('Expect a change in 30 minutes.', 'numeric', allow('A change shows in half an hour.'));
    });
  });

  test('a bare spelled number with no unit is not checked', () => {
    accepts('Two spots near the fence look thin and one near the walk.', {});
  });

  test('article and cadence timing phrases need a row', () => {
    rejects('We will look again in a week.', 'numeric', {});
    rejects('It dries out every week.', 'numeric', { droughtFlagged: true });
    rejects('Check back next week.', 'numeric', {});
    rejects('Look for change over the next few days.', 'numeric', {});
    accepts('We will look again in a week.', { allowedText: ['Recheck in a week.'] });
  });

  test('"this week" and "last week" are not number claims', () => {
    accepts('The edges looked tidier this week than last week.', { progress: 'up' });
  });

  test('fractions and unit measures: ½ inch, 1/2 inch, half an inch', () => {
    rejects('Thatch is about ½ inch deep.', 'numeric', {});
    rejects('Thatch is about 1/2 inch deep.', 'numeric', {});
    rejects('Thatch is about half an inch deep.', 'numeric', {});
    accepts('Thatch is about ½ inch deep.', { allowedText: ['Thatch near 0.5 inch.'] });
    accepts('Thatch is about 1/2 inch deep.', { allowedText: ['Thatch near ½ inch.'] });
    accepts('Thatch is about half an inch deep.', { allowedText: ['Thatch near 0.5 inch.'] });
    accepts('Thatch is about 1½ inches deep.', { allowedText: ['Thatch near 1 1/2 inches.'] });
  });

  test('scores license bare numbers and percents, never durations', () => {
    const facts = { allowedNumbers: [72, 5] };
    accepts('Your overall score is 72, up 5 points.', facts);
    accepts('Your overall score is 72%.', facts);
    rejects('Your overall score is 73.', 'numeric', facts);
    rejects('Expect a response in 5 days.', 'numeric', facts);
    rejects('Expect a response in 7 days.', 'numeric', { allowedNumbers: [7] });
    accepts('Your overall score is 72.', { allowedNumbers: ['72'] });
  });

  test('a score written as a fraction splits into both numbers', () => {
    accepts('Your score is 72/100.', { allowedNumbers: [72, 100] });
    rejects('Your score is 72/100.', 'numeric', { allowedNumbers: [72] });
  });

  test('digits glued to words (H2O, v6, 3rd) are not read as claims', () => {
    expect(checkNumericWhitelist('The v6 writer used the 3rd read.', {})).toEqual([]);
  });

  test('degrees and percent need the allowlist', () => {
    rejects('Highs near 90° stress turf.', 'numeric', {});
    rejects('Highs near 90 degrees stress turf.', 'numeric', {});
    rejects('About 40% of the lawn looks thin.', 'numeric', {});
    accepts('About 40% of the lawn looks thin.', { allowedNumbers: [40] });
  });

  test('the allowlist, not the model, decides: nothing supplied rejects every figure', () => {
    expect(checkNumericWhitelist('3 days', {}).length).toBe(1);
    expect(checkNumericWhitelist('3 days', undefined).length).toBe(1);
  });
});

describe('water / rain / irrigation / mow deny (G7)', () => {
  test.each([
    'Water the lawn deeply this week.',
    'Run the sprinklers longer.',
    'Your irrigation zones need a check.',
    'Rain helped the turf.',
    'Rainfall was light.',
    'Mowing at 4 inches helps.',
    'Keep the mower deck high.',
    'Moisture is uneven in the back.',
    'The soil is damp near the drain.',
    'The soil is staying soggy and wet.',
    'Adjust the run time on each zone.',
    'Hose the area down.',
    'Cut the grass a little higher.',
    'Raise the deck on your mower.',
    'Watering schedule is on the card below.',
    'Overwatering can feed fungus.',
  ])('rejects: %s', (text) => {
    rejects(text, 'water_mow', { droughtFlagged: true });
  });

  test('every lead WATERING_WORDS word except "coverage" is denied (parity)', () => {
    const samples = ['water', 'watered', 'irrigation', 'irrigate', 'sprinkler', 'sprinklers', 'moisture', 'moist',
      'dry', 'drier', 'dries', 'dried', 'drying', 'dryness', 'drought', 'damp', 'rain', 'rainy', 'rainfall'];
    samples.forEach((word) => {
      expect(WATERING_WORDS.test(word)).toBe(true);
      const reasons = checkWaterMowDeny(`The turf shows ${word} patterns.`, {});
      expect(reasons.length).toBeGreaterThan(0);
    });
  });

  test('dry / drier / drought pass only with a technician drought flag', () => {
    rejects('The back edge looks drier than the rest.', 'water_mow', {});
    rejects('Drought stress shows near the curb.', 'water_mow', {});
    accepts('The back edge looks drier than the rest.', { droughtFlagged: true });
    accepts('Drought stress shows near the curb.', { droughtFlagged: true });
    // the flag never opens the water words
    rejects('Drought stress means more water.', 'water_mow', { droughtFlagged: true });
  });

  test('"coverage" is allowed (turf talk) and "drain" is not a rain hit', () => {
    accepts('Coverage is thin along the driveway.', {});
    accepts('The strip by the drain looks healthy.', {});
  });
});

describe('weekday / date / clock deny (G9)', () => {
  test.each([
    'We will be back Thursday.',
    "Thursday's visit went well.",
    'Mondays are our usual day.',
    'See you Wed 4 PM.',
    'Back on Tue.',
    'Tomorrow the color should deepen.',
    'Tonight the products settle.',
    'Over the weekend it should settle.',
    'By noon it should be set.',
    'At 4 PM the area is ready.',
    'Around 4pm it is ready.',
    'At 4 p.m. it is ready.',
    'At 4:30 pm it is ready.',
    'At 16:00 it is ready.',
    'At 7 o’clock it is ready.',
    'Next visit is Oct 5.',
    'Next visit is October 5th.',
    'Next visit is the 5th of October.',
    'Next visit is 10/05/26.',
    'Next visit is 10/15.',
    'We applied this on Sept 3.',
  ])('rejects: %s', (text) => {
    rejects(text, 'weekday_clock', {});
  });

  test('uses unicode-aware normalization (curly apostrophe, nbsp, narrow nbsp)', () => {
    expect(checkWeekdayClockDeny('Thursday’s visit').length).toBe(1);
    expect(checkWeekdayClockDeny('At 4 PM').length).toBe(1);
    expect(checkWeekdayClockDeny('At 4 PM').length).toBe(1);
  });

  test('ordinary words that look like weekday abbreviations pass', () => {
    accepts('Full sun exposure in the front, and the lawn sat untouched at the edge.', {});
    accepts('We will mon the turf closely.', {});
  });

  test('"today" and month names without a day number pass', () => {
    accepts('Today we treated the broadleaf weeds along the edge.', {});
    accepts('Your score has held steady since March.', { progress: 'flat' });
  });
});

describe('progress-word coupling (G5)', () => {
  test.each(['Your lawn is improving.', 'The turf is recovering well.', 'Color looks better.', 'The lawn is responding to the program.', 'The lawn is on the mend.'])(
    'up word is rejected unless progress is up: %s',
    (text) => {
      ['down', 'flat', 'unknown', undefined, 'none'].forEach((progress) => {
        rejects(text, 'progress_coupling', { progress });
      });
      accepts(text, { progress: 'up' });
    }
  );

  test.each(['Your lawn is getting worse.', 'The turf is declining.', 'Density slipped since last time.', 'Color dropped a little.'])(
    'decline word is rejected unless progress is down: %s',
    (text) => {
      ['up', 'flat', 'unknown', undefined].forEach((progress) => {
        rejects(text, 'progress_coupling', { progress });
      });
      accepts(text, { progress: 'down' });
    }
  );

  test('flat or unknown allows neither improving nor decline words', () => {
    accepts('Your lawn looks about the same as last visit.', { progress: 'flat' });
    accepts('Your lawn looks about the same as last visit.', { progress: 'unknown' });
    rejects('Your lawn is improving and not declining.', 'progress_coupling', { progress: 'flat' });
  });

  test('state phrases need a matching progress item state', () => {
    rejects('Your turf is on track.', 'progress_coupling', { progress: 'up' });
    accepts('Your turf is on track.', { progressStates: ['on_track'] });
    accepts('Your turf is on track.', { progressStates: ['on-track'] });
    rejects('Your turf is ahead of schedule.', 'progress_coupling', { progressStates: ['on_track'] });
    accepts('Your turf is ahead of schedule.', { progressStates: ['ahead'] });
    rejects('Recovery is running behind schedule.', 'progress_coupling', { progressStates: ['on_track'] });
    accepts('Weed pressure is running behind schedule.', { progressStates: ['behind'] });
    rejects('It is too early to say.', 'progress_coupling', {});
    accepts('It is too early to say.', { progressStates: ['too_early'] });
  });

  test('"holding steady" needs overall flat', () => {
    rejects('Your score is holding steady.', 'progress_coupling', { progress: 'up' });
    rejects('Your score is holding steady.', 'progress_coupling', {});
    accepts('Your score is holding steady.', { progress: 'flat' });
  });

  test('the individual check returns reasons with the rule and the matched word', () => {
    expect(checkProgressCoupling('The lawn is improving.', { progress: 'flat' })).toEqual([
      { rule: 'progress_coupling', match: 'improving', detail: 'improving word with progress "flat"' },
    ]);
    expect(checkProgressCoupling('The lawn is improving.', { progress: 'up' })).toEqual([]);
  });

  test('"behind the house" is not a progress state', () => {
    accepts('The thin patch is behind the house near the fence.', {});
  });

  test('progress words are only judged outside approved sentences', () => {
    const sentence = 'Turf typically recovers in 3 to 7 days.';
    accepts(sentence, { approvedSentences: [sentence], allowedText: [sentence] });
    accepts(`${sentence}`, { approvedSentences: ['  turf typically recovers in 3 to 7 days  '], allowedText: [] });
    // the sentence beside an approved one is still judged
    rejects(`${sentence} Your lawn is improving.`, 'progress_coupling', { approvedSentences: [sentence], allowedText: [sentence] });
  });

  test('an approved sentence is exempt from numeric and progress only', () => {
    const sentence = 'Water the lawn in 3 to 7 days.';
    rejects(sentence, 'water_mow', { approvedSentences: [sentence], allowedText: [sentence] });
    const clock = 'Expect color by Thursday in 3 to 7 days.';
    rejects(clock, 'weekday_clock', { approvedSentences: [clock] });
  });
});

describe('banned re-entry pattern and the keep-off regression list', () => {
  test('hold-copy rejects from the appendix are rejected by the shared list AND this module', () => {
    expect(KEEP_OFF_REJECT).toEqual([
      'Keep the sprinklers off for 24 hours.',
      'Keep the sprinklers off until Tue 7 PM (24 hours).',
      'Let the lawn dry for 2 hours.',
    ]);
    KEEP_OFF_REJECT.forEach((text) => {
      expect(findBannedCustomerCopy(text).length).toBeGreaterThan(0);
      expect(checkReentryPattern(text).length).toBeGreaterThan(0);
      expect(checkBannerCopy(text).length).toBeGreaterThan(0);
      expect(checkLawnModelCopy(text, { allowedText: [text], allowedNumbers: [24, 2, 7], droughtFlagged: true }).ok).toBe(false);
    });
  });

  test('approved banner phrasings pass the re-entry rules', () => {
    expect(BANNER_COPY_ACCEPT).toEqual(expect.arrayContaining([
      'Pause the sprinklers for 24 hours.',
      'Pause the sprinklers until Thursday.',
      'Do not run the irrigation until Tuesday at 7 PM.',
      'Turn the sprinklers off for the next 24 hours.',
      'Skip your turf watering until Wed 4 PM.',
      'Water in today’s treatment by Wed 12 PM.'.replace('’', "'"),
      'Run each zone about 40 minutes.',
      'No watering change from today\'s treatment.',
    ]));
    BANNER_COPY_ACCEPT.forEach((text) => {
      expect(checkBannerCopy(text)).toEqual([]);
    });
  });

  test('banner phrasings that carry water words are still model-copy rejects: the banner owns them', () => {
    BANNER_COPY_ACCEPT.filter((text) => /water|sprinkl|irrigat|zone/i.test(text)).forEach((text) => {
      const result = checkLawnModelCopy(text, { allowedText: [text], allowedNumbers: [24, 40, 4, 12] });
      expect(rules(result)).toContain('water_mow');
    });
  });

  test.each([
    'Keep the pets off for 2 hours.',
    'Keep kids off the turf for 30 minutes.',
    'Stay off the grass for 1 hour.',
    'Stay off for two hours.',
    'Please wait 30 minutes before heading out.',
    'Waiting a couple of hours is best.',
    'Let it dry for 2 hours.',
    'Give it half an hour to dry.',
    'The turf will be dry in an hour.',
    'Keep off the area for a few minutes.',
    'Please wait one hour.',
  ])('rejects the banned re-entry pattern: %s', (text) => {
    expect(checkReentryPattern(text).length).toBe(1);
  });

  test.each([
    'Keep off the new sod.',
    'Stay off the grass until it dries.',
    'Wait for your technician.',
    'The turf stays dry in shaded corners.',
    'We applied it at 9 AM and left by 10.',
    'Run each zone about 40 minutes.',
  ])('does not flag a sentence with no hours or minutes figure: %s', (text) => {
    expect(checkReentryPattern(text)).toEqual([]);
  });

  // Pre-push audit: the re-entry figure is the full quantity grammar and an
  // absolute rule. No allowlist, score list or approved sentence can waive it.
  describe('re-entry figure uses the full quantity grammar and cannot be allowlisted', () => {
    const SPELLED = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
      'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one',
      'twenty-two', 'twenty-three', 'twenty-four', 'thirty', 'forty-eight', 'seventy-two', 'a dozen', 'two dozen'];
    const NUMBER_FORMS = [...SPELLED, ...Array.from({ length: 24 }, (_, i) => String(i + 1)), '30', '48', '72', '1.5', '2 to 3', 'two to three'];
    const TRIGGERS = [
      (f, u) => `Stay off the turf for ${f} ${u}.`,
      (f, u) => `Keep the kids off the grass for ${f} ${u}.`,
      (f, u) => `Please wait ${f} ${u} before heading out.`,
      (f, u) => `Let the lawn dry for ${f} ${u}.`,
    ];

    test.each(NUMBER_FORMS)('"%s" hours and minutes are a figure, under every trigger', (figure) => {
      ['hours', 'minutes', 'hrs', 'mins'].forEach((unit) => {
        TRIGGERS.forEach((make) => {
          expect(checkReentryPattern(make(figure, unit)).length).toBe(1);
        });
      });
    });

    test('the audit case: fourteen minutes', () => {
      const text = 'Stay off the turf for fourteen minutes.';
      expect(checkReentryPattern(text).length).toBe(1);
      expect(checkLawnModelCopy(text, { allowedText: ['14 minutes'] }).ok).toBe(false);
      rejects(text, 'reentry_figure', { allowedText: ['14 minutes'] });
    });

    test.each([
      'Stay off the turf for an hour.',
      'Stay off the turf for half an hour.',
      'Stay off the turf for half-hour.',
      'Stay off the turf for a half hour.',
      'Stay off the turf for a few minutes.',
      'Stay off the turf for a couple of hours.',
      'Stay off the turf for several hours.',
      'Stay off the turf for 30 more minutes.',
      'Stay off the turf for two full hours.',
      'Stay off the turf for 2-3 hours.',
      'Stay off the turf for 2\u20133 hours.',
      'STAY OFF THE TURF FOR FOURTEEN MINUTES.',
      'Stay off the turf within the hour.',
      'Stay off the turf for the next hour.',
    ])('vague and half forms count: %s', (text) => {
      expect(checkReentryPattern(text).length).toBe(1);
    });

    test('a number phrase the parser cannot read in full still counts', () => {
      ['twenty twenty minutes', 'a couple hundred minutes', 'one and a half hours', 'one two hours'].forEach((figure) => {
        expect(checkReentryPattern(`Stay off the turf for ${figure}.`).length).toBe(1);
      });
    });

    test('no allowedText, allowedNumbers or approvedSentences entry can waive it', () => {
      SPELLED.slice(0, 24).concat(['thirty', 'forty-eight', 'seventy-two', 'a dozen']).forEach((figure) => {
        TRIGGERS.forEach((make) => {
          const sentence = make(figure, 'minutes');
          const waivers = [
            { allowedText: [sentence] },
            { allowedText: [`${figure} minutes`] },
            { allowedNumbers: [1, 2, 3, 4, 5, 6, 7, 12, 14, 24, 30, 48, 72] },
            { approvedSentences: [sentence] },
            { approvedSentences: [sentence], allowedText: [sentence], allowedNumbers: [14], droughtFlagged: true, progress: 'up' },
          ];
          waivers.forEach((facts) => {
            const result = checkLawnModelCopy(sentence, facts);
            expect(result.ok).toBe(false);
            expect(rules(result)).toContain('reentry_figure');
          });
        });
      });
    });

    test('an approved sentence stays rejected beside clean sentences, and clean ones still pass', () => {
      const bad = 'Stay off the turf for fourteen minutes.';
      const facts = { approvedSentences: [bad], allowedText: [bad] };
      rejects(`Your lawn looks even. ${bad}`, 'reentry_figure', facts);
      accepts('Your lawn looks even. Stay off the new sod.', facts);
    });

    test('a bare cadence is not a figure', () => {
      expect(checkReentryPattern('Please wait for your technician every hour.')).toEqual([]);
    });

    test('hours or minutes outside a trigger sentence are not re-entry figures', () => {
      expect(checkReentryPattern('The visit took fourteen minutes.')).toEqual([]);
      expect(checkReentryPattern('Stay off the new sod. The visit took fourteen minutes.')).toEqual([]);
    });
  });

  test('the trigger and the figure must share a sentence', () => {
    expect(checkReentryPattern('Stay off the turf. The visit took 30 minutes.')).toEqual([]);
    expect(checkReentryPattern('The visit took 30 minutes. Stay off the turf.')).toEqual([]);
    expect(checkReentryPattern('The visit took 30 minutes. Stay off the turf for 2 hours.').length).toBe(1);
  });

  test('a.m./p.m. periods do not split a sentence and hide the pattern', () => {
    expect(checkReentryPattern('Stay off until 4 p.m. which is about 2 hours.').length).toBe(1);
  });
});

describe('shared banned list and lawn overpromise list (G1, G6)', () => {
  test.each(['The weeds are cleared.', 'The issue is resolved.', 'The grubs are gone.', 'We guarantee results.'])(
    'shared list rejects: %s',
    (text) => {
      expect(checkBannedCopy(text).length).toBeGreaterThan(0);
      rejects(text, 'banned_copy', {});
    }
  );

  test.each([
    'We will eliminate the weeds.',
    'This will eradicate chinch bugs.',
    'It cures brown patch.',
    'A permanent fix for the thin spot.',
    'Your lawn will be weed-free.',
    'Results are 100% certain.',
    'Under the county ordinance.',
    'Fertilizer blackout rules apply.',
  ])('lawn extra list rejects: %s', (text) => {
    expect(checkOverpromise(text).length).toBe(1);
    rejects(text, 'overpromise', {});
  });

  test('"not seen in today\'s photos" is the allowed phrasing', () => {
    accepts("Chinch bugs were not seen in today's photos.", {});
  });

  test('"secure" is not "cure"', () => {
    expect(checkOverpromise('The edge looks secure.')).toEqual([]);
  });
});

describe('entry point', () => {
  test('collects every failing rule in one pass', () => {
    const result = checkLawnModelCopy(
      'Water the lawn on Thursday at 4 PM, it is improving, and we eliminate weeds in 10 days.',
      {}
    );
    expect(result.ok).toBe(false);
    expect(new Set(rules(result))).toEqual(new Set(['numeric', 'water_mow', 'weekday_clock', 'progress_coupling', 'overpromise']));
    result.reasons.forEach((r) => expect(typeof r.match).toBe('string'));
  });

  test('a clean, fully allowed field passes', () => {
    accepts(
      'Your score is 72, up 5 points since March. Most turf shows a response in 3 to 7 days, so the thin edge is the thing to watch.',
      { ...ROW, allowedNumbers: [72, 5], progress: 'up' }
    );
  });

  test('unicode quotes and curly apostrophes do not hide a violation', () => {
    rejects('We’ll be back “Thursday”.', 'weekday_clock', {});
    rejects('It’s about “3” to “7” days.', 'numeric', {});
  });

  test('facts may be missing or malformed', () => {
    expect(() => checkLawnModelCopy('Nice and even.', null)).not.toThrow();
    expect(() => checkLawnModelCopy('Nice and even.', { allowedText: 'x', allowedNumbers: 'y', approvedSentences: 5 })).not.toThrow();
    expect(checkLawnModelCopy('Nice and even.', null).ok).toBe(true);
  });
});

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
  checkTimingLanguage,
  checkSubDayDuration,
  checkWaterMowDeny,
  checkWeekdayClockDeny,
  checkProgressCoupling,
  checkReentryPattern,
  checkBannedCopy,
  checkOverpromise,
  checkSafetyClaim,
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

const APPROVED = 'Most turf shows a response in 3 to 7 days.';
const ROW = { approvedSentences: [APPROVED] };

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
    accepts(sentence, { approvedSentences: [sentence] });
    accepts(`${sentence}`, { approvedSentences: ['  turf typically recovers in 3 to 7 days  '] });
    // the sentence beside an approved one is still judged
    rejects(`${sentence} Your lawn is improving.`, 'progress_coupling', { approvedSentences: [sentence] });
  });

  test('an approved sentence is exempt from numeric and progress only', () => {
    const sentence = 'Water the lawn in 3 to 7 days.';
    rejects(sentence, 'water_mow', { approvedSentences: [sentence] });
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
      expect(checkLawnModelCopy(text, { allowedNumbers: [24, 2, 7], droughtFlagged: true }).ok).toBe(false);
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
      const result = checkLawnModelCopy(text, { allowedNumbers: [24, 40, 4, 12] });
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
      expect(checkLawnModelCopy(text, { approvedSentences: [] }).ok).toBe(false);
      rejects(text, 'reentry_figure', { approvedSentences: [] });
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

    test('no allowedNumbers or approvedSentences entry can waive it (the removed allowedText is inert)', () => {
      SPELLED.slice(0, 24).concat(['thirty', 'forty-eight', 'seventy-two', 'a dozen']).forEach((figure) => {
        TRIGGERS.forEach((make) => {
          const sentence = make(figure, 'minutes');
          const waivers = [
            { allowedText: [sentence] },
            { allowedText: [`${figure} minutes`] },
            { allowedNumbers: [1, 2, 3, 4, 5, 6, 7, 12, 14, 24, 30, 48, 72] },
            { approvedSentences: [sentence] },
            { approvedSentences: [sentence], allowedNumbers: [14], droughtFlagged: true, progress: 'up' },
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
      const facts = { approvedSentences: [bad] };
      rejects(`Your lawn looks even. ${bad}`, 'reentry_figure', facts);
      accepts('Your lawn looks even. Stay off the new sod.', facts);
    });

    test('any time word counts, a bare cadence included', () => {
      expect(checkReentryPattern('Please wait for your technician every hour.').length).toBe(1);
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


describe('pesticide safety claims (AGENTS.md compliance language)', () => {
  test.each([
    'This treatment is pet-safe.',
    'This pesticide is safe for children.',
    'The product is safe for pets and kids.',
    'It is safe for family, wildlife and bees.',
    'A safer option for your yard.',
    'The application is safe.',
    'Applied safely around the beds.',
    'The chemical is harmless.',
    'A non-toxic treatment.',
    'A nontoxic product.',
    'Child-safe formula.',
    'A kid-friendly product.',
    'A pet-friendly application.',
    'An eco-friendly pesticide.',
    'This treatment is environmentally friendly.',
    'A natural treatment for the edge weeds.',
    'An organic fertilizer was applied.',
    'The product is all-natural.',
    'The spray is gentle on pets.',
    'There is no risk to pets.',
    'It will not harm your pets.',
    'The product is not harmful.',
    'The treatment is toxic to bees.',
    'Unsafe for kids until later.',
  ])('rejects: %s', (text) => {
    expect(checkSafetyClaim(text).length).toBe(1);
    rejects(text, 'safety_claim', { droughtFlagged: true });
  });

  test('"safe for ... once dry" is still a claim; only the bare idiom is allowed', () => {
    expect(checkSafetyClaim('Safe for pets once dry.').length).toBe(1);
    expect(checkSafetyClaim('The treatment is safe for kids once it dries.').length).toBe(1);
    expect(checkSafetyClaim('Treated areas are safe once dry.')).toEqual([]);
    expect(checkSafetyClaim('Treated areas are safe once it dries.')).toEqual([]);
    expect(checkSafetyClaim('Treated areas are safe once it is dry.')).toEqual([]);
    expect(checkSafetyClaim('Areas are safe once dry, and your technician confirms timing.')).toEqual([]);
  });

  test('the idiom still meets the other rules: dry is a water word for model copy, and a figure re-enters', () => {
    rejects('Treated areas are safe once dry.', 'water_mow', {});
    accepts('Treated areas are safe once dry.', { droughtFlagged: true });
    rejects('Treated areas are safe once dry in 30 minutes.', 'reentry_figure', { droughtFlagged: true });
  });

  test('"once it dries" without any safety word is not a safety claim', () => {
    expect(checkSafetyClaim('Walk on the area once it dries.')).toEqual([]);
  });

  test('agronomic uses of natural and organic pass', () => {
    accepts('Organic matter is building in the thatch layer.', {});
    accepts('The turf has a natural, even color along the front.', {});
    accepts('The back looks natural and even.', {});
  });

  test('no allowlist or approved sentence waives a safety claim', () => {
    const sentence = 'This treatment is pet-safe.';
    rejects(sentence, 'safety_claim', { approvedSentences: [sentence] });
  });
});

describe('efficacy guarantees', () => {
  test.each([
    'The weeds will never come back.',
    'They will not return.',
    'Chinch bugs never return after this.',
    'This kills all weeds.',
    'It kills everything in the bed.',
    'No more weeds along the edge.',
    'Fixed for good.',
    'The weeds are gone forever.',
    'Solved once and for all.',
    'The problem is completely gone.',
    'The weeds are totally controlled.',
    'It is 100 percent effective.',
    'A foolproof plan.',
    'It is guaranteed to work.',
  ])('rejects: %s', (text) => {
    rejects(text, 'overpromise', {});
  });

  test('ordinary talk about shade and growth passes', () => {
    accepts('The turf cannot grow in deep shade, so the thin patch near the oak is expected.', {});
    accepts('We will treat the edge weeds again if they show up.', {});
  });
});

describe('entry point', () => {
  test('collects every failing rule in one pass', () => {
    const result = checkLawnModelCopy(
      'Water the lawn on Thursday at 4 PM, it is improving, and we eliminate weeds in 10 days.',
      {}
    );
    expect(result.ok).toBe(false);
    expect(new Set(rules(result))).toEqual(new Set(['timing', 'numeric', 'water_mow', 'weekday_clock', 'progress_coupling', 'overpromise']));
    result.reasons.forEach((r) => expect(typeof r.match).toBe('string'));
  });

  test('a clean, fully allowed field passes', () => {
    accepts(
      `Your score is 72, up 5 points since March. ${APPROVED} The thin edge is the thing to watch.`,
      { ...ROW, allowedNumbers: [72, 5], progress: 'up' }
    );
  });

  test('unicode quotes and curly apostrophes do not hide a violation', () => {
    rejects('We’ll be back “Thursday”.', 'weekday_clock', {});
    rejects('It’s about “3” to “7” days.', 'numeric', {});
    rejects('It’s about “3” to “7” days.', 'timing', {});
  });

  test('facts may be missing or malformed', () => {
    expect(() => checkLawnModelCopy('Nice and even.', null)).not.toThrow();
    expect(() => checkLawnModelCopy('Nice and even.', { allowedNumbers: 'y', approvedSentences: 5 })).not.toThrow();
    expect(checkLawnModelCopy('Nice and even.', null).ok).toBe(true);
  });
});

describe('closed-world timing rule (terminal review)', () => {
  const CLEAN = 'The edge along the front looks thin and we will keep an eye on it.';
  const inside = (sentence, extra = {}) => ({ approvedSentences: [sentence], ...extra });

  // pass-1 reproductions
  test.each([
    ['Return to the lawn in one short minute.', 'timing'],
    ['Return to the lawn in one short minute.', 'sub_day_duration'],
    ['Expect a change over the next few weeks.', 'timing'],
    ['Expect a change over the following few weeks.', 'timing'],
    ['Your score changed by -5 points.', 'numeric'],
    ['The turf is behind the expected pace.', 'progress_coupling'],
    ['Expect a change in 12½ days.', 'numeric'],
  ])('%s is rejected by %s', (text, rule) => {
    rejects(text, rule, { allowedNumbers: [5, 12], progress: 'up', progressStates: ['on_track'] });
  });

  test('"next" and "following" are both rejected; no prefix can be masked', () => {
    ['next', 'coming', 'following'].forEach((w) => {
      expect(checkTimingLanguage(`Look for a change over the ${w} few weeks.`).length).toBeGreaterThan(0);
    });
  });

  describe('every time word and number form: rejected outside an approved sentence, accepted inside one', () => {
    const TIME_FORMS = [
      'day', 'days', 'week', 'weeks', 'month', 'months', 'year', 'years', 'season', 'seasons', 'night', 'nights',
      'overnight', 'wk', 'wks', 'mo', 'mos', 'yr', 'yrs', 'daily', 'weekly', 'monthly', 'yearly', 'annually',
      'biweekly', 'decade', 'fortnight',
    ];
    const RELATIVE_FORMS = ['next', 'coming', 'following', 'within', 'soon', 'shortly', 'later', 'ago', 'yesterday', 'eventually'];
    const NUMBER_FORMS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
      'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
      'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'dozen', 'half', 'quarter', 'zero'];
    const DIGIT_FORMS = ['3', '14', '3-7', '3–7', '.5', '0.5', '1.5', '1/2', '1 1/2', '½', '1½', '12½', '¼',
      '24/7', '3rd', 'H2O', '72%', '5 percent', '90°', '４', '٤'];

    test.each([...TIME_FORMS, ...RELATIVE_FORMS])('time word "%s"', (w) => {
      const sentence = `Color may shift ${w} along the edge.`;
      const outside = checkLawnModelCopy(sentence, {});
      expect(outside.ok).toBe(false);
      expect(rules(outside)).toContain('timing');
      expect(checkLawnModelCopy(sentence, inside(sentence)).reasons.filter((r) => r.rule === 'timing')).toEqual([]);
    });

    test('"a while" and "a few days" forms', () => {
      ['Color may shift in a while.', 'Color may shift in a few days.'].forEach((sentence) => {
        expect(checkLawnModelCopy(sentence, {}).ok).toBe(false);
        expect(checkLawnModelCopy(sentence, inside(sentence)).ok).toBe(true);
      });
    });

    test.each(NUMBER_FORMS)('spelled number "%s"', (w) => {
      const sentence = `We saw ${w} thin spots along the edge.`;
      const outside = checkLawnModelCopy(sentence, { allowedNumbers: [1, 2, 3] });
      expect(outside.ok).toBe(false);
      expect(rules(outside)).toContain('numeric');
      expect(checkLawnModelCopy(sentence, inside(sentence)).ok).toBe(true);
    });

    test.each(DIGIT_FORMS)('digit form "%s"', (d) => {
      const sentence = `We saw ${d} thin spots along the edge.`;
      const outside = checkLawnModelCopy(sentence, {});
      expect(outside.ok).toBe(false);
      expect(rules(outside)).toContain('numeric');
      expect(checkLawnModelCopy(sentence, inside(sentence)).ok).toBe(true);
    });

    test('a bare integer is only accepted when its value is a supplied score', () => {
      ['3', '14', '\uff14', '\u0664'].forEach((d) => {
        const sentence = `We saw ${d} thin spots along the edge.`;
        const value = Number(String(d).replace(/[\uff10-\uff19]/g, (c) => c.charCodeAt(0) - 0xff10).replace(/[\u0660-\u0669]/g, (c) => c.charCodeAt(0) - 0x660));
        expect(checkNumericWhitelist(sentence, { allowedNumbers: [value] })).toEqual([]);
        expect(checkNumericWhitelist(sentence, { allowedNumbers: [value + 1] }).length).toBe(1);
      });
    });

    test('a clean sentence passes with no facts', () => {
      accepts(CLEAN, {});
    });
  });

  describe('signed score allowance', () => {
    test.each([
      ['Your score is 72.', [72], true],
      ['Your score is 72 points.', [72], true],
      ['Your score changed by -5 points.', [-5], true],
      ['Your score changed by -5 points.', [5], false],
      ['Your score changed by -5 points.', [], false],
      ['Your score changed by −5 points.', [-5], true],
      ['Your score changed by −5 points.', [5], false],
      ['Your score changed by minus 5 points.', [-5], true],
      ['Your score changed by minus 5 points.', [5], false],
      ['Your score changed by +5 points.', [5], true],
      ['Your score changed by +5 points.', [-5], false],
      ['Your score changed by plus 5 points.', [5], true],
      ['Your score is up 5 points.', [5], true],
      ['Your score is up by 5 points.', [5], true],
      ['Your score is up 5 points.', [-5], false],
      ['Your score is down 5 points.', [-5], true],
      ['Your score is down 5 points.', [5], false],
      ['Your score is down by 5 points.', [-5], true],
      ['Your score is 5.', [5], true],
      ['Your score is 5.', [-5], false],
      ['Your score is 72%.', [72], false],
      ['Your score is 72.5.', [72], false],
      ['Your score is 72/100.', [72, 100], false],
      ['Your score is 73.', [72], false],
    ])('%s with allowedNumbers %j -> %s', (text, allowedNumbers, ok) => {
      const result = checkNumericWhitelist(text, { allowedNumbers });
      expect(result.length === 0).toBe(ok);
    });

    test('"-5" is not "5" and the sign is never dropped', () => {
      rejects('Your score changed by -5 points.', 'numeric', { allowedNumbers: [5], progress: 'down' });
      accepts('Your score changed by -5 points.', { allowedNumbers: [-5], progress: 'down' });
    });

    test('string and unicode-minus entries in allowedNumbers keep their sign', () => {
      expect(checkNumericWhitelist('Down 5 points.', { allowedNumbers: ['-5'] })).toEqual([]);
      expect(checkNumericWhitelist('Down 5 points.', { allowedNumbers: ['−5'] })).toEqual([]);
      expect(checkNumericWhitelist('Down 5 points.', { allowedNumbers: ['5'] }).length).toBe(1);
    });

    test('a score never licenses a duration word', () => {
      rejects('Your score is 7 days.', 'timing', { allowedNumbers: [7] });
    });
  });

  describe('approved sentences', () => {
    test('a verbatim approved row carries its window; the rest of the field is judged', () => {
      accepts(`${APPROVED} ${CLEAN}`, ROW);
      rejects(`${APPROVED} Check back in 2 weeks.`, 'timing', ROW);
    });

    test('matching ignores case, spacing and trailing punctuation', () => {
      accepts('  most TURF shows a response in 3 to 7 days  ', ROW);
    });

    test('a changed number is not the approved sentence', () => {
      rejects('Most turf shows a response in 3 to 8 days.', 'timing', ROW);
    });

    test('allowedText is gone: a licensed phrase no longer licenses anything', () => {
      rejects('Most turf shows a response in 3 to 7 days.', 'timing', { allowedText: [APPROVED] });
    });

    test('sub-day and re-entry rules are absolute even inside an approved sentence', () => {
      const hours = 'The color settles in 2 hours.';
      rejects(hours, 'sub_day_duration', inside(hours));
      const keepOff = 'Stay off the turf for 3 to 7 days.';
      rejects(keepOff, 'reentry_figure', inside(keepOff));
      const wait = 'Please wait a few days.';
      rejects(wait, 'reentry_figure', inside(wait));
    });

    test('water, clock, banned, overpromise and safety rules still read approved sentences', () => {
      const water = 'Water the lawn in 3 to 7 days.';
      rejects(water, 'water_mow', inside(water));
      const clock = 'Expect color at 4 PM in 3 to 7 days.';
      rejects(clock, 'weekday_clock', inside(clock));
      const safe = 'This treatment is pet-safe within 3 to 7 days.';
      rejects(safe, 'safety_claim', inside(safe));
    });
  });

  describe('re-entry rule takes any timing word or number', () => {
    test.each([
      'Stay off the turf for a while.',
      'Please wait until later.',
      'Wait a few days.',
      'Keep the kids off the grass soon.',
      'Stay off the turf for two.',
      'Wait 5.',
      'Keep off the lawn within the week.',
    ])('rejects: %s', (text) => {
      expect(checkReentryPattern(text).length).toBe(1);
    });

    test('trigger sentences with no timing or number pass the re-entry rule', () => {
      expect(checkReentryPattern('Stay off the new sod.')).toEqual([]);
      expect(checkReentryPattern('Please wait for your technician.')).toEqual([]);
    });
  });

  describe('"behind" is a progress claim unless a spatial noun follows', () => {
    const facts = { progressStates: ['on_track'] };
    test.each([
      'The turf is behind the expected pace.',
      'The turf is behind schedule.',
      'The turf is running behind.',
      'The turf is behind where it should be.',
      'The turf is behind the usual pace for this time.',
    ])('claim, rejected without a behind state: %s', (text) => {
      expect(checkProgressCoupling(text, facts).length).toBe(1);
      expect(checkProgressCoupling(text, { progressStates: ['behind'] })).toEqual([]);
    });

    test.each([
      'The thin patch is behind the house.',
      'The thin patch is behind the back fence.',
      'The weeds are behind the shed.',
      'The thin patch is behind the pool.',
      'The thin patch is behind your garage.',
      'The thin patch is behind the driveway.',
      'The thin patch is behind the patio.',
      'The thin patch is behind the deck.',
      'The thin patch is behind the hedge.',
      'The thin patch is behind the trees.',
      'The thin patch is behind the building.',
      'The thin patch is behind the wall.',
      'The thin patch is behind the gate.',
      'The thin patch is behind the mailbox.',
    ])('spatial, passes: %s', (text) => {
      expect(checkProgressCoupling(text, facts)).toEqual([]);
    });
  });

  test('the sub-day check reads second, minute and hour words and nothing else', () => {
    ['a minute', 'two hours', 'half-hour', 'hourly', '30 secs', '5 mins'].forEach((w) => {
      expect(checkSubDayDuration(`It settles in ${w}.`).length).toBeGreaterThan(0);
    });
    expect(checkSubDayDuration('Weeds yellow over days and weeks.')).toEqual([]);
  });

  test('"12½" is normalized to digits and rejected whole', () => {
    expect(guards.normalizeCopy('12½ days')).toBe('12 1/2 days');
    expect(checkNumericWhitelist('Expect 12½.', { allowedNumbers: [12, 1, 2] }).length).toBeGreaterThan(0);
  });
});

describe('whole numeric expressions, bare dry idiom, negation, line wraps (terminal review pass 2)', () => {
  describe('numeric expressions are read whole', () => {
    const facts = { allowedNumbers: [1, 2, 3, 4, 5, 72, 100] };
    test.each([
      ['Your score is 1 / 2.', '1 / 2'],
      ['Your score is 72 / 100.', '72 / 100'],
      ['Your score is 72/100.', '72/100'],
      ['Your score is 72 of 100.', '72 of 100'],
      ['Your score is 72 out of 100.', '72 out of 100'],
      ['Your score is 3 - 4.', '3 - 4'],
      ['Your score is 3-4.', '3-4'],
      ['Your score is 3 to 4.', '3 to 4'],
      ['Your score is 72 points%.', '72 points%'],
      ['Your score is 72%.', '72%'],
      ['Your score is 72 percent.', '72 percent'],
      ['Your score is 72 points degrees.', null],
      ['Your score is 1.5.', '1.5'],
      ['Your score is 72 100.', '72 100'],
    ])('%s rejects whole even when every digit is a supplied score', (text) => {
      const reasons = checkNumericWhitelist(text, facts);
      expect(reasons.length).toBeGreaterThan(0);
    });

    test('the rejected match is the whole expression, not a leftover fragment', () => {
      expect(checkNumericWhitelist('Your score is 72 / 100.', facts)).toEqual([
        { rule: 'numeric', match: '72 / 100', detail: 'not a single supplied score value' },
      ]);
      expect(checkNumericWhitelist('Your score is 72 out of 100.', facts)[0].match).toBe('72 out of 100');
    });

    test('a single signed integer, optionally with "points", still passes', () => {
      ['Your score is 72.', 'Your score is 72 points.', 'Your score is up 5 points.', 'Your score is down 5 points.', 'Score 72, up 5 points.']
        .forEach((text) => {
          expect(checkNumericWhitelist(text, { allowedNumbers: [72, 5, -5] })).toEqual([]);
        });
    });
  });

  describe('"safe once dry" is a bare idiom only', () => {
    const claim = (text) => expect(checkSafetyClaim(text).length).toBeGreaterThan(0);
    const idiom = (text) => expect(checkSafetyClaim(text)).toEqual([]);

    test.each([
      'Pet-safe once dry.',
      'Family-safe once dry.',
      'Child-safe once dry.',
      'Kid-safe once dry.',
      'Lawn-safe once dry.',
      'The pet-safe lawn is safe once dry.',
      'Safe for pets once dry.',
      'Safe for kids once it dries.',
      'This product is safe once dry.',
      'The treatment is safe once dry.',
      'The pesticide is safe once dry.',
      'This application is safe once dry.',
      'The chemical is safe once it dries.',
      'Our product is safe once dry.',
      'It is safe once dry.',
      'Everything is safe once dry.',
      'The lawn is safe for pets once dry.',
      'Treated areas are safe once dry and safe for kids.',
      'Once dry, the product is safe.',
      'The area is safe once dry. The product is pet-safe.',
    ])('claim: %s', claim);

    test.each([
      'Safe once dry.',
      'Safe once it dries.',
      'Treated areas are safe once dry.',
      'The lawn is safe once it dries.',
      'Your yard will be safe once dry.',
      'The turf is safe once it is dry.',
      'Treated areas are safe once dry, and your technician confirms timing.',
    ])('idiom: %s', idiom);

    test('the safety scan runs first: a claim sentence is not exempted by a neighboring idiom', () => {
      claim('Treated areas are safe once dry. This product is pet-safe.');
      claim('This product is pet-safe. Treated areas are safe once dry.');
    });

    test('the idiom still meets the other rules (dry needs a drought flag, no figure)', () => {
      rejects('Treated areas are safe once dry.', 'water_mow', {});
      accepts('Treated areas are safe once dry.', { droughtFlagged: true });
    });
  });

  describe('negated progress and state words reject whatever states are supplied', () => {
    const everything = { progress: 'up', progressStates: ['on_track', 'ahead', 'behind', 'too_early'] };
    const down = { progress: 'down', progressStates: ['behind'] };
    test.each([
      'The lawn is not improving.',
      'The lawn is not on track.',
      'The lawn is no longer behind.',
      "The lawn isn't recovering.",
      "The lawn isn’t recovering.",
      "The lawn hasn't improved.",
      "The turf aren't responding.",
      'The lawn is never better.',
      'Neither improving nor on track, nor ahead.',
      'The turf is improving without help.'.replace('improving without help', 'without improving'),
      'The lawn is hardly improving.',
      'The lawn is barely recovering.',
      'The lawn is not really improving.',
      'There is no improvement.',
      'The lawn is not too early.',
    ])('%s', (text) => {
      const out = checkProgressCoupling(text, everything);
      expect(out.length).toBeGreaterThan(0);
      expect(out[0].detail).toMatch(/negated|not supplied|progress/);
      expect(out.some((r) => r.detail === 'negated progress word')).toBe(true);
    });

    test('a negated decline word rejects too', () => {
      expect(checkProgressCoupling('The lawn is not getting worse.', down).some((r) => r.detail === 'negated progress word')).toBe(true);
      expect(checkProgressCoupling("The lawn isn't declining.", down).some((r) => r.detail === 'negated progress word')).toBe(true);
    });

    test('the un-negated phrase passes when the state is supplied', () => {
      expect(checkProgressCoupling('The lawn is improving.', everything)).toEqual([]);
      expect(checkProgressCoupling('The lawn is on track.', everything)).toEqual([]);
      expect(checkProgressCoupling('The lawn is behind schedule.', everything)).toEqual([]);
    });

    test('a negator beyond three words, or in another sentence, does not negate', () => {
      expect(checkProgressCoupling('We did not see any weeds today, and one more thing, the lawn is improving.', everything)).toEqual([]);
      expect(checkProgressCoupling('No weeds were seen. The lawn is improving.', everything)).toEqual([]);
    });

    test('the entry point rejects it', () => {
      rejects('The lawn is not improving.', 'progress_coupling', everything);
    });
  });

  describe('line wraps are plain whitespace', () => {
    test('"Stay off\\nfor fourteen minutes." is a re-entry violation in both entry points', () => {
      const text = 'Stay off\nfor fourteen minutes.';
      expect(checkBannerCopy(text).map((r) => r.rule)).toContain('reentry_figure');
      expect(checkReentryPattern(text).length).toBe(1);
      rejects(text, 'reentry_figure', {});
      rejects(text, 'sub_day_duration', {});
    });

    test.each([
      'Stay off\nfor 14 minutes.',
      'Stay off\r\nfor fourteen minutes.',
      'Stay\noff\nfor\na\nfew\nminutes.',
      'Keep the pets\n   off the grass for   two hours.',
      'Please wait\n\t30 minutes.',
      'Stay   off   for   fourteen   minutes.',
    ])('wrapped copy still rejects: %j', (text) => {
      expect(checkReentryPattern(text).length).toBe(1);
      expect(checkBannerCopy(text).map((r) => r.rule)).toContain('reentry_figure');
    });

    test('a sentence still ends at punctuation or a blank line', () => {
      expect(checkReentryPattern('Stay off the turf.\nThe visit took fourteen minutes.')).toEqual([]);
      expect(checkReentryPattern('Stay off the turf\n\nThe visit took fourteen minutes.')).toEqual([]);
      expect(checkReentryPattern('Stay off the turf.\n\nThe visit took fourteen minutes.')).toEqual([]);
    });

    test('other per-sentence checks see the joined sentence', () => {
      expect(checkSafetyClaim('This product\nis pet-safe.').length).toBe(1);
      expect(checkSafetyClaim('Treated areas\nare safe\nonce dry.')).toEqual([]);
      expect(checkProgressCoupling('The lawn is\nnot\nimproving.', { progress: 'up' }).length).toBe(1);
    });

    test('approved sentences match across line wraps', () => {
      accepts('Most turf shows a response\nin 3 to 7 days.', ROW);
    });
  });
});

describe('one canonical normalization feeds every rule (terminal review pass 3)', () => {
  describe('score allowance: only a whole signed integer, optionally followed by "points"', () => {
    const facts = { allowedNumbers: [5] };
    test.each([
      ['Your score is 5hours.', '5 hours'],
      ['Your score is 5th.', '5 th'],
      ['Your score is 5ft.', '5 ft'],
      ['Your score is 5 ft.', '5 ft'],
      ['Your score is 5in.', null],
      ['Your score is 5mm.', '5 mm'],
      ['Your score is 5lbs.', '5 lbs'],
      ['Your score is 5 hours.', '5 hours'],
      ['Your score is 5 inches.', '5 inches'],
      ['Your score is 5 points hours.', '5 points hours'],
      ['Your score is 5pts%.', null],
      ['Your score is 5x.', null],
    ])('%s rejects with allowedNumbers [5]', (text) => {
      expect(checkNumericWhitelist(text, facts).length).toBeGreaterThan(0);
    });

    test('digits are separated from attached letters by the canonical form', () => {
      expect(guards.normalizeCopy('5hours 5th 5ft 4pm')).toBe('5 hours 5 th 5 ft 4 pm');
      expect(guards.normalizeCopy('５hours')).toBe('5 hours');
    });

    test('the plain forms still pass', () => {
      ['Your score is 5.', 'Your score is 5 points.', 'Your score is 5 pts.', 'Your score is up 5 points.'].forEach((text) => {
        expect(checkNumericWhitelist(text, { allowedNumbers: [5] })).toEqual([]);
      });
    });
  });

  describe('vulgar fractions keep their exact value', () => {
    test('1½ and 1¼ are different canonical forms', () => {
      expect(guards.normalizeCopy('1½')).toBe('1 1/2');
      expect(guards.normalizeCopy('1¼')).toBe('1 1/4');
      expect(guards.normalizeCopy('¾')).toBe('3/4');
      expect(guards.normalizeCopy('12½')).toBe('12 1/2');
    });

    test('a changed approved sentence no longer matches', () => {
      const approved = 'Most turf shows 1½ inches of growth.';
      const facts = { approvedSentences: [approved] };
      accepts(approved, facts);
      accepts('Most turf shows 1 1/2 inches of growth.', facts);
      rejects('Most turf shows 1¼ inches of growth.', 'numeric', facts);
      rejects('Most turf shows 1¾ inches of growth.', 'numeric', facts);
      rejects('Most turf shows 1⅓ inches of growth.', 'numeric', facts);
    });
  });

  describe('whitespace and line wraps never hide a pattern in any rule', () => {
    test.each([
      ['The lawn is on\ntrack.', 'progress_coupling'],
      ['The lawn is on  track.', 'progress_coupling'],
      ['The lawn is on\r\ntrack.', 'progress_coupling'],
      ['The lawn is on\t track.', 'progress_coupling'],
      ['The lawn is\n\tnot\nimproving.', 'progress_coupling'],
      ['Your lawn is weed\nfree.', 'overpromise'],
      ['Your lawn is weed  free.', 'overpromise'],
      ['It kills\nall weeds.', 'overpromise'],
      ['This product is pet\n safe.', 'safety_claim'],
      ['Back on Fri\n morning.', 'weekday_clock'],
      ['Back at 4\nPM.', 'weekday_clock'],
      ['Water\nthe lawn.', 'water_mow'],
      ['We will eliminate\nthe weeds.', 'overpromise'],
      ['The weeds are\ngone.', 'banned_copy'],
    ])('%j -> %s', (text, rule) => {
      rejects(text, rule, {});
    });
  });

  describe('keep-off and re-entry match at any distance inside one sentence', () => {
    const LONG = 'Keep the very large treated back lawn and the side garden beds and the shaded flower border off the turf';
    test('a long subject escapes no gap', () => {
      expect(LONG.indexOf('Keep')).toBe(0);
      expect(LONG.length - LONG.indexOf('off') < 200 && LONG.indexOf('off') > 40).toBe(true);
      expect(checkReentryPattern(`${LONG} for a day.`).length).toBe(1);
      expect(checkReentryPattern(`${LONG} for 14 minutes.`).length).toBe(1);
      expect(checkBannerCopy(`${LONG} for 2 hours.`).map((r) => r.rule)).toContain('reentry_figure');
      rejects(`${LONG} for a day.`, 'reentry_figure', {});
    });

    test('the trigger is not limited to the first words of the sentence', () => {
      const wrap = 'Please be sure that your family and all of your friends and anyone visiting will wait';
      expect(checkReentryPattern(`${wrap} for fourteen minutes.`).length).toBe(1);
      expect(checkBannerCopy(`${wrap} for fourteen minutes.`).map((r) => r.rule)).toContain('reentry_figure');
    });

    test('a trigger sentence with no timing or number still passes the re-entry rule', () => {
      expect(checkReentryPattern(`${LONG}.`)).toEqual([]);
    });

    test('a time word in a different sentence is not the same sentence', () => {
      expect(checkReentryPattern(`${LONG}. The visit is quick.`)).toEqual([]);
    });
  });

  describe('weekday abbreviations, any case, in date context', () => {
    test.each([
      'Back FRI MORNING.',
      'Back fri morning.',
      'Back Fri Morning.',
      'Back WED 4.',
      'Back wed 4.',
      'Back thu afternoon.',
      'Back THU.',
      'Back tue.',
      'Back TUES.',
      'Back Mon.',
      'Back mon.',
      'Back sat.',
      'Back SAT EVENING.',
      'Back sun morning.',
      'Back SUN 5.',
      'Back Sun.',
      'Back SUN.',
      'Back Wed, 5.',
    ])('rejects: %s', (text) => {
      expect(checkWeekdayClockDeny(text).length).toBeGreaterThan(0);
    });

    test.each([
      'The front needs full sun.',
      'Full sun exposure matters.',
      'The sun is strong here.',
      'The turf sat untouched.',
      'They wed in spring.',
      'Mon amie.',
    ])('plain-word uses pass: %s', (text) => {
      expect(checkWeekdayClockDeny(text)).toEqual([]);
    });
  });

  describe('property: whitespace and case changes never turn a reject into a pass', () => {
    const FACTS = { allowedNumbers: [72, 100, 5], progress: 'up', progressStates: ['on_track'] };
    const SAMPLES = [
      ['Stay off the turf for fourteen minutes.', {}],
      ['Keep the pets off the grass for 2 hours.', {}],
      ['Please wait a few days.', {}],
      ['The lawn is on track.', { progress: 'flat', progressStates: [] }],
      ['The lawn is behind the expected pace.', { progress: 'up' }],
      ['The lawn is not improving.', FACTS],
      ['Your lawn is weed free.', {}],
      ['The weeds will never come back.', {}],
      ['It is 100 percent effective.', {}],
      ['Back Friday morning.', {}],
      ['Back at 4 PM.', {}],
      ['Back on Fri morning.', {}],
      ['Water the lawn deeply.', {}],
      ['This product is pet safe.', {}],
      ['The treatment is safe for kids.', {}],
      ['Expect a change in 10 days.', {}],
      ['Expect a change next week.', {}],
      ['Your score is 72 / 100.', FACTS],
      ['Your score is 5 ft.', FACTS],
      ['Your score is 1 1/2.', FACTS],
      ['We will eliminate the weeds.', {}],
      ['The weeds are gone.', {}],
    ];
    const SPACE_TRANSFORMS = {
      newline: (t) => t.replace(/ /g, '\n'),
      doubled: (t) => t.replace(/ /g, '  '),
      tabs: (t) => t.replace(/ /g, '\t'),
      crlf: (t) => t.replace(/ /g, '\r\n'),
      mixed: (t) => t.split(' ').map((w, i) => w + ['\n', '  ', ' \n ', '\t'][i % 4]).join('').trim(),
    };
    const CASE_TRANSFORMS = { upper: (t) => t.toUpperCase(), lower: (t) => t.toLowerCase(), swap: (t) => t.replace(/[a-z]/gi, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())) };

    test.each(SAMPLES)('baseline rejects: %s', (text, facts) => {
      expect(checkLawnModelCopy(text, { ...FACTS, ...facts }).ok).toBe(false);
    });

    describe.each(Object.entries({ ...SPACE_TRANSFORMS, ...CASE_TRANSFORMS }))('%s', (_name, transform) => {
      test.each(SAMPLES)('still rejects: %s', (text, facts) => {
        const allFacts = { ...FACTS, ...facts };
        expect(checkLawnModelCopy(transform(text), allFacts).ok).toBe(false);
        // and the same through the banner checks when the sentence is a re-entry one
        if (/stay off|keep the pets off|wait/i.test(text)) {
          expect(checkBannerCopy(transform(text)).length).toBeGreaterThan(0);
        }
      });
    });

    test('a clean sample stays clean under the same transforms', () => {
      const clean = 'The edge along the front looks thin and we will keep an eye on it.';
      Object.values({ ...SPACE_TRANSFORMS, ...CASE_TRANSFORMS }).forEach((transform) => {
        expect(checkLawnModelCopy(transform(clean), {}).ok).toBe(true);
      });
    });
  });
});

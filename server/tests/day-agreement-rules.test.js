/**
 * Day-only agreement shadow: the deterministic rules (day-agreement-rules.js).
 * Pure, no database, no model. Each skip reason has a case for both source
 * kinds where the rule differs by kind (stale age), and the daypart to slot
 * filter is covered with the picker's own slot shape. Synthetic data only.
 */
const rules = require('../services/day-agreement-rules');

const NOW = new Date('2040-03-12T16:00:00Z'); // Monday 12:00 ET
const TODAY = '2040-03-12';
const AGREED = new Date('2040-03-12T15:00:00Z');

const agreement = (over = {}) => ({
  at: '2040-03-12T11:00', act: true, kind: 'new_visit', day: '2040-03-14', from_day: null, daypart: 'any',
  service: 'pest control', blockers: [], confidence: 0.9, reason: 'staff offered Wednesday and the customer agreed', ...over,
});
const visit = (over = {}) => ({
  id: 'v-1', status: 'confirmed', created_at: new Date('2040-03-01T12:00:00Z'), updated_at: new Date('2040-03-01T12:00:00Z'), ...over,
});
const decide = (over = {}) => rules.decideAgreement({
  agreement: agreement(), kind: 'call', customerId: 'cust-1', todayET: TODAY, agreedAt: AGREED, now: NOW,
  visitsOnDay: [], visitsOnFromDay: [], ...over,
});

describe('decideAgreement: a clean agreement passes', () => {
  test('a new visit on a future day', () => {
    expect(decide()).toMatchObject({ pass: true, reason: null, kind: 'new_visit', day: '2040-03-14', fromVisitId: null });
  });

  test('a move of the one pending visit on the old day names that visit and only that visit', () => {
    const out = decide({
      agreement: agreement({ kind: 'move', from_day: '2040-03-16' }),
      visitsOnFromDay: [visit({ id: 'v-move', status: 'pending' })],
    });
    expect(out).toMatchObject({ pass: true, kind: 'move', fromVisitId: 'v-move' });
  });

  test('the same agreement passes as a text thread', () => {
    expect(decide({ kind: 'sms' }).pass).toBe(true);
  });
});

describe('decideAgreement: every rule records its own skip reason', () => {
  const cases = [
    ['model_no_act', { agreement: agreement({ act: false, blockers: ['vague_day'] }) }],
    ['model_blocker', { agreement: agreement({ blockers: ['customer_unsure'] }) }],
    ['low_confidence', { agreement: agreement({ confidence: 0.69 }) }],
    ['kind_invalid', { agreement: agreement({ kind: 'reschedule' }) }],
    ['kind_invalid', { agreement: agreement({ kind: null }) }],
    ['day_invalid', { agreement: agreement({ day: '2040-02-30' }) }],
    ['day_invalid', { agreement: agreement({ day: 'Wednesday' }) }],
    ['day_not_after_today', { agreement: agreement({ day: TODAY }) }],
    ['day_not_after_today', { agreement: agreement({ day: '2040-03-10' }) }],
    ['no_customer', { customerId: null }],
  ];
  test.each(cases)('%s', (reason, over) => {
    expect(decide(over)).toMatchObject({ pass: false, reason });
  });

  test('confidence of exactly 0.7 passes, a missing confidence fails', () => {
    expect(decide({ agreement: agreement({ confidence: 0.7 }) }).pass).toBe(true);
    expect(decide({ agreement: agreement({ confidence: undefined }) }).reason).toBe('low_confidence');
  });

  test('stale_moment: a call older than 24 hours and a text agreement older than 6 hours', () => {
    const old = (hours) => new Date(NOW.getTime() - hours * 3600 * 1000);
    expect(decide({ kind: 'call', agreedAt: old(23) }).pass).toBe(true);
    expect(decide({ kind: 'call', agreedAt: old(25) }).reason).toBe('stale_moment');
    expect(decide({ kind: 'sms', agreedAt: old(5) }).pass).toBe(true);
    expect(decide({ kind: 'sms', agreedAt: old(7) }).reason).toBe('stale_moment');
    expect(decide({ kind: 'sms', agreedAt: null }).reason).toBe('stale_moment');
    expect(decide({ kind: 'sms', agreedAt: new Date(NOW.getTime() + 3600 * 1000) }).reason).toBe('stale_moment');
  });

  test('staff_already_acted: a live visit on the day created or changed after the agreement', () => {
    const created = visit({ created_at: new Date('2040-03-12T15:30:00Z') });
    const moved = visit({ updated_at: new Date('2040-03-12T15:30:00Z') });
    expect(decide({ visitsOnDay: [created] }).reason).toBe('staff_already_acted');
    expect(decide({ visitsOnDay: [moved] }).reason).toBe('staff_already_acted');
  });

  test('a cancelled visit on the day, even one changed after the agreement, does not count as staff acting', () => {
    const cancelled = visit({ status: 'cancelled', updated_at: new Date('2040-03-12T15:30:00Z') });
    expect(decide({ visitsOnDay: [cancelled] }).pass).toBe(true);
  });

  test('day_has_visit: a live visit already on the day (booked before the agreement) blocks a new visit', () => {
    expect(decide({ visitsOnDay: [visit()] }).reason).toBe('day_has_visit');
  });

  describe('moves', () => {
    const move = (over = {}) => decide({
      agreement: agreement({ kind: 'move', from_day: '2040-03-16' }),
      visitsOnFromDay: [visit({ id: 'v-a', status: 'confirmed' })], ...over,
    });

    test('move_target_unclear: no usable from_day', () => {
      expect(move({ agreement: agreement({ kind: 'move', from_day: null }) }).reason).toBe('move_target_unclear');
      expect(move({ agreement: agreement({ kind: 'move', from_day: 'Monday' }) }).reason).toBe('move_target_unclear');
    });

    test('move_same_day: the old day is the new day', () => {
      expect(move({ agreement: agreement({ kind: 'move', from_day: '2040-03-14' }) }).reason).toBe('move_same_day');
    });

    test('move_visit_missing: no pending or confirmed visit on the old day', () => {
      expect(move({ visitsOnFromDay: [] }).reason).toBe('move_visit_missing');
      expect(move({ visitsOnFromDay: [visit({ status: 'completed' }), visit({ status: 'en_route' })] }).reason).toBe('move_visit_missing');
    });

    test('move_visit_ambiguous: two movable visits on the old day (never guess, never move a series)', () => {
      expect(move({ visitsOnFromDay: [visit({ id: 'a' }), visit({ id: 'b', status: 'pending' })] }).reason).toBe('move_visit_ambiguous');
    });

    test('one movable visit next to a finished one on the old day still passes and names the movable one', () => {
      const out = move({ visitsOnFromDay: [visit({ id: 'done', status: 'completed' }), visit({ id: 'live', status: 'pending' })] });
      expect(out).toMatchObject({ pass: true, fromVisitId: 'live' });
    });

    test('a move onto a day that already has a live visit is skipped', () => {
      expect(move({ visitsOnDay: [visit({ id: 'other' })] }).reason).toBe('day_has_visit');
    });
  });

  test('act:true with any blocker listed never passes, and model_no_act still comes first', () => {
    expect(decide({ agreement: agreement({ blockers: ['other'] }) })).toMatchObject({ pass: false, reason: 'model_blocker' });
    expect(decide({ agreement: agreement({ act: false, blockers: ['other'] }) }).reason).toBe('model_no_act');
  });

  test('the first failing rule is the recorded one (act false beats everything after it)', () => {
    expect(decide({ agreement: agreement({ act: false, day: TODAY }), customerId: null }).reason).toBe('model_no_act');
  });
});

describe('parseDaypart, slotsForDaypart and chooseSlot', () => {
  const slot = (start, tech = 't1') => ({ date: '2040-03-14', start_time: start, technician: { id: tech } });
  const day = [slot('08:00'), slot('08:30'), slot('09:00'), slot('11:00'), slot('12:00'), slot('13:00'), slot('16:00'), slot('17:00')];
  const starts = (daypart) => rules.slotsForDaypart(day, daypart).map((s) => s.start_time);

  test('whole-hour starts only', () => {
    expect(starts('any')).toEqual(['08:00', '09:00', '11:00', '12:00', '13:00', '16:00', '17:00']);
    expect(starts(null)).toEqual(starts('any'));
  });

  test('morning is a start before 12:00; afternoon is 12:00 up to 17:00', () => {
    expect(starts('morning')).toEqual(['08:00', '09:00', '11:00']);
    expect(starts('afternoon')).toEqual(['12:00', '13:00', '16:00']);
    expect(starts('evening')).toEqual(['17:00']);
  });

  test('after HH:MM starts at that hour or later; before HH:MM starts earlier', () => {
    expect(starts('after 13:00')).toEqual(['13:00', '16:00', '17:00']);
    expect(starts('before 11:00')).toEqual(['08:00', '09:00']);
    expect(starts('before 12:00')).toEqual(['08:00', '09:00', '11:00']);
    expect(starts('After 13:00')).toEqual(['13:00', '16:00', '17:00']);
  });

  test('an unreadable daypart offers nothing', () => {
    expect(rules.parseDaypart('whenever')).toBeNull();
    expect(rules.parseDaypart('after 25:99')).toBeNull();
    expect(rules.parseDaypart('after 24:00')).toBeNull();
    expect(rules.parseDaypart('before 24:30')).toBeNull();
    expect(rules.parseDaypart('after 13:60')).toBeNull();
    expect(rules.parseDaypart('after 23:59')).toEqual({ from: 1439, before: 1440 });
    expect(starts('after one')).toEqual([]);
  });

  test('chooseSlot takes the picker\'s best-ranked slot inside the daypart, not the earliest clock time', () => {
    const ranked = [slot('16:00', 't2'), slot('09:00', 't1')];
    expect(rules.chooseSlot(ranked, 'any')).toMatchObject({ start_time: '16:00', technician: { id: 't2' } });
    expect(rules.chooseSlot(ranked, 'morning')).toMatchObject({ start_time: '09:00' });
    expect(rules.chooseSlot(ranked, 'evening')).toBeNull();
    expect(rules.chooseSlot(undefined, 'any')).toBeNull();
  });
});

describe('the SMS day-word prefilter', () => {
  const hits = ['Tuesday works', 'ok tue', 'tues is fine', 'can you come Thurs?', 'How about tomorrow', 'today is better', '10/24 please', 'the 24th', 'SAT morning', 'sun', 'Weds works', 'weds', 'wed is fine'];
  const misses = ['thanks', 'sunny out', 'monster ants', 'call me', 'we saturate it', 'unit 2B'];
  test.each(hits)('matches "%s"', (text) => expect(rules.DAY_WORD_RE.test(text)).toBe(true));
  test.each(misses)('does not match "%s"', (text) => expect(rules.DAY_WORD_RE.test(text)).toBe(false));
});

describe('unusableReason and normalizeAgreement', () => {
  test('a stored field is held to its vocabulary before it is persisted, on an act:false object too', () => {
    const a = rules.normalizeAgreement(agreement({
      act: false, kind: 'cancel', day: '2040-02-30', from_day: 'Monday', daypart: 'whenever',
    }));
    expect(a).toMatchObject({ kind: null, day: null, from_day: null, daypart: null });
    const ok = rules.normalizeAgreement(agreement({ kind: ' Move ', day: ' 2040-03-14 ', from_day: '2040-03-16', daypart: ' After 13:00 ' }));
    expect(ok).toMatchObject({ kind: 'move', day: '2040-03-14', from_day: '2040-03-16', daypart: 'after 13:00' });
    for (const daypart of ['any', 'morning', 'afternoon', 'evening', 'before 11:00']) {
      expect(rules.normalizeAgreement(agreement({ daypart })).daypart).toBe(daypart);
    }
    for (const daypart of ['after 24:00', 'before 12:75', 'after one', '', null, undefined, 7]) {
      expect(rules.normalizeAgreement(agreement({ daypart })).daypart).toBeNull();
    }
  });

  test('an act:true object with an unknown kind, an unreal day or from_day, or an unparseable daypart is an unusable answer (the backup gets a turn), never a silent "any"', () => {
    expect(rules.unusableReason([agreement({ daypart: 'whenever' })])).toBe('daypart_invalid');
    expect(rules.unusableReason([agreement({ daypart: 'after 24:00' })])).toBe('daypart_invalid');
    expect(rules.unusableReason([agreement({ kind: 'move', from_day: 'Monday' })])).toBe('from_day_invalid');
    expect(rules.unusableReason([agreement({ kind: 'move', from_day: '2040-03-16', daypart: 'before 12:00' })])).toBeNull();
    // act:false objects are stored with the bad fields nulled and are accepted.
    expect(rules.unusableReason([agreement({ act: false, daypart: 'whenever', from_day: 'x', kind: 'cancel' })])).toBeNull();
  });

  test('a confidence outside 0..1 is an unusable answer, not clamped', () => {
    for (const confidence of [1.5, -0.1, 7, Number.NaN, 'high', null, undefined]) {
      expect(rules.unusableReason([agreement({ confidence })])).toBe('confidence_out_of_range');
      expect(rules.unusableReason([agreement({ act: false, confidence })])).toBe('confidence_out_of_range');
    }
    for (const confidence of [0, 0.5, 1]) expect(rules.unusableReason([agreement({ confidence })])).toBeNull();
    // One bad object makes the whole answer unusable.
    expect(rules.unusableReason([agreement(), agreement({ confidence: 2 })])).toBe('confidence_out_of_range');
  });

  test('an answer with no agreements is unusable', () => {
    expect(rules.unusableReason([])).toBe('no_agreements');
    expect(rules.unusableReason(undefined)).toBe('no_agreements');
  });

  test('act:true needs a known kind and a real day; act:false is accepted as is', () => {
    expect(rules.unusableReason([agreement({ kind: 'cancel' })])).toBe('kind_invalid');
    expect(rules.unusableReason([agreement({ day: '2040-13-01' })])).toBe('day_invalid');
    expect(rules.unusableReason([agreement({ act: false, kind: 'cancel', day: 'x' })])).toBeNull();
    expect(rules.unusableReason([agreement(), agreement({ kind: 'move', from_day: '2040-03-16' })])).toBeNull();
  });

  test('vocabulary is normalized: kind and daypart lower-cased, confidence clamped, blockers trimmed', () => {
    const a = rules.normalizeAgreement({ ...agreement({ kind: ' Move ', daypart: ' Morning ', confidence: 7, blockers: [' vague_day ', 3, ''] }) });
    expect(a).toMatchObject({ kind: 'move', daypart: 'morning', confidence: 1, blockers: ['vague_day'] });
  });

  test('the stored reason is clipped and any number or email in it is masked', () => {
    const reason = rules.safeReason(`Customer at jane@example.invalid called 941-555-0142 ${'x'.repeat(400)}`);
    expect(reason).not.toMatch(/jane@|941|0142/);
    expect(reason).toContain('[email]');
    expect(reason.length).toBeLessThanOrEqual(200);
  });

  test('short address, account, gate and reference numbers are masked too; a date and plain words survive', () => {
    const cases = [
      ['Customer at 123 Main Street accepted Wednesday', /123|Main/, '[address]'],
      ['Visit at 4455 Example Ln near the gate agreed', /4455|Example/, '[address]'],
      ['Gate code 1234 given, agreed 2040-03-14', /1234/, '[number]'],
      ['Reference #42 mentioned by the customer', /#42|\b42\b/, '[number]'],
      ['Account 98765 and unit 12 discussed', /98765/, '[number]'],
    ];
    for (const [input, gone, mask] of cases) {
      const out = rules.safeReason(input);
      expect(out).not.toMatch(gone);
      expect(out).toContain(mask);
    }
    expect(rules.safeReason('Staff offered Wednesday 2040-03-14 morning and the customer agreed')).toBe('Staff offered Wednesday 2040-03-14 morning and the customer agreed');
  });
});

describe('stored judgment fields are scrubbed (Codex #6350 r8)', () => {
  const rules = require('../services/day-agreement-rules');
  test('only the prompt blocker words survive, and the service text is masked like the reason', () => {
    const a = rules.normalizeAgreement({
      at: '2040-03-12T10:30', act: false, kind: 'new_visit', day: null, from_day: null, daypart: 'any',
      service: '123 Palm Tree Dr pest', blockers: ['exact_time_agreed', 'gate code 4417 at 99 Main St'], confidence: 0.4, reason: 'x',
    });
    expect(a.blockers).toEqual(['exact_time_agreed', 'other']);
    expect(a.service).not.toMatch(/123|Palm Tree/);
  });

  test('an at that is not the clock form is stored as null, for act:false too (Codex #6350 r14)', () => {
    expect(rules.normalizeAgreement({ at: '941-555-0142', act: false }).at).toBeNull();
    expect(rules.normalizeAgreement({ at: '2040-03-12T10:30', act: false }).at).toBe('2040-03-12T10:30');
  });

  test('an act:true answer with an unknown blocker is still skipped as model_blocker', () => {
    const a = rules.normalizeAgreement({ at: '2040-03-12T10:30', act: true, kind: 'new_visit', day: '2040-03-14', from_day: null, daypart: 'any', service: 'x', blockers: ['customer_declined'], confidence: 0.9, reason: 'x' });
    expect(a.blockers).toEqual(['other']);
  });
});

// Unit tests for the Cockroach Report V2 aggregator (one-time treatment
// program dashboard). Asserts the trust-critical behavior: every sentence
// traces to a typed field or the calendar, absence claims stay scoped,
// the German cooperation language always ships, the program position is
// honest about what the catalog and calendar actually say, the permanent
// PDF never promises or disclaims a date, the builder is null for other
// typed types, and the PDF signature is empty when the gate is off.
// Synthetic payloads only (no customer PII).

const {
  buildCockroachReportV2,
  attachCockroachReportV2,
  cockroachReportV2PdfSignature,
  cockroachSnapshotOf,
  frozenCockroachServiceKey,
  resolveCockroachStatus,
  hasLiveEvidence,
  resolveProgram,
  buildWhatsNext,
  buildHelp,
  buildWork,
  dedupedNarrative,
  nextStepFits,
  cockroachReportV2RenderedSignature,
  cockroachWorkSourceSignature,
  workChipsFromApplications,
  GENERIC_WHAT_WE_DID,
  COCKROACH_V2_DASHBOARD_FIELD_KEYS,
} = require('../services/service-report/cockroach-report-v2');
const { PROJECT_TYPES } = require('../services/project-types');
const ActivityIndicators = require('../services/service-report/activity-indicators');

const GERMAN_MODERATE = {
  species: 'German',
  activity_level: 'Moderate',
  activity_locations: ['Kitchen', 'Behind refrigerator', 'Under sink', 'Cabinet hinges'],
  evidence_observed: ['Live roaches', 'Droppings', 'Egg cases'],
  conducive_conditions: ['Moisture / leaks', 'Food debris'],
  work_completed: ['Bait placement', 'Insect growth regulator', 'Crack & crevice treatment', 'Monitoring stations placed'],
  customer_prep: ['No over-the-counter sprays', 'Do not disturb bait placements', 'Fix plumbing leaks'],
};

describe('buildCockroachReportV2 — assembly and guards', () => {
  it('returns null for any typed type other than cockroach, and for an empty snapshot', () => {
    expect(buildCockroachReportV2({ typedSnapshotValues: GERMAN_MODERATE, typedReportType: 'german_roach_knockdown' })).toBeNull();
    expect(buildCockroachReportV2({ typedSnapshotValues: {}, typedReportType: 'cockroach' })).toBeNull();
  });

  it('treatment 1: species + level headline, counts from the chips, work in plain English, metrics traceable', () => {
    const out = buildCockroachReportV2({ typedSnapshotValues: GERMAN_MODERATE, typedReportType: 'cockroach', serviceKey: 'cockroach_control', visitSequence: 1 });
    expect(out.status).toEqual({ key: 'active', tone: 'watch', label: 'German cockroach activity was moderate today' });
    expect(out.locations).toHaveLength(4);
    expect(out.evidence).toEqual(['Live roaches', 'Droppings', 'Egg cases']);
    expect(out.work.map((w) => w.short)).toEqual(['Bait', 'IGR', 'Crack & crevice', 'Monitors']);
    expect(out.metrics).toEqual([
      { label: 'Activity today', value: 'Moderate' },
      { label: 'Areas with activity', value: '4' },
      { label: 'Treatments applied', value: 'Bait · IGR · Crack & crevice +1' },
    ]);
    // built summary names only what was recorded
    expect(out.statusSummary).toMatch(/Live roaches, Droppings, Egg cases were found in 4 areas/);
    expect(out.program).toEqual({ treatmentNumber: 1, treatmentsTotal: 2, complete: false, laterCompleted: 0, scheduledAhead: 0 });
    expect(out.whatsNext.title).toBe('Treatment 1 of 2 complete');
    expect(out.whatsNext.badge).toBe('IN PROGRESS');
  });

  it('a tech-reviewed Today\'s Result body wins over the built summary; the technician report rides aiSummary', () => {
    const out = buildCockroachReportV2({
      typedSnapshotValues: GERMAN_MODERATE,
      typedReportType: 'cockroach',
      todaysResultBody: 'We found activity behind the fridge and baited it.',
      technicianReport: 'Reviewed narrative.',
    });
    expect(out.statusSummary).toBe('We found activity behind the fridge and baited it.');
    expect(out.aiSummary).toEqual({ headline: null, body: 'Reviewed narrative.' });
  });

  it('absence claims stay scoped to today\'s inspection and never invent a count', () => {
    const out = buildCockroachReportV2({ typedSnapshotValues: { species: 'German', activity_level: 'None observed', work_completed: ['Bait placement'] }, typedReportType: 'cockroach' });
    expect(out.status.key).toBe('clear');
    expect(out.status.tone).toBe('good');
    expect(out.status.label).toMatch(/No cockroach activity observed during today's inspection/);
    expect(out.metrics[1]).toEqual({ label: 'Areas with activity', value: '0' });
    expect(out.statusSummary).toMatch(/saw no live activity today/);
    expect(out.statusSummary).not.toMatch(/roach-free|eliminated/i);
  });

  it('activity without a location list is "Not counted", never a number', () => {
    const out = buildCockroachReportV2({ typedSnapshotValues: { species: 'American', activity_level: 'Heavy' }, typedReportType: 'cockroach' });
    expect(out.metrics[1]).toEqual({ label: 'Areas with activity', value: 'Not counted' });
    expect(out.metrics).toHaveLength(2);
    expect(out.status.label).toBe('American cockroach activity was heavy today');
  });
});

describe('resolveCockroachStatus — progress visits read the gauge trend', () => {
  it('trend words only on a non-baseline progress visit', () => {
    expect(resolveCockroachStatus({ activityLevel: 'Low', species: 'German', visitSequence: 2, activity: { score: 1, trend: 'improving' } }).label).toBe('German cockroach activity has decreased since your last treatment');
    expect(resolveCockroachStatus({ activityLevel: 'Heavy', species: 'German', visitSequence: 2, activity: { score: 4, trend: 'worsening' } }).label).toBe('German cockroach activity has increased since your last treatment');
    expect(resolveCockroachStatus({ activityLevel: 'Moderate', species: 'Mixed', visitSequence: 2, activity: { score: 3, trend: 'stable' } }).label).toBe('Cockroach activity is about the same as your last treatment');
    // a baseline gauge on visit 1 never claims a trend
    expect(resolveCockroachStatus({ activityLevel: 'Low', species: 'German', visitSequence: 1, activity: { score: 1, trend: 'improving', isBaseline: true } }).label).toBe('German cockroach activity was low today');
    // no level recorded → no activity claim either way
    expect(resolveCockroachStatus({ activityLevel: null, species: 'German' }).key).toBe('unknown');
  });
});

describe('"None observed" beside live-activity evidence is reconciled, never published as a contradiction (codex P2 #3613 r1)', () => {
  it('escalates the status, reports the evidence in the metric, withholds the stale select body and flags statusReconciled', () => {
    const out = buildCockroachReportV2({
      typedSnapshotValues: { species: 'German', activity_level: 'None observed', activity_locations: ['Kitchen', 'Under sink'], evidence_observed: ['Live roaches', 'Droppings'], work_completed: ['Bait placement'] },
      typedReportType: 'cockroach',
      todaysResultBody: 'No activity was observed today.',
    });
    expect(out.status).toEqual({ key: 'active', tone: 'watch', label: 'German cockroach activity signs were found today' });
    expect(out.statusReconciled).toBe(true);
    expect(out.metrics[0]).toEqual({ label: 'Activity today', value: 'Signs found' });
    expect(out.metrics[1]).toEqual({ label: 'Areas with activity', value: '2' });
    expect(out.statusSummary).not.toMatch(/No activity was observed/);
    expect(out.statusSummary).toMatch(/Live roaches, Droppings were found in 2 areas/);
    expect(out.evidence).toEqual(['Live roaches', 'Droppings']);
  });

  it('non-activity evidence (dead roaches, odor, moisture) does not escalate a clear select', () => {
    expect(hasLiveEvidence(['Dead roaches', 'Odor', 'Grease / food debris', 'Moisture present'])).toBe(false);
    const out = buildCockroachReportV2({ typedSnapshotValues: { species: 'German', activity_level: 'None observed', evidence_observed: ['Dead roaches'] }, typedReportType: 'cockroach' });
    expect(out.status.key).toBe('clear');
    expect(out.statusReconciled).toBe(false);
  });
});

describe('buildHelp — the German cooperation language is mandatory', () => {
  it('ships the three German defaults even when the tech picked nothing, without duplicating picked chips', () => {
    const none = buildHelp({ prepChips: [], species: 'German', baitRecorded: true });
    expect(none.items.map((i) => i.key)).toEqual(['no_sprays', 'keep_bait', 'food_debris']);
    expect(none.why).toMatch(/sprays are used between visits/);
    const picked = buildHelp({ prepChips: ['No over-the-counter sprays', 'Empty trash nightly'], species: 'German', baitRecorded: true });
    expect(picked.items.map((i) => i.key)).toEqual(['no_sprays', 'trash', 'keep_bait', 'food_debris']);
    // no bait recorded today → never instructs about placements that were not made
    const noBait = buildHelp({ prepChips: [], species: 'German', baitRecorded: false });
    expect(noBait.items.map((i) => i.key)).toEqual(['no_sprays', 'food_debris']);
    expect(noBait.why).not.toMatch(/bait/i);
  });

  it('large roaches get the flush disclosure and no invented interior defaults', () => {
    const out = buildHelp({ prepChips: ['Fix plumbing leaks'], species: 'Smoky brown' });
    expect(out.items.map((i) => i.key)).toEqual(['leaks']);
    expect(out.why).toMatch(/flushed from hiding areas/);
    expect(buildHelp({ prepChips: [], species: 'Unknown' })).toEqual({ items: [], why: null });
  });

  it('an unrecognized chip prints verbatim rather than vanishing', () => {
    expect(buildWork(['Bait placement', 'Custom hinge sealing'])[1]).toEqual({ key: 'Custom hinge sealing', title: 'Custom hinge sealing', detail: null, short: 'Custom hinge sealing' });
  });
});

describe('resolveProgram — honest about what the catalog and calendar say', () => {
  it('packaged keys fix the total; the calendar fills in for the severity-priced cleanout', () => {
    expect(resolveProgram({ serviceKey: 'cockroach_control', treatmentNumber: 1 })).toEqual({ treatmentNumber: 1, treatmentsTotal: 2, complete: false, laterCompleted: 0, scheduledAhead: 0 });
    expect(resolveProgram({ serviceKey: 'cockroach_control', treatmentNumber: 2 })).toEqual({ treatmentNumber: 2, treatmentsTotal: 2, complete: true, laterCompleted: 0, scheduledAhead: 0 });
    expect(resolveProgram({ serviceKey: 'german_roach_initial', treatmentNumber: 2 })).toEqual({ treatmentNumber: 2, treatmentsTotal: 3, complete: false, laterCompleted: 0, scheduledAhead: 0 });
    // german_roach: 1 upcoming roach visit → 2 total
    expect(resolveProgram({ serviceKey: 'german_roach', treatmentNumber: 1, upcomingRoachVisits: 1 })).toEqual({ treatmentNumber: 1, treatmentsTotal: 2, complete: false, laterCompleted: 0, scheduledAhead: 1 });
    expect(resolveProgram({ serviceKey: 'german_roach', treatmentNumber: 2, upcomingRoachVisits: 0 })).toEqual({ treatmentNumber: 2, treatmentsTotal: 2, complete: true, laterCompleted: 0, scheduledAhead: 0 });
    // treatment 1 with nothing on the calendar: total UNKNOWN, not complete
    expect(resolveProgram({ serviceKey: 'german_roach', treatmentNumber: 1, upcomingRoachVisits: 0 })).toEqual({ treatmentNumber: 1, treatmentsTotal: null, complete: false, laterCompleted: 0, scheduledAhead: 0 });
    // pdf/static (calendar not resolved): total unknown, never "complete"
    expect(resolveProgram({ serviceKey: 'german_roach', treatmentNumber: 2 })).toEqual({ treatmentNumber: 2, treatmentsTotal: null, complete: false, laterCompleted: 0, scheduledAhead: 0 });
    // a package never reads "3 of 2"
    expect(resolveProgram({ serviceKey: 'cockroach_control', treatmentNumber: 3 })).toEqual({ treatmentNumber: 3, treatmentsTotal: 3, complete: true, laterCompleted: 0, scheduledAhead: 0 });
  });
});

describe('dedupedNarrative — the reviewed copy and the next step render once each (codex P1 #3613)', () => {
  it('strips the trailing next-step sentence from the typed body and drops the separate summary the body already carries', () => {
    const todaysResult = { body: 'We found activity behind the fridge and baited it. Keep the bait undisturbed.', nextStep: 'Keep the bait undisturbed.', bodySource: 'technician_report' };
    expect(dedupedNarrative({ todaysResult, summary: 'We found activity behind the fridge and baited it.' })).toEqual({
      todaysResultBody: 'We found activity behind the fridge and baited it.',
      technicianReport: null,
      nextStep: 'Keep the bait undisturbed.',
    });
    // template body (no reviewed copy inside) → the technician summary still rides aiSummary
    expect(dedupedNarrative({ todaysResult: { body: 'Placed bait. Keep the bait undisturbed.', nextStep: 'Keep the bait undisturbed.' }, summary: 'Reviewed narrative.' })).toEqual({
      todaysResultBody: 'Placed bait.',
      technicianReport: 'Reviewed narrative.',
      nextStep: 'Keep the bait undisturbed.',
    });
    // …but never twice when the body contains it verbatim without the stamp
    expect(dedupedNarrative({ todaysResult: { body: 'Reviewed narrative. Extra disclosure.', nextStep: null }, summary: 'Reviewed narrative.' }).technicianReport).toBeNull();
    expect(dedupedNarrative({})).toEqual({ todaysResultBody: null, technicianReport: null, nextStep: null });
  });

  it('attach renders the narrative once: hero body without the next step, no duplicate aiSummary, next step on the program card', () => {
    process.env.COCKROACH_REPORT_V2 = 'true';
    const service = { service_data: JSON.stringify({ completedServiceKey: 'cockroach_control', typedReportSnapshot: { type: 'cockroach', serviceKey: 'cockroach_control', values: GERMAN_MODERATE } }) };
    const data = attachCockroachReportV2({
      typedReport: { type: 'cockroach', visitSequence: 1, todaysResult: { body: 'Reviewed copy. Keep bait undisturbed.', nextStep: 'Keep bait undisturbed.', bodySource: 'technician_report' } },
      summarySource: 'technician_report',
      summary: 'Reviewed copy.',
    }, service);
    expect(data.cockroachReportV2.statusSummary).toBe('Reviewed copy.');
    expect(data.cockroachReportV2.aiSummary).toBeNull();
    expect(data.cockroachReportV2.nextStep).toBe('Keep bait undisturbed.');
    expect(data.cockroachReportV2.whatsNext.lines.find((l) => l.label === 'From your technician').text).toBe('Keep bait undisturbed.');
    delete process.env.COCKROACH_REPORT_V2;
  });
});

describe('cockroachReportV2RenderedSignature — the store key describes the render, not a second lookup', () => {
  it('reads the stamped state from the payload; falls back to unknown; empty when the gate is off or no snapshot', () => {
    process.env.COCKROACH_REPORT_V2 = 'true';
    const service = { service_data: JSON.stringify({ typedReportSnapshot: { type: 'cockroach', values: {} } }) };
    expect(cockroachReportV2RenderedSignature({ cockroachReportV2RenderedSignature: '-roachv2a-p2u1' }, service)).toBe('-roachv2a-p2u1');
    expect(cockroachReportV2RenderedSignature({}, service)).toBe('-roachv2a-pf');
    expect(cockroachReportV2RenderedSignature({ cockroachReportV2RenderedSignature: '-roachv2a-p2u1' }, {})).toBe('');
    process.env.COCKROACH_REPORT_V2 = 'false';
    expect(cockroachReportV2RenderedSignature({ cockroachReportV2RenderedSignature: '-roachv2a-p2u1' }, service)).toBe('');
    delete process.env.COCKROACH_REPORT_V2;
  });
});

describe('unknown program position (lineage lookup failed) → no program claims', () => {
  it('builder: no number, no badge, no next-visit plan; attach: null position field means unknown, absent field means treatment 1', () => {
    const out = buildCockroachReportV2({ typedSnapshotValues: GERMAN_MODERATE, typedReportType: 'cockroach', serviceKey: 'cockroach_control', treatmentNumber: null, scheduleResolved: true, nextVisit: { scheduledDate: '2999-01-01' } });
    expect(out.program).toEqual({ treatmentNumber: null, treatmentsTotal: null, complete: false, laterCompleted: 0, scheduledAhead: 0 });
    expect(out.whatsNext.title).toBe("Today's treatment");
    expect(out.whatsNext.title).not.toMatch(/complete/i);
    expect(out.whatsNext.badge).toBeNull();
    // no lineage: the next booked date still references, no numbering, no honesty note
    expect(out.whatsNext.lines.map((l) => l.label)).toEqual(['Next treatment', 'Between now and then']);
    expect(JSON.stringify(out.whatsNext)).not.toMatch(/complete/i);
    // a FAILED lookup says so
    const failed = buildCockroachReportV2({ typedSnapshotValues: GERMAN_MODERATE, typedReportType: 'cockroach', serviceKey: 'cockroach_control', treatmentNumber: null, positionReason: 'failed', scheduleResolved: true, nextVisit: null });
    expect(failed.whatsNext.lines.map((l) => l.label)).toEqual(['Between now and then', 'Your program']);
    expect(out.whatsNext.nextVisitMissing).toBe(false);
    expect(resolveProgram({ serviceKey: 'cockroach_control', treatmentNumber: null })).toEqual({ treatmentNumber: null, treatmentsTotal: null, complete: false, laterCompleted: 0, scheduledAhead: 0 });
  });
});

describe('later completed treatments and follow-up next steps (codex P2 #3613 r4)', () => {
  it('a later completed same-program visit keeps the total: a treatment-1 report never shrinks from 1 of 3 to 1 of 2', () => {
    expect(resolveProgram({ serviceKey: 'german_roach', treatmentNumber: 1, upcomingRoachVisits: 1, laterCompleted: 1 })).toEqual({ treatmentNumber: 1, treatmentsTotal: 3, complete: false, laterCompleted: 1, scheduledAhead: 1 });
    // treatment 2's report after treatment 3 happened: not "2 of 2 complete"
    expect(resolveProgram({ serviceKey: 'german_roach', treatmentNumber: 2, upcomingRoachVisits: 0, laterCompleted: 1 })).toEqual({ treatmentNumber: 2, treatmentsTotal: 3, complete: false, laterCompleted: 1, scheduledAhead: 0 });
    // packaged total still honest when a later visit exists beyond the package size
    expect(resolveProgram({ serviceKey: 'cockroach_control', treatmentNumber: 1, laterCompleted: 2 })).toEqual({ treatmentNumber: 1, treatmentsTotal: 3, complete: false, laterCompleted: 2, scheduledAhead: 0 });
    // …and a packaged program with another same-program visit still BOOKED is never complete
    expect(resolveProgram({ serviceKey: 'cockroach_control', treatmentNumber: 2, upcomingRoachVisits: 1 })).toEqual({ treatmentNumber: 2, treatmentsTotal: 3, complete: false, laterCompleted: 0, scheduledAhead: 1 });
    expect(resolveProgram({ serviceKey: 'german_roach_initial', treatmentNumber: 3, upcomingRoachVisits: 1 })).toEqual({ treatmentNumber: 3, treatmentsTotal: 4, complete: false, laterCompleted: 0, scheduledAhead: 1 });
  });

  it('an earlier report read after later treatments references none, claims nothing missing, and says the program moved on', () => {
    const out = buildWhatsNext({ program: { treatmentNumber: 1, treatmentsTotal: 3, complete: false, laterCompleted: 2 }, species: 'German', scheduleResolved: true, nextVisit: null, nextStep: 'Follow-up in 10–14 days' });
    expect(out.badge).toBe('IN PROGRESS');
    expect(out.nextVisitMissing).toBe(false);
    expect(out.lines[0].label).toBe('Since this visit');
    expect(out.lines[0].text).toMatch(/2 later treatments in this program have since been completed/);
    expect(out.lines.map((l) => l.label)).not.toContain('Next treatment');
    expect(out.lines.map((l) => l.label)).not.toContain('From your technician');
    // read after treatment 2 but before a booked treatment 3: the progress note AND the next date
    const mid = buildWhatsNext({ program: { treatmentNumber: 1, treatmentsTotal: 3, complete: false, laterCompleted: 1 }, species: 'German', scheduleResolved: true, nextVisit: { scheduledDate: '2999-01-05' } });
    expect(mid.lines.map((l) => l.label)).toEqual(['Since this visit', 'Next treatment', 'What we will do', 'Between now and then']);
    expect(mid.nextVisitMissing).toBe(false);
  });

  it('follow-up-oriented next steps are dropped when the program is complete or a next date is booked; other steps pass', () => {
    const done = { treatmentNumber: 2, treatmentsTotal: 2, complete: true, laterCompleted: 0 };
    const open = { treatmentNumber: 1, treatmentsTotal: 2, complete: false, laterCompleted: 0 };
    expect(nextStepFits({ nextStep: 'Follow-up recommended', program: done, nextVisit: null })).toBeNull();
    expect(nextStepFits({ nextStep: 'Follow-up in 10–14 days', program: open, nextVisit: { scheduledDate: '2999-01-01' } })).toBeNull();
    expect(nextStepFits({ nextStep: 'Follow-up in 10–14 days', program: open, nextVisit: null })).toBe('Follow-up in 10–14 days');
    // pdf/static: no date, but a booked treatment (scheduledAhead) still retires the time-specific chip
    expect(nextStepFits({ nextStep: 'Follow-up in 10–14 days', program: { ...open, scheduledAhead: 1 }, nextVisit: null })).toBeNull();
    expect(nextStepFits({ nextStep: 'Keep bait undisturbed.', program: done, nextVisit: null })).toBe('Keep bait undisturbed.');
    const built = buildCockroachReportV2({ typedSnapshotValues: GERMAN_MODERATE, typedReportType: 'cockroach', serviceKey: 'cockroach_control', treatmentNumber: 2, nextStep: 'Follow-up recommended' });
    expect(built.program.complete).toBe(true);
    expect(built.nextStep).toBeNull();
    expect(JSON.stringify(built.whatsNext)).not.toMatch(/follow-?up/i);
  });
});

describe('buildWhatsNext — the next date is a live-view fact', () => {
  const program1 = { treatmentNumber: 1, treatmentsTotal: 2, complete: false };
  it('live view with a booked next treatment references it; live view without one says we will confirm (and flags the exception)', () => {
    const booked = buildWhatsNext({ program: program1, species: 'German', scheduleResolved: true, nextVisit: { scheduledDate: '2026-09-10', windowStart: '09:00:00' } });
    expect(booked.lines[0]).toEqual({ label: 'Next treatment', kind: 'next_visit' });
    expect(booked.nextVisitMissing).toBe(false);
    const missing = buildWhatsNext({ program: program1, species: 'German', scheduleResolved: true, nextVisit: null });
    expect(missing.lines[0].text).toMatch(/confirm your next treatment date/);
    expect(missing.nextVisitMissing).toBe(true);
  });

  it('pdf/static (schedule not resolved) neither promises nor disclaims a date', () => {
    const pdf = buildWhatsNext({ program: program1, species: 'German', scheduleResolved: false });
    expect(pdf.lines.map((l) => l.label)).toEqual(['What we will do', 'Between now and then']);
    expect(pdf.nextVisitMissing).toBe(false);
  });

  it('the completed program closes with expectations and "text us", carrying the tech\'s own next step', () => {
    const done = buildWhatsNext({ program: { treatmentNumber: 2, treatmentsTotal: 2, complete: true }, species: 'German', scheduleResolved: true, nextStep: 'Keep the bait undisturbed.' });
    expect(done.title).toBe('Treatment 2 of 2 complete');
    expect(done.badge).toBe('COMPLETE');
    expect(done.lines.map((l) => l.label)).toEqual(['What to expect', 'If activity returns', 'From your technician']);
    expect(done.lines[2].text).toBe('Keep the bait undisturbed.');
  });

  // Owner ruling 2026-09-27: the "Next steps" chip picker was retired, so a
  // NEW completion's todaysResult.nextStep is always null — no chip-derived
  // sentence, no "Contact us if you have any questions." filler — and the
  // "From your technician" line must never print for one, in-progress or
  // complete. An OLD snapshot's stored nextStep string still renders (the
  // 'carrying the tech's own next step' test above pins that).
  it('a new completion (nextStep null) prints no "From your technician" line — in progress or complete', () => {
    const inProgress = buildWhatsNext({ program: program1, species: 'German', scheduleResolved: true, nextVisit: { scheduledDate: '2999-01-05' }, nextStep: null });
    expect(inProgress.lines.map((l) => l.label)).not.toContain('From your technician');
    const complete = buildWhatsNext({ program: { treatmentNumber: 2, treatmentsTotal: 2, complete: true }, species: 'German', scheduleResolved: true, nextStep: null });
    expect(complete.lines.map((l) => l.label)).not.toContain('From your technician');
    const unknownPosition = buildWhatsNext({ program: { treatmentNumber: null }, species: 'German', scheduleResolved: false, nextStep: null });
    expect(unknownPosition.lines.map((l) => l.label)).not.toContain('From your technician');
  });

  it('the next-visit plan and the between-visits copy are built ONLY from the work recorded today', () => {
    const full = buildWork(['Bait placement', 'Insect growth regulator', 'Monitoring stations placed']);
    const german = buildWhatsNext({ program: program1, species: 'German', work: full });
    expect(german.lines[0].text).toBe('Re-check every harborage point, refresh the bait and the growth regulator, read the monitors and compare against today.');
    expect(german.lines[1].text).toMatch(/7–10 days as the bait spreads/);
    // crack & crevice only: no bait / IGR / monitor promise anywhere
    const cc = buildWhatsNext({ program: program1, species: 'German', work: buildWork(['Crack & crevice treatment']) });
    expect(cc.lines[0].text).toBe('Re-check every harborage point and compare against today.');
    expect(cc.lines[0].text).not.toMatch(/bait|regulator|monitor/i);
    expect(cc.lines[1].text).not.toMatch(/bait/i);
    // nothing recorded at all (only species + level are required)
    const none = buildWhatsNext({ program: program1, species: 'American', work: [] });
    expect(none.lines[0].text).not.toMatch(/bait|regulator|monitor/i);
    expect(none.lines[1].text).toMatch(/flushed from hiding areas/);
    // completed program: "bait keeps working" only when bait was recorded
    const doneNoBait = buildWhatsNext({ program: { treatmentNumber: 2, treatmentsTotal: 2, complete: true }, species: 'German', work: buildWork(['Dust application']) });
    expect(doneNoBait.lines[0].text).toMatch(/^The treatment keeps working/);
    const doneBait = buildWhatsNext({ program: { treatmentNumber: 2, treatmentsTotal: 2, complete: true }, species: 'German', work: full });
    expect(doneBait.lines[0].text).toMatch(/^The bait keeps working/);
  });
});

describe('attachCockroachReportV2 — the one composer shared by the route and the queued PDF renderer', () => {
  const original = process.env.COCKROACH_REPORT_V2;
  afterEach(() => {
    if (original === undefined) delete process.env.COCKROACH_REPORT_V2;
    else process.env.COCKROACH_REPORT_V2 = original;
  });
  const service = { service_data: JSON.stringify({ completedServiceKey: 'cockroach_control', typedReportSnapshot: { type: 'cockroach', serviceKey: 'cockroach_control', values: GERMAN_MODERATE } }) };
  const payload = () => ({
    serviceLine: 'pest',
    typedReport: { type: 'cockroach', visitSequence: 1, todaysResult: { body: 'Reviewed body.', nextStep: 'Keep bait undisturbed.' } },
    activity: { score: 3, isBaseline: true, trend: null },
    summarySource: 'technician_report',
    summary: 'Reviewed copy.',
    cockroachNextTreatmentVisit: { scheduledDate: '2026-09-10', windowStart: '09:00:00', serviceType: 'Cockroach Treatment' },
    cockroachUpcomingRoachVisits: 1,
    cockroachProgramPosition: { treatmentNumber: 1 },
  });

  it('attaches from the frozen snapshot, consumes the live-only schedule fields, and reads presence as "schedule resolved"', () => {
    process.env.COCKROACH_REPORT_V2 = 'true';
    const data = attachCockroachReportV2(payload(), service);
    expect(data.cockroachReportV2.source).toBe('primary');
    expect(data.cockroachReportV2.status.label).toBe('German cockroach activity was moderate today');
    expect(data.cockroachReportV2.statusSummary).toBe('Reviewed body.');
    expect(data.cockroachReportV2.aiSummary.body).toBe('Reviewed copy.');
    expect(data.cockroachReportV2.nextVisit.scheduledDate).toBe('2026-09-10');
    expect(data.cockroachReportV2.whatsNext.lines[0]).toEqual({ label: 'Next treatment', kind: 'next_visit' });
    expect(data.cockroachReportV2.whatsNext.nextVisitMissing).toBe(false);
    expect(data).not.toHaveProperty('cockroachNextTreatmentVisit');
    expect(data).not.toHaveProperty('cockroachUpcomingRoachVisits');
    expect(data).not.toHaveProperty('cockroachProgramPosition');
  });

  it('the treatment number is the PACKAGE position from report-data, never the customer-wide gauge visitSequence', () => {
    process.env.COCKROACH_REPORT_V2 = 'true';
    // an older roach job put the gauge at visit 3; this package is on its first treatment
    const data = attachCockroachReportV2({ ...payload(), typedReport: { ...payload().typedReport, visitSequence: 3 }, cockroachProgramPosition: { treatmentNumber: 1 } }, service);
    expect(data.cockroachReportV2.program).toEqual({ treatmentNumber: 1, treatmentsTotal: 2, complete: false, laterCompleted: 0, scheduledAhead: 1 });
    expect(data.cockroachReportV2.whatsNext.title).toBe('Treatment 1 of 2 complete');
    // …and without a position (legacy / lookup failed) the builder falls back to treatment 1, not the gauge
    const noPos = payload(); delete noPos.cockroachProgramPosition; noPos.typedReport.visitSequence = 3;
    expect(attachCockroachReportV2(noPos, service).cockroachReportV2.program.treatmentNumber).toBe(1);
    // …and an explicit null position (lineage lookup failed) makes NO program claims
    const failed = attachCockroachReportV2({ ...payload(), cockroachProgramPosition: null }, service);
    expect(failed.cockroachReportV2.program.treatmentNumber).toBeNull();
    expect(failed.cockroachReportV2.whatsNext.badge).toBeNull();
    expect(failed.cockroachReportV2.whatsNext.lines.some((l) => l.label === 'Your program')).toBe(true);
    expect(failed).not.toHaveProperty('cockroachProgramPosition');
    // no lineage (legacy / hand-booked): unnumbered, no claim, but the booked next date still shows
    const legacy = attachCockroachReportV2({ ...payload(), cockroachProgramPosition: { treatmentNumber: null, reason: 'no_lineage' } }, service);
    expect(legacy.cockroachReportV2.program.treatmentNumber).toBeNull();
    expect(legacy.cockroachReportV2.whatsNext.lines[0]).toEqual({ label: 'Next treatment', kind: 'next_visit' });
    expect(legacy.cockroachReportV2.whatsNext.lines.some((l) => l.label === 'Your program')).toBe(false);
  });

  it('live view with the field present but null → exception copy; pdf (fields absent) → no date line either way', () => {
    process.env.COCKROACH_REPORT_V2 = 'true';
    const live = attachCockroachReportV2({ ...payload(), cockroachNextTreatmentVisit: null, cockroachUpcomingRoachVisits: 0 }, service);
    expect(live.cockroachReportV2.whatsNext.nextVisitMissing).toBe(true);
    expect(live.cockroachReportV2.nextVisit).toBeNull();
    const pdfPayload = payload();
    delete pdfPayload.cockroachNextTreatmentVisit;
    delete pdfPayload.cockroachUpcomingRoachVisits;
    const pdf = attachCockroachReportV2(pdfPayload, service);
    expect(pdf.cockroachReportV2.whatsNext.nextVisitMissing).toBe(false);
    expect(pdf.cockroachReportV2.whatsNext.lines.map((l) => l.label)).not.toContain('Next treatment');
    // the packaged total still prints on the PDF (catalog fact, not calendar)
    expect(pdf.cockroachReportV2.program).toEqual({ treatmentNumber: 1, treatmentsTotal: 2, complete: false, laterCompleted: 0, scheduledAhead: 0 });
    // a severity-priced cleanout's COMPLETION STATE reaches the PDF too: the
    // same-program upcoming count is passed in every mode, only the date is
    // not (codex P1 #3613 r1)
    const cleanout = { service_data: JSON.stringify({ completedServiceKey: 'german_roach', typedReportSnapshot: { type: 'cockroach', serviceKey: 'german_roach', values: GERMAN_MODERATE } }) };
    const finalPdf = attachCockroachReportV2({ ...pdfPayload, cockroachProgramPosition: { treatmentNumber: 2 }, cockroachUpcomingRoachVisits: 0 }, cleanout);
    expect(finalPdf.cockroachReportV2.program).toEqual({ treatmentNumber: 2, treatmentsTotal: 2, complete: true, laterCompleted: 0, scheduledAhead: 0 });
    expect(finalPdf.cockroachReportV2.whatsNext.badge).toBe('COMPLETE');
    expect(finalPdf.cockroachReportV2.whatsNext.lines.map((l) => l.label)).not.toContain('What we will do');
  });

  it('is a no-op (still consuming the live-only fields) when the gate is off, on a non-cockroach primary, or without a snapshot', () => {
    process.env.COCKROACH_REPORT_V2 = 'false';
    const off = attachCockroachReportV2(payload(), service);
    expect(off.cockroachReportV2).toBeUndefined();
    expect(off).not.toHaveProperty('cockroachNextTreatmentVisit');
    process.env.COCKROACH_REPORT_V2 = 'true';
    expect(attachCockroachReportV2({ ...payload(), typedReport: { type: 'bed_bug' } }, service).cockroachReportV2).toBeUndefined();
    expect(attachCockroachReportV2(payload(), { service_data: JSON.stringify({ typedReportSnapshot: { type: 'bed_bug', values: {} } }) }).cockroachReportV2).toBeUndefined();
    expect(attachCockroachReportV2(null, service)).toBeNull();
  });

  it('a primary cockroach dashboard evicts a Pest V2 payload the name-derived line may have composed', () => {
    process.env.COCKROACH_REPORT_V2 = 'true';
    const data = attachCockroachReportV2({ ...payload(), pestReportV2: { status: {} } }, service);
    expect(data.cockroachReportV2).toBeTruthy();
    expect(data).not.toHaveProperty('pestReportV2');
  });
});

describe('cockroachReportV2PdfSignature / snapshot helpers', () => {
  const original = process.env.COCKROACH_REPORT_V2;
  afterEach(() => {
    if (original === undefined) delete process.env.COCKROACH_REPORT_V2;
    else process.env.COCKROACH_REPORT_V2 = original;
  });
  const roach = { service_data: JSON.stringify({ typedReportSnapshot: { type: 'cockroach', serviceKey: 'german_roach', values: GERMAN_MODERATE } }) };

  it('is empty when the gate is off, keys the dashboard render + program state when on, and ignores other typed types / malformed data', async () => {
    process.env.COCKROACH_REPORT_V2 = 'false';
    expect(await cockroachReportV2PdfSignature(roach)).toBe('');
    process.env.COCKROACH_REPORT_V2 = 'true';
    // no knex → program state unresolved (keys as failed); the render makes no program claims either
    expect(await cockroachReportV2PdfSignature(roach)).toBe('-roachv2a-pf');
    expect(await cockroachReportV2PdfSignature({ service_data: JSON.stringify({ typedReportSnapshot: { type: 'german_roach_knockdown', values: {} } }) })).toBe('');
    expect(await cockroachReportV2PdfSignature({ service_data: '{not json' })).toBe('');
    expect(await cockroachReportV2PdfSignature({})).toBe('');
  });

  it('keys the calendar-derived program state so a scheduling change re-renders the cached PDF; a lineage failure keys as unknown', async () => {
    process.env.COCKROACH_REPORT_V2 = 'true';
    const record = { id: 'rec-2', customer_id: 'c1', scheduled_service_id: 'sch-2', service_date: '2026-05-16', service_type: 'German Roach Cleanout', service_data: JSON.stringify({ completedServiceKey: 'german_roach', typedReportSnapshot: { type: 'cockroach', serviceKey: 'german_roach', values: GERMAN_MODERATE } }) };
    const tables = {
      scheduled_services: [
        { id: 'sch-2', source_estimate_id: 'est-A' },
        { id: 'sch-1', source_estimate_id: 'est-A' },
        { id: 'sch-3', customer_id: 'c1', scheduled_date: '2999-01-05', status: 'confirmed', service_type: 'German Roach Cleanout', source_estimate_id: 'est-A', service_key_snapshot: 'german_roach' },
      ],
      service_records: [
        { id: 'rec-1', customer_id: 'c1', status: 'completed', service_date: '2026-05-02', service_type: 'German Roach Cleanout', scheduled_service_id: 'sch-1', service_data: JSON.stringify({ completedServiceKey: 'german_roach' }) },
      ],
      service_completion_profiles: [{ service_key: 'german_roach', active: true, completion_mode: 'service_report', project_type: 'cockroach' }],
      services: [{ id: 'svc-gr', service_key: 'german_roach', name: 'German Roach Cleanout', short_name: 'German Roach' }],
    };
    const fake = (fail) => {
      const knex = (table) => {
        if (fail && table === 'scheduled_services') throw new Error('db down');
        let rows = [...(tables[table] || [])];
        const q = {
          where(c, v) { if (typeof c === 'object') rows = rows.filter((r) => Object.entries(c).every(([k, x]) => r[k] === x)); else rows = rows.filter((r) => r[c] === v); return q; },
          andWhere(c, op, v) { if (op === '>=') rows = rows.filter((r) => String(r[c]) >= String(v)); if (op === '<') rows = rows.filter((r) => String(r[c]) < String(v)); if (op === '>') rows = rows.filter((r) => String(r[c]) > String(v)); return q; },
          whereIn(c, vs) { rows = rows.filter((r) => vs.includes(r[c])); return q; },
          whereNot(c, v) { rows = rows.filter((r) => r[c] !== v); return q; },
          whereRaw() { return q; }, modify(fn) { fn(q); return q; }, limit: () => q, orderBy: () => q, select: () => q, leftJoin: () => q,
          first: () => Promise.resolve(rows[0] || null),
          then: (res) => Promise.resolve(rows).then(res), catch: () => Promise.resolve(rows),
        };
        return q;
      };
      knex.schema = { hasTable: async () => true };
      return knex;
    };
    const sig = await cockroachReportV2PdfSignature(record, fake(false));
    expect(sig).toBe('-roachv2a-p2u1l0');
    // the calendar changes → different key → cache miss → re-render
    tables.scheduled_services = tables.scheduled_services.filter((r) => r.id !== 'sch-3');
    expect(await cockroachReportV2PdfSignature(record, fake(false))).toBe('-roachv2a-p2u0l0');
    // lineage lookup fails → FAILED key (render fails closed with the warning line)
    expect(await cockroachReportV2PdfSignature(record, fake(true))).toBe('-roachv2a-pf');
    // a valid no-lineage result keys separately from a failure: different copy, different key
    tables.scheduled_services = tables.scheduled_services.map((r) => (r.id === 'sch-2' ? { id: 'sch-2' } : r));
    expect(await cockroachReportV2PdfSignature(record, fake(false))).toBe('-roachv2a-pn');
    // finite-plan chain (recurring_parent_id + recurring_ongoing=false on both ends) IS lineage:
    // visit 2 of a chained package counts its parent as treatment 1 and its finite sibling as ahead
    tables.scheduled_services = [
      { id: 'sch-2', recurring_parent_id: 'sch-1', recurring_ongoing: false },
      { id: 'sch-1', recurring_ongoing: false },
      { id: 'sch-3', customer_id: 'c1', scheduled_date: '2999-01-05', status: 'confirmed', service_type: 'German Roach Cleanout', recurring_parent_id: 'sch-1', recurring_ongoing: false, service_key_snapshot: 'german_roach' },
      // an OPEN-ENDED child under the same parent never matches (routine schedule)
      { id: 'sch-4', customer_id: 'c1', scheduled_date: '2999-01-06', status: 'confirmed', service_type: 'German Roach Cleanout', recurring_parent_id: 'sch-1', recurring_ongoing: true, service_key_snapshot: 'german_roach' },
    ];
    expect(await cockroachReportV2PdfSignature(record, fake(false))).toBe('-roachv2a-p2u1l0');
    // …and an open-ended source visit is NOT a finite plan: no lineage
    tables.scheduled_services[0] = { id: 'sch-2', recurring_parent_id: 'sch-1', recurring_ongoing: true };
    expect(await cockroachReportV2PdfSignature(record, fake(false))).toBe('-roachv2a-pn');
  });

  it('frozen key: completedServiceKey first, else the snapshot\'s own serviceKey', () => {
    expect(frozenCockroachServiceKey(roach)).toBe('german_roach');
    expect(frozenCockroachServiceKey({ service_data: JSON.stringify({ completedServiceKey: 'cockroach_control', typedReportSnapshot: { type: 'cockroach', serviceKey: 'german_roach', values: {} } }) })).toBe('cockroach_control');
    expect(cockroachSnapshotOf(roach).type).toBe('cockroach');
    expect(cockroachSnapshotOf({})).toBeNull();
  });

  it('the dashboard field-key set covers every typed field the cards render', () => {
    expect([...COCKROACH_V2_DASHBOARD_FIELD_KEYS].sort()).toEqual(['activity_level', 'activity_locations', 'conducive_conditions', 'customer_prep', 'evidence_observed', 'species', 'work_completed']);
  });
});

// ── Work derived from the visit's product rows (owner ruling 2026-09-26) ──
// The "Work completed today" chips are gone from the cockroach form; the
// recorded product rows are the work record. Rows are shaped like
// report-data's applications[].
const app = ({ name, category = '', method = 'spot_treatment', area = null, ai = '', type = null }) => ({
  product: { name, category, product_type: type, active_ingredient: ai },
  method,
  methodInferred: false,
  applicationArea: area,
});
const ADVION = app({ name: 'Advion Cockroach Gel Bait', category: 'bait', method: 'bait_placement', ai: 'indoxacarb' });
const GENTROL = app({ name: 'Gentrol IGR', category: 'IGR', ai: 'Hydroprene' });
const ALPINE = app({ name: 'Alpine WSG', category: 'insecticide', ai: 'dinotefuran' });
const NO_WORK_SNAPSHOT = { species: 'German', activity_level: 'Moderate', activity_locations: ['Kitchen'], customer_prep: [] };

describe('the cockroach form no longer offers work_completed', () => {
  it('is removed from the typed schema for cockroach ONLY; sibling lanes keep their work chips', () => {
    const keys = (type) => PROJECT_TYPES[type].findingsFields.map((f) => f.key);
    expect(keys('cockroach')).not.toContain('work_completed');
    expect(keys('bed_bug')).toContain('work_completed');
    expect(keys('one_time_pest_treatment')).toContain('work_completed');
    expect(keys('german_roach_knockdown')).toContain('treatment_completed');
    expect(keys('palmetto_roach_knockdown')).toContain('treatment_completed');
  });

  it('a NEW submission carrying the retired key is rejected like every other retired field', () => {
    const result = ActivityIndicators.validateTypedFindings({
      type: 'cockroach', expectedType: 'cockroach',
      values: { species: 'German', activity_level: 'Low', work_completed: 'Bait placement' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('Unknown findings field: work_completed');
  });

  it('a STORED snapshot\'s chips keep classifying as treatment evidence (old records unchanged)', () => {
    expect(ActivityIndicators.typedTreatmentEvidence('cockroach', { work_completed: 'Bait placement' }))
      .toEqual({ applied: true, performed: true, noWork: false, dryDown: false, declared: true, reentryWait: false });
    expect(ActivityIndicators.typedTreatmentEvidence('cockroach', { work_completed: 'Crack & crevice treatment, Bait placement' }).dryDown).toBe(true);
    expect(ActivityIndicators.typedTreatmentEvidence('cockroach', {}).declared).toBe(false);
    // the retired map is not part of the live every-label-exists registry
    expect(ActivityIndicators.TYPED_TREATMENT_OPTIONS).not.toHaveProperty('cockroach');
  });
});

describe('workChipsFromApplications — classification from the recorded row', () => {
  it('the three default cockroach products map to bait / IGR / crack & crevice, in the canonical order', () => {
    expect(workChipsFromApplications([ALPINE, GENTROL, ADVION])).toEqual(['Bait placement', 'Insect growth regulator', 'Crack & crevice treatment']);
  });

  it('classifies by catalog category / method / active ingredient before any brand name', () => {
    // a different bait product recorded through the bait method or a bait category
    expect(workChipsFromApplications([app({ name: 'Some Roach Product', category: 'gel', method: 'bait_placement' })])).toEqual(['Bait placement']);
    expect(workChipsFromApplications([app({ name: 'Unbranded', category: 'Bait' })])).toEqual(['Bait placement']);
    // an unbranded IGR by category, and by active ingredient with no category
    expect(workChipsFromApplications([app({ name: 'Unbranded', category: 'Insect Growth Regulator' })])).toEqual(['Insect growth regulator']);
    expect(workChipsFromApplications([app({ name: 'Unbranded', ai: 'pyriproxyfen' })])).toEqual(['Insect growth regulator']);
    // a dust by product identity
    expect(workChipsFromApplications([app({ name: 'Delta Dust', category: 'insecticide' })])).toEqual(['Dust application']);
    // name-only fallbacks for the known products (no category, no method on the row)
    expect(workChipsFromApplications([app({ name: 'Advion Cockroach Gel Bait', method: '' }), app({ name: 'Gentrol IGR', method: '' }), app({ name: 'Alpine WSG', method: '' })]))
      .toEqual(['Bait placement', 'Insect growth regulator', 'Crack & crevice treatment']);
  });

  it('an unrecognised product yields NO line — never a claim without a recorded fact', () => {
    expect(workChipsFromApplications([app({ name: 'Atticus Talak', category: 'insecticide', ai: 'bifenthrin' })])).toEqual([]);
    expect(workChipsFromApplications([app({ name: 'Taurus SC', category: 'insecticide', method: 'perimeter_spray' })])).toEqual([]);
    expect(workChipsFromApplications([])).toEqual([]);
    expect(workChipsFromApplications(null)).toEqual([]);
    expect(workChipsFromApplications([{ product: {} }, {}])).toEqual([]);
    // the unknown row does not disturb the recognised ones beside it
    expect(workChipsFromApplications([app({ name: 'Atticus Talak', category: 'insecticide' }), ADVION])).toEqual(['Bait placement']);
  });

  it('adjuvants, nutrients and other pest classes\' devices are never a roach treatment', () => {
    expect(workChipsFromApplications([
      app({ name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' }),
      app({ name: 'Bait Station Cartridge', category: 'termite bait', method: 'bait_placement' }),
      app({ name: 'Rodent Block', category: 'rodenticide bait', method: 'bait_placement' }),
      app({ name: 'Glue Board', category: 'glue', method: 'bait_placement' }),
      app({ name: 'Celsius WG', category: 'herbicide' }),
    ])).toEqual([]);
  });

  it('the exterior perimeter line rides the row\'s application AREA — never the stored method alone', () => {
    // 'perimeter_spray' is the DEFAULT method stored for any methodless pest product: not evidence
    expect(workChipsFromApplications([app({ name: 'Taurus SC', category: 'insecticide', method: 'perimeter_spray' })])).toEqual([]);
    expect(workChipsFromApplications([app({ name: 'Alpine WSG', method: 'perimeter_spray' })])).toEqual(['Crack & crevice treatment']);
    // an unknown pesticide applied to a controlled exterior area does say exterior perimeter
    expect(workChipsFromApplications([app({ name: 'Taurus SC', category: 'insecticide', method: 'perimeter_spray', area: 'Exterior perimeter' })])).toEqual(['Exterior perimeter treatment']);
    // Alpine: exterior area + a non-spot method reads perimeter only; a spot method keeps both recorded facts
    expect(workChipsFromApplications([app({ name: 'Alpine WSG', method: 'perimeter_spray', area: 'Exterior perimeter' })])).toEqual(['Exterior perimeter treatment']);
    expect(workChipsFromApplications([app({ name: 'Alpine WSG', method: 'spot_treatment', area: 'Exterior perimeter' })])).toEqual(['Crack & crevice treatment', 'Exterior perimeter treatment']);
    // an INTERIOR area chip is never exterior evidence
    expect(workChipsFromApplications([app({ name: 'Taurus SC', category: 'insecticide', area: 'Interior entry points' })])).toEqual([]);
    // bait / IGR never turn into a perimeter line
    expect(workChipsFromApplications([{ ...ADVION, applicationArea: 'Exterior perimeter' }, { ...GENTROL, applicationArea: 'Exterior perimeter' }])).toEqual(['Bait placement', 'Insect growth regulator']);
  });
});

describe('buildCockroachReportV2 — "What we did" from products when the snapshot has no chips', () => {
  const build = (extra = {}) => buildCockroachReportV2({
    typedSnapshotValues: NO_WORK_SNAPSHOT, typedReportType: 'cockroach', serviceKey: 'cockroach_control', ...extra,
  });

  it('a products-only visit shows bait / IGR / crack & crevice work, the treatments metric and the bait-aware next steps', () => {
    const out = build({ applications: [ALPINE, GENTROL, ADVION] });
    expect(out.work.map((w) => w.short)).toEqual(['Bait', 'IGR', 'Crack & crevice']);
    expect(out.work[0].title).toBe('Placed gel bait at the active harborage points');
    expect(out.metrics).toContainEqual({ label: 'Treatments applied', value: 'Bait · IGR · Crack & crevice' });
    expect(out.statusSummary).toMatch(/We placed gel bait at the active harborage points, applied an insect growth regulator, crack & crevice treatment\./);
    expect(out.whatsNext.lines.find((l) => l.label === 'What we will do').text).toBe('Re-check every harborage point, refresh the bait and the growth regulator and compare against today.');
    expect(out.whatsNext.lines.find((l) => l.label === 'Between now and then').text).toMatch(/bait spreads|Bait keeps working|tapers/);
  });

  it('the "keep bait" German prep joins ONLY when bait was recorded (from the product rows)', () => {
    const german = { ...NO_WORK_SNAPSHOT, species: 'German' };
    const withBait = buildCockroachReportV2({ typedSnapshotValues: german, typedReportType: 'cockroach', applications: [ADVION] });
    expect(withBait.help.items.map((i) => i.key)).toContain('keep_bait');
    expect(withBait.help.why).toMatch(/The bait only works if roaches can reach it/);
    const noBait = buildCockroachReportV2({ typedSnapshotValues: german, typedReportType: 'cockroach', applications: [ALPINE, GENTROL] });
    expect(noBait.help.items.map((i) => i.key)).not.toContain('keep_bait');
    expect(noBait.help.items.map((i) => i.key)).toEqual(['no_sprays', 'food_debris']);
    expect(noBait.whatsNext.lines.find((l) => l.label === 'What we will do').text).not.toMatch(/bait/i);
    expect(noBait.whatsNext.lines.find((l) => l.label === 'What we will do').text).toMatch(/growth regulator/);
  });

  it('no chips and no products: no work, no metric, no invented claim', () => {
    for (const applications of [undefined, null, [], [app({ name: 'Atticus Talak', category: 'insecticide' })]]) {
      const out = build({ applications });
      expect(out.work).toEqual([]);
      expect(out.metrics.map((m) => m.label)).not.toContain('Treatments applied');
      expect(out.statusSummary).not.toMatch(/We (placed|applied|treated)/);
      expect(out.whatsNext.lines.find((l) => l.label === 'What we will do').text).toBe('Re-check every harborage point and compare against today.');
    }
  });

  it('OLD records: stored chips WIN — products never add to, remove from or reorder the chips', () => {
    const old = { ...NO_WORK_SNAPSHOT, work_completed: ['Dust application', 'Monitoring stations placed'] };
    const out = buildCockroachReportV2({ typedSnapshotValues: old, typedReportType: 'cockroach', applications: [ALPINE, GENTROL, ADVION] });
    expect(out.work.map((w) => w.short)).toEqual(['Dust', 'Monitors']);
    // …and identical to the same record with no products at all
    const without = buildCockroachReportV2({ typedSnapshotValues: old, typedReportType: 'cockroach' });
    expect(out).toEqual(without);
    expect(out.help.items.map((i) => i.key)).not.toContain('keep_bait');
  });

  it('the generic frozen Today\'s Result body yields to the product-derived summary; any other body is kept', () => {
    const generic = build({ applications: [ADVION], todaysResultBody: GENERIC_WHAT_WE_DID });
    expect(generic.statusSummary).toMatch(/We placed gel bait/);
    expect(generic.statusSummary).not.toBe(GENERIC_WHAT_WE_DID);
    // a real narrative (e.g. the reviewed AI copy) is never replaced
    const reviewed = build({ applications: [ADVION], todaysResultBody: 'We baited behind the fridge.' });
    expect(reviewed.statusSummary).toBe('We baited behind the fridge.');
    // nothing derived → the generic body stays exactly as before
    expect(build({ applications: [], todaysResultBody: GENERIC_WHAT_WE_DID }).statusSummary).toBe(GENERIC_WHAT_WE_DID);
    // a record WITH stored chips keeps its body untouched
    const chipped = buildCockroachReportV2({ typedSnapshotValues: { ...NO_WORK_SNAPSHOT, work_completed: ['Bait placement'] }, typedReportType: 'cockroach', applications: [ADVION], todaysResultBody: GENERIC_WHAT_WE_DID });
    expect(chipped.statusSummary).toBe(GENERIC_WHAT_WE_DID);
  });

  it('the generic-body constant is exactly what the Today\'s Result generator writes for a chip-less cockroach snapshot', () => {
    const snapshot = ActivityIndicators.buildTypedReportSnapshot({
      projectType: 'cockroach', values: { species: 'German', activity_level: 'Moderate' }, serviceKey: 'cockroach_control',
      visitSequence: 1, activity: { indicatorKey: 'roach_activity', label: 'Roach activity', score: 3, source: 'derived' },
    });
    expect(snapshot.todaysResult.body).toBe(GENERIC_WHAT_WE_DID);
  });
});

describe('attachCockroachReportV2 — derives work from data.applications', () => {
  const original = process.env.COCKROACH_REPORT_V2;
  afterEach(() => {
    if (original === undefined) delete process.env.COCKROACH_REPORT_V2;
    else process.env.COCKROACH_REPORT_V2 = original;
  });
  const chipless = { service_data: JSON.stringify({ completedServiceKey: 'cockroach_control', typedReportSnapshot: { type: 'cockroach', serviceKey: 'cockroach_control', values: NO_WORK_SNAPSHOT } }) };
  const payload = (applications) => ({
    serviceLine: 'pest',
    applications,
    typedReport: { type: 'cockroach', visitSequence: 1, todaysResult: { body: GENERIC_WHAT_WE_DID, nextStep: null } },
    activity: { score: 3, isBaseline: true, trend: null },
    cockroachProgramPosition: { treatmentNumber: 1 },
  });

  it('live, pdf and static payloads all carry applications, so the page reads the same work in every mode', () => {
    process.env.COCKROACH_REPORT_V2 = 'true';
    const data = attachCockroachReportV2(payload([ALPINE, GENTROL, ADVION]), chipless);
    expect(data.cockroachReportV2.work.map((w) => w.short)).toEqual(['Bait', 'IGR', 'Crack & crevice']);
    expect(data.cockroachReportV2.statusSummary).toMatch(/We placed gel bait/);
    // the applications array itself is left alone (other cards read it)
    expect(data.applications).toHaveLength(3);
    // a payload with no applications key (never happens from report-data) still composes
    const bare = payload(undefined); delete bare.applications;
    expect(attachCockroachReportV2(bare, chipless).cockroachReportV2.work).toEqual([]);
  });
});

describe('cockroachWorkSourceSignature — keyed on the DERIVED work, chipped records keep their PDF keys', () => {
  const original = process.env.COCKROACH_REPORT_V2;
  afterEach(() => {
    if (original === undefined) delete process.env.COCKROACH_REPORT_V2;
    else process.env.COCKROACH_REPORT_V2 = original;
  });
  const rec = (values) => ({ id: 'rec-1', service_data: JSON.stringify({ typedReportSnapshot: { type: 'cockroach', serviceKey: 'cockroach_control', values } }) });

  it('is empty for a record with stored chips whatever the derived work is (no old PDF is re-rendered)', () => {
    const chipped = rec(GERMAN_MODERATE);
    expect(cockroachWorkSourceSignature(chipped, ['Bait placement'])).toBe('');
    expect(cockroachWorkSourceSignature(chipped, null)).toBe('');
    expect(cockroachWorkSourceSignature({}, ['Bait placement'])).toBe('');
    // …and a chip-less record whose products derive nothing keeps the pre-change key too
    expect(cockroachWorkSourceSignature(rec(NO_WORK_SNAPSHOT), [])).toBe('');
  });

  it('a chip-less record keys the derived chips: different work → different key; same work → same key; failed load → unknown', () => {
    const chipless = rec(NO_WORK_SNAPSHOT);
    const bait = cockroachWorkSourceSignature(chipless, ['Bait placement']);
    expect(bait).toMatch(/^-w[0-9a-f]{8}$/);
    expect(cockroachWorkSourceSignature(chipless, ['Bait placement', 'Insect growth regulator'])).not.toBe(bait);
    expect(cockroachWorkSourceSignature(chipless, ['Bait placement'])).toBe(bait);
    expect(cockroachWorkSourceSignature(chipless, null)).toBe('-wf');
  });
});

describe('the PDF cache-key lookup and the render stamp derive the SAME work (same enrichment, same classifier)', () => {
  const { buildReportV1Data, deriveCockroachWorkChipsForRecord, cockroachClassifierApplication } = require('../services/service-report/report-data');
  const original = process.env.COCKROACH_REPORT_V2;
  beforeEach(() => { process.env.COCKROACH_REPORT_V2 = 'true'; });
  afterEach(() => {
    if (original === undefined) delete process.env.COCKROACH_REPORT_V2;
    else process.env.COCKROACH_REPORT_V2 = original;
  });

  function makeKnex(tables, { failCatalog = false, failProducts = false } = {}) {
    const knex = (table) => {
      if (failProducts && table === 'service_products') throw new Error('db down');
      let rows = [...(tables[table] || [])];
      const q = {
        where(c, v) { if (c && typeof c === 'object') rows = rows.filter((r) => Object.entries(c).every(([k, x]) => r[k] === x)); else if (typeof c === 'string') rows = rows.filter((r) => r[c] === v); return q; },
        andWhere(c, op, v) { if (op === '>=') rows = rows.filter((r) => String(r[c]) >= String(v)); if (op === '<') rows = rows.filter((r) => String(r[c]) < String(v)); if (op === '>') rows = rows.filter((r) => String(r[c]) > String(v)); return q; },
        whereIn(c, vs) { rows = rows.filter((r) => vs.includes(r[c])); return q; },
        whereNot(c, v) { rows = rows.filter((r) => r[c] !== v); return q; },
        whereRaw() { return q; }, modify(fn) { fn(q); return q; }, limit: () => q, orderBy: () => q, leftJoin: () => q,
        select: () => {
          if (failCatalog && table === 'products_catalog') return Promise.reject(new Error('catalog down'));
          return q;
        },
        first: () => Promise.resolve(rows[0] || null),
        then: (res, rej) => Promise.resolve(rows).then(res, rej), catch: () => Promise.resolve(rows),
      };
      return q;
    };
    knex.schema = { hasTable: async () => true };
    return knex;
  }

  const catalog = (over = {}) => ({ id: 'cat-1', name: 'Mystery Roach Product', category: 'insecticide', product_type: 'pesticide', active_ingredient: 'x', epa_reg_number: '1-1', approved_for_service_report: true, ...over });
  const productRow = (over = {}) => ({ id: 'sp-1', service_record_id: 'rec-w', product_id: 'cat-1', product_name: 'Mystery Roach Product', product_category: null, application_method: 'spot_treatment', application_area: 'Kitchen', created_at: '2026-05-16', ...over });
  const service = (extra = {}) => ({
    id: 'rec-w', customer_id: 'c1', service_line: 'pest', service_type: 'Cockroach Control Service', service_date: '2026-05-16',
    first_name: 'A', last_name: 'B', areas_serviced: '[]', structured_notes: '{}', pressure_index: 0,
    service_data: JSON.stringify({ typedReportSnapshot: { type: 'cockroach', serviceKey: 'cockroach_control', values: NO_WORK_SNAPSHOT } }),
    ...extra,
  });
  const base = (over = {}) => ({ service_products: [productRow()], products_catalog: [catalog()], property_geometries: [], property_zones: [], service_findings: [], service_photos: [], scheduled_services: [], ...over });

  async function both(svc, tables, opts) {
    const knex = makeKnex(tables, opts);
    const data = await buildReportV1Data(svc, 'tok', knex, { mode: 'pdf' });
    const lookup = await cockroachReportV2PdfSignature(svc, knex);
    const rendered = cockroachReportV2RenderedSignature(data, svc);
    return { lookup, rendered, chips: await deriveCockroachWorkChipsForRecord(svc, knex) };
  }

  it('an unknown product derives no work: no key on either side', async () => {
    const { lookup, rendered, chips: derived } = await both(service(), base());
    expect(derived).toEqual([]);
    expect(lookup).toBe(rendered);
    expect(rendered).not.toMatch(/-w/);
  });

  it('a catalog CATEGORY correction that changes the derived work changes the key — and both sides agree before and after', async () => {
    const before = await both(service(), base());
    const after = await both(service(), base({ products_catalog: [catalog({ category: 'IGR' })] }));
    expect(after.chips).toEqual(['Insect growth regulator']);
    expect(after.lookup).toBe(after.rendered);
    expect(after.rendered).toMatch(/-w[0-9a-f]{8}$/);
    expect(after.rendered).not.toBe(before.rendered);
    const bait = await both(service(), base({ products_catalog: [catalog({ category: 'bait' })] }));
    expect(bait.chips).toEqual(['Bait placement']);
    expect(bait.lookup).toBe(bait.rendered);
    expect(bait.rendered).not.toBe(after.rendered);
  });

  it('a change that does NOT alter the derived work leaves the key unchanged (name, area, catalog note)', async () => {
    const one = await both(service(), base({ products_catalog: [catalog({ category: 'IGR' })] }));
    const two = await both(service(), base({
      service_products: [productRow({ application_area: 'Pantry', product_name: 'Renamed Product' })],
      products_catalog: [catalog({ category: 'IGR', name: 'Renamed Product', active_ingredient: 'other' })],
    }));
    expect(two.chips).toEqual(one.chips);
    expect(two.rendered).toBe(one.rendered);
    expect(two.lookup).toBe(two.rendered);
  });

  it('frozen reportIdentitySnapshot product facts win over a later live catalog edit, on both sides', async () => {
    const frozen = { productFacts: { 'cat-1': { productType: 'pesticide', name: 'Mystery Roach Product', category: 'IGR', activeIngredient: 'x' } } };
    const svc = service({ report_identity_snapshot: frozen });
    // the live catalog now says bait; the frozen facts still say IGR
    const r = await both(svc, base({ products_catalog: [catalog({ category: 'bait' })] }));
    expect(r.chips).toEqual(['Insect growth regulator']);
    expect(r.lookup).toBe(r.rendered);
  });

  it('a failed catalog enrichment (rows with no stored category) keys unknown on both sides', async () => {
    const r = await both(service(), base({ products_catalog: [catalog({ category: 'IGR' })] }), { failCatalog: true });
    expect(r.chips).toBeNull();
    expect(r.lookup).toBe('-roachv2a-pn-wf');
    expect(r.rendered).toBe(r.lookup);
  });

  it('a failed product read keys unknown; a chipped record never reads or keys the rows', async () => {
    const knex = makeKnex(base(), { failProducts: true });
    expect(await deriveCockroachWorkChipsForRecord(service(), knex)).toBeNull();
    expect(await cockroachReportV2PdfSignature(service(), knex)).toMatch(/-wf$/);
    const chipped = service({ service_data: JSON.stringify({ typedReportSnapshot: { type: 'cockroach', serviceKey: 'cockroach_control', values: GERMAN_MODERATE } }) });
    const r = await both(chipped, base({ products_catalog: [catalog({ category: 'IGR' })] }));
    expect(r.lookup).toBe(r.rendered);
    expect(r.lookup).not.toMatch(/-w/);
  });

  it('cockroachClassifierApplication reads the same row fields the render builds', () => {
    const app = cockroachClassifierApplication({ product_name: 'X', product_category: 'IGR', active_ingredient: 'y', approved_report_product_facts: { productType: 'pesticide' }, application_method: 'spot_treatment', application_area: 'Kitchen' }, 'pest');
    expect(app).toEqual({ product: { name: 'X', category: 'IGR', product_type: 'pesticide', active_ingredient: 'y' }, method: 'spot_treatment', applicationArea: 'Kitchen' });
  });
});

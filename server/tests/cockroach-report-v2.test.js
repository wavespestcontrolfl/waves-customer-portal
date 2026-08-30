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
  cockroachReportV2RenderedSignature,
  COCKROACH_V2_DASHBOARD_FIELD_KEYS,
} = require('../services/service-report/cockroach-report-v2');

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
    expect(out.program).toEqual({ treatmentNumber: 1, treatmentsTotal: 2, complete: false });
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
    expect(resolveProgram({ serviceKey: 'cockroach_control', treatmentNumber: 1 })).toEqual({ treatmentNumber: 1, treatmentsTotal: 2, complete: false });
    expect(resolveProgram({ serviceKey: 'cockroach_control', treatmentNumber: 2 })).toEqual({ treatmentNumber: 2, treatmentsTotal: 2, complete: true });
    expect(resolveProgram({ serviceKey: 'german_roach_initial', treatmentNumber: 2 })).toEqual({ treatmentNumber: 2, treatmentsTotal: 3, complete: false });
    // german_roach: 1 upcoming roach visit → 2 total
    expect(resolveProgram({ serviceKey: 'german_roach', treatmentNumber: 1, upcomingRoachVisits: 1 })).toEqual({ treatmentNumber: 1, treatmentsTotal: 2, complete: false });
    expect(resolveProgram({ serviceKey: 'german_roach', treatmentNumber: 2, upcomingRoachVisits: 0 })).toEqual({ treatmentNumber: 2, treatmentsTotal: 2, complete: true });
    // treatment 1 with nothing on the calendar: total UNKNOWN, not complete
    expect(resolveProgram({ serviceKey: 'german_roach', treatmentNumber: 1, upcomingRoachVisits: 0 })).toEqual({ treatmentNumber: 1, treatmentsTotal: null, complete: false });
    // pdf/static (calendar not resolved): total unknown, never "complete"
    expect(resolveProgram({ serviceKey: 'german_roach', treatmentNumber: 2 })).toEqual({ treatmentNumber: 2, treatmentsTotal: null, complete: false });
    // a package never reads "3 of 2"
    expect(resolveProgram({ serviceKey: 'cockroach_control', treatmentNumber: 3 })).toEqual({ treatmentNumber: 3, treatmentsTotal: 3, complete: true });
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
    expect(cockroachReportV2RenderedSignature({}, service)).toBe('-roachv2a-px');
    expect(cockroachReportV2RenderedSignature({ cockroachReportV2RenderedSignature: '-roachv2a-p2u1' }, {})).toBe('');
    process.env.COCKROACH_REPORT_V2 = 'false';
    expect(cockroachReportV2RenderedSignature({ cockroachReportV2RenderedSignature: '-roachv2a-p2u1' }, service)).toBe('');
    delete process.env.COCKROACH_REPORT_V2;
  });
});

describe('unknown program position (lineage lookup failed) → no program claims', () => {
  it('builder: no number, no badge, no next-visit plan; attach: null position field means unknown, absent field means treatment 1', () => {
    const out = buildCockroachReportV2({ typedSnapshotValues: GERMAN_MODERATE, typedReportType: 'cockroach', serviceKey: 'cockroach_control', treatmentNumber: null, scheduleResolved: true, nextVisit: { scheduledDate: '2999-01-01' } });
    expect(out.program).toEqual({ treatmentNumber: null, treatmentsTotal: null, complete: false });
    expect(out.whatsNext.title).toBe("Today's treatment");
    expect(out.whatsNext.title).not.toMatch(/complete/i);
    expect(out.whatsNext.badge).toBeNull();
    expect(out.whatsNext.lines.map((l) => l.label)).toEqual(['Between now and then', 'Your program']);
    expect(JSON.stringify(out.whatsNext)).not.toMatch(/complete/i);
    expect(out.whatsNext.nextVisitMissing).toBe(false);
    expect(resolveProgram({ serviceKey: 'cockroach_control', treatmentNumber: null })).toEqual({ treatmentNumber: null, treatmentsTotal: null, complete: false });
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
    expect(data.cockroachReportV2.program).toEqual({ treatmentNumber: 1, treatmentsTotal: 2, complete: false });
    expect(data.cockroachReportV2.whatsNext.title).toBe('Treatment 1 of 2 complete');
    // …and without a position (legacy / lookup failed) the builder falls back to treatment 1, not the gauge
    const noPos = payload(); delete noPos.cockroachProgramPosition; noPos.typedReport.visitSequence = 3;
    expect(attachCockroachReportV2(noPos, service).cockroachReportV2.program.treatmentNumber).toBe(1);
    // …and an explicit null position (lineage lookup failed) makes NO program claims
    const failed = attachCockroachReportV2({ ...payload(), cockroachProgramPosition: null }, service);
    expect(failed.cockroachReportV2.program.treatmentNumber).toBeNull();
    expect(failed.cockroachReportV2.whatsNext.badge).toBeNull();
    expect(failed).not.toHaveProperty('cockroachProgramPosition');
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
    expect(pdf.cockroachReportV2.program).toEqual({ treatmentNumber: 1, treatmentsTotal: 2, complete: false });
    // a severity-priced cleanout's COMPLETION STATE reaches the PDF too: the
    // same-program upcoming count is passed in every mode, only the date is
    // not (codex P1 #3613 r1)
    const cleanout = { service_data: JSON.stringify({ completedServiceKey: 'german_roach', typedReportSnapshot: { type: 'cockroach', serviceKey: 'german_roach', values: GERMAN_MODERATE } }) };
    const finalPdf = attachCockroachReportV2({ ...pdfPayload, cockroachProgramPosition: { treatmentNumber: 2 }, cockroachUpcomingRoachVisits: 0 }, cleanout);
    expect(finalPdf.cockroachReportV2.program).toEqual({ treatmentNumber: 2, treatmentsTotal: 2, complete: true });
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
    // no knex → program state unknown ('x'); the render makes no program claims either
    expect(await cockroachReportV2PdfSignature(roach)).toBe('-roachv2a-px');
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
          andWhere(c, op, v) { if (op === '>=') rows = rows.filter((r) => String(r[c]) >= String(v)); if (op === '<') rows = rows.filter((r) => String(r[c]) < String(v)); return q; },
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
    expect(sig).toBe('-roachv2a-p2u1');
    // the calendar changes → different key → cache miss → re-render
    tables.scheduled_services = tables.scheduled_services.filter((r) => r.id !== 'sch-3');
    expect(await cockroachReportV2PdfSignature(record, fake(false))).toBe('-roachv2a-p2u0');
    // lineage lookup fails → unknown key, and the resolver reports failure (render fails closed)
    expect(await cockroachReportV2PdfSignature(record, fake(true))).toBe('-roachv2a-px');
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

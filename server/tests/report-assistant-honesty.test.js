// Honesty guards for the deterministic report assistant + consistency layer
// (2026-07-16 audit): the assistant must never invent a pressure reading,
// never phrase re-entry as a minute count (owner site-compliance rule), and
// the consistency layer must never fabricate a "Follow-up already planned"
// card from routine sign-off prose.

const { answerServiceReportQuestion, answerAppliedToday, routeServiceReportQuestion } = require('../services/service-report/report-assistant');
const { reconcileLawnReport } = require('../services/service-report/report-consistency');
const { buildLawnReportV2 } = require('../services/service-report/lawn-report-v2');

describe('assistant never invents a pressure reading', () => {
  test('trend question on a report with no pressure data says so instead of "0.3"', () => {
    const answer = answerServiceReportQuestion({
      question: 'How is my pest trend?',
      data: { pressureIndex: null, dynamicContext: {} },
    });
    expect(answer).toContain('was not recorded');
    expect(answer).not.toContain('0.3');
  });

  test('a real reading still answers with the visible index', () => {
    const answer = answerServiceReportQuestion({
      question: 'How is my pest trend?',
      data: { pressureIndex: 1.8, dynamicContext: {} },
    });
    expect(answer).toContain('1.8 on a 0-5 scale');
  });
});

describe('assistant re-entry fallback never states minutes', () => {
  test('advisory minutes phrase as "fully dry", not a minute count', () => {
    const answer = answerServiceReportQuestion({
      question: 'When can I re-enter treated areas?',
      data: {
        dynamicContext: {},
        advisory: { exterior_reentry_min: 240, interior_reentry_min: 30, pet_advisory: 'Keep pets off treated areas until dry.' },
      },
    });
    expect(answer).not.toMatch(/\d+\s*min/i);
    expect(answer).toContain('fully dry');
    expect(answer).toContain('Keep pets off treated areas until dry.');
  });

  test('the reworded suggested question still routes to the re-entry answer', () => {
    const answer = answerServiceReportQuestion({
      question: 'When can I re-enter treated areas?',
      data: { dynamicContext: { reentry: { customerSummary: 'Treated areas are ready for normal use.' } } },
    });
    expect(answer).toBe('Treated areas are ready for normal use.');
  });
});

describe('consistency layer never fabricates a planned follow-up from sign-off prose', () => {
  function reconcile(summaryText, { nextVisitFocus = null } = {}) {
    const lawnAssessment = {
      scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, overallScore: 68 },
      aiSummary: summaryText,
      recommendations: nextVisitFocus ? { nextVisitFocus } : {},
    };
    const reportV2 = buildLawnReportV2({ lawnAssessment });
    return reconcileLawnReport({ data: { lawnAssessment, summary: '' }, reportV2 });
  }

  test('routine sign-off "see you at your next visit" fabricates nothing', () => {
    const result = reconcile('Great visit today. We will see you at your next visit.');
    expect(result?.followUp || null).toBeNull();
  });

  test('watering advice "return to normal watering" fabricates nothing', () => {
    const result = reconcile('You can return to normal watering tomorrow.');
    expect(result?.followUp || null).toBeNull();
  });

  test('an explicit commitment still surfaces the follow-up card', () => {
    const result = reconcile('We flagged the mid-lawn zone and a follow-up is planned to recheck it.');
    expect(result?.followUp).toMatchObject({ scheduled: true, headline: 'Follow-up already planned' });
  });

  test('a real nextVisitFocus still counts regardless of prose', () => {
    const result = reconcile('Routine service completed.', { nextVisitFocus: 'Recheck the mid-lawn irrigation coverage.' });
    expect(result?.followUp).toMatchObject({ scheduled: true });
    expect(result.followUp.reason).toContain('Recheck the mid-lawn');
  });
});

// Today's-result reconciliation leads with THIS visit's story (owner
// feedback 2026-08-03): the summary's first sentence is already vetted
// customer copy rendered verbatim in Visit Summary, so it can't introduce a
// new claim. Anything unusable keeps the neutral lead — never a truncated
// or thank-you-first hero line.
describe('reconciled todaysResult leads with the visit summary', () => {
  function reconcile(dataSummary) {
    const lawnAssessment = {
      scores: { turfDensity: 73, weedSuppression: 81, colorHealth: 77, stressDamage: 35, overallScore: 68 },
      aiSummary: 'We flagged the mid-lawn zone and a follow-up is planned to recheck it.',
      recommendations: { nextVisitFocus: 'Recheck the mid-lawn zone.' },
    };
    const reportV2 = buildLawnReportV2({ lawnAssessment });
    return reconcileLawnReport({ data: { lawnAssessment, summary: dataSummary }, reportV2 });
  }

  test('uses the summary first sentence as the lead', () => {
    const result = reconcile(
      'The front and back yards received a lawn application addressing large patch and fire ants. More prose follows.',
    );
    // No appended fixed clause (owner 2026-08-04): "No urgent homeowner
    // action is needed today." rendered on every reconciled report and
    // contradicted snapshots carrying a real "Your next step".
    expect(result.todaysResult).toBe(
      'The front and back yards received a lawn application addressing large patch and fire ants.',
    );
  });

  test('empty summary keeps the neutral lead', () => {
    expect(reconcile('').todaysResult).toMatch(/^Routine service completed\./);
  });

  test('a thank-you greeting never opens the hero line', () => {
    const result = reconcile('Thanks for having us out today. We treated the full lawn for chinch bugs.');
    expect(result.todaysResult).toMatch(/^We treated the full lawn for chinch bugs\./);
  });

  test('abbreviation periods are not sentence boundaries ("The St." must never ship)', () => {
    const result = reconcile('The St. Augustine lawn received a preventive fungicide application. More prose follows.');
    expect(result.todaysResult).toBe(
      'The St. Augustine lawn received a preventive fungicide application.',
    );
  });

  test('initialism periods are not sentence boundaries ("The U.S." must never ship)', () => {
    const result = reconcile('The U.S. EPA-registered product was applied to the full lawn. More prose follows.');
    expect(result.todaysResult).toBe(
      'The U.S. EPA-registered product was applied to the full lawn.',
    );
  });

  test('a single-letter product suffix IS a sentence end ("Heritage G.")', () => {
    const result = reconcile('We applied Heritage G. A follow-up is planned to recheck the flagged areas.');
    expect(result.todaysResult).toBe('We applied Heritage G.');
    expect(result.todaysResult).not.toMatch(/A follow-up is planned/);
  });

  test('an over-long first sentence falls back instead of truncating with an ellipsis', () => {
    const longSentence = `The lawn received ${'a very detailed set of applications, '.repeat(8)}covering every zone.`;
    expect(reconcile(longSentence).todaysResult).toMatch(/^Routine service completed\./);
    expect(reconcile(longSentence).todaysResult).not.toContain('…');
  });
});

// PR #5033 P2 (thread PRRT_kwDOR3YQi86mlJsv): water/irrigation/sprinkler as
// a noun never reaches a watering branch.
const INCIDENTAL_WATER_NOUNS = ['Is this water damage?', 'What caused the water stains?', 'Is the irrigation meter broken?'];

describe('watering questions answer with the weekly plan when the report carries one (codex #3565 gh-r29)', () => {
  const plan = { title: 'This week: check the rain before you water', detail: 'Leave the turf irrigation off for now; run one cycle only if less than ½" has fallen.' };
  test('plan present → the plan, before re-entry / trend routing', () => {
    const data = { pressureIndex: null, dynamicContext: {}, reportV2: { water: { weekPlan: plan } } };
    for (const q of [
      'How should I water this week?',
      'What is my irrigation plan?',
      'Should I run the sprinklers?',
      'I found mushrooms; should I water this week?',
      'I spotted dry areas; how often should I water?',
      'I observed dry spots; do I need to water?',
      'I found mushrooms; is it okay to water?',
      'I spotted fungus; do we need to run the sprinklers?',
      'I observed dry spots; do I still need to water?',
      'I found mushrooms; is it okay to still water?',
      // Passive / impersonal subjects and other modals (PR #5033 P2).
      'I found mushrooms; may I water?',
      'I found mushrooms; would I water this week?',
      'I found mushrooms; should the lawn be watered?',
      'I spotted dry areas; is the lawn getting watered enough?',
      'I observed dry spots; was it watered?',
      'I found dry spots; does it need water?',
      'I spotted fungus; does my lawn still need watering?',
    ]) {
      expect(answerServiceReportQuestion({ question: q, data })).toBe(`${plan.title} ${plan.detail}`);
    }
    // gh-r38: controller phrasing without the word "water" is a watering question too.
    for (const q of ['How long should I run each zone?', 'How many minutes per zone?']) {
      expect(answerServiceReportQuestion({ question: q, data })).toBe(`${plan.title} ${plan.detail}`);
    }
    // PR #5033 P2: a verbless watering-schedule topic is still a watering request.
    expect(answerServiceReportQuestion({ question: 'What’s my watering schedule this week?', data })).toBe(`${plan.title} ${plan.detail}`);
    // PR #5033 P2: an incidental watering noun is not a watering request.
    for (const q of INCIDENTAL_WATER_NOUNS) {
      expect(answerServiceReportQuestion({ question: q, data })).not.toBe(`${plan.title} ${plan.detail}`);
    }
    // gh-r46: "time zone" is not watering intent — the appointment router answers it.
    expect(answerServiceReportQuestion({ question: 'What time zone is my next appointment?', data })).not.toBe(`${plan.title} ${plan.detail}`);
    // Unrelated questions keep their routing.
    expect(answerServiceReportQuestion({ question: 'When can my dog go outside?', data })).not.toMatch(/check the rain/);
  });
  test('safety and aftercare intents route BEFORE the plan (codex gh-r30)', () => {
    const data = {
      pressureIndex: null, dynamicContext: {},
      reportV2: {
        water: { weekPlan: { ...plan, visitInPlanWeek: true, prescribesRun: true, afterTreatment: { title: 'This week: covered by today’s treatment watering-in', detail: 'No further turf runs this week.' } } },
        aftercare: {
          watering: 'Water in with 0.25 inches today.', waterInRequired: true,
          creditableWaterIn: true, evidenceSource: 'product_instruction', wateringHold: false, needsReview: false,
        },
      },
    };
    expect(answerServiceReportQuestion({ question: 'How many minutes until my dog can go outside?', data })).not.toMatch(/check the rain|turf irrigation/);
    const after = answerServiceReportQuestion({ question: 'Should I water after today’s treatment?', data });
    expect(after).toMatch(/^Water in with 0.25 inches/);
    expect(after).toMatch(/covered by today’s treatment watering-in\. No further turf runs this week\./);
    expect(answerServiceReportQuestion({ question: 'How should I water this week?', data })).toBe(`${plan.title} ${plan.detail}`);
    // gh-r45: a HOLD plan beside a required watering-in — the answer carries the plan's
    // no-extra-runs guidance, never the label instruction alone.
    const holdData = { ...data, reportV2: { ...data.reportV2, water: { weekPlan: { title: 'This week: skip your turf watering', detail: 'Your lawn has what it needs for the week.', visitInPlanWeek: true, prescribesRun: false } } } };
    const holdAnswer = answerServiceReportQuestion({ question: 'Should I water after today’s treatment?', data: holdData });
    expect(holdAnswer).toMatch(/^Water in with 0.25 inches/);
    expect(holdAnswer).toMatch(/skip your turf watering\. Your lawn has what it needs for the week\./);
    // gh-r31: a reopened HISTORICAL report (visit outside the plan week) never answers with the reduced plan.
    const old = { ...data, reportV2: { ...data.reportV2, water: { weekPlan: { ...data.reportV2.water.weekPlan, visitInPlanWeek: false } } } };
    const oldAnswer = answerServiceReportQuestion({ question: 'Should I water after today’s treatment?', data: old });
    expect(oldAnswer).toMatch(/^Water in with 0.25 inches/);
    expect(oldAnswer).not.toMatch(/No further turf runs this week/);
    for (const incompleteAftercare of [
      { ...data.reportV2.aftercare, evidenceSource: undefined },
      { ...data.reportV2.aftercare, evidenceSource: 'irrigation_requirement' },
      { ...data.reportV2.aftercare, needsReview: true },
      { ...data.reportV2.aftercare, wateringHold: true },
    ]) {
      const incomplete = { ...data, reportV2: { ...data.reportV2, aftercare: incompleteAftercare } };
      const answer = answerServiceReportQuestion({ question: 'Should I water after today’s treatment?', data: incomplete });
      expect(answer).toMatch(/check the rain before you water/);
      expect(answer).not.toMatch(/covered by today’s treatment watering-in|No further turf runs this week/);
    }
    // Bare "minutes"/"zones" are not plan intent.
    expect(answerServiceReportQuestion({ question: 'How many minutes did the visit take?', data })).not.toMatch(/check the rain/);
  });

  test('no plan without aftercare → existing routing (irrigation → re-entry) is unchanged', () => {
    const data = { pressureIndex: null, dynamicContext: {}, reportV2: { water: { weekPlan: null } } };
    expect(answerServiceReportQuestion({ question: 'What is my irrigation plan?', data })).not.toMatch(/This week:/);
  });

  test.each([
    [{ watering: 'Turn irrigation off for 24 hours after application.', wateringHold: true, needsReview: false, evidenceSource: 'product_instruction' }, /Turn irrigation off for 24 hours/],
    [{ watering: 'Use the recorded product note.', needsReview: true, evidenceSource: 'legacy_unverified_instruction' }, /Use the recorded product note/],
  ])('no plan preserves restricted or review-required aftercare for watering questions', (aftercare, expected) => {
    const data = {
      pressureIndex: null,
      dynamicContext: {},
      findings: [{ title: 'Sprinkler area checked', detail: 'No pest activity was observed there.' }],
      reportV2: { aftercare, water: { weekPlan: null } },
    };
    for (const question of [
      'How should I water?',
      'What is my irrigation plan?',
      'I found mushrooms; should I water this week?',
      'I spotted dry areas; how often should I water?',
      'I observed mushrooms; what is my irrigation plan?',
      'I observed dry spots; do I need to water?',
      'I found mushrooms; is it okay to water?',
      'I spotted fungus; do we need to run the sprinklers?',
      'I observed dry spots; do I still need to water?',
      'I found mushrooms; is it still okay to water?',
      'I found mushrooms; is it fine to water?',
      'I spotted fungus; am I allowed to water?',
      // Passive / impersonal subjects and other modals (PR #5033 P2).
      'I found mushrooms; may I water?',
      'I found mushrooms; would I water this week?',
      'I found mushrooms; should the lawn be watered?',
      'I spotted dry areas; is the lawn getting watered enough?',
      'I observed dry spots; was it watered?',
      'I found dry spots; does it need water?',
      'I spotted fungus; does my lawn still need watering?',
    ]) {
      const answer = answerServiceReportQuestion({ question, data });
      expect(answer).toMatch(expected);
      expect(answer).not.toMatch(/This week:|re-entry guidance/);
    }
    for (const question of [
      'What did you observe in the dry spots?',
      'Did you find mushrooms by the sprinkler?',
      'What fungus did you spot near the irrigation zone?',
      'What did you find by the sprinkler?',
      'How much fungus did you find by the sprinkler?',
      'I observed mushrooms by the sprinkler, do you know what they are?',
      // Water as a noun modifier is not a watering ask.
      'I found mushrooms by the sprinkler; is it water damage?',
    ]) {
      const findingsAnswer = answerServiceReportQuestion({ question, data });
      expect(findingsAnswer).toMatch(/Sprinkler area checked/);
      expect(findingsAnswer).not.toMatch(expected);
    }
    // Unresolved aftercare answers watering requests only — an incidental
    // watering noun keeps its findings / trend routing.
    for (const question of INCIDENTAL_WATER_NOUNS) {
      const answer = answerServiceReportQuestion({ question, data });
      expect(answer).not.toMatch(expected);
      expect(answer).not.toMatch(/Confirm the product watering directions|Follow the product-specific watering restriction/);
    }
  });

  // Round 8 (codex P1 #5033 on report-assistant.js:577): a verified
  // instruction still marked needsReview resolves to the SAME 'review'
  // verdict as the legacy-unverified case above, but wateringPlanCondition()
  // used to return null with no weekPlan at all — dropping the mandatory
  // confirmation task and leaving the customer with only the unreviewed
  // label instruction, as if it were settled guidance.
  test('a review-marked instruction still carries its confirmation task with no weekly plan at all', () => {
    const aftercare = {
      watering: 'Apply 0.25 inches within 24 hours.',
      evidenceSource: 'product_instruction',
      needsReview: true,
    };
    const data = { pressureIndex: null, dynamicContext: {}, reportV2: { aftercare, water: { weekPlan: null } } };
    const answer = answerServiceReportQuestion({ question: 'Should I water?', data });
    expect(answer).toContain(aftercare.watering);
    expect(answer).toMatch(/Confirm the product watering directions with your technician before changing irrigation\./);
  });

  test.each([
    [true, true],
    [undefined, true],
    [false, false],
  ])('a review condition applies only when visitInPlanWeek=%s is current or legacy', (visitInPlanWeek, conditioned) => {
    const aftercare = {
      watering: 'Apply 0.25 inches within 24 hours.',
      needsReview: true,
      evidenceSource: 'legacy_unverified_instruction',
    };
    const data = {
      pressureIndex: null,
      dynamicContext: {},
      reportV2: { aftercare, water: { weekPlan: { ...plan, visitInPlanWeek } } },
    };
    const answer = answerServiceReportQuestion({
      question: 'I found mushrooms; is it okay to water?',
      data,
    });
    expect(answer).toContain(aftercare.watering);
    expect(answer).toContain(plan.title);
    expect(answer.includes('before applying the plan below')).toBe(conditioned);
  });

  test.each(['snapshot', 'recommendation', 'fallback'])('generic next-step questions retain mandatory aftercare in the %s answer', (source) => {
    const mowing = 'Keep mowing at 3.5 inches.';
    const data = {
      serviceLine: 'lawn',
      dynamicContext: source === 'recommendation' ? { aiSummary: { recommendedNextStep: { text: mowing } } } : {},
      lawnAssessment: source === 'snapshot' ? { snapshot: {}, recommendationCards: [{ customerCopy: mowing }] } : {},
      findings: [{ title: 'Mushrooms observed' }],
      reportV2: { aftercare: { watering: 'Product note.', needsReview: true, evidenceSource: 'legacy_unverified_instruction' } },
    };
    for (const question of ['What should I do next?', 'What should I do about the mushrooms I observed?', 'What do you recommend based on what you spotted?', 'What do I do about the mushrooms I observed?', 'I observed mushrooms. What can I do about them?', 'What could we do about the areas you spotted?', 'What do I need to do about the mushrooms I observed?', 'Is there anything I should do about what you observed?', 'Any action needed for what you spotted?', 'What are the next steps for the mushrooms you found?', 'How do I handle the fungus you spotted?']) {
      const answer = answerServiceReportQuestion({ question, data });
      expect(answer).toMatch(/^Confirm the product watering directions/);
      if (source !== 'fallback') expect(answer).toContain(mowing);
    }
  });

  // Round 7 (codex P2 #5033 on report-assistant.js:391): the same mandatory
  // aftercare above is a PAST visit's note once its own weekPlan carries
  // visitInPlanWeek: false — the generic next-step route must still classify
  // as 'next_steps' (routeServiceReportQuestion), but never promote that
  // historical confirmation into today's answer.
  test('generic next-step question drops a past-visit review confirmation once its weekPlan is out of scope', () => {
    const data = {
      dynamicContext: {},
      findings: [{ title: 'Mushrooms observed' }],
      reportV2: {
        aftercare: { watering: 'Product note.', needsReview: true, evidenceSource: 'legacy_unverified_instruction' },
        water: { weekPlan: { title: 'This week: check the rain before you water', detail: 'Leave the turf irrigation off for now.', visitInPlanWeek: false } },
      },
    };
    const routed = routeServiceReportQuestion({ question: 'What should I do next?', data });
    expect(routed.topic).toBe('next_steps');
    expect(routed.answer).not.toMatch(/Confirm the product watering directions/);
    expect(routed.answer).toMatch(/^No special repair or prep was flagged/);
  });

  // PR #5033 round 5 (moved to this follow-up): a stored watering
  // recommendation must not be answered beside the restriction it contradicts.
  const HELD = { watering: 'Do not water for 24 hours.', wateringHold: true, evidenceSource: 'product_instruction' };
  const REVIEW = { watering: 'Product note.', needsReview: true, evidenceSource: 'legacy_unverified_instruction' };
  const withAftercare = (aftercare, source) => ({
    serviceLine: 'lawn',
    dynamicContext: {},
    lawnAssessment: source === 'snapshot'
      ? { snapshot: {}, recommendationCards: [{ customerCopy: 'Increase irrigation to twice this week.' }, { customerCopy: 'Keep mowing at 3.5 inches.' }] }
      : {},
    recommendations: source === 'recommendation' ? ['Run sprinklers 20 minutes per zone.', 'Keep mowing at 3.5 inches.'] : [],
    findings: [{ title: 'Mushrooms observed' }],
    reportV2: { aftercare },
  });
  test.each([
    ['held', HELD, /^Follow the product-specific watering restriction/],
    ['review', REVIEW, /^Confirm the product watering directions/],
  ])('generic next steps withhold watering recommendations while aftercare is %s', (_state, aftercare, task) => {
    for (const source of ['snapshot', 'recommendation']) {
      const answer = answerServiceReportQuestion({ question: 'What should I do next?', data: withAftercare(aftercare, source) });
      expect(answer).toMatch(task);
      expect(answer).not.toMatch(/Increase irrigation|Run sprinklers/);
      expect(answer).toContain('Keep mowing at 3.5 inches.');
    }
  });

  test('controller and cycle directives count as watering recommendations under a restriction (PR #5258 P1)', () => {
    const data = {
      ...withAftercare(HELD, 'snapshot'),
      lawnAssessment: {
        snapshot: {},
        recommendationCards: ['Run each zone for 20 minutes.', 'Add another cycle this week.', 'Resume the normal schedule tomorrow.', 'Set the sprinklers for 20 minutes tomorrow.', 'Schedule two irrigation cycles this week.', 'Turn the sprinkler heads back on tonight.', 'Turn the damaged irrigation system back on tomorrow.', 'Keep mowing at 3.5 inches.']
          .map((customerCopy) => ({ customerCopy })),
      },
    };
    const answer = answerServiceReportQuestion({ question: 'What should I do next?', data });
    expect(answer).not.toMatch(/each zone|another cycle|normal schedule|Set the sprinklers|irrigation cycles|sprinkler heads|damaged irrigation/);
    expect(answer).toContain('Keep mowing at 3.5 inches.');
    // A watering noun with no watering action is not a directive (round 2).
    for (const keep of ['Watch the sprinkler area for recurring mushrooms.', 'Replace the damaged controller battery.', 'Set a timer to inspect the treated area tomorrow.']) {
      const other = { ...withAftercare(HELD, 'recommendation'), recommendations: [keep] };
      expect(answerServiceReportQuestion({ question: 'What should I do next?', data: other })).toContain(keep);
    }
    // A zone or cycle outside the controller sense is not a watering directive.
    for (const keep of ['A second visit breaks the flea life cycle.', 'Treat the weed zone by the fence.', 'Mow on a 5-day cycle.', 'Resume your normal mowing schedule.']) {
      const other = { ...withAftercare(HELD, 'recommendation'), recommendations: [keep] };
      expect(answerServiceReportQuestion({ question: 'What should I do next?', data: other })).toContain(keep);
    }
  });

  test.each([
    ['What can we do to move the appointment?', 'next_visit'],
    ['What action did you take after you spotted fungus?', 'findings'],
    ['What action was taken after you spotted fungus?', 'findings'],
    ['What can I do to confirm my appointment?', 'next_visit'],
    ['What do I do about my next appointment?', 'next_visit'],
    ['What could we do to get an earlier appointment?', 'next_visit'],
    ['What can I do about the weeds before my next appointment?', 'next_steps'],
    ['What do I do until the next visit?', 'next_steps'],
    ['Did you find any broken sprinklers?', 'findings'],
    ['What mowing action caused the damage you observed?', 'findings'],
    ['What action should I take after spraying?', 'next_steps'],
    ['What can we do to move our next service?', 'next_visit'],
    ['Can I turn the sprinkler heads back on?', 'watering'],
    ['Can I turn the damaged sprinklers back on?', 'watering'],
    ['Did you find fungus near sprinklers?', 'findings'],
    ['Were mushrooms found around sprinkler heads?', 'findings'],
    ['I found brown spots, do they indicate damage?', 'findings'],
    ['Any action needed for what you spotted?', 'next_steps'],
  ])('"%s" routes to %s (PR #5258 P2)', (question, topic) => {
    const data = withAftercare(REVIEW, 'none');
    expect(routeServiceReportQuestion({ question, data, nextAppointment: { scheduled_date: '2026-10-05' } }).topic).toBe(topic);
  });

  test('a word that only starts with "water" is not watering (PR #5258 round 2)', () => {
    const data = { ...withAftercare(HELD, 'none'), reportV2: { aftercare: HELD, water: { weekPlan: { title: 'This week: run once', detail: 'One cycle.' } } } };
    expect(routeServiceReportQuestion({ question: 'Should I waterproof the deck?', data }).topic).not.toBe('watering');
  });

  test.each(['Is the irrigation meter broken?', 'What caused the irrigation leak?'])('incidental irrigation noun "%s" never gets the re-entry answer (PR #5258 P2)', (question) => {
    const data = { pressureIndex: null, dynamicContext: {}, reportV2: { water: { weekPlan: null } } };
    expect(routeServiceReportQuestion({ question, data }).topic).not.toBe('reentry');
  });

  test('watering recommendations still answer when the aftercare restricts nothing', () => {
    for (const source of ['snapshot', 'recommendation']) {
      const answer = answerServiceReportQuestion({ question: 'What should I do next?', data: withAftercare(null, source) });
      expect(answer).toMatch(/Increase irrigation|Run sprinklers/);
    }
  });
});

// AW-03 (ask-waves-audit-20260925): the "What was applied today?" answer must
// come from data.applications[].product — the same approved/frozen facts
// report-data.js's attachApprovedReportProductFacts already resolved for the
// report display — and never a second, ungated live products_catalog lookup.
// These fixtures mirror exactly what buildServiceReportV1ResponseData
// attaches to each application's `product` (server/services/service-report/
// report-data.js ~L3616-3651) for the three cases report-data.js
// distinguishes: frozen-at-completion, explicitly unapproved (frozen null or
// live-unapproved), and a genuinely pre-freeze/legacy report resolved live.
describe('service report answers only approved/frozen product facts (AW-03)', () => {
  function appliedTodayData(product) {
    return {
      serviceDisplayName: 'Pest Control',
      applications: [{
        id: 'app-1',
        product,
        applicationArea: 'Exterior perimeter',
        method: 'perimeter_spray',
      }],
      dynamicContext: {},
    };
  }

  test('a later catalog edit never reaches the answer, and no REI figure is rendered', () => {
    // At completion the catalog said REI 4 and was approved, so
    // reportIdentitySnapshot.productFacts froze reentry_hours at 4. A later
    // catalog edit to REI 24 must never reach this answer (no live lookup),
    // and no fixed re-entry figure is rendered at all (compliance language:
    // the re-entry answer gives the once-dry guidance instead).
    const answer = answerAppliedToday({
      data: appliedTodayData({
        name: 'Audit Product',
        active_ingredient: 'Frozen ingredient',
        epa_reg: 'synthetic-epa',
        reentry_hours: 4,
        facts_approved: true,
      }),
    });
    expect(answer).toContain('active ingredient: Frozen ingredient');
    expect(answer).not.toMatch(/\bREI\b|\b24 hr\b|\b4 hr\b/);
  });

  test('an explicitly unapproved product never falls back to a live value', () => {
    // report-data.js leaves reentry_hours/rainfast_minutes/epa/active
    // ingredient null for a product that is not approved for the report
    // (frozen-null at completion, or live-unapproved on a legacy report) —
    // the assistant must render nothing rather than invent a value.
    const answer = answerAppliedToday({
      data: appliedTodayData({
        name: 'Unapproved Product',
        active_ingredient: '',
        epa_reg: '',
        reentry_hours: null,
        rainfast_minutes: null,
        facts_approved: false,
      }),
    });
    expect(answer).not.toMatch(/label REI/i);
    expect(answer).not.toMatch(/rainfast/i);
    expect(answer).not.toMatch(/EPA Reg\./);
    expect(answer).not.toMatch(/active ingredient/i);
  });

  test('a genuinely pre-freeze/legacy report still shows the currently-approved facts', () => {
    // No reportIdentitySnapshot ever existed for this report, so
    // attachApprovedReportProductFacts falls back to the CURRENT approved
    // catalog row (report-data.js's documented legacy-compatibility path).
    // The assistant treats this exactly like a frozen product — it only
    // reads whatever report-data.js already resolved onto app.product.
    const answer = answerAppliedToday({
      data: appliedTodayData({
        name: 'Legacy Approved Product',
        active_ingredient: 'Bifenthrin',
        epa_reg: 'legacy-epa-1',
        reentry_hours: 12,
        rainfast_minutes: 60,
        facts_approved: true,
      }),
    });
    expect(answer).toContain('EPA Reg. legacy-epa-1');
    expect(answer).toContain('active ingredient: Bifenthrin');
    expect(answer).not.toMatch(/\bREI\b|rainfast/i);
  });
});

// AW-07 (ask-waves-audit-20260925): the product insight matcher must not use
// a brand name alone as chemistry/category evidence — a LESCO fertilizer
// must never be described as a spray adjuvant, and with no verified
// ingredient/category match, no explanation is offered at all.
describe('product insight matcher classifies from approved facts, not brand name (AW-07)', () => {
  test('a LESCO fertilizer is not described as a spray adjuvant', () => {
    const answer = answerAppliedToday({
      data: {
        serviceDisplayName: 'Lawn Care',
        applications: [{
          id: 'fertilizer-app',
          product: { name: 'LESCO 20-0-0 60% CRN Plus Micros Turfgrass Liquid Fertilizer', active_ingredient: 'Nitrogen 20-0-0 + micros' },
          method: 'broadcast_spray',
        }],
        dynamicContext: {},
      },
    });
    expect(answer).not.toMatch(/spray adjuvant/i);
    expect(answer).not.toMatch(/not the insecticide/i);
  });

  test('an approved-catalog adjuvant is still classified from its category, not its name', () => {
    const answer = answerAppliedToday({
      data: {
        serviceDisplayName: 'Pest Control',
        applications: [{
          id: 'adjuvant-app',
          product: { name: 'LESCO Wetting Concentrate', product_type: 'wetting_agent', category: 'surfactant', facts_approved: true },
          method: 'perimeter_spray',
        }],
        dynamicContext: {},
      },
    });
    expect(answer).toMatch(/spray adjuvant/i);
  });

  test('an unapproved product never gets a category-derived chemistry claim', () => {
    // buildReportV1Data still carries the recorded product_category onto
    // app.product.category when facts are frozen-null / unapproved.
    const answer = answerAppliedToday({
      data: {
        serviceDisplayName: 'Pest Control',
        applications: [{
          id: 'unapproved-adjuvant-app',
          product: { name: 'Wetting Concentrate', product_type: null, category: 'surfactant', facts_approved: false },
          method: 'perimeter_spray',
        }],
        dynamicContext: {},
      },
    });
    expect(answer).not.toMatch(/spray adjuvant/i);
    expect(answer).not.toMatch(/not the insecticide/i);
  });
});

// AW-06 (ask-waves-audit-20260925): "Shipped report questions route to the
// wrong answers." This suite table-drives EVERY shipped prompt chip (project
// + service report) plus the four audit reproduction questions and their
// plural/inflected variants, asserting the answer CATEGORY — not just that
// the assistant returns something.
//
// Chip sources (kept in sync manually — see the comments at each list):
//   - project: server/services/project-report-assistant.js projectReportAskPrompts()
//     / client/src/components/report/ProjectReportEngage.jsx PROMPTS
//   - service: client/src/pages/ReportViewPage.jsx reportAskPrompts()

const { answerProjectReportQuestion } = require('../services/project-report-assistant');
const { answerServiceReportQuestion } = require('../services/service-report/report-assistant');

describe('project report — every shipped chip answers its own category (AW-06)', () => {
  const project = {
    project_type: 'rodent_trapping',
    findings: {
      areas_treated: 'Exterior perimeter',
      products_used: 'Synthetic bait',
      findings_observed: 'Activity at the rear wall',
    },
    recommendations: 'Seal the gap at the rear wall.',
  };
  const payload = {};

  // Each shipped chip, its bound intent (projectReportAskPrompts()), and a
  // signature that proves the CATEGORY of the answer.
  test.each([
    ['What did you find?', 'findings', /Activity at the rear wall/i],
    ['What was treated?', 'treatment', /Exterior perimeter/i],
    ['What should I do next?', 'recommendations', /Seal the gap at the rear wall/i],
    ['When is my next visit?', 'next_visit', /Nothing further is scheduled|scheduled for/i],
  ])('chip "%s" (intent=%s) answers the right category via explicit intent AND free-text', (question, intent, expected) => {
    // Chip click: server honors the explicit intent.
    expect(answerProjectReportQuestion({ question, project, payload, intent })).toMatch(expected);
    // Typed question, no intent sent (older client / free typing): the
    // improved free-text router must independently reach the same category.
    expect(answerProjectReportQuestion({ question, project, payload })).toMatch(expected);
  });

  test('an unrecognized or missing intent falls back to free-text routing (older-client compatibility)', () => {
    expect(answerProjectReportQuestion({ question: 'What was treated?', project, payload, intent: 'not_a_real_intent' }))
      .toMatch(/Exterior perimeter/i);
    expect(answerProjectReportQuestion({ question: 'What was treated?', project, payload, intent: undefined }))
      .toMatch(/Exterior perimeter/i);
  });

  // AW-06: exact-word matching missed inflections of "treat" ("treated") and
  // a bare "next" swallowed "What should I do next?" into the visit/
  // schedule router instead of recommendations.
  test.each([
    'What was treated?',
    "What's treated?",
    'What is being treated?',
    'Was anything treated today?',
  ])('inflected treatment phrasing "%s" still answers with the recorded treatment', (question) => {
    expect(answerProjectReportQuestion({ question, project, payload })).toMatch(/Exterior perimeter/i);
  });

  test.each([
    'Do I need to be home for the next visit?',
    'When can I see you again?',
    'When are you coming back?',
  ])('typed scheduling question "%s" answers the next visit', (question) => {
    expect(answerProjectReportQuestion({ question, project, payload })).toMatch(/Nothing further is scheduled|scheduled for/i);
  });

  test.each([
    'What should I do next?',
    'What do I need to do next?',
    'Anything I should do now?',
  ])('"%s" answers with customer next steps, not the visit-scheduling fallback', (question) => {
    const answer = answerProjectReportQuestion({ question, project, payload });
    expect(answer).toMatch(/Seal the gap at the rear wall/i);
    expect(answer).not.toMatch(/Nothing further is scheduled/i);
  });

  test('a genuine next-visit question still reaches the visit answer, not recommendations', () => {
    const withVisit = {
      ...project,
      recommendations: 'Seal the gap at the rear wall.',
    };
    const answer = answerProjectReportQuestion({
      question: 'When is my next visit?',
      project: withVisit,
      payload: { upcomingAppointment: { scheduledDate: '2026-10-15' } },
    });
    expect(answer).toMatch(/next visit is scheduled for/i);
  });

  // AW-06 r1: "use" restored as a treatment cue, guarded against the
  // "use my yard again" scheduling phrasing.
  test('"What did you use?" answers with the recorded treatment', () => {
    expect(answerProjectReportQuestion({ question: 'What did you use?', project, payload }))
      .toMatch(/Synthetic bait/i);
  });

  test('"When can I use my yard again?" answers the next visit, not treatment', () => {
    const answer = answerProjectReportQuestion({ question: 'When can I use my yard again?', project, payload });
    expect(answer).toMatch(/Nothing further is scheduled|scheduled for/i);
    expect(answer).not.toMatch(/Synthetic bait/i);
  });

  // AW-06 r1: "see" restored as a findings cue, guarded against "see you
  // again" scheduling phrasing (already covered above for "When can I see
  // you again?" — reconfirmed here against the findings answer specifically).
  test('"What did you see?" answers with the recorded findings', () => {
    expect(answerProjectReportQuestion({ question: 'What did you see?', project, payload }))
      .toMatch(/Activity at the rear wall/i);
  });

  test('"When can I see you again?" answers the next visit, not findings', () => {
    const answer = answerProjectReportQuestion({ question: 'When can I see you again?', project, payload });
    expect(answer).toMatch(/Nothing further is scheduled|scheduled for/i);
    expect(answer).not.toMatch(/Activity at the rear wall/i);
  });

  // AW-06 r1: bare "next" reaches the weak final scheduling branch, while
  // "What should I do next?" still hits recommendations (checked earlier).
  test.each([
    'What happens next?',
    "What's next?",
  ])('"%s" answers the next visit', (question) => {
    const answer = answerProjectReportQuestion({ question, project, payload });
    expect(answer).toMatch(/Nothing further is scheduled|scheduled for/i);
  });

  test('"What should I do next?" still answers with customer next steps, not the next-visit fallback', () => {
    const answer = answerProjectReportQuestion({ question: 'What should I do next?', project, payload });
    expect(answer).toMatch(/Seal the gap at the rear wall/i);
    expect(answer).not.toMatch(/Nothing further is scheduled/i);
  });
});

describe('service report — every shipped chip answers its own category (AW-06)', () => {
  // "Pest"-style report: no lawnAssessment (matches how a non-lawn service
  // report is actually built — lawnAssessment is lawn-only).
  const pestData = {
    serviceDisplayName: 'Pest Control',
    applications: [{
      id: 'app-1',
      product: { name: 'Taurus SC', active_ingredient: 'Fipronil', epa_reg: 'epa-1', reentry_hours: 4 },
      applicationArea: 'Exterior perimeter',
      method: 'perimeter_spray',
    }],
    dynamicContext: {
      reentry: { customerSummary: 'Treated areas are ready for normal use.' },
      premiumExperience: { primaryMove: { title: 'Recheck bait stations at the next visit.' } },
    },
    pressureIndex: 1.8,
    findings: [{ title: 'Ant activity noted', detail: 'Near the garage.', recommendation: 'Keep pet food sealed.' }],
  };
  const nextAppointment = { service_type: 'Pest Control', scheduled_date: '2026-10-01', window_start: '09:00:00' };

  // "Lawn"-style report: carries a weekly watering plan and a lawn
  // assessment score breakdown, the way the actual lawn report builder does.
  const lawnData = {
    serviceDisplayName: 'Lawn Care',
    serviceLine: 'lawn',
    applications: [{ id: 'lawn-app-1', product: { name: 'Fertilizer blend' }, method: 'broadcast_spray', applicationArea: 'Front and back yard' }],
    dynamicContext: {},
    reportV2: {
      water: { weekPlan: { title: 'This week: check the rain before you water', detail: 'Leave the turf irrigation off for now.' } },
    },
    lawnAssessment: {
      scores: { turfDensity: 70, weedSuppression: 55, colorHealth: 60, stressDamage: 40, overallScore: 62 },
      snapshot: { summary: 'Lawn snapshot summary.', findings: [{ customerCopy: 'Thin patch by the mailbox.' }] },
      recommendationCards: [{ customerCopy: 'Keep mowing at 3.5 inches.' }],
    },
    findings: [],
  };

  // --- The two AW-06 audit reproduction questions -----------------------
  test('AW-06: "What was applied outside today?" answers with the recorded treatment, not a re-entry hijack', () => {
    const answer = answerServiceReportQuestion({ question: 'What was applied outside today?', data: pestData });
    expect(answer).toMatch(/Taurus SC/);
    expect(answer).toMatch(/Sources used: this service report/);
    expect(answer).not.toMatch(/No re-entry timer/);
  });

  test('AW-06: "When can my pets go back out?" answers with re-entry guidance or an explicit safe handoff', () => {
    const answer = answerServiceReportQuestion({ question: 'When can my pets go back out?', data: pestData });
    expect(answer).toBe('Treated areas are ready for normal use.');
  });

  test('AW-06: with no recorded interval, the pets question gets an explicit safe handoff, not a generic summary', () => {
    const noWindowData = { ...pestData, dynamicContext: {} };
    const answer = answerServiceReportQuestion({ question: 'When can my pets go back out?', data: noWindowData });
    expect(answer).toMatch(/No re-entry timer was recorded/);
    expect(answer).toMatch(/call or text \(941\) 297-5749/);
    expect(answer).not.toMatch(/This service is complete/);
  });

  // --- Plural/inflected safety words (the matcher had "pet" but missed "pets") ---
  test.each(['pet', 'pets', 'dog', 'dogs', 'cat', 'cats', 'kid', 'kids', 'child', 'children'])(
    'safety subject "%s" routes to the re-entry answer',
    (word) => {
      const answer = answerServiceReportQuestion({ question: `Is it safe for my ${word} to go back outside?`, data: pestData });
      expect(answer).toBe('Treated areas are ready for normal use.');
    },
  );

  // --- Location words alone must not hijack a treatment question ---------
  test.each([
    'What was applied inside today?',
    'What was sprayed outside?',
    'What products were used inside the house?',
  ])('"%s" is a treatment question, not a location-hijacked re-entry answer', (question) => {
    const answer = answerServiceReportQuestion({ question, data: pestData });
    expect(answer).toMatch(/Sources used: this service report/);
  });

  // --- Non-lawn shipped chips (ReportViewPage.jsx reportAskPrompts) -------
  test('chip "When can I re-enter treated areas?" answers re-entry', () => {
    expect(answerServiceReportQuestion({ question: 'When can I re-enter treated areas?', data: pestData }))
      .toBe('Treated areas are ready for normal use.');
  });

  test('chip "What areas were treated?" answers the recorded treatment', () => {
    expect(answerServiceReportQuestion({ question: 'What areas were treated?', data: pestData }))
      .toMatch(/Sources used: this service report/);
  });

  test('chip "Why was <product> used?" answers the recorded treatment', () => {
    expect(answerServiceReportQuestion({ question: 'Why was Taurus SC used?', data: pestData }))
      .toMatch(/Sources used: this service report/);
  });

  test('chip "Why were these products used?" answers the recorded treatment', () => {
    expect(answerServiceReportQuestion({ question: 'Why were these products used?', data: pestData }))
      .toMatch(/Sources used: this service report/);
  });

  test('chip "What does Pest Pressure mean?" answers with the pressure trend', () => {
    expect(answerServiceReportQuestion({ question: 'What does Pest Pressure mean?', data: pestData }))
      .toMatch(/pressure index is 1\.8/);
  });

  test('chip "What should I do about the inaccessible area?" answers customer next steps', () => {
    expect(answerServiceReportQuestion({ question: 'What should I do about the inaccessible area?', data: pestData }))
      .toMatch(/Priority next step: Recheck bait stations/);
  });

  // AW-06: previously hijacked by the bare "next" appointment branch.
  test('chip "What should I watch for next?" answers customer next steps, not an appointment date', () => {
    const answer = answerServiceReportQuestion({ question: 'What should I watch for next?', data: pestData, nextAppointment });
    expect(answer).toMatch(/Priority next step: Recheck bait stations/);
    expect(answer).not.toMatch(/Your next appointment is/);
  });

  test('chip "When is my next service?" answers the next appointment', () => {
    const answer = answerServiceReportQuestion({ question: 'When is my next service?', data: pestData, nextAppointment });
    expect(answer).toMatch(/Your next appointment is/);
  });
  test.each([
    'When can we go outside again?',
    'Can the kids play outdoors now?',
  ])('location-only re-entry question "%s" still gets the re-entry answer', (question) => {
    const answer = answerServiceReportQuestion({ question, data: pestData });
    expect(answer).not.toMatch(/service is complete/i);
    expect(answer).not.toMatch(/Your next appointment is/);
    expect(answer).not.toMatch(/Taurus SC/);
  });

  test('the no-timer re-entry handoff makes no blanket safety claim', () => {
    const answer = answerServiceReportQuestion({ question: 'When can my pets go back out?', data: { ...pestData, dynamicContext: {} } });
    expect(answer).toMatch(/confirm the timing/);
    expect(answer).not.toMatch(/\bsafe\b/i);
  });

  test.each([
    'When can I go inside after the treatment?',
    'Can I go indoors after the application? How long until I can go in?',
  ])('temporal re-entry question naming the treatment gets re-entry: %s', (question) => {
    const answer = answerServiceReportQuestion({ question, data: pestData });
    expect(answer).toBe(answerServiceReportQuestion({ question: 'When can my pets go back out?', data: pestData }));
  });

  test('"Did you see any ants indoors?" reaches the findings answer', () => {
    const answer = answerServiceReportQuestion({ question: 'Did you see any ants indoors?', data: pestData });
    expect(answer).toBe(answerServiceReportQuestion({ question: 'What did you find?', data: pestData }));
  });

  test.each([
    'Is the weed treatment working?',
    'Is the product improving the weeds?',
  ])('effectiveness question naming the treatment gets the trend answer: %s', (question) => {
    expect(answerServiceReportQuestion({ question, data: lawnData }))
      .toBe(answerServiceReportQuestion({ question: 'Is my lawn getting better?', data: lawnData }));
  });

  test('explicit advice wording outranks a lawn-trend subject', () => {
    expect(answerServiceReportQuestion({ question: 'What do you recommend for the stress areas?', data: lawnData }))
      .toBe(answerServiceReportQuestion({ question: 'What do you recommend?', data: lawnData }));
  });

  test('"When will you come back?" is a scheduling question, not re-entry', () => {
    const answer = answerServiceReportQuestion({ question: 'When will you come back?', data: pestData, nextAppointment });
    expect(answer).toMatch(/Your next appointment is/);
  });

  // AW-06 r1: a findings/observation cue paired with a location word is not
  // a re-entry question — "outdoors"/"indoors" describes WHERE something was
  // found, not a request to know when it's safe to go there.
  test('"What did you find outdoors?" is a findings question, not re-entry', () => {
    const answer = answerServiceReportQuestion({ question: 'What did you find outdoors?', data: pestData });
    expect(answer).not.toBe('Treated areas are ready for normal use.');
    expect(answer).toMatch(/Ant activity noted/i);
  });

  test('"Did you see any ants indoors?" is not a re-entry question', () => {
    const answer = answerServiceReportQuestion({ question: 'Did you see any ants indoors?', data: pestData });
    expect(answer).not.toBe('Treated areas are ready for normal use.');
  });

  // Regression: the new findings-cue guard on isReentryIntent must not
  // swallow the genuine location-only re-entry questions below (already
  // covered by the "Location words alone" table above), reconfirmed here
  // against the two audit-named phrasings specifically.
  test.each([
    'When can we go outside again?',
    'Can the kids play outdoors now?',
  ])('"%s" still gets the re-entry answer (findings cue guard does not swallow it)', (question) => {
    const answer = answerServiceReportQuestion({ question, data: pestData });
    expect(answer).toBe('Treated areas are ready for normal use.');
  });

  // --- Lawn V2 insight chips (category-specific, ReportViewPage.jsx QUESTION_BY_CATEGORY) ---
  test('chip "Am I watering the right amount?" answers with the weekly watering plan', () => {
    expect(answerServiceReportQuestion({ question: 'Am I watering the right amount?', data: lawnData }))
      .toBe('This week: check the rain before you water Leave the turf irrigation off for now.');
  });

  test('chip "How do I keep the weeds from spreading?" answers with the lawn trend/score breakdown', () => {
    expect(answerServiceReportQuestion({ question: 'How do I keep the weeds from spreading?', data: lawnData }))
      .toMatch(/weed cleanliness/i);
  });

  test('chip "What are the stress areas you flagged?" answers with the lawn trend/score breakdown', () => {
    expect(answerServiceReportQuestion({ question: 'What are the stress areas you flagged?', data: lawnData }))
      .toMatch(/stress\/damage/i);
  });

  test('chip "How can I thicken up the thin areas?" answers with the lawn trend/score breakdown', () => {
    expect(answerServiceReportQuestion({ question: 'How can I thicken up the thin areas?', data: lawnData }))
      .toMatch(/Lawn snapshot summary|overall/i);
  });

  test('chip "How do I get more even color?" answers with the lawn trend/score breakdown', () => {
    expect(answerServiceReportQuestion({ question: 'How do I get more even color?', data: lawnData }))
      .toMatch(/color\/nutrients/i);
  });

  // Known pre-existing architecture gap, not introduced by this fix and out
  // of this fix's scope to redesign: there is no dedicated mowing-guidance
  // answer function, so this chip currently maps onto the lawn trend/score
  // answer via the "lawn" keyword rather than mowing-specific advice. It at
  // least never falls into the generic "service is complete" fallback.
  test('chip "What mowing height is best for my lawn?" answers with lawn context, not the generic fallback', () => {
    const answer = answerServiceReportQuestion({ question: 'What mowing height is best for my lawn?', data: lawnData });
    expect(answer).not.toMatch(/This service is complete/);
  });

  test('chip "Can you follow up on what I flagged?" answers customer next steps', () => {
    expect(answerServiceReportQuestion({ question: 'Can you follow up on what I flagged?', data: lawnData }))
      .toMatch(/Recommended next step: Keep mowing at 3\.5 inches/);
  });

  test('chip "How is my lawn trending?" answers the lawn trend/score breakdown', () => {
    expect(answerServiceReportQuestion({ question: 'How is my lawn trending?', data: lawnData }))
      .toMatch(/Lawn snapshot summary/);
  });

  // AW-06 r1: a question that names both a treatment cue and a lawn-trend
  // cue ("weeds", "thin areas") is asking about what was applied, not the
  // score breakdown — treatment cues must win when both match.
  test('"What was applied to the weeds?" answers with the recorded treatment, not the lawn trend', () => {
    const answer = answerServiceReportQuestion({ question: 'What was applied to the weeds?', data: lawnData });
    expect(answer).toMatch(/Sources used: this service report/);
    expect(answer).not.toMatch(/Lawn snapshot summary|weed cleanliness/i);
  });

  test('"What did you spray on the thin areas?" answers with the recorded treatment, not the lawn trend', () => {
    const answer = answerServiceReportQuestion({ question: 'What did you spray on the thin areas?', data: lawnData });
    expect(answer).toMatch(/Sources used: this service report/);
    expect(answer).not.toMatch(/Lawn snapshot summary|overall/i);
  });
});

// Owner rules for the AI report paragraph (GATE_REPORT_WRITER_RULES, owner
// "go" 2026-09-30). Lawn and tree/shrub/palm stay byte-identical (owner: a
// separate lane owns them); every other writer gets the rules block, and
// every older line the rules contradict is rewritten out of its prompt.
const fs = require('fs');
const path = require('path');
const { selectReportCopyPrompt, writerRulesInScope } = require('../services/service-report/lawn-report-copy-prompt');
const {
  OWNER_RULES, PROMPT_REWRITES, REPORT_WRITER_RULES_VERSION, writerRulesRejection, activeIngredientsMentioned,
} = require('../services/service-report/report-writer-rules');
const { HUMAN_PROSE_RULES } = require('../services/llm/human-prose-rules');

// The real v4 hard constraints, sliced from the route source. Only template
// expressions are stubbed; every rewrite target is literal text.
const scheduleSource = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');
const v4Start = scheduleSource.indexOf('## HARD CONSTRAINTS');
const v4End = scheduleSource.indexOf('## ANTI-TEMPLATE RULES', v4Start);
const V4_SHARED = `# SERVICE REPORT COPY — SYSTEM PROMPT v4\n${scheduleSource.slice(v4Start, v4End).replace(/\$\{[^}]*\}/g, 'X')}## ANTI-TEMPLATE RULES\nOld examples.`;

const IN_SCOPE = [
  ['pest_general_quarterly', null],
  ['pest_re_service', null],
  ['one_time_pest_control', null],
  ['pest_rodent_quarterly', null],
  ['rodent_trapping', 'rodent_trapping'],
  ['rodent_bait_quarterly', 'rodent_bait_station'],
  ['rodent_trapping_exclusion_sanitation', 'rodent_trapping'],
  ['termite_bait', 'termite_bait_station'],
  ['termite_liquid', 'termite_treatment'],
  ['foam_drill', 'termite_treatment'],
  ['mosquito_monthly', null],
  ['mosquito_event', 'mosquito_event'],
  ['cockroach_control', 'cockroach'],
  ['flea_tick', 'flea'],
  ['bed_bug_treatment', null],
  ['bee_wasp_removal', null],
  ['fire_ant', null],
  ['pest_inspection', 'pest_inspection'],
  ['tick_control', null],
  ['rodent_sanitation_light', 'rodent_sanitation'],
];

// Owner 2026-09-30: "dont touch Lawn / Tree, shrub & palm".
const OUT_OF_SCOPE = [
  ['lawn_care_6week', null],
  ['lawn_care_one_time', 'one_time_lawn_treatment'],
  ['lawn_re_service', 'one_time_lawn_treatment'],
  ['lawn_tree_shrub_combo', null],
  ['dethatching', null],
  ['plugging', null],
  ['top_dressing', null],
  ['tree_shrub_program', 'tree_shrub'],
  ['tree_shrub_6week', 'tree_shrub'],
  ['palm_injection', 'palm_injection'],
  ['palm_treatment', null],
  ['termite_pretreatment', 'termite_treatment'],
  ['waveguard_membership', null],
];

describe('writer rules scope', () => {
  test.each(IN_SCOPE)('%s gets the owner rules', (serviceKey, findingsType) => {
    const context = { serviceKey, findingsType };
    expect(writerRulesInScope('Old label', context)).toBe(true);
    const prompt = selectReportCopyPrompt(V4_SHARED, 'Old label', { ...context, writerRules: true });
    expect(prompt).toContain(OWNER_RULES);
    expect(prompt).toContain(`# ${REPORT_WRITER_RULES_VERSION}`);
    expect(prompt.split('Describe the rating in words only')).toHaveLength(2);
  });

  test.each(OUT_OF_SCOPE)('%s stays byte-identical with the gate on', (serviceKey, findingsType) => {
    const context = { serviceKey, findingsType };
    expect(writerRulesInScope('Old label', context)).toBe(false);
    expect(selectReportCopyPrompt(V4_SHARED, 'Old label', { ...context, writerRules: true }))
      .toBe(selectReportCopyPrompt(V4_SHARED, 'Old label', context));
  });

  test.each([
    ['Every 6 Weeks Lawn Care Service', false],
    ['Palm Care Service', false],
    ['Bi-Monthly Tree & Shrub Care Service', false],
    ['Quarterly Pest Control Service', true],
  ])('legacy label %s follows the same scope', (label, inScope) => {
    const on = selectReportCopyPrompt(V4_SHARED, label, { writerRules: true });
    const off = selectReportCopyPrompt(V4_SHARED, label);
    expect(on === off).toBe(!inScope);
    expect(on.includes(OWNER_RULES)).toBe(inScope);
  });

  test('without the flag nothing changes for an in-scope writer', () => {
    const prompt = selectReportCopyPrompt(V4_SHARED, 'Old label', { serviceKey: 'pest_general_quarterly', findingsType: null });
    expect(prompt).not.toContain('OWNER RULES');
    expect(prompt).toContain('other labeled crawling pests');
  });
});

describe('prompt rewrites', () => {
  const inScopePrompts = IN_SCOPE
    .map(([serviceKey, findingsType]) => selectReportCopyPrompt(V4_SHARED, 'Old label', { serviceKey, findingsType, writerRules: true }));
  const sourcePrompts = IN_SCOPE
    .map(([serviceKey, findingsType]) => selectReportCopyPrompt(V4_SHARED, 'Old label', { serviceKey, findingsType }));

  test.each(PROMPT_REWRITES.map(([from, to], index) => [index, from, to]))(
    'rewrite %i still matches its source text and never survives', (index, from, to) => {
      expect(sourcePrompts.some((prompt) => prompt.includes(from))).toBe(true);
      for (const prompt of inScopePrompts) expect(prompt).not.toContain(from);
      if (to) expect(inScopePrompts.some((prompt) => prompt.includes(to))).toBe(true);
    },
  );

  test('the rules prompt no longer invites active ingredients, paragraphs or the coverage phrase', () => {
    for (const prompt of inScopePrompts) {
      expect(prompt).not.toMatch(/Use active ingredient names/);
      expect(prompt).not.toMatch(/use a supplied active ingredient/);
      expect(prompt).not.toContain('other labeled crawling pests');
      expect(prompt).not.toContain('plain-text paragraphs');
      expect(prompt).toContain('exactly ONE line');
    }
  });

  test('the gauge rule keeps the activity level in words', () => {
    expect(OWNER_RULES).toMatch(/activity gauge's number or scale/);
    expect(OWNER_RULES).toMatch(/activity level in words .* belongs in the paragraph/);
  });

  test('the owner style rules ride along with the grounding exception', () => {
    expect(OWNER_RULES).toContain(HUMAN_PROSE_RULES);
    expect(OWNER_RULES).toMatch(/hedges .* keep them/);
  });
});

describe('writerRulesRejection', () => {
  test.each([
    ['We mixed 2 oz per gallon along the foundation.', 'amount'],
    ['We applied 30 mL at the slider.', 'amount'],
    ['A teaspoon went into each crack.', 'amount'],
    ['We treated 120 linear feet of foundation.', 'footage'],
    ['We treated about 1,200 sq ft of beds.', 'footage'],
    ['We treated a 3-ft band around the home.', 'footage'],
    ['Activity dropped 50% since the last visit.', 'percent'],
    ['This is billed per visit.', 'per_visit'],
    ['Thank you for choosing Waves Pest Control & Lawn Care.', 'company_name'],
    ['Waves Lawn Care treated the beds.', 'company_name'],
    ['The area is safe once dry.', 'safe_word'],
    ['We used a pet-safe bait.', 'safe_word'],
    ['The gel is non-toxic to people.', 'safe_word'],
    ['We applied a chemical along the base.', 'chemical'],
    ['We applied fipronil along the foundation.', 'active_ingredient'],
    ['A lambda-cyhalothrin spray went on the eaves.', 'active_ingredient'],
    ['Please keep off the lawn until dry.', 'reentry'],
    ['You can re-enter the treated rooms after it has dried.', 'reentry'],
    ['Keep pets and kids away from the treated band for a while.', 'reentry'],
    ['Stay out of the garage until the spray has dried.', 'reentry'],
    ['Some activity can continue for a few days.', 'timeframe'],
    ['Activity may take 7–14 days to drop off.', 'timeframe'],
    ['Webbing should thin out over about two weeks.', 'timeframe'],
    ['We will follow up in 7 days.', 'timeframe'],
    ['This re-service is free of charge.', 'price'],
    ['The visit is included in your plan.', 'price'],
    ['Each extra check is $95.', 'price'],
    ['The work is covered by your warranty.', 'price'],
    ['We will return next Tuesday.', 'date'],
    ['Your next visit is scheduled for October 7.', 'date'],
    ['We arrive between 8 and 10 AM.', 'time'],
    ['The garage was infested.', 'owner_phrase'],
    ['No problems were found today.', 'owner_phrase'],
    ['There is nothing to worry about.', 'owner_phrase'],
    ['The treatment map shows where we sprayed.', 'owner_phrase'],
    ['Your termite bond stays active.', 'owner_phrase'],
    ['We will be back October 7.', 'date'],
    ['October 7 is your next visit.', 'date'],
    ['The next check is free.', 'price'],
    ['The follow-up is included.', 'price'],
    ['Your retreatment is covered.', 'price'],
    ['Activity fell by five percent.', 'percent'],
    ['We treated two acres of the back lot.', 'footage'],
    ['The home is now termite-proof.', 'owner_phrase'],
    ['We made the garage roachproof.', 'owner_phrase'],
    ['We will arrive between 8 and 10 AM.', 'time'],
    ['Your arrival window is 8 to 10 AM.', 'time'],
    ['We mixed 2 gals for the perimeter.', 'amount'],
    ['We used 2 qt in the backpack.', 'amount'],
    ['We used 3 ozs of bait.', 'amount'],
    ['We applied at the label rate.', 'rate'],
    ['We used the recorded mix strength.', 'rate'],
    ['The spray was diluted for the beds.', 'rate'],
    ['Thank you from Waves Pest & Lawn.', 'company_name'],
    ['Waves Pest Services came out today.', 'company_name'],
    ['The treatment lasts three weeks.', 'timeframe'],
    ['Waves Pest Control Services came out today.', 'company_name'],
    ['Thanks from Waves Pest Control LLC.', 'company_name'],
    ['Waves Home Services treated the lanai.', 'company_name'],
    ['No pest activity was observed today.', 'unscoped_absence'],
    ['The technician found no active pests during the visit.', 'unscoped_absence'],
    ['None were observed during the visit.', 'unscoped_absence'],
    ['The technician saw none today.', 'unscoped_absence'],
    ['Nothing was found.', 'unscoped_absence'],
    ['No pest activity was observed on this visit.', 'unscoped_absence'],
    ["None were observed in today's inspection.", 'unscoped_absence'],
    ["Nothing was found at today's service.", 'unscoped_absence'],
    ['Please do not disturb the bait placements.', 'aftercare'],
    ['Avoid cleaning the treated areas.', 'aftercare'],
    ['Water the treated area this evening.', 'aftercare'],
    ['Leave the bait stations undisturbed.', 'aftercare'],
    ['We recommend not mopping along the baseboards.', 'aftercare'],
    ['We mapped the treated perimeter.', 'owner_phrase'],
    ['The technician followed the traced route.', 'owner_phrase'],
    ['We completed the treated outline.', 'owner_phrase'],
    ['The recheck is 95 dollars.', 'price'],
    ['That visit costs ninety-five dollars.', 'price'],
    ['There is a small fee for the extra station.', 'price'],
    ['We will not charge for the follow-up.', 'price'],
    ['Your next visit is scheduled for 10/7.', 'date'],
    ['We will be back on 2026-10-07.', 'date'],
    ['No pest activity was observed by the technician today.', 'unscoped_absence'],
    ['No pest activity of any kind was found.', 'unscoped_absence'],
    ['There was no pest activity today.', 'unscoped_absence'],
    ['No activity was found at your home.', 'unscoped_absence'],
    ['We will return Tuesday.', 'date'],
    ["We'll be back tomorrow.", 'date'],
    ['See you next week.', 'date'],
    ['Bacillus thuringiensis israelensis went into the pond.', 'active_ingredient'],
    ['We applied two cc behind the stove.', 'amount'],
    ['Two cubic centimeters went into each crack.', 'amount'],
    ["Please don't walk on the treated lawn.", 'aftercare'],
    ['Please avoid the treated areas.', 'aftercare'],
    ['Keep off the treated beds for now.', 'reentry'],
    ['We treated the kitchen, and no pest activity was observed across the property.', 'unscoped_absence'],
    ['Your next visit is at noon.', 'time'],
    ['We will return at midnight.', 'time'],
    ['Activity may continue for a week.', 'timeframe'],
    ['We mixed two gals for the perimeter.', 'amount'],
    ['We used three qts in the backpack.', 'amount'],
    ['Your next visit is in the morning.', 'time'],
    ['We will arrive this afternoon.', 'time'],
    ['Thanks from Waves Pest Control of Southwest Florida.', 'company_name'],
    ['Thanks from Waves Pest Control, LLC.', 'company_name'],
    ['We did not observe any pest activity today.', 'unscoped_absence'],
    ["The technician didn't see ants today.", 'unscoped_absence'],
    ['Activity was not observed today.', 'unscoped_absence'],
    ['Allow the treated areas to dry before using them.', 'reentry'],
    ['Wait for the treatment to dry before returning.', 'reentry'],
    ['Avoid contact with treated surfaces.', 'reentry'],
    ['Activity may continue over the coming days.', 'timeframe'],
    ['You may notice activity in the days ahead.', 'timeframe'],
    ['The activity rating was 2.', 'gauge'],
    ['The kitchen was rated two out of five.', 'gauge'],
    ['Activity was 2 on the five-point scale.', 'gauge'],
    ['Zero pest activity was observed across the property.', 'unscoped_absence'],
    ['We found zero signs of pest activity across the property.', 'unscoped_absence'],
    ['Not a single ant was seen today.', 'unscoped_absence'],
    ['We will be back next month.', 'timeframe'],
  ])('rejects %j (%s)', (copy, reason) => {
    expect(writerRulesRejection(copy)).toBe(reason);
  });

  test('a three-letter catalog active and a parenthesized alias are screened', () => {
    expect(writerRulesRejection('We placed Bti larvicide in the pond.', { activeIngredients: ['Bacillus thuringiensis israelensis (Bti)'] })).toBe('active_ingredient');
    expect(writerRulesRejection('We placed a larvicide in the pond.', { activeIngredients: ['Bacillus thuringiensis israelensis (Bti)'] })).toBeNull();
  });

  test('past windows and physical words are not timeframes or prices', () => {
    expect(writerRulesRejection('About 1.4 inches of rain fell in the seven days before the visit.')).toBeNull();
    expect(writerRulesRejection('The customer first saw ants two weeks ago.')).toBeNull();
    expect(writerRulesRejection('We will recheck station 7 at your next monitoring visit.')).toBeNull();
    expect(writerRulesRejection('The station behind the garage is covered by mulch.')).toBeNull();
    expect(writerRulesRejection('The gutters were free of standing water.')).toBeNull();
    expect(writerRulesRejection('You texted us on Monday about the ants.')).toBeNull();
    expect(writerRulesRejection('We checked 4/5 stations.')).toBeNull();
    expect(writerRulesRejection('We will recheck 4/5 stations at the next visit.')).toBeNull();
    expect(writerRulesRejection('On 9/15 you mentioned ants by the sink.')).toBeNull();
    expect(writerRulesRejection('The technician in charge of your route checked the lanai.')).toBeNull();
    expect(writerRulesRejection('The other 10 stations showed no termite activity.')).toBeNull();
    expect(writerRulesRejection('We saw none at the front.')).toBeNull();
    expect(writerRulesRejection('You mentioned ants came back on Tuesday.')).toBeNull();
    expect(writerRulesRejection('In the kitchen, no activity was found.')).toBeNull();
    expect(writerRulesRejection('Mosquitoes were most active near midnight.')).toBeNull();
    expect(writerRulesRejection('We walked the fence line and treated the beds.')).toBeNull();
    expect(writerRulesRejection('Mosquitoes may bite several times a day.')).toBeNull();
    expect(writerRulesRejection('You mentioned seeing ants for a week.')).toBeNull();
    expect(writerRulesRejection('Mosquitoes will be most active in the evening.')).toBeNull();
    expect(writerRulesRejection('The technician arrived in the morning.')).toBeNull();
    expect(writerRulesRejection('Waves Pest Control, your technician checked the stations.')).toBeNull();
    expect(writerRulesRejection('We did not see ants in the kitchen.')).toBeNull();
    expect(writerRulesRejection('We did not find the source of the smell.')).toBeNull();
    expect(writerRulesRejection('We allowed the cabinet to dry before placing bait.')).toBeNull();
    expect(writerRulesRejection('Two out of five stations had feeding.')).toBeNull();
    expect(writerRulesRejection('Activity was light at 3 stations.')).toBeNull();
    expect(writerRulesRejection('Zero captures were recorded in the attic traps.')).toBeNull();
    expect(writerRulesRejection('The ants were back the next day, you said.')).toBeNull();
    expect(writerRulesRejection('On September 15, we noted activity near the sink.')).toBeNull();
    expect(writerRulesRejection('September 15 at your last visit showed ants at the slider.')).toBeNull();
    expect(writerRulesRejection('The station was covered by mulch.')).toBeNull();
    expect(writerRulesRejection('Web removal was included in today\'s visit.')).toBeNull();
    expect(writerRulesRejection('Mosquito activity was strongest after 8 PM.')).toBeNull();
    expect(writerRulesRejection('We arrived at 10 AM and started at the back fence.')).toBeNull();
    expect(writerRulesRejection('You mentioned seeing ants for two weeks.')).toBeNull();
    expect(writerRulesRejection('Activity continued during the last two weeks.')).toBeNull();
    expect(writerRulesRejection('Waves Pest Control treated the perimeter.')).toBeNull();
    expect(writerRulesRejection('No activity was seen at the lanai today.')).toBeNull();
    expect(writerRulesRejection('No visible pest activity was noted within the assessed areas today.')).toBeNull();
    expect(writerRulesRejection('You mentioned ants near the dishwasher; none were seen there today.')).toBeNull();
    expect(writerRulesRejection('None of the 10 stations had feeding.')).toBeNull();
    expect(writerRulesRejection('The activity rating was light.')).toBeNull();
  });

  test('work copy that shares the aftercare words gives no instruction', () => {
    expect(writerRulesRejection('We moved one station under the eave to keep the bait dry.')).toBeNull();
    expect(writerRulesRejection('We found standing water in the yard near the downspout.')).toBeNull();
    expect(writerRulesRejection('We chose gel bait to avoid spraying near the koi pond.')).toBeNull();
    expect(writerRulesRejection('Water was pooling by the A/C pad.')).toBeNull();
    expect(writerRulesRejection('No ants were seen in the kitchen during this visit.')).toBeNull();
  });

  test('a device placeholder in the catalog active field is not a chemical', () => {
    expect(writerRulesRejection('We reset the mechanical snap traps.', { activeIngredients: ['Mechanical snap trap'] })).toBeNull();
    expect(writerRulesRejection('We refilled the bromadiolone blocks.', { activeIngredients: ['Mechanical snap trap', 'Bromadiolone 0.005%'] })).toBe('active_ingredient');
  });

  test('a dry cabinet or a note about rain is not re-entry wording', () => {
    expect(writerRulesRejection('The cabinet under the sink was dry.')).toBeNull();
    expect(writerRulesRejection('About 1.4 inches of rain fell after the rain dried up the week before.')).toBeNull();
  });

  test('a catalog active named on its own is found; a lone nutrient or material word is not a name', () => {
    expect(activeIngredientsMentioned('Customer asked about azadirachtin for the roses', 'Azadirachtin')).toBe(true);
    expect(activeIngredientsMentioned('Treated along the wrought iron fence', 'Iron + N (foliar)')).toBe(false);
    expect(writerRulesRejection('We packed copper mesh into the gap.', { activeIngredients: ['Copper hydroxide', 'Copper'] })).toBeNull();
    expect(writerRulesRejection('We treated along the wrought iron fence.', { activeIngredients: ['Iron + N (foliar)'] })).toBeNull();
  });

  test('a catalog active with digits in its name is screened as written', () => {
    const activeIngredients = ['2,4-D + MCPP + Dicamba'];
    expect(writerRulesRejection('We applied 2,4-D to the weeds.', { activeIngredients })).toBe('active_ingredient');
    expect(writerRulesRejection('We treated the weeds by the fence.', { activeIngredients })).toBeNull();
    expect(writerRulesRejection('We applied fipronil at the slab.', { activeIngredients: ['Fipronil 9.1%, Pyriproxyfen'] })).toBe('active_ingredient');
  });

  test("the catalog's taxonomic Bti name still screens the Bti alias", () => {
    expect(writerRulesRejection('We placed Bti larvicide in the pond.', { activeIngredients: ['Bacillus thuringiensis subsp. israelensis solids'] })).toBe('active_ingredient');
  });

  test("this visit's catalog actives are screened as well", () => {
    const copy = 'We placed an indoxacarb gel under the sink.';
    expect(writerRulesRejection(copy, { activeIngredients: ['Indoxacarb 0.6%'] })).toBe('active_ingredient');
    expect(writerRulesRejection('We placed gel bait under the sink.', { activeIngredients: ['Indoxacarb 0.6%'] })).toBeNull();
  });

  // The four in-scope example paragraphs from the plan page Adam approved
  // (pest, rodent, termite, mosquito) must pass the screen.
  test.each([
    ['pest', 'WHAT WE DID\n\nWe came back to look into the ants you booked us for. Your technician checked the kitchen and the lanai side of the house, treated the kitchen cabinet bases and the sliding-door track inside, and treated the door thresholds and the lanai-side foundation outside.\n\nWHAT WE FOUND\n\nGhost ants were trailing along the back of the kitchen counter and the sliding-door track, and activity was light. You mentioned ants near the dishwasher; none were seen there today. The photo of the sliding-door track shows the ants there.'],
    ['rodent', 'WHAT WE DID\n\nWe checked the six traps set for this job, reset them, and refreshed the lure.\n\nWHAT WE FOUND\n\nTwo captures were recorded, and the technician logged roof rats. Droppings were still present near the A/C unit in the attic, where you told us you hear scratching at night. The technician also noted a gap at the rear soffit corner, and the soffit-vent tip in this report covers openings like it.'],
    ['termite', 'WHAT WE DID\n\nYou asked us to check your termite stations after a neighbor found termites, and to look at the lines you saw on the garage wall. We inspected 11 of your 12 stations, replaced the bait at station 7 on the east wall, and looked over the garage wall. The station behind the garage is buried under mulch, so we could not open it.\n\nWHAT WE FOUND\n\nTermites were feeding on the bait at station 7, and we saw live termites there. The other 10 stations we opened showed no termite activity, and we found no mud tubes on the garage wall. We will recheck station 7 and open the buried station at your next monitoring visit.'],
    ['mosquito', 'WHAT WE DID\n\nWe treated the shrub leaves along your back fence and the beds around the pool cage and lanai, where adult mosquitoes rest, keeping spray off the blooming hibiscus. We emptied two plant saucers on the lanai and flipped a bucket by the shed.\n\nWHAT WE FOUND\n\nMosquito activity was light along the back fence; we saw none at the front. The saucers and bucket were holding water, the kind of spot mosquitoes can breed in, and about 1.4 inches of rain fell in the seven days before the visit. You mentioned evening bites on the lanai, so we focused there.'],
  ])('passes the approved %s example', (_family, copy) => {
    expect(writerRulesRejection(copy)).toBeNull();
  });
});

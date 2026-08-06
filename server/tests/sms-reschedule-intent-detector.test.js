const { hasRescheduleOrAwayIntent, hasSchedulingIntent } = require('../services/sms-intent');

// Positive cases are the four real texts from the 2026-08-05 weekly comms
// sweep that the automation ignored (lightly paraphrased, no PII).
describe('hasRescheduleOrAwayIntent', () => {
  test('vacation-departure reschedule ask (the serviced-anyway incident)', () => {
    expect(hasRescheduleOrAwayIntent(
      'Good evening. We are leaving for vacation tomorrow morning. Can we rescheduled for next week? Sorry for the short notice.',
    )).toBe(true);
  });

  test('move-to-month ask with garage access', () => {
    expect(hasRescheduleOrAwayIntent(
      'Hi Adam We won’t be back till November 12. How about moving till late October and I can let you in via garage.',
    )).toBe(true);
  });

  test('away-recovery push ask', () => {
    expect(hasRescheduleOrAwayIntent(
      'She is recovering now and will stay here for another month or 2 so we will need to reschedule again.',
    )).toBe(true);
  });

  test('cancel wording', () => {
    expect(hasRescheduleOrAwayIntent('I need to cancel the appointment for Friday')).toBe(true);
  });

  test('out-of-town without a verb still flags', () => {
    expect(hasRescheduleOrAwayIntent('We are out of town this week')).toBe(true);
  });

  test('skip-this-visit wording', () => {
    expect(hasRescheduleOrAwayIntent('Can we skip this month? Nothing going on pest-wise')).toBe(true);
  });

  // Negatives: ordinary scheduling questions and confirmations must NOT
  // flag — those are hasSchedulingIntent's territory, not a reschedule ask.
  test('timing question does not flag', () => {
    const body = 'What time are you coming tomorrow?';
    expect(hasSchedulingIntent(body)).toBe(true);
    expect(hasRescheduleOrAwayIntent(body)).toBe(false);
  });

  test('confirmation does not flag', () => {
    expect(hasRescheduleOrAwayIntent('Sounds good, see you Saturday!')).toBe(false);
  });

  test('away + access permission is a heads-up, not a reschedule ask', () => {
    expect(hasRescheduleOrAwayIntent('I will not be home but I have a gate code for the left gate: 9618')).toBe(false);
    expect(hasRescheduleOrAwayIntent("I won't be here Saturday but exterior only is fine")).toBe(false);
  });

  test('permission never suppresses an explicit reschedule verb', () => {
    expect(hasRescheduleOrAwayIntent("The gate code is 1234 but actually can we reschedule to next week?")).toBe(true);
  });

  test('bare moving-the-couch does not flag', () => {
    expect(hasRescheduleOrAwayIntent('The guys are moving furniture in the living room')).toBe(false);
  });

  test('reaction and empty bodies do not flag', () => {
    expect(hasRescheduleOrAwayIntent('Liked “Hello! Your service is tomorrow”')).toBe(false);
    expect(hasRescheduleOrAwayIntent('')).toBe(false);
    expect(hasRescheduleOrAwayIntent(null)).toBe(false);
  });

  test('typographic apostrophes match like ASCII (phone keyboards)', () => {
    expect(hasRescheduleOrAwayIntent('I won’t be home tomorrow')).toBe(true);
    expect(hasRescheduleOrAwayIntent('We’re on vacation until Friday')).toBe(true);
  });

  test('thanks does not flag', () => {
    expect(hasRescheduleOrAwayIntent('Thank you so much!')).toBe(false);
  });
});

describe('r6 regression cases', () => {
  test('clock-time reschedule targets flag', () => {
    expect(hasRescheduleOrAwayIntent('Can we change it to 3pm?')).toBe(true);
    expect(hasRescheduleOrAwayIntent('Can we move it to 10:30 tomorrow?')).toBe(true);
  });
  test('delayed billing cancellations do not flag', () => {
    expect(hasRescheduleOrAwayIntent("Please cancel tomorrow's payment")).toBe(false);
    expect(hasRescheduleOrAwayIntent('Cancel my next invoice')).toBe(false);
  });
});

describe('r8 regression cases', () => {
  test('relative-date cancellations flag', () => {
    expect(hasRescheduleOrAwayIntent('I need to cancel for next week')).toBe(true);
    expect(hasRescheduleOrAwayIntent("cancel this week's treatment")).toBe(true);
    expect(hasRescheduleOrAwayIntent('Please cancel on the 12th')).toBe(true);
  });
});

describe('r13 regression cases', () => {
  test('present-perfect confirmations do not flag', () => {
    expect(hasRescheduleOrAwayIntent('Has my appointment been rescheduled?')).toBe(false);
  });
});

describe('r14 regression cases', () => {
  test('present-tense away messages flag', () => {
    expect(hasRescheduleOrAwayIntent("I'm away this week")).toBe(true);
    expect(hasRescheduleOrAwayIntent("I'm not home tomorrow")).toBe(true);
  });
});

describe('r16 regression cases', () => {
  test('present-perfect + fresh request still flags', () => {
    expect(hasRescheduleOrAwayIntent('I have been rescheduled to Friday, but I need to reschedule again')).toBe(true);
  });
  test('billing reschedules do not flag', () => {
    expect(hasRescheduleOrAwayIntent('Can I reschedule my autopay?')).toBe(false);
    expect(hasRescheduleOrAwayIntent('I need to reschedule my payment')).toBe(false);
  });
});

describe('r17 regression cases', () => {
  test('past absences do not flag', () => {
    expect(hasRescheduleOrAwayIntent('We were out of town last week')).toBe(false);
    expect(hasRescheduleOrAwayIntent('I was on vacation last week')).toBe(false);
  });
});

describe('r18 regression cases (cancel acknowledgments)', () => {
  test('cancellation acknowledgments and status questions do not flag', () => {
    expect(hasRescheduleOrAwayIntent('Has my appointment been canceled?')).toBe(false);
    expect(hasRescheduleOrAwayIntent('Did you cancel my appointment?')).toBe(false);
    expect(hasRescheduleOrAwayIntent('Thanks for canceling my appointment')).toBe(false);
  });
});

describe('r19 regression cases (active cancel auxiliaries)', () => {
  test('active cancellation requests with auxiliaries flag', () => {
    expect(hasRescheduleOrAwayIntent('I have to cancel my appointment Friday')).toBe(true);
    expect(hasRescheduleOrAwayIntent('I was hoping to cancel my appointment')).toBe(true);
  });
});

describe('r20 regression cases (billing synonyms)', () => {
  test('billing postpone/move do not flag', () => {
    expect(hasRescheduleOrAwayIntent('Can I postpone my payment until Friday?')).toBe(false);
    expect(hasRescheduleOrAwayIntent('Please move my bill to next month')).toBe(false);
  });
});

describe('r22 regression cases (fresh cancel after ack)', () => {
  test('acknowledgment followed by a fresh cancel ask flags', () => {
    expect(hasRescheduleOrAwayIntent('Thanks for canceling last week. I need to cancel my appointment Friday too')).toBe(true);
  });
});

describe('r23 regression cases', () => {
  test('skip with direct temporal targets flags', () => {
    expect(hasRescheduleOrAwayIntent('Can we skip tomorrow?')).toBe(true);
  });
  test('billing date-only phrasing does not flag', () => {
    expect(hasRescheduleOrAwayIntent('Can I make my payment a different day?')).toBe(false);
  });
});

describe('corrected asks override same-message negations (codex r24)', () => {
  test('negation then correction flags', () => {
    expect(hasRescheduleOrAwayIntent("Don't reschedule Tuesday. Actually, please reschedule my appointment for Friday.")).toBe(true);
  });
  test('plain please-reschedule ask flags', () => {
    expect(hasRescheduleOrAwayIntent('Please reschedule my appointment for next week')).toBe(true);
  });
  test('pure negation still suppresses', () => {
    expect(hasRescheduleOrAwayIntent("Don't reschedule us, you can still come Tuesday")).toBe(false);
  });
  test('please do NOT reschedule stays suppressed', () => {
    expect(hasRescheduleOrAwayIntent("Please don't reschedule my appointment")).toBe(false);
  });
  test('past acknowledgment with actually-status is not a fresh ask', () => {
    expect(hasRescheduleOrAwayIntent('Actually they already rescheduled it, thanks')).toBe(false);
  });
});

describe('postpone/skip veto coverage (codex r25)', () => {
  test('dont-postpone negation suppresses', () => {
    expect(hasRescheduleOrAwayIntent("Don't postpone my appointment")).toBe(false);
  });
  test('been-postponed status question suppresses', () => {
    expect(hasRescheduleOrAwayIntent('Has my appointment been postponed?')).toBe(false);
  });
  test('did-you-skip status question suppresses', () => {
    expect(hasRescheduleOrAwayIntent('Did you skip tomorrow?')).toBe(false);
  });
  test('need-to-postpone fresh ask still flags', () => {
    expect(hasRescheduleOrAwayIntent('We need to postpone our appointment this week')).toBe(true);
  });
  test('please-postpone fresh ask still flags', () => {
    expect(hasRescheduleOrAwayIntent('Please postpone my service until next week')).toBe(true);
  });
});

describe('negated need/want phrases are not fresh asks (codex r26)', () => {
  test('dont-need-to-reschedule suppresses', () => {
    expect(hasRescheduleOrAwayIntent("I don't need to reschedule")).toBe(false);
  });
  test('dont-want-to-reschedule suppresses', () => {
    expect(hasRescheduleOrAwayIntent("We don't want to reschedule, Tuesday still works")).toBe(false);
  });
  test('no-need-to-reschedule suppresses', () => {
    expect(hasRescheduleOrAwayIntent('No need to reschedule, see you then')).toBe(false);
  });
  test('plain need-to-reschedule still flags', () => {
    expect(hasRescheduleOrAwayIntent('I need to reschedule my appointment')).toBe(true);
  });
});

describe('absence forms, cancel negations, correction verbs (codex r27)', () => {
  test('cant-be-there absence flags', () => {
    expect(hasRescheduleOrAwayIntent("I can't be there tomorrow")).toBe(true);
  });
  test('wont-be-available absence flags', () => {
    expect(hasRescheduleOrAwayIntent("I won't be available for tomorrow's service")).toBe(true);
  });
  test('nobody-home absence flags', () => {
    expect(hasRescheduleOrAwayIntent('Nobody will be home tomorrow')).toBe(true);
  });
  test('dont-want-you-to-cancel suppresses', () => {
    expect(hasRescheduleOrAwayIntent("I don't want you to cancel tomorrow's appointment")).toBe(false);
  });
  test('dont-want-my-appointment-canceled suppresses', () => {
    expect(hasRescheduleOrAwayIntent("I don't want my appointment canceled")).toBe(false);
  });
  test('was-not-asking-to-cancel suppresses', () => {
    expect(hasRescheduleOrAwayIntent("I was not asking to cancel tomorrow's service")).toBe(false);
  });
  test('move correction overrides negation', () => {
    expect(hasRescheduleOrAwayIntent("Don't move Tuesday. Actually, please move my appointment to Friday")).toBe(true);
  });
  test('skip correction overrides negation', () => {
    expect(hasRescheduleOrAwayIntent("Don't skip Tuesday. Actually, please skip Friday")).toBe(true);
  });
  test('please-move-forward business phrase stays quiet', () => {
    expect(hasRescheduleOrAwayIntent('Please move forward with the treatment plan')).toBe(false);
  });
});

describe('fresh appointment-cancel overrides whole-message vetoes (codex r28)', () => {
  test('corrected billing negation plus service cancel flags', () => {
    expect(hasRescheduleOrAwayIntent("Please don't cancel autopay. I need to cancel tomorrow's service")).toBe(true);
  });
  test('pure billing cancel stays quiet', () => {
    expect(hasRescheduleOrAwayIntent('I need to cancel autopay tomorrow')).toBe(false);
  });
  test('negated service cancel stays quiet', () => {
    expect(hasRescheduleOrAwayIntent("I don't want to cancel my service")).toBe(false);
  });
  test('plain please-cancel-my-appointment flags', () => {
    expect(hasRescheduleOrAwayIntent('Please cancel my appointment for tomorrow')).toBe(true);
  });
});

describe('skip-with-adjective and gone/away forms (codex r29)', () => {
  test('skip my next appointment flags', () => {
    expect(hasRescheduleOrAwayIntent('I need to skip my next appointment')).toBe(true);
  });
  test('we will be gone tomorrow flags', () => {
    expect(hasRescheduleOrAwayIntent('We will be gone tomorrow')).toBe(true);
  });
  test('we are going to be away tomorrow flags', () => {
    expect(hasRescheduleOrAwayIntent('We are going to be away tomorrow')).toBe(true);
  });
  test('the ants are gone stays quiet', () => {
    expect(hasRescheduleOrAwayIntent('Great news, the ants are gone')).toBe(false);
  });
});

describe('determiner-less skip asks (codex r30)', () => {
  test('please skip next appointment flags', () => {
    expect(hasRescheduleOrAwayIntent('Please skip next appointment')).toBe(true);
  });
  test('could you skip upcoming appointment flags', () => {
    expect(hasRescheduleOrAwayIntent('Could you skip upcoming appointment?')).toBe(true);
  });
});

describe('direct travel targets (codex r31)', () => {
  test('traveling tomorrow flags', () => {
    expect(hasRescheduleOrAwayIntent('I will be traveling tomorrow')).toBe(true);
  });
  test('traveling Friday flags', () => {
    expect(hasRescheduleOrAwayIntent('We are traveling Friday')).toBe(true);
  });
});

describe('present-state cancel status questions (codex r32)', () => {
  test('is-my-appointment-canceled suppresses', () => {
    expect(hasRescheduleOrAwayIntent('Is my appointment canceled?')).toBe(false);
  });
  test('confirm-is-canceled suppresses', () => {
    expect(hasRescheduleOrAwayIntent('Can you confirm my appointment is canceled?')).toBe(false);
  });
});

describe('cant-make absence forms (codex r33)', () => {
  test('cant make tomorrows appointment flags', () => {
    expect(hasRescheduleOrAwayIntent("I can't make tomorrow's appointment")).toBe(true);
  });
  test('cant make it Friday flags', () => {
    expect(hasRescheduleOrAwayIntent("Sorry, we can't make it Friday")).toBe(true);
  });
  test('cant make the payment stays quiet', () => {
    expect(hasRescheduleOrAwayIntent("I can't make the payment this month")).toBe(false);
  });
});

describe('unable-to-attend forms and plan-change vetoes (codex r34)', () => {
  test('wont be able to attend flags', () => {
    expect(hasRescheduleOrAwayIntent("I won't be able to attend tomorrow's appointment")).toBe(true);
  });
  test('unable to attend flags', () => {
    expect(hasRescheduleOrAwayIntent("I'm unable to attend Friday's service")).toBe(true);
  });
  test('plan change stays quiet', () => {
    expect(hasRescheduleOrAwayIntent('I need to change my service from quarterly to monthly')).toBe(false);
  });
  test('provider change stays quiet', () => {
    expect(hasRescheduleOrAwayIntent('I am changing service providers')).toBe(false);
  });
  test('plan upgrade stays quiet', () => {
    expect(hasRescheduleOrAwayIntent('Can you bump my service up to the premium plan?')).toBe(false);
  });
  test('move service to a weekday still flags', () => {
    expect(hasRescheduleOrAwayIntent('Can you move my service to Thursday?')).toBe(true);
  });
});

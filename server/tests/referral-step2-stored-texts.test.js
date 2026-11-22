// Referral Step 2, the stored texts (words: owner 2026-11-21; GATE_REFERRAL_STEP2). The texts in the database are never changed:
// with the gate on, the SEEDED sentence inside a rendered text is swapped for the approved words at render time
// (referral-step2.js), and every amount is the live cents. Gate off: the text is exactly as stored.
// Fixtures are the seeds the migrations wrote; a read of production (2026-11-22) found each stored text equal to its seed.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));

const step2 = require('../services/referral-step2');
const { stripSmsUrlScheme } = require('../services/messaging/sms-link-policy');
const db = require('../models/db');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderRequiredSmsTemplate } = require('../services/sms-template-renderer');
const { gates } = require('../config/feature-gates');
const engine = require('../services/referral-engine');

const step1Migration = require('../models/migrations/20261120090000_referral_step1_settings');
const { _SWAPS: smsSwaps } = require('../models/migrations/20261006220000_sms_template_tighten');
const { _STEP_SWAPS: stepSwaps } = require('../models/migrations/20260926120200_customer_copy_audit_automations');

const COLUMN_SEED = step1Migration._CHANGES.find(([column]) => column === 'invite_sms_template')[2];
const ROW_SEED = smsSwaps.find(([key]) => key === 'referral_invite')[2];
const nudgeSeed = (field) => stepSwaps.find((s) => s.key === 'referral_nudge' && s.field === field).after;
const HTML_SEED = nudgeSeed('html_body');
const TEXT_SEED = nudgeSeed('text_body');
const PREVIEW_SEED = nudgeSeed('preview_text');

const LINK = 'portal.wavespestcontrol.com/r/WAVES-ABC12345';
const fillColumn = (text, names = { referee: 'Jo', referrer: 'Sam' }) => text
  .replace('{referee_name}', () => names.referee).replace('{referrer_name}', () => names.referrer).replace('{referral_link}', () => LINK);
const fillRow = fillColumn;

describe('the seeded sentences are in the seeds', () => {
  test('each seed holds the sentence the swap looks for, so a drifting seed fails here', () => {
    expect(COLUMN_SEED).toContain(`${step2.SEEDED_INVITE_OFFERS[0].head}${step2.SEEDED_INVITE_OFFERS[0].legacy}: {referral_link}`);
    expect(ROW_SEED).toContain(`${step2.SEEDED_INVITE_OFFERS[1].head}${step2.SEEDED_INVITE_OFFERS[1].legacy}: {referral_link}\n\nReply STOP to opt out.`);
    expect(HTML_SEED).toContain(step2.NUDGE_SEEDED.html);
    expect(TEXT_SEED).toContain(step2.NUDGE_SEEDED.text);
    expect(PREVIEW_SEED).toBe(step2.NUDGE_SEEDED.preview);
  });
});

describe('inviteSmsWithOffer (the invite text, column and referral_invite row)', () => {
  test('gate off: the text is returned exactly as rendered, whatever the amount', () => {
    for (const body of [fillColumn(COLUMN_SEED), fillRow(ROW_SEED)]) {
      expect(step2.inviteSmsWithOffer(body)).toBe(body);
      for (const refereeCents of [0, 5000]) expect(step2.inviteSmsWithOffer(body, { step2On: false, refereeCents })).toBe(body);
    }
  });

  test('gate on with no friend credit to state: the seeded "You\'ll both save" becomes the neutral words, never a reward', () => {
    for (const refereeCents of [0, undefined, null, -5, NaN]) {
      expect(step2.inviteSmsWithOffer(fillColumn(COLUMN_SEED), { step2On: true, refereeCents, link: LINK })).toBe(
        `Hi Jo! Your neighbor Sam recommended Waves. Get a free quote: ${LINK}\n\nReply STOP to opt out.`,
      );
      // The referral_invite row already names no reward: unchanged.
      expect(step2.inviteSmsWithOffer(fillRow(ROW_SEED), { step2On: true, refereeCents, link: LINK })).toBe(fillRow(ROW_SEED));
    }
  });

  test('the column text gets the approved words with the live amount', () => {
    expect(step2.inviteSmsWithOffer(fillColumn(COLUMN_SEED), { step2On: true, refereeCents: 5000, link: LINK })).toBe(
      `Hi Jo! Your neighbor Sam recommended Waves. Start a plan and get a $50 credit after your first plan service: ${LINK}\n\nReply STOP to opt out.`,
    );
  });

  test('the referral_invite row gets the approved words and keeps its STOP line', () => {
    expect(step2.inviteSmsWithOffer(fillRow(ROW_SEED), { step2On: true, refereeCents: 5000, link: LINK })).toBe(
      `Hi Jo, Sam recommended Waves to you. Start a plan and get a $50 credit after your first plan service: ${LINK}\n\nReply STOP to opt out.`,
    );
  });

  test('a swapped invite ends in the STOP line exactly once, whether the seed had it (the row) or not (the column)', () => {
    for (const body of [fillColumn(COLUMN_SEED), fillRow(ROW_SEED)]) {
      for (const refereeCents of [5000, 0]) {
        const swapped = step2.inviteSmsWithOffer(body, { step2On: true, refereeCents, link: LINK });
        expect(swapped.endsWith(`${LINK}\n\nReply STOP to opt out.`)).toBe(true);
        expect(swapped.split('Reply STOP to opt out.').length).toBe(2);
      }
    }
  });

  test('cents are shown to the cent', () => {
    expect(step2.inviteSmsWithOffer(fillColumn(COLUMN_SEED), { step2On: true, refereeCents: 2550, link: LINK })).toContain('get a $25.50 credit after');
  });

  test('a text an admin rewrote is left as it is', () => {
    for (const edited of [
      `Hi Jo, Sam says Waves is great: ${LINK}`,
      `Hi Jo! Sam recommended Waves. You'll both save $10 when you sign up: ${LINK}`,
      `Hi Jo! Your neighbor Sam recommended Waves. You'll both save when you sign up, so call us: ${LINK} Thanks!`,
    ]) for (const refereeCents of [5000, 0]) expect(step2.inviteSmsWithOffer(edited, { step2On: true, refereeCents, link: LINK })).toBe(edited);
  });

  test('the saved-text renderer shows the link without https://: the row still matches the link the caller holds', () => {
    const full = `https://${LINK}`;
    expect(stripSmsUrlScheme(full)).toBe(LINK);
    expect(step2.inviteSmsWithOffer(fillRow(ROW_SEED), { step2On: true, refereeCents: 5000, link: full })).toBe(
      `Hi Jo, Sam recommended Waves to you. Start a plan and get a $50 credit after your first plan service: ${LINK}\n\nReply STOP to opt out.`,
    );
    // The settings column keeps the link as given.
    const column = fillColumn(COLUMN_SEED).replace(LINK, full);
    expect(step2.inviteSmsWithOffer(column, { step2On: true, refereeCents: 5000, link: full })).toBe(
      `Hi Jo! Your neighbor Sam recommended Waves. Start a plan and get a $50 credit after your first plan service: ${full}\n\nReply STOP to opt out.`,
    );
  });

  test('a text an admin pointed at something else than the referral link is not swapped, and neither is a text with no link to match', () => {
    const phone = COLUMN_SEED.replace('{referee_name}', 'Jo').replace('{referrer_name}', 'Sam').replace('{referral_link}', '9415550100');
    expect(step2.inviteSmsWithOffer(phone, { step2On: true, refereeCents: 5000, link: LINK })).toBe(phone);
    const rowPhone = `Hi Jo, Sam recommended Waves to you. Get a free quote: 9415550100\n\nReply STOP to opt out.`;
    expect(step2.inviteSmsWithOffer(rowPhone, { step2On: true, refereeCents: 5000, link: LINK })).toBe(rowPhone);
    expect(step2.inviteSmsWithOffer(fillColumn(COLUMN_SEED), { step2On: true, refereeCents: 5000 })).toBe(fillColumn(COLUMN_SEED));
  });

  test('a name that holds the seeded sentence is not swapped: only the stretch before the link counts', () => {
    const name = "Pat recommended Waves. You'll both save when you sign up: ";
    const rewritten = `Hi Jo, ${name}recommended Waves to you. Call us: ${LINK}`;
    expect(step2.inviteSmsWithOffer(rewritten, { step2On: true, refereeCents: 5000, link: LINK })).toBe(rewritten);
    const seeded = fillColumn(COLUMN_SEED, { referee: 'Jo', referrer: name });
    expect(step2.inviteSmsWithOffer(seeded, { step2On: true, refereeCents: 5000, link: LINK })).toBe(
      `Hi Jo! Your neighbor ${name} recommended Waves. Start a plan and get a $50 credit after your first plan service: ${LINK}\n\nReply STOP to opt out.`,
    );
  });
});

describe('composerReferralLine (the office composer insert)', () => {
  test('no amount: today\'s line exactly; an amount: the approved words', () => {
    const link = 'https://portal.wavespestcontrol.com/r/WAVES-ABC12345';
    expect(step2.composerReferralLine(link, 0)).toBe(`Know someone who needs pest control? Share Waves here: ${link}\n\n`);
    expect(step2.composerReferralLine(link, undefined)).toBe(`Know someone who needs pest control? Share Waves here: ${link}\n\n`);
    expect(step2.composerReferralLine(link, 5000)).toBe(
      `Know someone who needs pest or lawn care? They get a $50 credit after their first plan service with your link: ${link}\n\n`,
    );
    expect(step2.composerReferralLine(link, 2550)).toContain('They get a $25.50 credit');
  });
});

describe('nudgeEmailWithOffer (the referral_nudge email)', () => {
  const offer = { refereeCents: 5000, memberCents: 2500, atLimit: false };
  const APPROVED_HTML = 'When a neighbor, friend or family member starts a recurring plan with your link, they get a <strong>$50 account credit</strong> after their first service. After we complete their first service, you get a <strong>$25 account credit</strong>.';
  const APPROVED_TEXT = 'When a neighbor, friend or family member starts a recurring plan with your link, they get a $50 account credit after their first service. After we complete their first service, you get a $25 account credit.';

  test('the HTML body: the seeded sentence becomes the approved words, nothing else moves', () => {
    expect(step2.nudgeEmailWithOffer(HTML_SEED, { html: true, ...offer })).toBe(
      HTML_SEED.replace(step2.NUDGE_SEEDED.html, () => APPROVED_HTML),
    );
    expect(step2.nudgeEmailWithOffer(HTML_SEED, { html: true, ...offer })).toContain(
      `<p>Share your personal referral link — it's in the Refer tab of your customer portal. ${APPROVED_HTML}</p>`,
    );
  });

  test('the text body: the seeded dash clause becomes a sentence and the approved words', () => {
    const swapped = step2.nudgeEmailWithOffer(TEXT_SEED, { html: false, ...offer });
    expect(swapped).toBe(
      `Hi {{first_name}}! If our last service was solid, we'd love your help growing by word-of-mouth. Share your referral link from the Refer tab in your portal. ${APPROVED_TEXT} Or reply with their name and we'll reach out (one contact, no spam). Thanks for being on our route. — The Waves Pest Control team`,
    );
  });

  test('amounts are the live cents, to the cent', () => {
    expect(step2.nudgeEmailWithOffer(TEXT_SEED, { html: false, refereeCents: 2550, memberCents: 3000, atLimit: false }))
      .toContain('they get a $25.50 account credit after their first service. After we complete their first service, you get a $30 account credit.');
  });

  test('a member at the yearly limit, or with no member amount, is promised no credit: the first sentence only', () => {
    for (const memberOffer of [{ ...offer, atLimit: true }, { ...offer, memberCents: 0 }]) {
      const swapped = step2.nudgeEmailWithOffer(HTML_SEED, { html: true, ...memberOffer });
      expect(swapped).toContain('they get a <strong>$50 account credit</strong> after their first service.</p>');
      expect(swapped).not.toMatch(/you get a/);
    }
  });

  test('a $0 friend credit never restates the seeded "$25 each": the member\'s sentence alone', () => {
    const memberOnly = { ...offer, refereeCents: 0 };
    expect(step2.nudgeEmailWithOffer(HTML_SEED, { html: true, ...memberOnly })).toContain(
      '<p>Share your personal referral link — it\'s in the Refer tab of your customer portal. When a neighbor, friend or family member starts a recurring plan with your link and we complete their first service, you get a <strong>$25 account credit</strong>.</p>',
    );
    const text = step2.nudgeEmailWithOffer(TEXT_SEED, { html: false, ...memberOnly });
    expect(text).toContain('in your portal. When a neighbor, friend or family member starts a recurring plan with your link and we complete their first service, you get a $25 account credit. Or reply');
    for (const body of [step2.nudgeEmailWithOffer(HTML_SEED, { html: true, ...memberOnly }), text]) {
      expect(body).not.toMatch(/you each get|they get/);
    }
  });

  test('no credit to state (both $0, or a $0 friend credit at the yearly limit): the sentence is left out', () => {
    for (const none of [{ refereeCents: 0, memberCents: 0, atLimit: false }, { refereeCents: 0, memberCents: 2500, atLimit: true }]) {
      expect(step2.nudgeEmailWithOffer(HTML_SEED, { html: true, ...none })).toContain(
        '<p>Share your personal referral link — it\'s in the Refer tab of your customer portal.</p>',
      );
      const text = step2.nudgeEmailWithOffer(TEXT_SEED, { html: false, ...none });
      expect(text).toContain('Share your referral link from the Refer tab in your portal. Or reply with their name');
      expect(text).not.toMatch(/account credit/);
    }
  });

  test('a body that holds the seeded sentence twice has every copy swapped: no copy of the old promise is left', () => {
    const twiceHtml = `${HTML_SEED}\n${HTML_SEED}`;
    const twiceText = `${TEXT_SEED} ${TEXT_SEED}`;
    for (const o of [offer, { refereeCents: 0, memberCents: 0, atLimit: false }, { ...offer, refereeCents: 0 }]) {
      for (const [body, html] of [[twiceHtml, true], [twiceText, false]]) {
        const swapped = step2.nudgeEmailWithOffer(body, { html, ...o });
        expect(swapped).not.toMatch(/you each get/);
        expect(swapped).not.toContain(html ? step2.NUDGE_SEEDED.html : step2.NUDGE_SEEDED.text);
      }
    }
    expect(step2.nudgeEmailWithOffer(twiceHtml, { html: true, ...offer }).split(APPROVED_HTML).length).toBe(3);
  });

  test('a body an admin rewrote is returned as stored', () => {
    const edited = '<p>Know a neighbor? Send them your link and we\'ll thank you both.</p>';
    expect(step2.nudgeEmailWithOffer(edited, { html: true, ...offer })).toBe(edited);
    // The HTML sentence in the text arm (and the reverse) is not the seeded stretch for that arm.
    expect(step2.nudgeEmailWithOffer(HTML_SEED, { html: false, ...offer })).toBe(HTML_SEED);
  });

  test('the preview line states the same credits as the body, and only a seeded line is swapped', () => {
    expect(step2.nudgePreviewWithOffer(PREVIEW_SEED, offer)).toBe('Refer a neighbor: they get a $50 credit, you get a $25 credit.');
    expect(step2.nudgePreviewWithOffer(PREVIEW_SEED, { ...offer, atLimit: true })).toBe('Refer a neighbor: they get a $50 credit.');
    expect(step2.nudgePreviewWithOffer(PREVIEW_SEED, { ...offer, memberCents: 0 })).toBe('Refer a neighbor: they get a $50 credit.');
    expect(step2.nudgePreviewWithOffer(PREVIEW_SEED, { ...offer, refereeCents: 0 })).toBe('Refer a neighbor: you get a $25 credit.');
    expect(step2.nudgePreviewWithOffer(PREVIEW_SEED, { refereeCents: 0, memberCents: 0 })).toBe('Refer a neighbor.');
    expect(step2.nudgePreviewWithOffer('Refer a neighbor, edited.', offer)).toBe('Refer a neighbor, edited.');
  });
});

describe('submitReferral sends the stored invite (column), swapped only while the gate is on', () => {
  // A chainable stand-in for knex: every method returns the chain; a read answers from `tables`; a count answers 0.
  let settingsReads;
  let settingsRow;
  function installDb() {
    settingsReads = 0;
    const make = (table) => {
      const chain = new Proxy(function chainTarget() {}, {
        get(_t, prop) {
          if (prop === 'then') return undefined;
          if (prop === 'first') {
            return async () => {
              if (table === 'referral_program_settings') { settingsReads += 1; return settingsRow; }
              if (table === 'referral_promoters') return { id: 'promoter-1', customer_id: 'cust-1', first_name: 'Sam', referral_code: 'WAVES-ABC12345', customer_phone: '+19415550000' };
              if (table === 'customers') return null;
              if (table === 'referrals') return null;
              return null;
            };
          }
          if (prop === 'count') return () => ({ first: async () => ({ c: 0 }) });
          if (prop === 'returning') return async () => [{ id: 'row-1' }];
          if (prop === 'forUpdate' || prop === 'forKeyShare') return () => chain;
          return () => chain;
        },
        apply() { return chain; },
      });
      return chain;
    };
    db.mockImplementation(make);
    db.transaction = jest.fn(async (fn) => fn((table) => make(table)));
    db.raw = jest.fn();
  }

  let savedGate;
  beforeEach(() => {
    jest.clearAllMocks();
    savedGate = gates.referralStep2;
    settingsRow = { id: 1, program_active: true, base_url: 'https://portal.wavespestcontrol.com', referrer_reward_cents: 2500, referee_discount_cents: 5000, max_referrals_per_month: 20, invite_sms_template: COLUMN_SEED };
    installDb();
  });
  afterEach(() => { gates.referralStep2 = savedGate; });

  const sentBody = () => sendCustomerMessage.mock.calls[0][0].body;
  const send = () => engine.submitReferral('promoter-1', { name: 'Jo Friend', phone: '941-555-0123', referrerName: 'Sam' });
  const TODAY = (link) => `Hi Jo! Your neighbor Sam recommended Waves. You'll both save when you sign up: ${link}`;

  test('gate off: the text is exactly the stored text, and the settings row is read once (no new read)', async () => {
    gates.referralStep2 = false;
    await send();
    expect(sentBody()).toMatch(/^Hi Jo! Your neighbor Sam recommended Waves\. You'll both save when you sign up: \S+$/);
    expect(sentBody()).toBe(TODAY(sentBody().split(': ').pop()));
    expect(settingsReads).toBe(1);
  });

  test('gate off, a hand-edited stored text: sent exactly as stored', async () => {
    gates.referralStep2 = false;
    settingsRow.invite_sms_template = 'Hi {referee_name}, {referrer_name} thinks you will love Waves: {referral_link}';
    await send();
    expect(sentBody()).toMatch(/^Hi Jo, Sam thinks you will love Waves: \S+$/);
  });

  test('gate on: the approved words with the live friend credit', async () => {
    gates.referralStep2 = true;
    await send();
    expect(sentBody()).toMatch(/^Hi Jo! Your neighbor Sam recommended Waves\. Start a plan and get a \$50 credit after your first plan service: \S+\n\nReply STOP to opt out\.$/);
  });

  test('gate on, the friend credit is $0 or the program is paused: neutral words, never "You\'ll both save"', async () => {
    gates.referralStep2 = true;
    settingsRow.referee_discount_cents = 0;
    await send();
    expect(sentBody()).toMatch(/^Hi Jo! Your neighbor Sam recommended Waves\. Get a free quote: \S+\n\nReply STOP to opt out\.$/);
    sendCustomerMessage.mockClear();
    installDb();
    settingsRow.referee_discount_cents = 5000;
    settingsRow.program_active = false;
    await send();
    expect(sentBody()).toMatch(/^Hi Jo! Your neighbor Sam recommended Waves\. Get a free quote: \S+\n\nReply STOP to opt out\.$/);
  });

  test('gate on, a hand-edited stored text: sent exactly as stored', async () => {
    gates.referralStep2 = true;
    settingsRow.invite_sms_template = 'Hi {referee_name}, {referrer_name} thinks you will love Waves: {referral_link}';
    await send();
    expect(sentBody()).toMatch(/^Hi Jo, Sam thinks you will love Waves: \S+$/);
  });

  test('with no stored column text the referral_invite row is used and swapped the same way', async () => {
    gates.referralStep2 = true;
    settingsRow.invite_sms_template = null;
    // As the real renderer returns it: the link without https:// (getTemplate ends in stripSmsUrlScheme).
    renderRequiredSmsTemplate.mockImplementation(async (_key, vars) => stripSmsUrlScheme(fillRow(ROW_SEED, { referee: vars.referee_name, referrer: vars.referrer_name }).replace(LINK, vars.referral_link)));
    await send();
    expect(sentBody()).toMatch(/^Hi Jo, Sam recommended Waves to you\. Start a plan and get a \$50 credit after your first plan service: \S+\n\nReply STOP to opt out\.$/);
  });
});

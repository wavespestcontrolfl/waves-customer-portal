// Tech Rewards Plan D5-5, part 1: the season bonus, stay bonus and December gift pay line kinds. Their plain words, that the
// add form does not offer them, and the figure a check carries for them. Pure; the pay run itself is in
// payroll-pay-lines-postgres.test.js. Synthetic amounts only.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => 'audit-1') }));

const { totalsOf, KIND_WORDS, KINDS, TECH_REWARD_KINDS } = require('../services/payroll-pay-lines');

describe('the Tech Rewards Plan pay line kinds', () => {
  test('have plain words and are not offered for hand entry', () => {
    expect(TECH_REWARD_KINDS).toEqual(['season_bonus', 'stay_bonus', 'december_gift']);
    expect(TECH_REWARD_KINDS.map((kind) => KIND_WORDS[kind])).toEqual(['Season bonus', 'Stay bonus', 'December gift']);
    for (const kind of TECH_REWARD_KINDS) expect(KINDS).not.toContain(kind);
  });

  test('totalsOf adds the three kinds into techRewardsCents, and only a check that holds one has the key', () => {
    const line = (kind, amountCents) => ({ kind, amountCents });
    expect(totalsOf([line('commission', 100)])).toEqual({ reviewBonusCents: 0, commissionCents: 100, healthAllowanceCents: 0, hsaEmployerCents: 0 });
    expect(totalsOf([line('season_bonus', 150000), line('december_gift', 30000), line('stay_bonus', 5000), line('review_bonus', 700)]))
      .toEqual({ reviewBonusCents: 700, commissionCents: 0, healthAllowanceCents: 0, hsaEmployerCents: 0, techRewardsCents: 185000 });
  });
});

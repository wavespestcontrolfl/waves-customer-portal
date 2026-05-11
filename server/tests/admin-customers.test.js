const adminCustomersRoute = require('../routes/admin-customers');

const {
  isValidStage,
  mapPipelineCustomer,
} = adminCustomersRoute._private;

describe('admin customers route helpers', () => {
  test('validates known customer pipeline stages', () => {
    expect(isValidStage('new_lead')).toBe(true);
    expect(isValidStage('active_customer')).toBe(true);
    expect(isValidStage('not_a_stage')).toBe(false);
  });

  test('maps pipeline rows to the V2 customer-card contract', () => {
    const changedAt = new Date('2026-05-10T12:00:00Z');
    const mapped = mapPipelineCustomer({
      id: 'customer-1',
      first_name: 'Ada',
      last_name: 'Lovelace',
      account_id: 'account-1',
      profile_label: 'Primary',
      address_line1: '1 Algorithm Way',
      city: 'Sarasota',
      phone: '+19415550100',
      waveguard_tier: 'Gold',
      monthly_rate: '129.50',
      lead_score: 82,
      lead_source: 'referral',
      pipeline_stage_changed_at: changedAt,
      next_follow_up_date: '2026-05-12',
    }, 'estimate_sent');

    expect(mapped).toMatchObject({
      id: 'customer-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      name: 'Ada Lovelace',
      accountId: 'account-1',
      profileLabel: 'Primary',
      address: '1 Algorithm Way, Sarasota',
      monthlyRate: 129.5,
      pipelineStage: 'estimate_sent',
      stageEnteredAt: changedAt,
    });
  });
});

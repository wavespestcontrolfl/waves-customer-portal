'use strict';

/**
 * Unit tests for server/services/tech-addon-prompt.js (owner 2026-11-27 "ok go").
 * Verifies Pest <-> Lawn only ladder (owner 2026-11-21), fail-closed ownership,
 * commercial exclusion, and zero dollar amounts (owner 2026-11-04 tech visibility).
 */

const { pickTechAddonPrompt, techAddonPromptFacts } = require('../services/tech-addon-prompt');

function mockDb(customerRow, { throwOnCustomer = false } = {}) {
  return jest.fn((table) => {
    if (table !== 'customers') throw new Error(`unexpected table ${table}`);
    return {
      where: jest.fn(() => ({
        first: jest.fn(async () => {
          if (throwOnCustomer) throw new Error('db down');
          return customerRow;
        }),
      })),
    };
  });
}

describe('tech-addon-prompt', () => {
  test('pest-only recurring customer prompts Lawn Care with zero dollar figures', () => {
    const prompt = pickTechAddonPrompt(['pest_control']);
    expect(prompt).toMatchObject({
      targetFamily: 'lawn_care',
      targetLabel: 'Lawn Care',
      fieldLeadServiceType: 'Lawn',
    });
    expect(JSON.stringify(prompt)).not.toMatch(/\$|\b\d{2,}\b/);
  });

  test('lawn-only recurring customer prompts Pest Control with zero dollar figures', () => {
    const prompt = pickTechAddonPrompt(['lawn_care']);
    expect(prompt).toMatchObject({
      targetFamily: 'pest_control',
      targetLabel: 'Pest Control',
      fieldLeadServiceType: 'Pest',
    });
    expect(JSON.stringify(prompt)).not.toMatch(/\$|\b\d{2,}\b/);
  });

  test('customer owning both pest and lawn gets null (never pushes Tree & Shrub or Termite)', () => {
    expect(pickTechAddonPrompt(['pest_control', 'lawn_care'])).toBeNull();
  });

  test('customer with neither pillar (e.g., mosquito or termite only) gets null', () => {
    expect(pickTechAddonPrompt([])).toBeNull();
    expect(pickTechAddonPrompt(['mosquito', 'termite_bait'])).toBeNull();
  });

  test('pest + mosquito still prompts Lawn Care (single pillar owned)', () => {
    const prompt = pickTechAddonPrompt(['pest_control', 'mosquito']);
    expect(prompt?.targetFamily).toBe('lawn_care');
  });

  test('commercial customer or commercial service type returns null', async () => {
    const loadOwned = jest.fn(async () => ['pest_control']);
    expect(
      await techAddonPromptFacts(
        { customer_id: 'c1', service_type: 'Quarterly Pest Control' },
        mockDb({ id: 'c1', is_commercial: true, active: true }),
        { loadOwnedRecurringServiceKeys: loadOwned },
      ),
    ).toBeNull();
    expect(
      await techAddonPromptFacts(
        { customer_id: 'c2', service_type: 'Commercial Pest Control' },
        mockDb({ id: 'c2', is_commercial: false, active: true }),
        { loadOwnedRecurringServiceKeys: loadOwned },
      ),
    ).toBeNull();
    expect(loadOwned).not.toHaveBeenCalled();
  });

  test('fail-closed: ownership lookup error returns null instead of guessing', async () => {
    const loadOwned = jest.fn(async () => { throw new Error('catalog join failed'); });
    const res = await techAddonPromptFacts(
      { customer_id: 'c1', service_type: 'Quarterly Pest Control' },
      mockDb({ id: 'c1', is_commercial: false, active: true }),
      { loadOwnedRecurringServiceKeys: loadOwned },
    );
    expect(res).toBeNull();
  });

  test('returns Lawn Care prompt for active residential pest-only customer', async () => {
    const loadOwned = jest.fn(async () => ['pest_control']);
    const res = await techAddonPromptFacts(
      { customer_id: 'c1', service_type: 'Quarterly Pest Control' },
      mockDb({ id: 'c1', is_commercial: false, active: true, waveguard_tier: 'Bronze' }),
      { loadOwnedRecurringServiceKeys: loadOwned },
    );
    expect(res?.targetFamily).toBe('lawn_care');
    expect(res?.fieldLeadServiceType).toBe('Lawn');
  });
});

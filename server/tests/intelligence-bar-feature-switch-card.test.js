/**
 * Feature-switch cards (set_railway_gate, set_growthbook_feature_environment)
 * — Codex r1 on #5489: the card shows the live preview facts (not the raw
 * model params), including every GrowthBook targeting rule a confirm puts live.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { confirmationDisplayParams } = require('../routes/admin-intelligence-bar');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');

const gatePreview = {
  preview: true,
  tool: 'set_railway_gate',
  gate: 'GATE_LATE_PAYMENT_CHECKER_OFF',
  controls: 'retires the legacy late-payment checker',
  current_value: 'false',
  new_value: 'true',
  meaning: "Inverted gate: 'true' turns the thing it names OFF.",
  inverted: true,
  redeploy_notice: 'Railway redeploys the portal when a variable changes, so the portal restarts briefly.',
  target: { service_id: 'svc-portal', service: 'waves-customer-portal', environment_id: 'env-1', environment: 'production' },
};

const gbPreview = {
  preview: true,
  tool: 'set_growthbook_feature_environment',
  feature: 'pricing-hub',
  environment: 'production',
  current_state: 'disabled in production',
  new_state: 'enabled in production',
  default_value: 'false',
  rule_count: 2,
  rules: {
    rule_1: 'force · serves true · when {"email":{"$regex":"@wavespestcontrol.com$"}}',
    rule_2: 'rollout · serves true · to 25% of matching traffic',
  },
  effect_note: "Once enabled, production serves the feature's default value (false) plus its 2 targeting rule(s) — enabling does not by itself make it serve true.",
};

describe('feature-switch cards show the live preview facts', () => {
  test('Railway gate card: change, meaning, controls, target and restart — not the raw params', () => {
    const shown = confirmationDisplayParams('set_railway_gate', { gate_name: 'GATE_LATE_PAYMENT_CHECKER_OFF', value: 'true' }, gatePreview);
    expect(shown).toEqual({
      gate: 'GATE_LATE_PAYMENT_CHECKER_OFF',
      change: 'false → true',
      meaning: gatePreview.meaning,
      controls: gatePreview.controls,
      target: 'waves-customer-portal (production)',
      restart: gatePreview.redeploy_notice,
    });
  });

  test('GrowthBook card: environment change, default value, every rule and served-value effect', () => {
    const shown = confirmationDisplayParams('set_growthbook_feature_environment', { feature_id: 'pricing-hub', enabled: true }, gbPreview);
    expect(shown).toEqual({
      feature: 'pricing-hub',
      change: 'disabled in production → enabled in production',
      default_value: 'false',
      targeting_rules: 2,
      rules: gbPreview.rules,
      effect: gbPreview.effect_note,
    });
  });

  test('the contract effects carry those lines — each GrowthBook rule on its own line', () => {
    for (const [toolName, params, preview] of [
      ['set_railway_gate', { gate_name: 'GATE_LATE_PAYMENT_CHECKER_OFF', value: 'true' }, gatePreview],
      ['set_growthbook_feature_environment', { feature_id: 'pricing-hub', enabled: true }, gbPreview],
    ]) {
      const displayParams = confirmationDisplayParams(toolName, params, preview);
      const contract = buildContract({ toolName, params, displayParams, preview, summary: 's' });
      const labels = contract.effects.map((e) => e.label);
      expect(labels.join('\n')).toMatch(toolName === 'set_railway_gate' ? /turns the thing it names OFF/ : /does not by itself make it serve true/);
      if (toolName === 'set_growthbook_feature_environment') {
        expect(labels).toContain(`rule 1: ${gbPreview.rules.rule_1}`);
        expect(labels).toContain(`rule 2: ${gbPreview.rules.rule_2}`);
      }
    }
  });
});

// Codex r4 on #5514: the switches are undone by confirming the opposite
// value, so "Cannot be undone" shows only when this tool could not restore
// the prior state (a Railway gate that was unset or held another value).
describe('feature-switch irreversibility is derived from the preview', () => {
  const contractFor = (toolName, preview) => buildContract({
    toolName, params: {}, displayParams: confirmationDisplayParams(toolName, {}, preview), preview, summary: 's',
  });

  test('a GrowthBook environment toggle is reversible', () => {
    expect(contractFor('set_growthbook_feature_environment', gbPreview).irreversible).toBe(false);
  });

  test.each([
    ['boolean', false],
    ['unset', true],
    ['non_boolean', true],
  ])('a Railway gate whose prior was %s: irreversible=%s', (priorKind, irreversible) => {
    expect(contractFor('set_railway_gate', { ...gatePreview, prior_kind: priorKind }).irreversible).toBe(irreversible);
  });

  test('other outside writes keep the irreversible badge', () => {
    expect(contractFor('purge_cloudflare_cache', {}).irreversible).toBe(true);
  });
});

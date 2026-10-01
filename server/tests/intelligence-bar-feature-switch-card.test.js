/**
 * Feature-switch cards (set_railway_gate, set_growthbook_feature_environment)
 * — Codex r1 on #5489: the card shows the live preview facts (not the raw
 * model params), and its contract is marked preview_only so the client hides
 * Confirm until the commit-path PR.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { confirmationDisplayParams } = require('../routes/admin-intelligence-bar');
const { buildContract } = require('../services/intelligence-bar/authorization-contract');
const { PREVIEW_ONLY_WRITE_TOOL_NAMES } = require('../services/intelligence-bar/write-gates');

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

  test('GrowthBook card: environment change, default value, rule count and served-value effect', () => {
    const shown = confirmationDisplayParams('set_growthbook_feature_environment', { feature_id: 'pricing-hub', enabled: true }, gbPreview);
    expect(shown).toEqual({
      feature: 'pricing-hub',
      change: 'disabled in production → enabled in production',
      default_value: 'false',
      targeting_rules: 2,
      effect: gbPreview.effect_note,
    });
  });

  test('the contract effects carry those lines, and preview_only is set', () => {
    for (const [toolName, params, preview] of [
      ['set_railway_gate', { gate_name: 'GATE_LATE_PAYMENT_CHECKER_OFF', value: 'true' }, gatePreview],
      ['set_growthbook_feature_environment', { feature_id: 'pricing-hub', enabled: true }, gbPreview],
    ]) {
      const displayParams = confirmationDisplayParams(toolName, params, preview);
      const contract = buildContract({ toolName, params, displayParams, preview, summary: 's' });
      expect(contract.preview_only).toBe(true);
      const labels = contract.effects.map((e) => e.label).join('\n');
      expect(labels).toMatch(toolName === 'set_railway_gate' ? /turns the thing it names OFF/ : /does not by itself make it serve true/);
    }
  });

  test('ordinary outside writes are not preview_only', () => {
    const contract = buildContract({
      toolName: 'purge_cloudflare_cache', params: { zone_name: 'wavespestcontrol.com' }, displayParams: { zone_name: 'wavespestcontrol.com' }, preview: {}, summary: 's',
    });
    expect(contract.preview_only).toBeUndefined();
    expect([...PREVIEW_ONLY_WRITE_TOOL_NAMES].sort()).toEqual(['set_growthbook_feature_environment', 'set_railway_gate']);
  });
});

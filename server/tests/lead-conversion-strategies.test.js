/**
 * resolveConversionLeads (lead-estimate-link.js) is a table of three resolution strategies tried in
 * order: direct link, wizard lead (customer link), contact fallback. Behavior is unchanged from the
 * one-function version (the lead-link suites cover the real queries); this pins the table: the order,
 * first hit wins, a reason stops the walk, the open-lead filter and the ambiguity guard, and that no
 * piece is over the complexity limit the old function broke (37 against 20). Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { Linter } = require('eslint');
const LeadLink = require('../services/lead-estimate-link');

const lead = (id, overrides = {}) => ({ id, status: 'new', deleted_at: null, ...overrides });
// Swap the strategy table's entries for spies for one test, then put the real ones back.
function withStrategies(spies, body) {
  const real = LeadLink.CONVERSION_STRATEGIES.splice(0, LeadLink.CONVERSION_STRATEGIES.length, ...spies);
  return Promise.resolve(body()).finally(() => LeadLink.CONVERSION_STRATEGIES.splice(0, LeadLink.CONVERSION_STRATEGIES.length, ...real));
}
const resolve = (extra = {}) => LeadLink.resolveConversionLeads(jest.fn(), { source: 'invoice_sent', customerId: 'cust-1', ...extra });

describe('resolveConversionLeads strategy table', () => {
  test('the table is direct link, wizard lead, contact fallback, in that order', () => {
    expect(LeadLink.CONVERSION_STRATEGIES.map((fn) => fn.name)).toEqual(['directLinkStrategy', 'wizardLeadStrategy', 'contactFallbackStrategy']);
  });

  test('the first strategy that finds leads wins; later ones are not tried', async () => {
    const calls = [];
    const spy = (name, found) => jest.fn(async () => { calls.push(name); return found; });
    await withStrategies([spy('direct', null), spy('wizard', { candidates: [lead('l-1')], resolution: 'customer_link' }), spy('contact', { candidates: [lead('l-2')], resolution: 'contact' })], async () => {
      await expect(resolve()).resolves.toMatchObject({ resolution: 'customer_link', open: [{ id: 'l-1' }] });
    });
    expect(calls).toEqual(['direct', 'wizard']);
  });

  test('a strategy that answers a reason stops the walk and nothing converts', async () => {
    const later = jest.fn(async () => ({ candidates: [lead('l-9')], resolution: 'contact' }));
    await withStrategies([jest.fn(async () => null), jest.fn(async () => ({ reason: 'not_first_close' })), later], async () => {
      await expect(resolve()).resolves.toEqual({ reason: 'not_first_close' });
    });
    expect(later).not.toHaveBeenCalled();
  });

  test('nothing found, or only closed / deleted leads, is no_open_lead; a closed wizard duplicate still counts', async () => {
    await withStrategies([async () => null, async () => null, async () => null], async () => {
      await expect(resolve()).resolves.toEqual({ reason: 'no_open_lead' });
    });
    await withStrategies([async () => ({ candidates: [lead('l-1', { status: 'won' }), lead('l-2', { deleted_at: '2099-01-01' })], resolution: 'estimate' })], async () => {
      await expect(resolve()).resolves.toEqual({ reason: 'no_open_lead' });
    });
    await withStrategies([async () => ({ candidates: [lead('l-1', { status: 'duplicate' })], resolution: 'customer_link' })], async () => {
      await expect(resolve()).resolves.toMatchObject({ open: [{ id: 'l-1' }] });
    });
    await withStrategies([async () => ({ candidates: [lead('l-1', { status: 'duplicate' })], resolution: 'contact' })], async () => {
      await expect(resolve()).resolves.toEqual({ reason: 'no_open_lead' });
    });
  });

  test('two open leads on one contact are ambiguous; two linked to the estimate all convert', async () => {
    const two = [lead('l-1'), lead('l-2')];
    await withStrategies([async () => ({ candidates: two, resolution: 'contact' })], async () => {
      await expect(resolve()).resolves.toEqual({ reason: 'ambiguous_contact' });
    });
    await withStrategies([async () => ({ candidates: two, resolution: 'estimate' })], async () => {
      await expect(resolve()).resolves.toMatchObject({ resolution: 'estimate', open: [{ id: 'l-1' }, { id: 'l-2' }] });
    });
  });

  test('the direct link reads leads by estimate id and needs an estimate', async () => {
    const database = jest.fn(() => ({ where: jest.fn(async () => [lead('l-1')]) }));
    await expect(LeadLink.resolveConversionLeads(database, { source: 'estimate_accepted', estimateId: 'est-1' })).resolves.toMatchObject({ resolution: 'estimate', open: [{ id: 'l-1' }] });
    expect(database).toHaveBeenCalledWith('leads');
    const none = jest.fn();
    await expect(LeadLink.CONVERSION_STRATEGIES[0]({ database: none, estimateId: null })).resolves.toBeNull();
    expect(none).not.toHaveBeenCalled();
  });

  test('the contact fallback is skipped without a phone or an email', async () => {
    await expect(LeadLink.CONVERSION_STRATEGIES[2]({ database: jest.fn(), phone: null, email: null })).resolves.toBeNull();
  });

  test('round 8: an event pinned to a lead set converts only that set; any other set converts nothing', async () => {
    const markConverted = jest.fn(async () => undefined);
    const helpers = require('../services/invoice-helpers');
    const event = (expectedLeadSet) => LeadLink.convertLeadFromEvent({
      source: 'invoice_sent', customerId: 'cust-1', database: jest.fn(), leadAttributionService: { markConverted }, expectedLeadSet,
    });
    const found = (...ids) => [async () => ({ candidates: ids.map((id) => lead(id)), resolution: 'estimate' })];
    await withStrategies(found('l-1', 'l-2'), async () => {
      // The approved set (order does not matter) converts.
      await expect(event(helpers.leadSetDigest(['l-2', 'l-1']))).resolves.toMatchObject({ converted: true, count: 2 });
      expect(markConverted).toHaveBeenCalledTimes(2);
      markConverted.mockClear();
      // A lead appeared after the card, or the approved set is a different one: nothing converts.
      await expect(event(helpers.leadSetDigest(['l-1']))).resolves.toEqual({ converted: false, reason: 'approved_leads_changed' });
      await expect(event(helpers.leadSetDigest(['l-1', 'l-3']))).resolves.toEqual({ converted: false, reason: 'approved_leads_changed' });
      expect(markConverted).not.toHaveBeenCalled();
      // No pin (every other caller): unchanged.
      await expect(event(null)).resolves.toMatchObject({ converted: true, count: 2 });
    });
  });

  test('no function in the resolver is over the complexity limit of 20', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/lead-estimate-link.js'), 'utf8');
    const messages = new Linter().verify(source, [{ files: ['**/*.js'], languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs' }, rules: { complexity: ['error', 20] } }], 'lead-estimate-link.js');
    const ours = ['resolveConversionLeads', 'directLinkStrategy', 'wizardLeadStrategy', 'contactFallbackStrategy', 'originatingOnly', 'firstConversionFind', 'isOpenConversionLead'];
    const over = messages.filter((m) => m.ruleId === 'complexity' && ours.some((name) => m.message.includes(`'${name}'`)));
    expect(over.map((m) => m.message)).toEqual([]);
  });
});

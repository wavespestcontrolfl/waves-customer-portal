/**
 * The billing-lane FACT the customer-facing assistant surfaces depend on.
 *
 * The house voice permits a monthly amount only when the account facts say the
 * lane is monthly membership — a rule that was enforced for a long time
 * without anything ever producing that fact, so the exception it protects was
 * unreachable and every genuine monthly member was deferred to the office.
 *
 * These pin the two halves that have to agree: the fact must CARRY the amount
 * it authorizes (the MONEY rule forbids computing or inventing figures, so a
 * lane that says "state it plainly" without the number just produces a
 * deferral), and no surface may still restrict the exception to an explicitly
 * owner-set lane — resolveBillingLane's NULL-mode inference is the same rule
 * MONTHLY_LANE_SQL uses to select who the dues cron charges.
 */

const fs = require('fs');
const path = require('path');

const drafter = fs.readFileSync(path.join(__dirname, '../services/sms-shadow-drafter.js'), 'utf8');
const agent = fs.readFileSync(path.join(__dirname, '../services/ai-assistant/managed-agent-config.js'), 'utf8');

describe('the monthly-lane exception carries its amount and agrees across surfaces', () => {
  test('the drafter emits the rate ONLY for the monthly lane', () => {
    // For every other lane this field is the stored artifact 157 of 159
    // per-application customers carry and are never charged.
    expect(drafter).toContain('lane?.monthlyBilled && Number(context.customer?.monthlyRate) > 0');
    expect(drafter).toContain('Monthly plan rate:');
  });

  test('no surface still restricts the exception to an EXPLICIT lane', () => {
    // The house voice and BOTH tool descriptions have to agree, or the model
    // is told to withhold a real price the account fact just authorized. This
    // pins the AGREEMENT rather than the individual call sites: a third
    // description added later that reintroduced the qualifier fails here.
    expect(agent).not.toMatch(/explicit monthly-membership/);
    const toolDescriptions = agent.match(/description: `[^`]*monthly rate[^`]*`/g) || [];
    expect(toolDescriptions.length).toBe(2);
    for (const desc of toolDescriptions) {
      expect(desc).toMatch(/Billing lane/);
      expect(desc).toMatch(/owner-set or inferred/);
    }
  });
});

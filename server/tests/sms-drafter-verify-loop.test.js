/**
 * generateGroundedDraft — the draft→verify→revise convergence loop (v3).
 * Drives it with a scripted fake Anthropic client (no network, no DB): each
 * messages.create() returns the next queued response, so we can assert pass
 * counts and convergence for each path.
 */
const { generateGroundedDraft } = require('../services/sms-shadow-drafter');

function makeClient(scripted) {
  const queue = [...scripted];
  const calls = [];
  return {
    calls,
    messages: {
      create: (args) => {
        calls.push(args);
        const next = queue.shift();
        if (next === undefined) throw new Error('out of scripted responses');
        return Promise.resolve({ content: [{ text: typeof next === 'string' ? next : JSON.stringify(next) }] });
      },
    },
  };
}

const CTX = { summary: 'Dana — Quarterly Pest, Venice', upcomingServices: [{ type: 'Quarterly Pest', date: '2026-06-19' }] };
const ARGS = (client) => ({ client, context: CTX, inboundMessage: 'When are you coming?', intent: { intent: 'general_customer_sms_needs_review' }, schedulingIntent: false });

describe('generateGroundedDraft — convergence loop', () => {
  test('verifier clean on first check → 1 pass, converged', async () => {
    const client = makeClient([
      { reply: 'Hello Dana! I will confirm your exact time and get right back to you.', intended_actions: [], missing_info: null },
      { supported: true, violations: [] },
    ]);
    const r = await generateGroundedDraft(ARGS(client));
    expect(r.passes).toBe(1);
    expect(r.converged).toBe(true);
    expect(r.parsed.reply).toMatch(/confirm your exact time/);
    expect(client.calls).toHaveLength(2); // draft + 1 verify
  });

  test('violation → revise → clean → 2 passes, converged on the revised draft', async () => {
    const client = makeClient([
      { reply: 'Hello Dana! See you tomorrow at 2 PM.', intended_actions: [], missing_info: null }, // fabricates
      { supported: false, violations: ['invents "tomorrow at 2 PM"'] },
      { reply: 'Hello Dana! Let me confirm your time and get right back to you.', intended_actions: [], missing_info: null }, // revised
      { supported: true, violations: [] },
    ]);
    const r = await generateGroundedDraft(ARGS(client));
    expect(r.passes).toBe(2);
    expect(r.converged).toBe(true);
    expect(r.parsed.reply).toMatch(/confirm your time/);
    expect(client.calls).toHaveLength(4); // draft + verify + revise + verify
  });

  test('still violating after the revision budget → not converged', async () => {
    // default MAX_REVISIONS=2 → draft + (verify, revise) + (verify, revise) + verify
    const fab = { reply: 'See you Tuesday at 9am.', intended_actions: [], missing_info: null };
    const bad = { supported: false, violations: ['invents Tuesday 9am'] };
    const client = makeClient([fab, bad, fab, bad, fab, bad]);
    const r = await generateGroundedDraft(ARGS(client));
    expect(r.converged).toBe(false);
    expect(r.passes).toBe(3); // 3 generations
  });

  test('empty reply asserts nothing → converged without a verify call', async () => {
    const client = makeClient([{ reply: '', intended_actions: [{ type: 'none', note: 'no reply warranted' }], missing_info: null }]);
    const r = await generateGroundedDraft(ARGS(client));
    expect(r.converged).toBe(true);
    expect(r.passes).toBe(1);
    expect(client.calls).toHaveLength(1); // draft only — nothing to verify
  });

  test('a verify error degrades gracefully — keeps the draft, not converged', async () => {
    const queue = [{ reply: 'Hello Dana! On it.', intended_actions: [], missing_info: null }];
    const calls = [];
    const client = {
      calls,
      messages: {
        create: (args) => {
          calls.push(args);
          if (calls.length === 1) return Promise.resolve({ content: [{ text: JSON.stringify(queue[0]) }] });
          return Promise.reject(new Error('verifier 500'));
        },
      },
    };
    const r = await generateGroundedDraft(ARGS(client));
    expect(r.parsed.reply).toBe('Hello Dana! On it.');
    expect(r.converged).toBe(false);
  });
});

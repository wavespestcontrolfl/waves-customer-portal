/**
 * Alert accuracy fixes — source-pattern guards (house style — see
 * attribution-capture-wiring.test.js).
 *
 * Pins the three 07-11 alert-audit fixes in place so a refactor can't
 * silently regress them:
 *  1. new_lead bell deep-links the LEAD row (was customer.id → dead link)
 *  2. quote-promised bell dedupes on callSid (reprocessed call rang 3 bells)
 *  3. morning digest never fabricates "$0.00 logged" for unextracted amounts
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

describe('new_lead bell links the lead row (lead-webhook.js)', () => {
  const src = read('../routes/lead-webhook.js');

  test('notification passes leadRecord id with customer fallback', () => {
    expect(src).toMatch(/leadId: leadRecord\?\.id \|\| customer\.id/);
  });

  test('no bare customer.id leadId remains on the new_lead trigger', () => {
    expect(src).not.toMatch(/leadId: customer\.id,/);
  });

  test('notification fires after the lead row is created', () => {
    const insertAt = src.indexOf("await db('leads').insert(");
    const notifyAt = src.indexOf("triggerNotification('new_lead'");
    expect(insertAt).toBeGreaterThan(-1);
    expect(notifyAt).toBeGreaterThan(insertAt);
  });
});

describe('quote-promised bell dedupes on callSid (call-recording-processor.js)', () => {
  const src = read('../services/call-recording-processor.js');

  test('dedupe helper exists and fails open', () => {
    expect(src).toMatch(/async function quotePromisedAlreadyNotified\(callSid, \{ ignoreNoLead = false \} = \{\}\)/);
    // Fail-open: the catch path must return false (notify anyway), never throw.
    const helper = src.slice(
      src.indexOf('async function quotePromisedAlreadyNotified'),
      src.indexOf('async function quotePromisedAlreadyNotified') + 1200
    );
    expect(helper).toMatch(/catch[\s\S]*return false/);
    // Lane awareness: ignoreNoLead must exclude no_lead bells from the match.
    expect(helper).toMatch(/no_lead'\) IS DISTINCT FROM 'true'/);
  });

  test('BOTH notify sites consult the dedupe guard, lane-aware', () => {
    const guarded = src.match(/await quotePromisedAlreadyNotified\(call\.twilio_call_sid/g) || [];
    expect(guarded.length).toBe(2);
    // Lead path dedupes ONLY against equivalent lead-path bells — a stale
    // no-lead bell must not suppress the corrected lead-linked bell (codex P2).
    expect(src).toMatch(/callQuotePromised && enriched\s*\n\s*&& !\(await quotePromisedAlreadyNotified\(call\.twilio_call_sid, \{ ignoreNoLead: true \}\)\)/);
    // No-lead path dedupes against ANY prior quote-promised bell for the call.
    expect(src).toMatch(/callQuotePromised && !leadId && !extracted\.is_spam\s*\n\s*&& !\(await quotePromisedAlreadyNotified\(call\.twilio_call_sid\)\)/);
  });
});

describe('morning digest invoice totals are honest (scheduler.js)', () => {
  const src = read('../services/scheduler.js');

  test('dollar figure only claimed when extraction produced one', () => {
    expect(src).toMatch(/invoiceAmounts > 0/);
    expect(src).toMatch(/amounts not extracted/);
  });

  test('no unconditional $-total push remains for invoices', () => {
    // The old shape pushed the toFixed total directly under `if (invoices > 0)`
    // with no amount check; the ternary is now the only path to the $ figure.
    expect(src).not.toMatch(/if \(invoices > 0\) parts\.push\([^)]*toFixed/);
  });
});

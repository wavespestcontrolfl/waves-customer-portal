/**
 * The admin composer awaits Opus drafts inside a browser request, so every
 * interactive draft call (effort 'high') must also carry the request-sized
 * INTERACTIVE_DRAFT_TIMEOUT_MS, not the autopilot's 10-minute chain budget.
 */
const fs = require('fs');
const path = require('path');
const { INTERACTIVE_DRAFT_TIMEOUT_MS } = require('../services/newsletter-draft');

const routeSource = fs.readFileSync(path.join(__dirname, '../routes/admin-newsletter.js'), 'utf8');

describe('interactive newsletter drafts use a request-sized deadline', () => {
  test('the interactive deadline is the dispatcher\'s standard 4-minute budget', () => {
    expect(INTERACTIVE_DRAFT_TIMEOUT_MS).toBe(4 * 60 * 1000);
  });

  test('every effort:\'high\' draft call in the admin routes passes INTERACTIVE_DRAFT_TIMEOUT_MS', () => {
    const calls = routeSource.split('\n')
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /^\s+effort: 'high',$/.test(line));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    const lines = routeSource.split('\n');
    for (const { i } of calls) {
      expect(lines[i + 1].trim()).toBe('timeoutMs: INTERACTIVE_DRAFT_TIMEOUT_MS,');
    }
  });

  test('the legacy free-form draft call uses the same deadline', () => {
    expect(routeSource).toMatch(/maxTokens: 24000,\n\s+timeoutMs: INTERACTIVE_DRAFT_TIMEOUT_MS,/);
  });
});

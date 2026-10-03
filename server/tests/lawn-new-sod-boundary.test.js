// enforceNewSodAtBoundary: the LAST step on every path that assembles a lawn payload, after the (unchanged)
// reconciliation pass. Reconciliation REBUILDS the follow-up from lawnAssessment.recommendations.nextVisitFocus,
// derives today's result and the lead, and attaches the re-entry context; the boundary step must scrub all of it.
// A no-op, returning the same object, for anything but an active new-sod visit. Synthetic data only.
const fs = require('fs');
const path = require('path');

const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');
const { enforceNewSodPayload, enforceNewSodAtBoundary, isNewSodPayload, ADVICE_WORDS } = require('../services/service-report/lawn-new-sod-payload');
const { maximalLawnPayload } = require('./helpers/new-sod-maximal-payload');

const ADVICE_FOCUS = 'Recheck moisture and sprinkler coverage.';

// What buildReportV1Data hands over for an active visit (already enforced), with the SOURCE put back as it would
// be if anything upstream left it unscrubbed: the worst case for the rebuild.
const builderOutput = () => {
  const data = enforceNewSodPayload(maximalLawnPayload());
  data.serviceLine = 'lawn';
  data.summary = 'Water the front strip every morning this week.';
  data.lawnAssessment.recommendations = { nextVisitFocus: ADVICE_FOCUS, customerTip: 'Water the thin areas by hand.', recommendations: [{ action: 'Raise the mower one setting', priority: 1 }] };
  return data;
};

describe('reconciliation then the boundary step', () => {
  test('control: reconciliation alone rebuilds advice from the unscrubbed source and the summary', () => {
    const data = builderOutput();
    applyLawnReportReconciliation(data, null);
    expect(data.reportV2.followUp.reason).toMatch(/moisture and sprinkler coverage/i);
    expect(data.reportV2.todaysResult).toMatch(/Water the front strip/i);
  });

  test('after the boundary step: the follow-up, today\'s result, the source and the warnings carry no advice', () => {
    const data = builderOutput();
    applyLawnReportReconciliation(data, null);
    enforceNewSodAtBoundary(data, null);
    expect(data.reportV2.followUp.reason).toBeNull();
    expect(data.reportV2.todaysResult).toBeNull();
    for (const warning of data.reportV2.consistencyWarnings || []) expect(ADVICE_WORDS.test(String(warning.suggestedFix || ''))).toBe(false);
    expect(ADVICE_WORDS.test(JSON.stringify(data.lawnAssessment.recommendations))).toBe(false);
    expect(data.reportV2.banner.state).toBe('new_sod');
    expect(data.mowingHeight).toBeNull();
  });

  test('the SOURCE is scrubbed on its own: the builder\'s pass leaves nothing for the rebuild to find', () => {
    const payload = maximalLawnPayload();
    payload.lawnAssessment.recommendations = { nextVisitFocus: ADVICE_FOCUS, customerTip: 'Water the thin areas by hand.', recommendations: [{ action: 'Raise the mower one setting' }, { action: 'Reassess weed pressure next visit.' }] };
    const out = enforceNewSodPayload(payload);
    expect(out.lawnAssessment.recommendations.nextVisitFocus).toBeNull();
    expect(out.lawnAssessment.recommendations.customerTip).toBeNull();
    expect(out.lawnAssessment.recommendations.recommendations).toEqual([{ action: 'Reassess weed pressure next visit.' }]);
  });

  test('the lead derived by the reconciliation is scrubbed too', () => {
    const data = builderOutput();
    data.reportV2.lead = { headline: 'Stable — watching watering', why: 'The main driver is too much water.', applied: 'We applied a fertilizer and watered it in.', yourPart: ['Water the front strip by hand.', 'Keep pets off until dry.'], next: 'Recheck the moisture balance.', whatToExpect: 'Once the sod has rooted, you can start mowing.' };
    enforceNewSodAtBoundary(data, null);
    expect(data.reportV2.lead).toMatchObject({ headline: null, why: null, next: null, applied: 'We applied a fertilizer and watered it in.', yourPart: ['Keep pets off until dry.'] });
  });

  test('the label irrigation hold in the re-entry context (attached after the builder) is removed', () => {
    const data = builderOutput();
    const dynamicContext = { reentry: { irrigationReadyAt: '2026-10-03T19:00:00.000Z', petAdvisory: 'Keep pets off until dry.' } };
    enforceNewSodAtBoundary(data, dynamicContext);
    expect(dynamicContext.reentry.irrigationReadyAt).toBeNull();
    expect(dynamicContext.reentry.petAdvisory).toMatch(/pets/i);
  });
});

describe('the boundary step is a no-op for everything but an active new-sod visit', () => {
  test('a normal lawn visit comes back as the same, untouched object', () => {
    const data = maximalLawnPayload();
    const before = JSON.stringify(data);
    expect(isNewSodPayload(data)).toBe(false);
    expect(enforceNewSodAtBoundary(data, { reentry: { irrigationReadyAt: 'x' } })).toBe(data);
    expect(JSON.stringify(data)).toBe(before);
  });

  test.each([[null], [undefined], [{}], [{ reportV2: null }], [{ reportV2: { banner: null } }], [{ reportV2: { banner: { state: 'hold' } } }]])('payload %j is returned as is', (payload) => {
    expect(enforceNewSodAtBoundary(payload, null)).toBe(payload);
  });
});

describe('call sites: reconciliation exactly where it ran on main, the boundary step last', () => {
  const root = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'tests' ? [] : walk(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });

  test('the reconciliation call sites are the two that main has, with the same arguments', () => {
    const callers = [...walk(path.join(root, 'routes')), ...walk(path.join(root, 'services'))]
      .filter((f) => /\bapplyLawnReportReconciliation\s*\(/.test(fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')))
      .map((f) => path.relative(root, f)).sort();
    expect(callers).toEqual(['routes/reports-public.js', 'services/service-report/pdf-queue.js', 'services/service-report/report-consistency.js']);
    // reports-public.js: the mid-function block, byte for byte, before the Pest V2 dashboard.
    const route = read('routes/reports-public.js');
    const block = "  {\n    const { applyLawnReportReconciliation } = require('../services/service-report/report-consistency');\n    applyLawnReportReconciliation(data, dynamicContext);\n  }\n";
    expect(route.split(block)).toHaveLength(2);
    expect(route.indexOf(block)).toBeLessThan(route.indexOf('Pest Report V2 — protection-first dashboard'));
    // pdf-queue.js: before the termite / cockroach attach calls, as on main.
    const queue = read('services/service-report/pdf-queue.js');
    expect(queue).toMatch(/const \{ applyLawnReportReconciliation \} = require\('\.\/report-consistency'\);/);
    expect(queue.split('applyLawnReportReconciliation(data, data.dynamicContext);')).toHaveLength(2);
    expect(queue.indexOf('applyLawnReportReconciliation(data, data.dynamicContext);')).toBeLessThan(queue.indexOf('attachTermiteReportV2(data, service);'));
  });

  test('when origin/main is available, the reconciliation lines are identical to its', () => {
    let main;
    try {
      main = (rel) => require('child_process').execFileSync('git', ['show', `origin/main:server/${rel}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      main('routes/reports-public.js');
    } catch { return; } // no origin/main in this checkout: the literal pins above stand
    for (const rel of ['routes/reports-public.js', 'services/service-report/pdf-queue.js']) {
      const lines = (src) => src.split('\n').filter((l) => /applyLawnReportReconciliation/.test(l));
      // Only compare when main still has the call (it moves with a future refactor, not with this PR).
      if (lines(main(rel)).length) expect(lines(read(rel))).toEqual(lines(main(rel)));
    }
  });

  test('the boundary step wraps BOTH returns of the response builder, after the reconciliation block', () => {
    const src = code('routes/reports-public.js');
    const body = src.slice(src.indexOf('async function buildServiceReportV1ResponseData'), src.indexOf('async function findProjectByReportSegment'));
    expect((body.match(/return enforceNewSodAtBoundary\(/g) || [])).toHaveLength(2);
    expect(body.match(/return \{\s*\.\.\.data/g)).toBeNull();
    expect(body).toMatch(/if \(service\?\.report_template_version !== 'service_report_v1'\) return data;/);
    expect(body.indexOf('applyLawnReportReconciliation(data, dynamicContext)')).toBeLessThan(body.indexOf('return enforceNewSodAtBoundary('));
  });

  test('in pdf-queue.js the boundary step is the last call that touches the payload before the render', () => {
    const src = code('services/service-report/pdf-queue.js');
    const at = src.indexOf('enforceNewSodAtBoundary(data, data.dynamicContext)');
    expect(at).toBeGreaterThan(src.indexOf('applyLawnReportReconciliation(data, data.dynamicContext)'));
    expect(at).toBeGreaterThan(src.indexOf('attachCockroachReportV2(data, service)'));
    expect(at).toBeLessThan(src.indexOf('renderServiceReportV1Pdf(data'));
    // nothing between the boundary step and the render mutates the payload
    const between = src.slice(at, src.indexOf('renderServiceReportV1Pdf(data'));
    expect(between).not.toMatch(/\bdata\.\w+\s*=[^=]|attach\w+\(data|apply\w+\(data|strip\w+\(data/);
  });
});

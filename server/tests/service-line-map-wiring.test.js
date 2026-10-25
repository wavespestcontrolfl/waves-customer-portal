/**
 * Service-line map shadow (GATE_SERVICE_LINE_MAP=shadow, owner 2026-10-25): where the
 * six choice points call the recorder. /book confirm and the after-call booking cannot
 * be driven to a committed booking without a live database, so their position is pinned
 * from the source: the call sits AFTER the commit, is never awaited, and the resolver is
 * required lazily (gate off = no resolver module load, no query, byte-identical).
 */
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SITES = {
  book: 'routes/booking.js',
  phone_live: 'services/voice-agent/relay-booking.js',
  after_call: 'services/call-recording-processor.js',
  estimate_accept: 'services/estimate-converter.js',
  office_auto: 'routes/admin-schedule.js',
  night_run: 'services/auto-dispatch/audit.js',
};

describe('service-line map shadow wiring', () => {
  test.each(Object.entries(SITES))('%s: one recorder source tag in %s, required lazily (no top-level load)', (source, file) => {
    const text = read(file);
    // The recorder's own source tag: `source: 'x'` followed by the recorder's other fields.
    expect(text.match(new RegExp(`source: '${source}',? (?:trx|scheduledServiceId|runId)`, 'g'))).toHaveLength(1);
    expect(text.match(/recordLinePickShadow\(/g).length).toBeGreaterThanOrEqual(1);
    // Lazy: every load of the module sits inside a call expression, never in the import block.
    for (const line of text.split('\n').filter((l) => /line-technician/.test(l) && /require\(/.test(l))) {
      expect(line).toMatch(/require\('[./]+\/(?:services\/)?scheduling\/line-technician'\)\.recordLinePickShadow/);
    }
  });

  test('/book confirm: recorded after the booking transaction, only for a fresh booking (a replay has no serviceRow)', () => {
    const text = read(SITES.book);
    const at = text.indexOf("source: 'book'");
    expect(text.indexOf('txResult = await db.transaction')).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(text.indexOf('txResult = await db.transaction'));
    expect(at).toBeGreaterThan(text.indexOf('} catch (txErr) {'));
    expect(text.slice(text.lastIndexOf('\n', at - 400), at)).toContain('if (txResult?.serviceRow)');
    expect(text.slice(text.lastIndexOf('void', at), at)).toMatch(/^void require\(/);
  });

  test('after-call booking: recorded after the booking transaction, for a fresh insert or a reused row this run assigned', () => {
    const text = read(SITES.after_call);
    const at = text.indexOf("source: 'after_call'");
    expect(at).toBeGreaterThan(text.indexOf("const techNotices = require('./tech-visit-notifications')"));
    expect(text.slice(text.lastIndexOf('\n', at - 200), at)).toContain('if (!reusedExistingSchedule || reuseAssignedTechId)');
    expect(text.slice(text.lastIndexOf('void', at), at)).toMatch(/^void require\(/);
  });

  test('phone live booking: recorded only after the commit returned ok', () => {
    const text = read(SITES.phone_live);
    const at = text.indexOf("source: 'phone_live'");
    expect(at).toBeGreaterThan(text.indexOf("if (commit.status !== 'ok')"));
  });

  test('estimate accept: recorded through the caller transaction so a rollback records nothing', () => {
    const text = read(SITES.estimate_accept);
    expect(text).toMatch(/source: 'estimate_accept', trx: database/);
    // The definition plus three call sites: reserved lines, promoted lines, auto-scheduled lines.
    expect(text.match(/recordEstimateLinePick\(database,/g)).toHaveLength(4);
  });

  test('office create: parent visit only, after the response, only when the office left the technician to Auto or unassigned', () => {
    const text = read(SITES.office_auto);
    const at = text.indexOf("source: 'office_auto'");
    expect(at).toBeGreaterThan(text.indexOf('setImmediate(async () => {', text.indexOf('res.status(201).json({')));
    expect(text.slice(text.lastIndexOf('\n', at - 300), at)).toContain("assignmentMode === 'auto' || !technicianId");
  });
});

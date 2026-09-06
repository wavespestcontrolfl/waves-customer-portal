/**
 * Stamping-coverage source pins (audit: "every booking path stamps or joins
 * the correct parent visit"). Every scheduled_services creation path either
 * calls maybeGroupRow (in-trx, after the insert) or carries a deliberate-
 * skip comment naming the covering mechanism. Source pins, not flow tests:
 * the helper itself is self-refusing + savepoint-wrapped and is exercised
 * by the visit-groups suites; what a regression here would silently lose is
 * the CALL, which is exactly what these pins hold.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('every booking path stamps or deliberately skips', () => {
  test.each([
    ['routes/booking.js', 2],            // primary insert + seeded series rows
    ['services/availability.js', 1],
    ['routes/admin-leads.js', 1],
    ['services/intelligence-bar/tools.js', 1],
    ['services/annual-prepay-renewals.js', 1], // timed first visit (owner: prepaid stamps)
  ])('%s calls maybeGroupRow %i time(s)', (file, count) => {
    const src = read(file);
    expect((src.match(/maybeGroupRow\(/g) || []).length).toBe(count);
  });

  test('admin-schedule.js stamps all eight insert sites', () => {
    const src = read('routes/admin-schedule.js');
    // Insert seams pass the inserted row's id. The address-edit regroup
    // loop passes an existing id and is covered by update-details tests.
    expect((src.match(/maybeGroupRow\(\w+\.id,/g) || []).length).toBe(8);
  });

  test('estimate-converter stamps BOTH paths (standalone + recurring unit)', () => {
    const src = read('services/estimate-converter.js');
    expect((src.match(/VisitGroups\.maybeGroupRow\(/g) || []).length).toBe(2);
  });

  test('annual-prepay timed seeds carry the sole-property anchor (GH codex r8 P2)', () => {
    const src = read('services/annual-prepay-renewals.js');
    expect(src).toContain("if (cols.property_id && seedPropertyId) insertData.property_id = seedPropertyId;");
    expect(src).toMatch(/const seedPropertyId = cols\.property_id\s*\n\s*\? await require\('\.\/customer-properties'\)\.soleActivePropertyId\(term\.customer_id, conn\)/);
  });

  test('admin-dispatch follow-up booking stamps inside the comms-lock trx', () => {
    const src = read('routes/admin-dispatch.js');
    expect(src).toMatch(/const inserted = await trx\('scheduled_services'\)\.insert\(insertData\)\.returning\('\*'\);[\s\S]{0,600}maybeGroupRow\(inserted\[0\]\.id, \{ database: trx, createdBy: 'dispatch' \}\)/);
    // The follow-up carries the source visit's property anchor, or the
    // stamp is a permanent no-op (GH codex r6 P2).
    expect(src).toContain("if (cols.property_id && svc.property_id) insertData.property_id = svc.property_id;");
  });

  test('call pipeline: main booking stamps only on a fresh insert, never on the idempotency-conflict reuse', () => {
    const src = read('services/call-recording-processor.js');
    // Both stamps (primary + follow-up child) are inside `if (created)` /
    // `if (fuRow?.id)` guards — the reuse branches carry no stamp call.
    expect((src.match(/maybeGroupRow\(/g) || []).length).toBe(2);
    expect(src).toMatch(/if \(created\) \{[\s\S]{0,700}maybeGroupRow\(created\.id, \{ database: trx, createdBy: 'dispatch' \}\)/);
    expect(src).toMatch(/if \(fuRow\?\.id\) \{\s*\n\s*await require\('\.\/visit-groups'\)\.maybeGroupRow\(fuRow\.id, \{ database: sp, createdBy: 'dispatch' \}\);/);
  });

  test('auto-extend stamps ONLY after the post-insert cancellation re-check passes', () => {
    const src = read('routes/admin-schedule.js');
    expect(src).toMatch(/if \(autoExtLive && autoExtRow\?\.id\) \{[\s\S]{0,500}maybeGroupRow\(autoExtRow\.id, \{ database: conn, createdBy: 'dispatch' \}\);/);
    // And never before the re-check (the compensating delete would orphan a
    // freshly minted visit): no stamp between the insert and autoExtLive.
    const between = src.slice(
      src.indexOf("const [autoExtRow] = await conn('scheduled_services')"),
      src.indexOf('let autoExtLive = true;'),
    );
    expect(between).not.toContain('maybeGroupRow');
  });

  test('deliberate skips name their covering mechanism', () => {
    expect(read('services/voice-agent/relay-booking.js')).toMatch(/deliberately NOT stamped[\s\S]{0,200}office confirm/);
    expect(read('services/slot-reservation.js')).toMatch(/deliberately NOT stamped[\s\S]{0,200}converter/);
    expect(read('services/health-alerts.js')).toMatch(/deliberately NOT stamped[\s\S]{0,120}windowless/);
    expect((read('services/annual-prepay-renewals.js').match(/deliberately NOT stamped|NOT stamped — windowless seed/g) || []).length).toBe(2);
  });

  test('customer confirm route runs the pendingConfirmed regroup seam post-commit, not on the idempotent path', () => {
    const src = read('routes/appointment-public.js');
    expect(src).toMatch(/if \(updated > 0\) \{[\s\S]{0,900}maybeGroupRow\(svc\.id, \{ createdBy: 'dispatch' \}\)\.catch/);
    // Exactly one seam call in the file.
    expect((src.match(/maybeGroupRow\(/g) || []).length).toBe(1);
  });
});

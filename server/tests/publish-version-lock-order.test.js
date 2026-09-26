/**
 * Source-order pin for Codex #4918 r5 P2: publishVersion's transaction
 * (server/services/email-template-library.js) must take the email_templates
 * row lock (`FOR UPDATE`) as its FIRST statement, before any
 * email_template_versions status write or the closing email_templates
 * update — the same lock order the four 20260926* migrations already use,
 * so a concurrent admin publish serializes with them instead of leaving two
 * active versions. This codebase's established pattern for pinning
 * ordering inside a function too large to unit-test directly is a source
 * `.indexOf()` position assertion (see
 * booking-post-commit-series-lock-order.test.js) — the dynamic call-order
 * test lives in email-template-library.test.js; this pins the exact code
 * shape so a future edit cannot silently re-order the statements without
 * failing a test even if a mock elsewhere papers over it.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'email-template-library.js'), 'utf8');

describe('publishVersion — email_templates row lock precedes every version/template write', () => {
  test('forUpdate() on email_templates, THEN archive the old active version, THEN activate the new one, THEN update the template row', () => {
    const fnAt = src.indexOf('async function publishVersion(');
    expect(fnAt).toBeGreaterThan(-1);
    const bodyEnd = src.indexOf('\n}\n', fnAt);
    const body = src.slice(fnAt, bodyEnd);

    const lockAt = body.indexOf("await trx('email_templates').where({ id: row.template_id }).forUpdate().first();");
    expect(lockAt).toBeGreaterThan(-1);

    const archiveAt = body.indexOf(
      "await trx('email_template_versions')\n      .where({ template_id: row.template_id, status: 'active' })",
      lockAt,
    );
    expect(archiveAt).toBeGreaterThan(lockAt);

    const activateAt = body.indexOf("await trx('email_template_versions').where({ id: versionId }).update({", archiveAt);
    expect(activateAt).toBeGreaterThan(archiveAt);

    const templateUpdateAt = body.indexOf("await trx('email_templates').where({ id: row.template_id }).update({", activateAt);
    expect(templateUpdateAt).toBeGreaterThan(activateAt);

    // The lock is genuinely the FIRST statement inside db.transaction's
    // callback — nothing else touches email_templates or
    // email_template_versions before it.
    const txAt = body.indexOf('await db.transaction(async (trx) => {');
    expect(txAt).toBeGreaterThan(-1);
    expect(txAt).toBeLessThan(lockAt);
    const betweenTxAndLock = body.slice(txAt, lockAt);
    expect(betweenTxAndLock).not.toMatch(/trx\('email_template/);
  });
});

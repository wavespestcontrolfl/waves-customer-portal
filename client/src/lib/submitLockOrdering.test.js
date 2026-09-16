/**
 * Money submits must take their synchronous double-submit lock BEFORE the
 * first `await`.
 *
 * Round 4 added a submit-time gate revalidation (`ensureStackingFresh()`) to
 * four money surfaces and placed it at the very top of each handler — ahead of
 * the lock. That yields to the microtask queue before the busy flag is set, so
 * two fast clicks both pass `if (savingRef.current) return` and post twice: a
 * duplicate invoice, a double charge, a double booking. CI caught it on the
 * invoice builder; the same defect was present on all four.
 *
 * This is a source-level guard because the ordering — not the behavior of any
 * one click — is the invariant, and it is the kind of thing a later edit
 * silently reintroduces.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/** The body of `name`'s handler, from its declaration to `lines` lines on. */
function handlerBody(src, header, lines = 40) {
  const at = src.indexOf(header);
  expect(at).toBeGreaterThan(-1);
  return src.slice(at).split('\n').slice(0, lines).join('\n');
}

/**
 * In `body`, the lock assignment must appear before the first `await`.
 * Returns [lockIndex, awaitIndex] for a readable failure.
 */
function lockBeforeAwait(body, lockPattern) {
  const lockAt = body.search(lockPattern);
  const awaitAt = body.indexOf('await ');
  return { lockAt, awaitAt };
}

describe('the double-submit lock is taken before the first await', () => {
  it('AdminInvoicesPage handleCreate locks before awaiting', () => {
    const body = handlerBody(
      read('pages/admin/AdminInvoicesPage.jsx'),
      '  const handleCreate = async () => {\n    if (savingRef.current) return;',
      60,
    );
    const { lockAt, awaitAt } = lockBeforeAwait(body, /savingRef\.current = true;/);
    expect(lockAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(lockAt);
  });

  it('CreateAppointmentModal handleSubmit locks before awaiting', () => {
    const body = handlerBody(
      read('components/schedule/CreateAppointmentModal.jsx'),
      '  const handleSubmit = async (separateProgram) => {',
      30,
    );
    const { lockAt, awaitAt } = lockBeforeAwait(body, /submitLockRef\.current = true;/);
    expect(lockAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(lockAt);
  });

  it('MobileCheckoutSheet handleCharge sets its busy flag before awaiting', () => {
    const body = handlerBody(
      read('components/schedule/MobileCheckoutSheet.jsx'),
      '  async function handleCharge() {',
      30,
    );
    const { lockAt, awaitAt } = lockBeforeAwait(body, /setMinting\(true\);/);
    expect(lockAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(lockAt);
  });

  it('SchedulePage handleSave sets its busy flag before awaiting', () => {
    const body = handlerBody(
      read('pages/admin/SchedulePage.jsx'),
      '  const handleSave = async ({ takePayment = false } = {}) => {',
      30,
    );
    const { lockAt, awaitAt } = lockBeforeAwait(body, /setSaving\(true\);/);
    expect(lockAt).toBeGreaterThan(-1);
    expect(awaitAt).toBeGreaterThan(lockAt);
  });

  it('every surface that revalidates releases the lock when it blocks', () => {
    // A guard that returns without clearing the busy flag would wedge the
    // surface: the operator could never retry after reloading the gate.
    const cases = [
      ['pages/admin/AdminInvoicesPage.jsx', /savingRef\.current = false;\s*\n\s*setSaving\(false\);/],
      ['components/schedule/CreateAppointmentModal.jsx', /submitLockRef\.current = false;/],
      ['components/schedule/MobileCheckoutSheet.jsx', /setMinting\(false\);/],
      ['pages/admin/SchedulePage.jsx', /setSaving\(false\);/],
    ];
    for (const [file, pattern] of cases) {
      expect(read(file)).toMatch(pattern);
    }
  });
});

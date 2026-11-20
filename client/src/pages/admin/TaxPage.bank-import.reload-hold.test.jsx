// @vitest-environment jsdom
// Tax > Bank import reads the statement CSV before its upload starts, so no
// save is open yet. The import holds an out-of-date tab's reload from the file
// pick until the upload settles, or until a failed read ends
// (lib/reloadHolds.js).
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BankImportTab } from './TaxPage.jsx';
import { reloadHoldNames } from '../../lib/reloadHolds';

let uploads;
let finishUpload;
let readers;

beforeEach(() => {
  uploads = [];
  readers = [];
  vi.stubGlobal('FileReader', class { readAsText() { readers.push(this); } });
  vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    const answer = (body) => ({ ok: true, status: 200, json: async () => body });
    if (options.method === 'POST' && path.endsWith('/bank-import/upload')) {
      uploads.push(path);
      return new Promise((resolve) => {
        finishUpload = () => resolve(answer({ imported: 1, parsed: 1, duplicates: 0, skipped: [] }));
      });
    }
    return answer({ counts: {}, transactions: [], months: [] });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function pickStatement(container) {
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: [new File(['date,amount'], 'statement.csv', { type: 'text/csv' })] },
  });
}

it('holds an out-of-date tab reload from the file pick while the CSV is read, until the upload settles', async () => {
  const { container } = render(<BankImportTab />);
  pickStatement(container);
  expect(reloadHoldNames()).toContain('bank-import');
  expect(uploads).toEqual([]);
  await act(async () => {
    readers[0].result = 'date,amount\n2026-11-02,12.00';
    readers[0].onload();
    readers[0].onloadend();
  });
  await waitFor(() => expect(uploads).toEqual(['/api/admin/tax/bank-import/upload']));
  expect(reloadHoldNames()).toContain('bank-import');
  await act(async () => finishUpload());
  await waitFor(() => expect(reloadHoldNames()).not.toContain('bank-import'));
});

it('a read that fails ends the hold, with no upload', async () => {
  const { container } = render(<BankImportTab />);
  pickStatement(container);
  expect(reloadHoldNames()).toContain('bank-import');
  await act(async () => readers[0].onloadend());
  await waitFor(() => expect(reloadHoldNames()).not.toContain('bank-import'));
  expect(uploads).toEqual([]);
});

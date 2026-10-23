// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LedgerInboxTab from './LedgerInboxTab.jsx';

const categories = [
  { id: 'cat-1', name: 'Supplies', irsLine: '22' },
  { id: 'cat-2', name: 'Tools', irsLine: '22' },
];
const row = {
  id: 'row-1',
  txn_date: '2026-10-01',
  description: 'ACME HARDWARE 123',
  amount: '42.50',
  direction: 'debit',
  account_label: 'test-checking',
  account_type: 'bank',
  suggestion: {
    categoryId: 'cat-2',
    categoryName: 'Tools',
    irsLine: '22',
    rule: { id: 'r1', kind: 'expense', note: 'Hardware store', source: 'seed' },
  },
};

let calls;
let status;

function json(body, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body };
}

beforeEach(() => {
  calls = [];
  status = { enabled: true, rules: 3, inbox: 1 };
  localStorage.setItem('waves_admin_token', 'test-token');
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (u.includes('/ledger/status')) return json(status);
    if (u.includes('/ledger/inbox')) return json({ rows: [row], total: 1 });
    if (u.includes('/expense-categories')) return json({ categories });
    if (u.includes('/ledger/decide')) return json({ success: true, action: 'x', ruleCreated: false, createExpense: true });
    if (u.includes('/create-expense')) return json({ success: true, expense: { id: 'e1' } });
    return json({});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const posts = () => calls.filter((c) => c.method === 'POST');

it('renders only the off line when the ledger gate is off', async () => {
  status = { enabled: false, rules: 0, inbox: 0 };
  render(<LedgerInboxTab />);
  expect(await screen.findByText('The tax ledger is off (GATE_TAX_LEDGER).')).toBeInTheDocument();
  expect(calls.some((c) => c.url.includes('/ledger/inbox'))).toBe(false);
});

it('renders a row with its suggestion chip and signed amount', async () => {
  render(<LedgerInboxTab />);
  expect(await screen.findByText('ACME HARDWARE 123')).toBeInTheDocument();
  expect(screen.getByText('expense · Tools')).toBeInTheDocument();
  expect(screen.getByText('Hardware store')).toBeInTheDocument();
  expect(screen.getByText('-$42.50')).toBeInTheDocument();
  expect(screen.getByText('1 rows to review · 3 rules')).toBeInTheDocument();
});

it('posts a personal decision and removes the row', async () => {
  render(<LedgerInboxTab />);
  await screen.findByText('ACME HARDWARE 123');
  fireEvent.click(screen.getByRole('button', { name: 'Personal' }));
  await waitFor(() => expect(screen.queryByText('ACME HARDWARE 123')).not.toBeInTheDocument());
  const p = posts();
  expect(p).toHaveLength(1);
  expect(p[0].url).toMatch(/\/admin\/tax\/bank-import\/ledger\/decide$/);
  expect(p[0].body).toEqual({ id: 'row-1', decision: 'personal', always: false });
});

it('Business with Always posts decide, then create-expense with the chosen category', async () => {
  // after an Always decision the view reloads: the server no longer lists the booked row
  let created = false;
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/create-expense')) { created = true; calls.push({ url: u, method: 'POST', body: JSON.parse(opts.body) }); return json({ success: true, expense: { id: 'e1' } }); }
    if (u.includes('/ledger/inbox') && created) return json({ rows: [], total: 0 });
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  fireEvent.change(within(card).getByLabelText('Category'), { target: { value: 'cat-1' } });
  fireEvent.click(within(card).getByLabelText('Always treat this payee this way (not for Later or Recorded)'));
  fireEvent.click(within(card).getByRole('button', { name: 'Business' }));
  await waitFor(() => expect(screen.queryByText('ACME HARDWARE 123')).not.toBeInTheDocument());
  const p = posts();
  expect(p).toHaveLength(2);
  expect(p[0].url).toMatch(/\/ledger\/decide$/);
  expect(p[0].body).toEqual({ id: 'row-1', decision: 'expense', categoryId: 'cat-1' });
  expect(p[1].url).toMatch(/\/admin\/tax\/bank-import\/row-1\/create-expense$/);
  expect(p[1].body).toEqual({ categoryId: 'cat-1', fromLedger: true, always: true });
});

it('Business without Always still posts decide first, then create-expense marked fromLedger; an untouched default category is not sent, so the server keeps its provenance', async () => {
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  fireEvent.click(within(card).getByRole('button', { name: 'Business' }));
  await waitFor(() => expect(screen.queryByText('ACME HARDWARE 123')).not.toBeInTheDocument());
  const p = posts();
  expect(p.map((c) => c.url.replace(/^.*\/admin\/tax\/bank-import/, ''))).toEqual(['/ledger/decide', '/row-1/create-expense']);
  expect(p[0].body).toEqual({ id: 'row-1', decision: 'expense', categoryId: 'cat-2' }); // the preflight validates the default
  expect(p[1].body).toEqual({ fromLedger: true, always: false }); // the claim books the row's own suggestion (a model's default keeps its AI-verify note)
});

it('a category the operator re-picks to the same value as the default counts as picked', async () => {
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  fireEvent.change(within(card).getByLabelText('Category'), { target: { value: 'cat-1' } });
  fireEvent.change(within(card).getByLabelText('Category'), { target: { value: 'cat-2' } });
  fireEvent.click(within(card).getByRole('button', { name: 'Business' }));
  await waitFor(() => expect(screen.queryByText('ACME HARDWARE 123')).not.toBeInTheDocument());
  expect(posts()[1].body).toEqual({ categoryId: 'cat-2', fromLedger: true, always: false });
});

it('a refused decide leaves the row in place with the server reason', async () => {
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    if (String(url).includes('/ledger/decide')) return json({ error: 'this row may match an expense or payout that is already booked: decide it in Bank Import' }, false);
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  fireEvent.click(within(card).getByRole('button', { name: 'Business' }));
  expect(await within(card).findByRole('alert')).toHaveTextContent(/decide it in Bank Import/);
  expect(screen.getByText('ACME HARDWARE 123')).toBeInTheDocument();
  expect(posts().some((c) => c.url.includes('/create-expense'))).toBe(false);
});

it('the Income view loads view=income and explains that nothing counts it as revenue', async () => {
  status = { enabled: true, rules: 3, inbox: 1, income: 2 };
  render(<LedgerInboxTab />);
  expect(await screen.findByText('1 rows to review · 3 rules · 2 income')).toBeInTheDocument();
  // the view switch and the row's decision button both read "Income"; the view carries its own name
  fireEvent.click(screen.getByRole('button', { name: 'Income view' }));
  await waitFor(() => expect(calls.some((c) => c.url.includes('/ledger/inbox') && c.url.includes('view=income'))).toBe(true));
  expect(await screen.findByText(/not in the P&L or any report/)).toBeInTheDocument();
});

it('Apply rules now follows the continuation cursor until the server has no more', async () => {
  let applyCalls = 0;
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/rules/apply')) {
      applyCalls += 1;
      calls.push({ url: u, method: 'POST', body: opts.body ? JSON.parse(opts.body) : undefined });
      return applyCalls === 1
        ? json({ success: true, examined: 5000, suggested: 40, cleared: 1, more: true, cursor: { txn_date: '2026-03-01', id: '11111111-1111-4111-8111-111111111111' } })
        : json({ success: true, examined: 120, suggested: 2, cleared: 0, more: false, cursor: null });
    }
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  await screen.findByText('ACME HARDWARE 123');
  fireEvent.click(screen.getByRole('button', { name: 'Apply rules now' }));
  expect(await screen.findByText('Examined 5120, suggested 42, cleared 1.')).toBeInTheDocument();
  const applies = calls.filter((c) => c.url.includes('/ledger/rules/apply'));
  expect(applies).toHaveLength(2);
  expect(applies[0].body).toEqual({});
  expect(applies[1].body).toEqual({ after: { txn_date: '2026-03-01', id: '11111111-1111-4111-8111-111111111111' } });
});

it('Apply rules now stops after its per-click page cap, says more rows remain, and the next click resumes from the kept cursor', async () => {
  let applyCalls = 0;
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/rules/apply')) {
      applyCalls += 1;
      calls.push({ url: u, method: 'POST', body: opts.body ? JSON.parse(opts.body) : undefined });
      // the server always has more: the cursor advances every page
      return json({ success: true, examined: 500, suggested: 1, cleared: 0, more: true, cursor: { txn_date: '2026-03-01', id: `00000000-0000-4000-8000-${String(applyCalls).padStart(12, '0')}` } });
    }
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  await screen.findByText('ACME HARDWARE 123');
  fireEvent.click(screen.getByRole('button', { name: 'Apply rules now' }));
  expect(await screen.findByText(/Examined 200000, suggested 400, cleared 0\. More rows remain: click Apply rules now again/)).toBeInTheDocument();
  expect(calls.filter((c) => c.url.includes('/ledger/rules/apply'))).toHaveLength(400);
  fireEvent.click(await screen.findByRole('button', { name: 'Apply rules now' }));
  await waitFor(() => expect(calls.filter((c) => c.url.includes('/ledger/rules/apply')).length).toBeGreaterThan(400));
  const resumed = calls.filter((c) => c.url.includes('/ledger/rules/apply'))[400];
  expect(resumed.body).toEqual({ after: { txn_date: '2026-03-01', id: '00000000-0000-4000-8000-000000000400' } });
});

it('an Always decision whose payee pass stopped short (propagated:false) keeps the decision and tells the operator to run Apply rules now', async () => {
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/decide')) {
      calls.push({ url: u, method: 'POST', body: JSON.parse(opts.body) });
      return json({ success: true, action: 'ignored', ruleCreated: true, propagated: false });
    }
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  await screen.findByText('ACME HARDWARE 123');
  fireEvent.click(screen.getByLabelText('Always treat this payee this way (not for Later or Recorded)'));
  fireEvent.click(screen.getByRole('button', { name: 'Personal' }));
  expect(await screen.findByText(/Decision saved, but not every open row of this payee was updated yet\. Click Apply rules now to finish\./)).toBeInTheDocument();
  expect(calls.find((c) => c.url.includes('/ledger/decide')).body).toEqual({ id: 'row-1', decision: 'personal', always: true });
});

it('a row stays busy until its own request finishes, whatever happens on another row', async () => {
  const base = fetch;
  let resolveFirst;
  const second = { ...row, id: 'row-2', description: 'OTHER SHOP 55' };
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/inbox')) return json({ rows: [row, second], total: 2 });
    if (u.includes('/ledger/decide')) {
      const body = JSON.parse(opts.body);
      if (body.id === 'row-1') return new Promise((r) => { resolveFirst = () => r(json({ success: true, action: 'ignored', ruleCreated: false })); });
      return json({ success: true, action: 'ignored', ruleCreated: false });
    }
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  await screen.findByText('OTHER SHOP 55');
  const personal = (id) => within(screen.getByTestId(`ledger-row-${id}`)).getByRole('button', { name: 'Personal' });
  fireEvent.click(personal('row-1'));
  await waitFor(() => expect(personal('row-1')).toBeDisabled());
  fireEvent.click(personal('row-2'));
  await waitFor(() => expect(screen.queryByText('OTHER SHOP 55')).not.toBeInTheDocument());
  expect(personal('row-1')).toBeDisabled(); // still in flight
  await act(async () => { resolveFirst(); });
  await waitFor(() => expect(screen.queryByText('ACME HARDWARE 123')).not.toBeInTheDocument());
});

it('a page load and a decision never overlap: Load more disables the rows, a row in flight disables Load more', async () => {
  const base = fetch;
  const second = { ...row, id: 'row-2', description: 'OTHER SHOP 55' };
  let resolvePage;
  let resolveDecide;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/inbox')) {
      if (u.includes('offset=0')) return json({ rows: [row], total: 3 });
      return new Promise((r) => { resolvePage = () => r(json({ rows: [second], total: 3 })); });
    }
    if (u.includes('/ledger/decide')) return new Promise((r) => { resolveDecide = () => r(json({ success: true, action: 'ignored', ruleCreated: false })); });
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  await screen.findByText('ACME HARDWARE 123');
  const personal = (id) => within(screen.getByTestId(`ledger-row-${id}`)).getByRole('button', { name: 'Personal' });
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await waitFor(() => expect(personal('row-1')).toBeDisabled()); // the page is in flight: no decision can shift it
  await act(async () => { resolvePage(); });
  await screen.findByText('OTHER SHOP 55');
  expect(personal('row-1')).not.toBeDisabled();
  fireEvent.click(personal('row-2'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled()); // a decision is in flight: no page can be read past a moving list
  await act(async () => { resolveDecide(); });
  await waitFor(() => expect(screen.queryByText('OTHER SHOP 55')).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Load more' })).not.toBeDisabled();
});

it('a full reload after an Always decision never brings back a row decided while the reload was in flight', async () => {
  const base = fetch;
  const second = { ...row, id: 'row-2', description: 'OTHER SHOP 55' };
  let resolveSecond;
  let resolveReload;
  let inboxCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/inbox')) {
      inboxCalls += 1;
      if (inboxCalls === 1) return json({ rows: [row, second], total: 2 });
      // the reload read the list before row-2's decision committed
      return new Promise((r) => { resolveReload = () => r(json({ rows: [second], total: 1 })); });
    }
    if (u.includes('/ledger/decide')) {
      const body = JSON.parse(opts.body);
      if (body.id === 'row-2') return new Promise((r) => { resolveSecond = () => r(json({ success: true, action: 'ignored', ruleCreated: false })); });
      return json({ success: true, action: 'ignored', ruleCreated: true, propagated: true });
    }
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  await screen.findByText('OTHER SHOP 55');
  const card = (id) => screen.getByTestId(`ledger-row-${id}`);
  fireEvent.click(within(card('row-2')).getByRole('button', { name: 'Personal' })); // in flight
  fireEvent.click(within(card('row-1')).getByLabelText('Always treat this payee this way (not for Later or Recorded)'));
  fireEvent.click(within(card('row-1')).getByRole('button', { name: 'Personal' })); // answers at once: a full reload starts
  await waitFor(() => expect(inboxCalls).toBe(2));
  await act(async () => { resolveSecond(); });
  await waitFor(() => expect(screen.queryByText('OTHER SHOP 55')).not.toBeInTheDocument());
  await act(async () => { resolveReload(); });
  await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
  expect(screen.queryByText('OTHER SHOP 55')).not.toBeInTheDocument(); // the stale snapshot does not revive it
  expect(screen.queryByText('ACME HARDWARE 123')).not.toBeInTheDocument();
});

it('an older status answer never lands after a newer one when two row actions overlap', async () => {
  const base = fetch;
  const second = { ...row, id: 'row-2', description: 'OTHER SHOP 55' };
  const pendingStatus = [];
  let statusCalls = 0;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/status')) {
      statusCalls += 1;
      if (statusCalls === 1) return json({ enabled: true, rules: 3, inbox: 2 });
      return new Promise((r) => { pendingStatus.push((body) => r(json(body))); });
    }
    if (u.includes('/ledger/inbox')) return json({ rows: [row, second], total: 2 });
    if (u.includes('/ledger/decide')) return json({ success: true, action: 'ignored', ruleCreated: false });
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  await screen.findByText('OTHER SHOP 55');
  fireEvent.click(within(screen.getByTestId('ledger-row-row-1')).getByRole('button', { name: 'Personal' }));
  await waitFor(() => expect(screen.queryByText('ACME HARDWARE 123')).not.toBeInTheDocument());
  fireEvent.click(within(screen.getByTestId('ledger-row-row-2')).getByRole('button', { name: 'Personal' }));
  await waitFor(() => expect(pendingStatus).toHaveLength(2));
  // the newer refresh (after row-2) answers first with the true count; the older one (after row-1) answers later and must be ignored
  await act(async () => { pendingStatus[1]({ enabled: true, rules: 3, inbox: 0 }); });
  await screen.findByText(/0 rows to review/);
  await act(async () => { pendingStatus[0]({ enabled: true, rules: 3, inbox: 1 }); });
  expect(screen.getByText(/0 rows to review/)).toBeInTheDocument();
  expect(screen.queryByText(/1 rows to review/)).not.toBeInTheDocument();
});

it('a rule saved with priority 0 keeps 0 (lower runs first); a blank priority is the default 10', async () => {
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    if (u.includes('/ledger/rules') && method === 'GET') return json({ rules: [] });
    if (u.includes('/ledger/rules') && method === 'POST') { calls.push({ url: u, method, body: JSON.parse(opts.body) }); return json({ success: true, rule: { id: 'r9' } }); }
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  await screen.findByText('ACME HARDWARE 123');
  fireEvent.click(screen.getByRole('button', { name: 'Rules' }));
  await screen.findByRole('button', { name: 'Add rule' });
  const saved = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/ledger/rules'));
  fireEvent.change(screen.getByLabelText('Pattern'), { target: { value: 'wawa' } });
  fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'personal' } });
  fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  await waitFor(() => expect(saved()).toHaveLength(1));
  expect(saved()[0].body).toEqual({ pattern: 'wawa', kind: 'personal', priority: 0 });
  fireEvent.change(screen.getByLabelText('Pattern'), { target: { value: 'costco' } });
  fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'personal' } });
  fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
  await waitFor(() => expect(saved()).toHaveLength(2));
  expect(saved()[1].body.priority).toBe(10);
});

it('the Income view offers Recorded, which settles the row with the recorded decision; other views do not', async () => {
  const base = fetch;
  const credit = { ...row, direction: 'credit', amount: 120, suggestion: { noMatch: true, income: true, decision: 'income' } };
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/inbox')) return json({ rows: [credit], total: 1 });
    if (u.includes('/ledger/decide')) { calls.push({ url: u, method: 'POST', body: JSON.parse(opts.body) }); return json({ success: true, action: 'ignored', ruleCreated: false }); }
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  await screen.findByText('ACME HARDWARE 123');
  expect(screen.queryByRole('button', { name: 'Recorded' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Income view' }));
  await screen.findByText('ACME HARDWARE 123');
  // Always makes no rule for Recorded: while it is checked the action is not offered
  fireEvent.click(screen.getByLabelText('Always treat this payee this way (not for Later or Recorded)'));
  expect(screen.queryByRole('button', { name: 'Recorded' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText('Always treat this payee this way (not for Later or Recorded)'));
  fireEvent.click(await screen.findByRole('button', { name: 'Recorded' }));
  await waitFor(() => expect(calls.find((c) => c.url.includes('/ledger/decide'))).toBeTruthy());
  expect(calls.find((c) => c.url.includes('/ledger/decide')).body).toEqual({ id: 'row-1', decision: 'recorded', always: false });
  await waitFor(() => expect(screen.queryByText('ACME HARDWARE 123')).not.toBeInTheDocument());
});

it('a money-out row offers no Income button', async () => {
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  expect(within(card).queryByRole('button', { name: 'Income' })).not.toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'Business' })).toBeInTheDocument();
});

it('a row the bank corrected after it was decided shows the notice and holds every action until the change is resolved in Bank Import', async () => {
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    if (String(url).includes('/ledger/inbox')) return json({ rows: [{ ...row, id: 'row-3', suggestion: { ...row.suggestion, later: true, decision: 'later', plaidModified: { amount: 43.5 } } }], total: 1 });
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-3');
  expect(within(card).getByText(/The bank corrected this transaction after it was decided: apply or dismiss the bank change in Bank Import first\./)).toBeInTheDocument();
  const buttons = within(card).getAllByRole('button');
  expect(buttons.map((b) => b.textContent)).toEqual(expect.arrayContaining(['Business', 'Personal', 'Transfer', 'Later']));
  for (const b of buttons) expect(b).toBeDisabled();
  expect(within(card).getByRole('checkbox', { name: /Always treat this payee/ })).toBeDisabled();
});

it('a money-in row offers no Business button', async () => {
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    if (String(url).includes('/ledger/inbox')) return json({ rows: [{ ...row, id: 'row-2', direction: 'credit', description: 'ZELLE FROM SOMEONE', suggestion: null }], total: 1 });
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-2');
  expect(within(card).queryByRole('button', { name: 'Business' })).not.toBeInTheDocument();
  expect(within(card).getByRole('button', { name: 'Income' })).toBeInTheDocument();
  expect(within(card).getByText('+$42.50')).toBeInTheDocument();
});

it('a shelf view does not offer its own shelf again: no Later button in the Later view, no Income button in the Income view', async () => {
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/inbox') && u.includes('view=income')) return json({ rows: [{ ...row, id: 'row-3', direction: 'credit', suggestion: { income: true } }], total: 1 });
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  await screen.findByTestId('ledger-row-row-1');
  fireEvent.click(screen.getByRole('button', { name: 'Later view' }));
  const laterCard = await screen.findByTestId('ledger-row-row-1');
  await waitFor(() => expect(within(laterCard).queryByRole('button', { name: 'Later' })).not.toBeInTheDocument());
  expect(within(laterCard).getByRole('button', { name: 'Personal' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Income view' }));
  const incomeCard = await screen.findByTestId('ledger-row-row-3');
  expect(within(incomeCard).queryByRole('button', { name: 'Income' })).not.toBeInTheDocument();
  expect(within(incomeCard).getByRole('button', { name: 'Later' })).toBeInTheDocument();
});

it('after Apply rules now, an untouched category selection follows the refreshed suggestion; an edited one stays', async () => {
  let inboxLoads = 0;
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/inbox')) {
      inboxLoads += 1;
      const refreshed = inboxLoads >= 2;
      return json({ rows: [
        { ...row, suggestion: { ...row.suggestion, categoryId: refreshed ? 'cat-1' : 'cat-2' } },
        { ...row, id: 'row-2', description: 'OTHER PAYEE', suggestion: { ...row.suggestion, categoryId: refreshed ? 'cat-1' : 'cat-2' } },
      ], total: 2 });
    }
    if (u.includes('/ledger/rules/apply')) return json({ success: true, examined: 2, suggested: 2, cleared: 0, more: false, cursor: null });
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  const edited = await screen.findByTestId('ledger-row-row-2');
  fireEvent.change(within(edited).getByLabelText('Category'), { target: { value: 'cat-1' } });
  fireEvent.change(within(edited).getByLabelText('Category'), { target: { value: 'cat-2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply rules now' }));
  await waitFor(() => expect(within(screen.getByTestId('ledger-row-row-1')).getByLabelText('Category')).toHaveValue('cat-1'));
  expect(within(screen.getByTestId('ledger-row-row-2')).getByLabelText('Category')).toHaveValue('cat-2');
});

it('checking Always removes the Later action, and a decided row shows the decision instead of the stale rule label', async () => {
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/inbox') && u.includes('view=income')) {
      return json({ rows: [{ ...row, id: 'row-4', direction: 'credit', suggestion: { ...row.suggestion, rule: { id: 'r9', kind: 'review' }, categoryName: 'Tools', income: true, decision: 'income' } }], total: 1 });
    }
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  expect(within(card).getByRole('button', { name: 'Later' })).toBeInTheDocument();
  fireEvent.click(within(card).getByLabelText('Always treat this payee this way (not for Later or Recorded)'));
  expect(within(card).queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Income view' }));
  const decided = await screen.findByTestId('ledger-row-row-4');
  expect(within(decided).getByText('income')).toBeInTheDocument();
  expect(within(decided).queryByText(/review/)).not.toBeInTheDocument();
});

it('an Always decision reloads the view so sibling rows show the new rule', async () => {
  let inboxLoads = 0;
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/inbox')) {
      inboxLoads += 1;
      const sibling = { ...row, id: 'row-5', description: 'ACME HARDWARE 999', suggestion: inboxLoads >= 2 ? { ...row.suggestion, rule: { id: 'r-owner', kind: 'personal', source: 'owner' }, personal: true, categoryName: null } : null };
      return json({ rows: inboxLoads >= 2 ? [sibling] : [row, sibling], total: inboxLoads >= 2 ? 1 : 2 });
    }
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  fireEvent.click(within(card).getByLabelText('Always treat this payee this way (not for Later or Recorded)'));
  fireEvent.click(within(card).getByRole('button', { name: 'Personal' }));
  await waitFor(() => expect(inboxLoads).toBeGreaterThanOrEqual(2));
  const sibling = await screen.findByTestId('ledger-row-row-5');
  await waitFor(() => expect(within(sibling).getByText('personal')).toBeInTheDocument());
  expect(screen.queryByTestId('ledger-row-row-1')).not.toBeInTheDocument();
});

it('an action that finishes after a view switch does not write the old view into the new one', async () => {
  let resolveDecide;
  const base = fetch;
  vi.stubGlobal('fetch', vi.fn(async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/ledger/decide')) { calls.push({ url: u, method: 'POST', body: JSON.parse(opts.body) }); return new Promise((r) => { resolveDecide = () => r(json({ success: true, action: 'ignored', ruleCreated: false })); }); }
    if (u.includes('/ledger/inbox') && u.includes('view=later')) return json({ rows: [{ ...row, id: 'row-L', description: 'LATER ROW', suggestion: { later: true } }], total: 1 });
    return base(url, opts);
  }));
  render(<LedgerInboxTab />);
  const card = await screen.findByTestId('ledger-row-row-1');
  fireEvent.click(within(card).getByRole('button', { name: 'Personal' }));
  await waitFor(() => expect(resolveDecide).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', { name: 'Later view' }));
  await screen.findByTestId('ledger-row-row-L');
  resolveDecide();
  await waitFor(() => expect(calls.filter((c) => c.url.includes('/ledger/status')).length).toBeGreaterThanOrEqual(2));
  expect(screen.getByTestId('ledger-row-row-L')).toBeInTheDocument();
  expect(screen.getByText('1 rows to review · 3 rules')).toBeInTheDocument();
});

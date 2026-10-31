// @vitest-environment jsdom
// A plain price/notes edit must not rewrite the visit's stored service type
// (UI audit 2026-09-07, SMS-01): only a tier the tech changed does.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MobileServiceEditModal from './MobileServiceEditModal';

const saveNotice = vi.hoisted(() => ({ shown: [] }));
vi.mock('./ScheduleSaveNotice', async (importOriginal) => ({
  ...(await importOriginal()),
  showScheduleSaveNotice: (message) => { saveNotice.shown.push(message); },
}));

const SERVICE = {
  id: 'svc-1',
  serviceType: 'Lawn Care - Track B',
  estimatedPrice: 99,
  technicianId: '',
  estimatedDuration: 30,
  notes: '',
};

function lastPutBody() {
  const call = fetch.mock.calls.find(([url, opts]) => String(url).endsWith('/admin/schedule/svc-1/update-details') && opts?.method === 'PUT');
  expect(call).toBeTruthy();
  return JSON.parse(call[1].body);
}

describe('MobileServiceEditModal save payload', () => {
  beforeEach(() => {
    localStorage.setItem('waves_admin_token', 'test-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); saveNotice.shown.length = 0; });

  it('omits serviceType when the tech did not pick a different tier', async () => {
    const onSaved = vi.fn();
    render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = lastPutBody();
    expect(body).not.toHaveProperty('serviceType');
    expect(body.estimatedPrice).toBe(99);
  });

  it('rewrites serviceType only from a tier the tech chose', async () => {
    const onSaved = vi.fn();
    render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /Quarterly/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(lastPutBody().serviceType).toBe('Lawn Care - Track B — Quarterly');
  });

  it('a refused change on a shared stop asks whole stop or separate, and the answer rides the next save', async () => {
    const answers = [
      new Response(JSON.stringify({ error: 'This service is grouped with another at the same stop.', code: 'VISIT_EDIT_SCHEDULE_UNSUPPORTED' }), { status: 409 }),
      new Response(JSON.stringify({ success: true, comboMove: { moved: true, warnings: ['Fixture overlap warning.'] } }), { status: 200 }),
    ];
    fetch.mockImplementation(async () => answers.shift());
    const onSaved = vi.fn();
    render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const ask = await screen.findByRole('group', { name: 'This stop has more than one service' });
    expect(ask).toHaveTextContent('Nothing was changed.');
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Change the whole stop' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const puts = fetch.mock.calls.filter(([, opts]) => opts?.method === 'PUT').map(([, opts]) => JSON.parse(opts.body));
    expect(puts[0]).not.toHaveProperty('comboMove');
    expect(puts[1].comboMove).toBe('together');
    // A warning the whole-stop change returned (a double booking) is shown.
    expect(saveNotice.shown).toEqual(['Saved.\n\nFixture overlap warning.']);
  });

  it('a whole-stop change that was partly done, did not confirm, or was refused is reported as that', async () => {
    const outcomes = [
      { moved: false, needsAttention: { message: 'Only part of this stop was reassigned: fixture repair text.' } },
      { moved: null, error: 'connection reset' },
      { moved: false, error: 'Technician is inactive.' },
    ];
    for (const comboMove of outcomes) {
      fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ success: true, comboMove }), { status: 200 }));
      const onSaved = vi.fn();
      const view = render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={onSaved} />);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      view.unmount();
    }
    expect(saveNotice.shown).toEqual([
      'The other changes were saved. Only part of this stop was reassigned: fixture repair text.',
      'The other changes were saved. The technician change did not confirm, so the stop may or may not have changed: check the schedule. (connection reset)',
      "The other changes were saved, but the stop's technician was not changed: Technician is inactive.",
    ]);
  });

  it('a whole-stop save that gets no answer is reported as unconfirmed, not as failed', async () => {
    const answers = [
      async () => new Response(JSON.stringify({ error: 'grouped', code: 'VISIT_EDIT_SCHEDULE_UNSUPPORTED' }), { status: 409 }),
      async () => { throw new TypeError('Failed to fetch'); },
    ];
    fetch.mockImplementation(() => answers.shift()());
    render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Change the whole stop' }));
    expect(await screen.findByText('The save did not confirm, so it may or may not have gone through. Close this and check the schedule before you save again.')).toBeInTheDocument();
  });

  describe('auto-dispatch lock box', () => {
    const OCCURRENCE = { ...SERVICE, isRecurring: true, recurringParentId: 'parent-1', autoDispatchLocked: true };
    const LABEL = 'Keep auto-dispatch off this visit';
    const saveBody = () => JSON.parse(fetch.mock.calls.find(([url]) => String(url).endsWith('/update-details'))[1].body);

    it('shows the box checked for a locked recurring occurrence and hides it otherwise', () => {
      const view = render(<MobileServiceEditModal desktopVisible service={OCCURRENCE} onClose={vi.fn()} onSaved={vi.fn()} />);
      expect(screen.getByLabelText(new RegExp(LABEL))).toBeChecked();
      view.unmount();
      render(<MobileServiceEditModal desktopVisible service={{ ...SERVICE, isRecurring: false, recurringParentId: null }} onClose={vi.fn()} onSaved={vi.fn()} />);
      expect(screen.queryByText(LABEL)).not.toBeInTheDocument();
    });

    it('a cleared box rides the one save: the new value and the value the form opened with', async () => {
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={OCCURRENCE} onClose={vi.fn()} onSaved={onSaved} />);
      fireEvent.click(screen.getByLabelText(new RegExp(LABEL)));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(saveBody()).toMatchObject({ autoDispatchLocked: false, autoDispatchLockedWas: true });
      expect(fetch.mock.calls.filter(([url]) => String(url).includes('/auto-dispatch/'))).toHaveLength(0);
    });

    it('an untouched box sends the same value twice, which the server reads as no decision', async () => {
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={OCCURRENCE} onClose={vi.fn()} onSaved={onSaved} />);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(saveBody()).toMatchObject({ autoDispatchLocked: true, autoDispatchLockedWas: true });
    });
  });

  // Bug 4 of the 10-24 price audit (owner 2026-10-26): a series price edit
  // from this sheet asks the question Edit appointment asks. The server says
  // whether it may (series-summary canScopeSheetPrice: true only when
  // GATE_SERVICE_SHEET_PRICE_SCOPE and GATE_EDIT_APPT_PRICE_SERVICE_SCOPE are
  // both on), so "gate on/off" here is that answer.
  describe('"Apply price change to" on a series visit', () => {
    const PARENT = { ...SERVICE, isRecurring: true, recurringParentId: null };
    const CHILD = { ...SERVICE, isRecurring: true, recurringParentId: 'parent-1' };
    const ONE_TIME = { ...SERVICE, isRecurring: false, recurringParentId: null };
    // Boosters share the parent id but are not base-series rows.
    const BOOSTER = { ...SERVICE, isRecurring: false, recurringParentId: 'parent-1' };
    const GROUP = 'Apply price change to';
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const summaryCalls = () => fetch.mock.calls.filter(([url]) => String(url).endsWith('/admin/schedule/svc-1/series-summary'));
    const putBodies = () => fetch.mock.calls
      .filter(([url, opts]) => String(url).endsWith('/update-details') && opts?.method === 'PUT')
      .map(([, opts]) => JSON.parse(opts.body));
    // series-summary answers what the server would for that row; every PUT
    // answers from `puts` in order, then { ok: true }.
    function routeFetch({ summary, summaryStatus = 200, puts = [] } = {}) {
      fetch.mockImplementation(async (url, opts) => {
        if (String(url).endsWith('/series-summary')) return json(summary || { series: false }, summaryStatus);
        if (opts?.method === 'PUT') return puts.length ? puts.shift() : json({ ok: true });
        return json({});
      });
    }
    const editPrice = (value) => fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value } });
    // The summary read has answered and the sheet has rendered its answer.
    async function summarySettled(calls = 1) {
      await waitFor(() => expect(summaryCalls()).toHaveLength(calls));
      await act(async () => {});
    }

    const KINDS = [
      ['series parent', PARENT, true],
      ['series child', CHILD, true],
      ['one-time visit', ONE_TIME, false],
      ['booster', BOOSTER, false],
    ];
    const MATRIX = KINDS.flatMap(([kind, service, baseSeries]) => [true, false].flatMap((gateOn) => [true, false]
      .map((priceEdited) => [kind, gateOn ? 'on' : 'off', priceEdited ? 'changed' : 'unchanged', service, baseSeries, gateOn, priceEdited])));

    it.each(MATRIX)('%s, gate %s, price %s', async (_kind, _gate, _price, service, baseSeries, gateOn, priceEdited) => {
      // A booster's own summary would say series:true too; the sheet must
      // still never offer it (or ask for it).
      routeFetch({ summary: { series: service.isRecurring || !!service.recurringParentId, canScopePriceService: true, canScopeSheetPrice: gateOn } });
      render(<MobileServiceEditModal desktopVisible service={service} onClose={vi.fn()} onSaved={vi.fn()} />);
      if (baseSeries) await summarySettled();
      if (priceEdited) editPrice('199');
      const shown = baseSeries && gateOn && priceEdited;
      if (shown) {
        const group = screen.getByRole('radiogroup', { name: GROUP });
        expect(within(group).getByRole('radio', { name: 'This appointment only' })).toHaveAttribute('aria-checked', 'true');
        expect(within(group).getByRole('radio', { name: 'This and following appointments' })).toHaveAttribute('aria-checked', 'false');
        // No helper line: the label and the two rows are the whole section.
        expect(group.parentElement).toHaveTextContent(/^Apply price change toThis appointment onlyThis and following appointments$/);
      } else {
        expect(screen.queryByRole('radiogroup', { name: GROUP })).not.toBeInTheDocument();
        expect(screen.queryByText(GROUP)).not.toBeInTheDocument();
      }
      // One-offs and boosters never ask the server.
      expect(summaryCalls()).toHaveLength(baseSeries ? 1 : 0);
    });

    it('posts this_only by default, following when picked, and no scope once the price is back to the opening value', async () => {
      routeFetch({ summary: { series: true, canScopeSheetPrice: true } });
      const onSaved = vi.fn();
      // Untouched choice: this appointment only.
      let view = render(<MobileServiceEditModal desktopVisible service={PARENT} onClose={vi.fn()} onSaved={onSaved} />);
      await summarySettled();
      editPrice('199');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      expect(putBodies()[0]).toMatchObject({ estimatedPrice: 199, price: '199', priceServiceScope: 'this_only' });
      view.unmount();

      // Picked: this and following.
      view = render(<MobileServiceEditModal desktopVisible service={CHILD} onClose={vi.fn()} onSaved={onSaved} />);
      await summarySettled(2);
      editPrice('199');
      fireEvent.click(screen.getByRole('radio', { name: 'This and following appointments' }));
      expect(screen.getByRole('radio', { name: 'This and following appointments' })).toHaveAttribute('aria-checked', 'true');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
      expect(putBodies()[1]).toMatchObject({ estimatedPrice: 199, priceServiceScope: 'following' });
      view.unmount();

      // Numerically the opening price again: nothing to scope, nothing sent.
      render(<MobileServiceEditModal desktopVisible service={CHILD} onClose={vi.fn()} onSaved={onSaved} />);
      await summarySettled(3);
      editPrice('199');
      expect(screen.getByRole('radiogroup', { name: GROUP })).toBeInTheDocument();
      editPrice('99.00');
      expect(screen.queryByRole('radiogroup', { name: GROUP })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(3));
      expect(putBodies()[2]).not.toHaveProperty('priceServiceScope');
      expect(putBodies()[2].estimatedPrice).toBe(99);
    });

    it('gate off: a series price edit posts exactly the body it posted before — no scope key', async () => {
      routeFetch({ summary: { series: true, canScopePriceService: true, canScopeSheetPrice: false } });
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={PARENT} onClose={vi.fn()} onSaved={onSaved} />);
      await summarySettled();
      editPrice('199');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      const body = putBodies()[0];
      expect(body).not.toHaveProperty('priceServiceScope');
      expect(Object.keys(body).sort()).toEqual([
        'autoDispatchLocked', 'autoDispatchLockedWas', 'estimatedDuration', 'estimatedPrice', 'notes', 'price', 'technicianId',
      ]);
    });

    it('an unreadable series-summary hides the choice and the save posts no scope, as in Edit appointment', async () => {
      routeFetch({ summary: { error: 'boom' }, summaryStatus: 500 });
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={PARENT} onClose={vi.fn()} onSaved={onSaved} />);
      await summarySettled();
      editPrice('199');
      expect(screen.queryByRole('radiogroup', { name: GROUP })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(putBodies()[0]).not.toHaveProperty('priceServiceScope');
      expect(putBodies()[0].estimatedPrice).toBe(199);
    });

    it('the pick survives the shared-stop question and rides the whole-stop re-save', async () => {
      routeFetch({
        summary: { series: true, canScopeSheetPrice: true },
        puts: [json({ error: 'This service is grouped with another at the same stop.', code: 'VISIT_EDIT_SCHEDULE_UNSUPPORTED' }, 409)],
      });
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={CHILD} onClose={vi.fn()} onSaved={onSaved} />);
      await summarySettled();
      editPrice('199');
      fireEvent.click(screen.getByRole('radio', { name: 'This and following appointments' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Change the whole stop' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      const [first, second] = putBodies();
      expect(first.priceServiceScope).toBe('following');
      expect(first).not.toHaveProperty('comboMove');
      expect(second).toMatchObject({ priceServiceScope: 'following', comboMove: 'together', estimatedPrice: 199 });
    });

    it("reports a 'following' save with the server's count, the way Edit appointment does", async () => {
      routeFetch({
        summary: { series: true, canScopeSheetPrice: true },
        puts: [json({ success: true, priceServiceScope: { scope: 'following', updatedVisits: 3 } })],
      });
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={PARENT} onClose={vi.fn()} onSaved={onSaved} />);
      await summarySettled();
      editPrice('199');
      fireEvent.click(screen.getByRole('radio', { name: 'This and following appointments' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(saveNotice.shown).toEqual([
        'Price/service change applied to this visit and 3 other upcoming visits in the series. Visits the plan schedules later will use the new values too.',
      ]);
    });
  });

  const tierRow = (name) => screen.getAllByRole('button').find((b) => within(b).queryByText(name, { exact: true }));

  // Owner ruling 2026-09-01: never bill monthly — "Monthly" is a cadence.
  describe('the Monthly tier', () => {
    it('reads "Monthly", and a visit stamped by the old "Billed Monthly" label still opens on it and keeps its type on an untouched save', async () => {
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={{ ...SERVICE, serviceType: 'Pest Control — Billed Monthly' }} onClose={vi.fn()} onSaved={onSaved} />);
      expect(screen.queryByText('Billed Monthly')).not.toBeInTheDocument();
      // The selected tier shows the price; the others read "Variable".
      expect(within(tierRow('Monthly')).getByText('$99.00')).toBeInTheDocument();
      expect(within(tierRow('Quarterly')).getByText('Variable')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(lastPutBody()).not.toHaveProperty('serviceType');
    });

    it('a tech who picks Monthly stamps "<base> — Monthly"', async () => {
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={{ ...SERVICE, serviceType: 'Quarterly Pest Control' }} onClose={vi.fn()} onSaved={onSaved} />);
      fireEvent.click(tierRow('Monthly'));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(lastPutBody().serviceType).toBe('Pest Control — Monthly');
    });
  });

  describe('the tier the sheet opens on', () => {
    // The selected tier is the one row that shows the price.
    const selectedTiers = () => ['Monthly', 'Bi-Monthly', 'Quarterly', 'Semiannual', 'One-Time Service']
      .filter((name) => within(tierRow(name)).queryByText('$99.00'));

    it('a Bi-Monthly label opens on Bi-Monthly, not Monthly', () => {
      render(<MobileServiceEditModal desktopVisible service={{ ...SERVICE, serviceType: 'Pest Control — Bi-Monthly' }} onClose={vi.fn()} onSaved={vi.fn()} />);
      expect(selectedTiers()).toEqual(['Bi-Monthly']);
    });

    it("a label with no cadence (the day feed's \"Pest Control\") opens on the visit's repeat, and an untouched save keeps its type", async () => {
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={{ ...SERVICE, serviceType: 'Pest Control', isRecurring: true, recurringPattern: 'quarterly' }} onClose={vi.fn()} onSaved={onSaved} />);
      expect(selectedTiers()).toEqual(['Quarterly']);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(lastPutBody()).not.toHaveProperty('serviceType');
    });

    it('a repeat with no row (every 4 months) selects none, and an untouched save keeps its type', async () => {
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={{ ...SERVICE, serviceType: 'Pest Control', isRecurring: true, recurringPattern: 'triannual' }} onClose={vi.fn()} onSaved={onSaved} />);
      expect(selectedTiers()).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(lastPutBody()).not.toHaveProperty('serviceType');
    });

    it('from no row selected, a pick stamps "<base> — <tier>"', async () => {
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={{ ...SERVICE, serviceType: 'Pest Control', isRecurring: true, recurringPattern: 'triannual' }} onClose={vi.fn()} onSaved={onSaved} />);
      fireEvent.click(tierRow('Quarterly'));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(lastPutBody().serviceType).toBe('Pest Control — Quarterly');
    });

    it('a visit with no series and no cadence opens on One-Time', () => {
      render(<MobileServiceEditModal desktopVisible service={SERVICE} onClose={vi.fn()} onSaved={vi.fn()} />);
      expect(selectedTiers()).toEqual(['One-Time Service']);
    });

    it.each(['Pest Control — Monthly', 'Pest Control — Billed Monthly'])('a new pick on "%s" stamps "Pest Control — Quarterly": no doubled dash, no "Billed"', async (serviceType) => {
      const onSaved = vi.fn();
      render(<MobileServiceEditModal desktopVisible service={{ ...SERVICE, serviceType }} onClose={vi.fn()} onSaved={onSaved} />);
      expect(screen.getByText('PEST CONTROL: CHOOSE ONE')).toBeInTheDocument();
      fireEvent.click(tierRow('Quarterly'));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(onSaved).toHaveBeenCalled());
      expect(lastPutBody().serviceType).toBe('Pest Control — Quarterly');
    });
  });
});

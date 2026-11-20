// @vitest-environment jsdom
// The line under Minutes per Zone shows the number the server would use: the owner table (spray 1.0 in/hr),
// "typical head rates" only. A typed Weekly Inches entry still wins over the derived figure.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/api', () => ({
  default: {
    getPropertyPreferences: vi.fn(),
    getWateringPlan: vi.fn(),
    updatePropertyPreferences: vi.fn(),
    getServicePreferences: vi.fn(),
    updateServicePreferences: vi.fn(),
  },
}));

import api from '../utils/api';
import { PropertyTab } from './PortalPage';

const lawnCustomer = { id: 'cust-1', firstName: 'Pat', lastName: 'Customer', phone: '9415551234', email: 'pat@example.com', tier: 'Gold', property: {} };
const SPRAY_PREFS = { irrigationRunMinutes: 30, wateringDays: ['Mon', 'Thu'], irrigationSystemType: ['spray'], irrigationInchesPerWeek: null };

beforeEach(() => {
  vi.clearAllMocks();
  api.getWateringPlan.mockResolvedValue({ available: false });
  api.getServicePreferences.mockResolvedValue({ preferences: {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('portal derived irrigation line follows the server rate table', () => {
  it('the same entries read 1" a week, "typical head rates" only', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: SPRAY_PREFS, hasLawnCare: true });
    render(<PropertyTab customer={lawnCustomer} />);
    const line = await screen.findByText(/a week from 30 minutes per zone, 2 days a week on spray heads/);
    expect(line).toHaveTextContent('About 1" a week from 30 minutes per zone, 2 days a week on spray heads — typical head rates. If your controller');
    expect(line).not.toHaveTextContent('University of Florida');
  });

  it('a typed Weekly Inches entry still wins, and the line says so', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: { ...SPRAY_PREFS, irrigationInchesPerWeek: 0.8 }, hasLawnCare: true });
    render(<PropertyTab customer={lawnCustomer} />);
    const line = await waitFor(() => screen.getByText(/works out to about 1" a week/));
    expect(line).toHaveTextContent('your Weekly Inches entry above is what we\'ll use');
  });
});

describe('water source (phase 2 of "water you saved")', () => {
  it('shows the three answers under Irrigation, the saved one pressed, and the summary names it', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: { ...SPRAY_PREFS, irrigationWaterSource: 'well' }, hasLawnCare: true });
    render(<PropertyTab customer={lawnCustomer} />);
    const well = await screen.findByRole('button', { name: 'Private well' });
    expect(well).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'County water' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Reclaimed' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/well water/)).toBeInTheDocument();
  });
});

describe('sprinkler timer on file (step 1 of sprinkler timer connect)', () => {
  it('a lawn customer sees the timer on file, and a new pick saves brand, model and a cleared app answer in one request', async () => {
    api.getPropertyPreferences.mockResolvedValue({
      preferences: { ...SPRAY_PREFS, irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: 'yes' },
      hasLawnCare: true, hasLawnService: true,
    });
    // The server answers with the row it now holds.
    api.updatePropertyPreferences.mockImplementation(async (payload) => ({ saved: true, preferences: { ...SPRAY_PREFS, ...payload } }));
    render(<PropertyTab customer={lawnCustomer} />);
    expect(await screen.findByText('Hunter X2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'true');
    // The plan card reads the week's plan once when it mounts; take the count after that read.
    await waitFor(() => expect(api.getWateringPlan).toHaveBeenCalled());
    const planReads = api.getWateringPlan.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Change my timer' }));
    fireEvent.click(screen.getByRole('button', { name: /^Pro-C/ }));
    expect(await screen.findByText('Hunter Pro-C')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1), { timeout: 8000 });
    // The save names the timer the screen showed before the change: the server sets the timer only over that one.
    expect(api.updatePropertyPreferences).toHaveBeenCalledWith(expect.objectContaining({
      irrigationControllerBrand: 'hunter', irrigationControllerModel: 'pro_c', irrigationControllerApp: null, controller_timer_seen: ['hunter|x2|yes'],
    }));
    expect(screen.getByText('Hunter Pro-C')).toBeInTheDocument();
    // A timer is not a watering input: recording one does not reload the week's plan.
    expect(api.getWateringPlan.mock.calls.length).toBe(planReads);
  }, 15000); // real autosave timer (about a second) plus two awaited renders: room for a loaded CI runner

  // The server refuses a timer whole (all three fields, one reason), as a 400 when the timer was the batch's only
  // change: the card shows that reason. A network failure re-queues the edit, and the banner says so. Meanwhile
  // staff set a Rain Bird. The next save of another field leaves the refused pick beside its reason (the customer
  // reloads to see the new timer), and carries the re-queued pick, which is the last write.
  const REFUSED = 'The home on this account changed. Reload, then set the sprinkler timer again.';
  const STAFF_RAIN_BIRD = { irrigationControllerBrand: 'rain_bird', irrigationControllerModel: null, irrigationControllerApp: null };
  it.each([
    ['refused, with its reason', Object.assign(new Error(REFUSED), {
      rejected: ['irrigationControllerBrand', 'irrigationControllerModel', 'irrigationControllerApp'].map((field) => ({ field, message: REFUSED })),
    }), `We could not save your timer. ${REFUSED}`, false],
    ['lost to a network failure', new Error('Failed to fetch'), 'Could not save. Please check your connection and try again.', true],
  ])('a timer whose save is %s stays on screen, and only a lost one is sent again', async (_case, failure, shown, sentAgain) => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: { ...SPRAY_PREFS }, hasLawnCare: true, hasLawnService: true });
    api.updatePropertyPreferences.mockRejectedValueOnce(failure)
      .mockImplementation(async (payload) => ({ saved: true, preferences: { ...SPRAY_PREFS, ...STAFF_RAIN_BIRD, ...payload } }));
    render(<PropertyTab customer={lawnCustomer} />);
    fireEvent.click(await screen.findByRole('button', { name: /^X2/ }));
    expect(await screen.findByText(shown, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByText('Hunter X2')).toBeInTheDocument();
    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1);
    expect(api.updatePropertyPreferences.mock.calls[0][0].controller_timer_seen).toEqual(['||']);

    fireEvent.change(screen.getByLabelText('Side Gate / Backyard Access'), { target: { value: 'Lift latch' } });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(2), { timeout: 8000 });
    expect(api.updatePropertyPreferences.mock.calls[1][0].irrigationControllerModel).toBe(sentAgain ? 'x2' : undefined);
    // A lost change goes again naming the timer it was made against and the one it sent (that save may have landed);
    // a refused one leaves nothing behind.
    expect(api.updatePropertyPreferences.mock.calls[1][0].controller_timer_seen).toEqual(sentAgain ? ['||', 'hunter|x2|'] : undefined);
    expect(await screen.findByText('Property details saved.')).toBeInTheDocument();
    expect(screen.getByText('Hunter X2')).toBeInTheDocument();
  }, 20000);

  // A batch that also carries another field saves that field and refuses the timer (a stale home): a 200 that names
  // the timer. The refused pick stays beside its reason, and the next save does not replace it.
  it('a timer refused beside a field that saved stays on screen with its reason', async () => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: { ...SPRAY_PREFS }, hasLawnCare: true, hasLawnService: true });
    const timerRefused = ['irrigationControllerBrand', 'irrigationControllerModel', 'irrigationControllerApp'].map((field) => ({ field, message: REFUSED }));
    const withoutTimer = (payload) => Object.fromEntries(Object.entries(payload).filter(([field]) => !field.startsWith('irrigationController')));
    api.updatePropertyPreferences
      .mockImplementationOnce(async (payload) => ({ saved: true, rejected: timerRefused, preferences: { ...SPRAY_PREFS, ...withoutTimer(payload) } }))
      .mockImplementation(async (payload) => ({ saved: true, preferences: { ...SPRAY_PREFS, ...STAFF_RAIN_BIRD, ...payload } }));
    render(<PropertyTab customer={lawnCustomer} />);
    fireEvent.change(await screen.findByLabelText('Side Gate / Backyard Access'), { target: { value: 'Lift latch' } });
    fireEvent.click(screen.getByRole('button', { name: /^X2/ }));
    expect(await screen.findByText(`We could not save your timer. ${REFUSED}`, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1);
    expect(api.updatePropertyPreferences.mock.calls[0][0]).toMatchObject({ irrigationControllerModel: 'x2' });

    fireEvent.change(screen.getByLabelText('Side Gate / Backyard Access'), { target: { value: 'Lift latch, then left' } });
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(2), { timeout: 8000 });
    expect(api.updatePropertyPreferences.mock.calls[1][0]).not.toHaveProperty('irrigationControllerModel');
    expect(api.updatePropertyPreferences.mock.calls[1][0]).not.toHaveProperty('controller_timer_seen');
    expect(await screen.findByText('Property details saved.')).toBeInTheDocument();
    expect(screen.getByText('Hunter X2')).toBeInTheDocument();
  }, 20000);

  // Staff replaced the timer while this page was open: the next change here names the timer the screen showed, so the
  // server refuses it (an app answer never puts back an old box), and the card says why.
  it('a timer change names the timer the screen showed before it; the server\'s refusal stays on screen', async () => {
    api.getPropertyPreferences.mockResolvedValue({
      preferences: { ...SPRAY_PREFS, irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: null },
      hasLawnCare: true, hasLawnService: true,
    });
    const CHANGED = 'The sprinkler timer on this account changed while this page was open. Reload, then set it again.';
    api.updatePropertyPreferences
      .mockImplementationOnce(async (payload) => ({ saved: true, preferences: { ...SPRAY_PREFS, ...payload } }))
      .mockRejectedValueOnce(Object.assign(new Error(CHANGED), {
        rejected: ['irrigationControllerBrand', 'irrigationControllerModel', 'irrigationControllerApp'].map((field) => ({ field, message: CHANGED })),
      }));
    render(<PropertyTab customer={lawnCustomer} />);
    // A pick and an answer in one save: both were made against the X2.
    fireEvent.click(await screen.findByRole('button', { name: 'Change my timer' }));
    fireEvent.click(screen.getByRole('button', { name: /^Pro-C/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1), { timeout: 8000 });
    expect(api.updatePropertyPreferences.mock.calls[0][0]).toMatchObject({
      irrigationControllerModel: 'pro_c', irrigationControllerApp: 'yes', controller_timer_seen: ['hunter|x2|'],
    });
    expect(await screen.findByText('Property details saved.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(2), { timeout: 8000 });
    expect(api.updatePropertyPreferences.mock.calls[1][0]).toMatchObject({ irrigationControllerApp: 'no', controller_timer_seen: ['hunter|pro_c|yes'] });
    expect(await screen.findByText(`We could not save your timer. ${CHANGED}`, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByText('Hunter Pro-C')).toBeInTheDocument();
  }, 20000);

  // X2 on file; the customer picks the Pro-C, then the X2 again while the Pro-C save is in flight. The Pro-C answer
  // must not replace the X2 waiting in the queue, which is sent next.
  it('a newer pick waiting behind a save in flight stays on screen when that save returns', async () => {
    api.getPropertyPreferences.mockResolvedValue({
      preferences: { ...SPRAY_PREFS, irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: null },
      hasLawnCare: true, hasLawnService: true,
    });
    let answerFirstSave;
    api.updatePropertyPreferences
      .mockImplementationOnce((payload) => new Promise((resolve) => {
        answerFirstSave = () => resolve({ saved: true, preferences: { ...SPRAY_PREFS, ...payload } });
      }))
      .mockRejectedValueOnce(new Error('Failed to fetch'));
    render(<PropertyTab customer={lawnCustomer} />);
    expect(await screen.findByText('Hunter X2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Change my timer' }));
    fireEvent.click(screen.getByRole('button', { name: /^Pro-C/ }));
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1), { timeout: 8000 });
    fireEvent.click(screen.getByRole('button', { name: 'Change my timer' }));
    fireEvent.click(screen.getByRole('button', { name: /^X2/ }));
    await act(async () => { answerFirstSave(); });
    expect(screen.getByText('Hunter X2')).toBeInTheDocument();
    // The X2 was picked while the screen showed the Pro-C on its way to the server.
    expect(api.updatePropertyPreferences.mock.calls[0][0].controller_timer_seen).toEqual(['hunter|x2|']);

    expect(await screen.findByText('Could not save. Please check your connection and try again.', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(api.updatePropertyPreferences.mock.calls[1][0]).toMatchObject({ irrigationControllerModel: 'x2', controller_timer_seen: ['hunter|pro_c|'] });
    expect(screen.getByText('Hunter X2')).toBeInTheDocument();
  }, 20000);

  // Pro-C picked over an X2; Yes tapped while that save is out; the save lands but its answer is lost. The retry
  // carries the answer and names both timers the row may hold, so the server takes it over either one.
  it('after a save whose answer was lost, the queued answer names both timers the row may hold', async () => {
    api.getPropertyPreferences.mockResolvedValue({
      preferences: { ...SPRAY_PREFS, irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: null },
      hasLawnCare: true, hasLawnService: true,
    });
    let loseFirstAnswer;
    api.updatePropertyPreferences
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { loseFirstAnswer = () => reject(new Error('Failed to fetch')); }))
      .mockImplementation(async (payload) => ({ saved: true, preferences: { ...SPRAY_PREFS, ...payload } }));
    render(<PropertyTab customer={lawnCustomer} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change my timer' }));
    fireEvent.click(screen.getByRole('button', { name: /^Pro-C/ }));
    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1), { timeout: 8000 });
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await act(async () => { loseFirstAnswer(); });

    await waitFor(() => expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(2), { timeout: 8000 });
    expect(api.updatePropertyPreferences.mock.calls[1][0]).toMatchObject({
      irrigationControllerBrand: 'hunter', irrigationControllerModel: 'pro_c', irrigationControllerApp: 'yes',
      controller_timer_seen: ['hunter|x2|', 'hunter|pro_c|'],
    });
    expect(await screen.findByText('Property details saved.', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.getByText('Hunter Pro-C')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'true');
  }, 20000);

  it('a timer staff saved while the page was open replaces the old one after the next save', async () => {
    api.getPropertyPreferences.mockResolvedValue({
      preferences: { ...SPRAY_PREFS, irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: 'yes' },
      hasLawnCare: true, hasLawnService: true,
    });
    // Staff set a Rain Bird in Customer 360 meanwhile: the next save answers with that row.
    api.updatePropertyPreferences.mockImplementation(async (payload) => ({ saved: true, preferences: { ...SPRAY_PREFS, ...payload, ...STAFF_RAIN_BIRD } }));
    render(<PropertyTab customer={lawnCustomer} />);
    expect(await screen.findByText('Hunter X2')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Side Gate / Backyard Access'), { target: { value: 'Lift latch' } });
    expect(await screen.findByText('Rain Bird', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(api.updatePropertyPreferences.mock.calls[0][0]).not.toHaveProperty('irrigationControllerBrand');
  }, 15000);

  // X2 on file; the customer picks the Pro-C. The server takes it, but staff save a Rain Bird before the PUT reads
  // the row back, so the PUT answers with the Rain Bird. The card shows what the server holds.
  it('a timer staff saved just after the customer\'s pick replaces that pick when its save returns', async () => {
    api.getPropertyPreferences.mockResolvedValue({
      preferences: { ...SPRAY_PREFS, irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: null },
      hasLawnCare: true, hasLawnService: true,
    });
    api.updatePropertyPreferences.mockImplementation(async (payload) => ({ saved: true, preferences: { ...SPRAY_PREFS, ...payload, ...STAFF_RAIN_BIRD } }));
    render(<PropertyTab customer={lawnCustomer} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change my timer' }));
    fireEvent.click(screen.getByRole('button', { name: /^Pro-C/ }));
    expect(await screen.findByText('Rain Bird', {}, { timeout: 8000 })).toBeInTheDocument();
    expect(screen.queryByText('Hunter Pro-C')).not.toBeInTheDocument();
    expect(api.updatePropertyPreferences).toHaveBeenCalledTimes(1);
    expect(api.updatePropertyPreferences.mock.calls[0][0]).toMatchObject({ irrigationControllerModel: 'pro_c' });
  }, 15000);

  // The card is a lawn surface: it follows the server's hasLawnService only (the Lawn Health card's rule, owner ruling
  // 2026-08-28). hasLawnCare (Weekly Inches, the watering plan) also takes the Monday irrigation email's opt-ins and a
  // tier or a turf type on file: a tier counts any two services, and a pest-only home can have a turf type.
  it.each([
    ['no lawn service', false, { hasLawnCare: false }, {}],
    ['only the Monday irrigation email', false, { hasLawnCare: true, hasLawnService: false }, {}],
    ['a Gold tier and a turf type, but no lawn care', false, { hasLawnCare: true, hasLawnService: false }, { tier: 'Gold', property: { lawnType: 'St. Augustine' } }],
    ['lawn care on record', true, { hasLawnCare: true, hasLawnService: true }, {}],
  ])('a customer with %s: the card shows = %s', async (_case, shown, flags, customerFields) => {
    api.getPropertyPreferences.mockResolvedValue({ preferences: { ...SPRAY_PREFS }, ...flags });
    render(<PropertyTab customer={{ ...lawnCustomer, tier: 'Bronze', ...customerFields }} />);
    await screen.findByText('Controller Location');
    expect(screen.queryByText('Your sprinkler timer') !== null).toBe(shown);
  });
});

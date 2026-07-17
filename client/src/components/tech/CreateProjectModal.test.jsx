// @vitest-environment jsdom
/**
 * WDO Complete Service sheet — inspection date + Property & scope prefill.
 *
 * Date: the sheet must show the linked visit's calendar date. Callers have
 * passed both 'YYYY-MM-DD' and full ISO timestamps (a Postgres DATE
 * serialized at UTC midnight); a raw timestamp is invalid for a date input,
 * which silently blanks the field on iOS and saves the raw string.
 *
 * Prefill: the manufactured/mobile construction mapping
 * (customers.property_type) and the inspection fee (the linked visit's NET
 * price) seed blank fields only — hand-typed values always win. The retired
 * structure-footprint helper is not rendered; WDO pricing is flat by default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';

vi.mock('./WdoIntelligenceBar', () => ({ default: () => null }));
vi.mock('./DictationButton', () => ({ default: () => null }));
vi.mock('../AddressAutocomplete', () => ({ default: () => null }));
// jsdom has no canvas — the real pad's initCanvas would throw. The mock
// exposes the wiring the sign-step tests pin: which project it signs, the
// prefill, and the onChanged refresh hook.
vi.mock('./WdoSignaturePad', () => ({
  default: (props) => (
    <div data-testid="sign-pad" data-project-id={props.projectId} data-signer={props.defaultSignerName} data-idcard={props.defaultSignerIdCard}>
      <button
        type="button"
        onClick={() => props.onChanged({ signed: true, signer_name: 'Adam Benetti', signed_at: '2026-07-16T23:00:00.000Z' })}
      >mock-sign-saved</button>
      <button type="button" onClick={() => props.onChanged(null)}>mock-sign-cleared</button>
      <button type="button" onClick={() => props.onBusyChange?.(true)}>mock-busy-start</button>
      <button type="button" onClick={() => props.onBusyChange?.(false)}>mock-busy-end</button>
    </div>
  ),
}));

import CreateProjectModal, { wdoFeeSeedFromVisit } from './CreateProjectModal';
import * as projectTypesModule from '../../../../server/services/project-types.js';

const PROJECT_TYPES = projectTypesModule.PROJECT_TYPES
  || projectTypesModule.default?.PROJECT_TYPES;

const baseCustomer = {
  id: 9,
  first_name: 'Mike',
  last_name: 'Padil',
  phone: '+18138133734',
  address_line1: '15766 High Bell Pl',
  city: 'Bradenton',
  state: 'FL',
  zip: '34212',
  property_type: 'Single Family Residential',
  property_sqft: 2200,
};

let customerPayload;

function jsonResponse(payload) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });
}

beforeEach(() => {
  customerPayload = { ...baseCustomer };
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('fetch', vi.fn((url) => {
    const u = String(url);
    if (u.includes('/admin/projects/types')) return jsonResponse({ types: PROJECT_TYPES });
    if (u.includes('/estimates-summary')) return jsonResponse({ customer: customerPayload, estimates: [] });
    return jsonResponse({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// The sheet portals to document.body, so queries go through document, not
// the render container.
function renderWdoSheet(overrides = {}) {
  return render(
    <CreateProjectModal
      theme="light"
      presentation="sheet"
      defaultCustomerId="9"
      defaultCustomerLabel="Mike Padil"
      defaultScheduledServiceId="55"
      defaultProjectDate="2026-07-16"
      defaultInspectionFee={175}
      defaultProjectType="wdo_inspection"
      allowedProjectTypes={['wdo_inspection']}
      allowInvoiceCompletion
      onClose={() => {}}
      onCreated={() => {}}
      {...overrides}
    />,
  );
}

const field = (key) => document.querySelector(`#create-project-wdo_inspection-${key}`);
const dateInput = () => document.querySelector('input[type="date"]');

describe('CreateProjectModal WDO inspection date', () => {
  it('exposes a named Complete Service dialog', async () => {
    renderWdoSheet();
    expect(
      await screen.findByRole('dialog', { name: 'Complete Service Report' }),
    ).toBeTruthy();
  });

  it('shows the visit date passed as YYYY-MM-DD', async () => {
    renderWdoSheet();
    await waitFor(() => expect(dateInput()).toBeTruthy());
    expect(dateInput().value).toBe('2026-07-16');
  });

  it('takes the date part of an ISO-timestamp default instead of blanking the input', async () => {
    renderWdoSheet({ defaultProjectDate: '2026-07-16T00:00:00.000Z' });
    await waitFor(() => expect(dateInput()).toBeTruthy());
    expect(dateInput().value).toBe('2026-07-16');
  });
});

describe('CreateProjectModal WDO Property & scope prefill', () => {
  it('prefills the fee from the visit price and omits the retired footprint helper', async () => {
    customerPayload.property_sqft = 8000;
    renderWdoSheet();
    await waitFor(() => expect(field('inspection_fee')).toBeTruthy());
    await waitFor(() => expect(field('inspection_fee').value).toBe('175'));
    expect(field('structure_sqft')).toBeNull();
    // Construction is not derivable for a single-family home — never guessed.
    expect(field('structure_type').value).toBe('');
  });

  it('offers both camera and photo-library sources for prior-treatment extraction', async () => {
    renderWdoSheet();
    await waitFor(() => expect(field('previous_treatment_notes')).toBeTruthy());
    const camera = document.querySelector('input[data-wdo-prior-treatment-source="camera"]');
    const library = document.querySelector('input[data-wdo-prior-treatment-source="library"]');
    expect(camera).toBeTruthy();
    expect(camera.getAttribute('capture')).toBe('environment');
    expect(library).toBeTruthy();
    expect(library.hasAttribute('capture')).toBe(false);
  });

  it('maps a manufactured/mobile property_type onto the construction select', async () => {
    customerPayload.property_type = 'Manufactured Home';
    renderWdoSheet();
    await waitFor(() => expect(field('structure_type')).toBeTruthy());
    await waitFor(() => expect(field('structure_type').value).toBe('Manufactured / Mobile Home'));
  });

  it('leaves the fee blank when the visit carries no price', async () => {
    renderWdoSheet({ defaultInspectionFee: '' });
    await waitFor(() => expect(field('inspection_fee')).toBeTruthy());
    // Contact autofill has landed by now — the fee stays untouched.
    await waitFor(() => expect(field('requested_by').value).toContain('Mike Padil'));
    expect(field('inspection_fee').value).toBe('');
  });

  it('seeds an explicit "0" for a $0-booked visit — the no-charge statement', async () => {
    // Distinct from '' (no price known): the server reads "0" as no-charge
    // and refuses to bill it, instead of the $250 blank-fee default.
    renderWdoSheet({ defaultInspectionFee: 0 });
    await waitFor(() => expect(field('inspection_fee')).toBeTruthy());
    await waitFor(() => expect(field('inspection_fee').value).toBe('0'));
  });
});

describe('wdoFeeSeedFromVisit', () => {
  it('seeds the net visit price for a single-line WDO visit', () => {
    expect(wdoFeeSeedFromVisit({ estimatedPrice: 150, serviceAddons: [] })).toBe(150);
  });

  it('seeds nothing when the visit has a billable add-on — estimatedPrice is the group total', () => {
    // $175 WDO + $80 add-on: the auto-invoice bills inspection_fee as a
    // single WDO line, so the $255 total must never seed the fee (Codex P1).
    expect(wdoFeeSeedFromVisit({
      estimatedPrice: 255,
      serviceAddons: [{ serviceName: 'Rodent exclusion check', estimatedPrice: 80 }],
    })).toBe('');
  });

  it('still seeds when add-ons carry no dollars', () => {
    expect(wdoFeeSeedFromVisit({
      estimatedPrice: 175,
      serviceAddons: [{ serviceName: 'Free re-check', estimatedPrice: 0 }],
    })).toBe(175);
  });

  it('seeds nothing when the visit has no price', () => {
    expect(wdoFeeSeedFromVisit({ estimatedPrice: null, serviceAddons: [] })).toBe('');
    expect(wdoFeeSeedFromVisit(undefined)).toBe('');
  });

  it('passes an explicit $0 booking through as numeric 0 (no-charge)', () => {
    expect(wdoFeeSeedFromVisit({ estimatedPrice: 0, serviceAddons: [] })).toBe(0);
  });
});

describe('CreateProjectModal WDO one-page create-and-sign', () => {
  let detailPayload;

  beforeEach(() => {
    detailPayload = {
      wdo_applicator: { name: 'Adam Benetti', idCardNo: 'JE362022' },
      wdo_signature: null,
    };
    vi.stubGlobal('fetch', vi.fn((url, opts = {}) => {
      const u = String(url);
      if (u.includes('/admin/projects/types')) return jsonResponse({ types: PROJECT_TYPES });
      if (u.includes('/estimates-summary')) return jsonResponse({ customer: customerPayload, estimates: [] });
      if (u.includes('/admin/customers/9/cards')) return jsonResponse({ cards: [] });
      if (/\/admin\/projects$/.test(u) && opts.method === 'POST') {
        return jsonResponse({ project: { id: 'p-1', project_type: 'wdo_inspection' } });
      }
      if (u.includes('/admin/projects/p-1/send-with-invoice')) {
        const body = JSON.parse(opts.body || '{}');
        if (body.dry_run) {
          return jsonResponse({ invoice: { id: null, total: 250, created: true } });
        }
        return jsonResponse({
          sent: true,
          report_held: true,
          invoice: { id: 'inv-1', invoice_number: 'INV-1001', total: 250 },
        });
      }
      if (u.includes('/admin/projects/p-1/close')) {
        return jsonResponse({ project: { id: 'p-1', project_type: 'wdo_inspection', status: 'closed' } });
      }
      if (u.includes('/admin/projects/p-1')) return jsonResponse({ project: detailPayload });
      return jsonResponse({});
    }));
  });

  async function saveIntoSignStep(callbacks) {
    renderWdoSheet(callbacks);
    await waitFor(() => expect(field('inspection_fee')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save Report' }));
    await screen.findByText('✓ Report draft saved');
  }

  it('holds the sheet open on the signature step after save — callbacks deferred', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    await saveIntoSignStep({ onCreated, onClose });

    // The parent (which unmounts the modal from onCreated) must not have
    // been told yet — the tech is still signing.
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // The pad signs the just-created project with the report page's prefill.
    const pad = screen.getByTestId('sign-pad');
    expect(pad.getAttribute('data-project-id')).toBe('p-1');
    expect(pad.getAttribute('data-signer')).toBe('Adam Benetti');
    expect(pad.getAttribute('data-idcard')).toBe('JE362022');
  });

  it('"Sign later" leaves the saved draft and reports the project to the parent', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    await saveIntoSignStep({ onCreated, onClose });

    expect(screen.getByText("Unsigned reports can’t be sent yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign later' }));

    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-1' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a saved signature reveals invoice-first completion via the pad-reported outcome', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    await saveIntoSignStep({ onCreated, onClose });

    // The pad passes the POST response's metadata straight to the host —
    // there is no detail refetch to race or fail (Codex P2).
    fireEvent.click(screen.getByText('mock-sign-saved'));

    const saveForLater = await screen.findByRole('button', { name: 'Save for later' });
    const finish = screen.getByRole('button', { name: 'Send invoice & hold report' });
    expect(finish.style.width).toBe('100%');
    expect(screen.queryByText("Unsigned reports can’t be sent yet.")).toBeNull();
    fireEvent.click(saveForLater);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-1' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps invoice completion admin-only while allowing a technician to save the signed draft', async () => {
    await saveIntoSignStep({ allowInvoiceCompletion: false });
    fireEvent.click(screen.getByText('mock-sign-saved'));
    await screen.findByText('Signed — saved for office review and invoice delivery.');
    expect(screen.queryByRole('button', { name: 'Send invoice & hold report' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save for later' })).toBeTruthy();
  });

  it('a cleared signature flips the exit back to Sign later', async () => {
    await saveIntoSignStep({ onCreated: vi.fn(), onClose: vi.fn() });

    fireEvent.click(screen.getByText('mock-sign-saved'));
    await screen.findByRole('button', { name: 'Save for later' });

    fireEvent.click(screen.getByText('mock-sign-cleared'));
    await screen.findByRole('button', { name: 'Sign later' });
    expect(screen.getByText("Unsigned reports can’t be sent yet.")).toBeTruthy();
  });

  it('sends the invoice, arms the customer-side hold, closes the service, and skips the legacy editor handoff', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    await saveIntoSignStep({ onCreated, onClose });
    fireEvent.click(screen.getByText('mock-sign-saved'));

    fireEvent.click(await screen.findByRole('button', { name: 'Send invoice & hold report' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'p-1', status: 'closed' }),
      expect.objectContaining({
        completed: true,
        invoice: expect.objectContaining({ id: 'inv-1' }),
      }),
    ));
    expect(onClose).toHaveBeenCalledTimes(1);

    const calls = fetch.mock.calls.filter(([url]) => String(url).includes('/admin/projects/p-1'));
    const holdSend = calls.find(([url, opts]) => (
      String(url).includes('/send-with-invoice')
      && JSON.parse(opts.body || '{}').hold_report_until_paid === true
      && !JSON.parse(opts.body || '{}').dry_run
    ));
    expect(holdSend).toBeTruthy();
    expect(calls.some(([url]) => String(url).includes('/admin/projects/p-1/close'))).toBe(true);
  });

  it('retries only closeout after the invoice was delivered — never sends a duplicate invoice', async () => {
    const baseFetch = fetch;
    let closeAttempts = 0;
    vi.stubGlobal('fetch', vi.fn((url, opts = {}) => {
      if (String(url).includes('/admin/projects/p-1/close')) {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ error: 'Temporary closeout failure' }),
          });
        }
      }
      return baseFetch(url, opts);
    }));

    const onCreated = vi.fn();
    await saveIntoSignStep({ onCreated, onClose: vi.fn() });
    fireEvent.click(screen.getByText('mock-sign-saved'));
    fireEvent.click(await screen.findByRole('button', { name: 'Send invoice & hold report' }));

    await screen.findByText('Temporary closeout failure');
    fireEvent.click(screen.getByRole('button', { name: 'Finish service' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'closed' }),
      expect.objectContaining({ completed: true }),
    ));
    expect(closeAttempts).toBe(2);
    const invoiceCalls = fetch.mock.calls.filter(([url]) => String(url).includes('/send-with-invoice'));
    expect(invoiceCalls).toHaveLength(2); // one preview + one real send, no retry send
  });

  it('closing from the sign step still reports the created project', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    await saveIntoSignStep({ onCreated, onClose });

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-1' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a scrim click on the sign step exits through the finisher (onCreated fires)', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    await saveIntoSignStep({ onCreated, onClose });

    // The overlay only closes on a DIRECT scrim click (target === currentTarget).
    fireEvent.click(screen.getByRole('dialog'));

    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-1' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('every sign-step exit holds while the signature mutation is in flight', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    await saveIntoSignStep({ onCreated, onClose });

    fireEvent.click(screen.getByText('mock-busy-start'));

    // Footer exit, header close, and scrim are all inert while busy.
    const exit = screen.getByRole('button', { name: 'Saving…' });
    expect(exit.disabled).toBe(true);
    fireEvent.click(exit);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('dialog'));
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Mutation settles → exits work again.
    fireEvent.click(screen.getByText('mock-busy-end'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign later' }));
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-1' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('CreateProjectModal pre-treatment invoice-first completion', () => {
  function renderCertificateSheet(overrides = {}) {
    return render(
      <CreateProjectModal
        theme="light"
        presentation="sheet"
        defaultCustomerId="9"
        defaultCustomerLabel="Mike Padil"
        defaultScheduledServiceId="55"
        defaultProjectDate="2026-07-16"
        defaultProjectType="pre_treatment_termite_certificate"
        allowedProjectTypes={['pre_treatment_termite_certificate']}
        allowInvoiceCompletion
        onClose={() => {}}
        onCreated={() => {}}
        {...overrides}
      />,
    );
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn((url, opts = {}) => {
      const u = String(url);
      if (u.includes('/admin/projects/types')) return jsonResponse({ types: PROJECT_TYPES });
      if (u.includes('/estimates-summary')) return jsonResponse({ customer: customerPayload, estimates: [] });
      if (u.includes('/admin/customers/9/cards')) return jsonResponse({ cards: [] });
      if (u.includes('/admin/projects/scheduled-service/55/application-prefill')) {
        return jsonResponse({
          applications: [
            {
              _scheduled_service_label: 'Termite Pretreatment Service',
              treatment_method: 'Soil barrier (chemical)',
              product_name: 'Termidor SC',
              epa_registration: '7969-210',
              active_ingredient: 'fipronil',
            },
            {
              _scheduled_service_label: 'Termite Pretreatment Service',
              treatment_method: 'Wood treatment (borate)',
              product_name: 'Bora-Care',
              epa_registration: '64405-1',
              active_ingredient: 'disodium octaborate tetrahydrate',
            },
          ],
        });
      }
      if (/\/admin\/projects$/.test(u) && opts.method === 'POST') {
        return jsonResponse({ project: { id: 'cert-1', project_type: 'pre_treatment_termite_certificate' } });
      }
      if (u.includes('/admin/projects/cert-1/send-with-invoice')) {
        const body = JSON.parse(opts.body || '{}');
        if (body.dry_run) return jsonResponse({ invoice: { id: 'inv-cert', total: 425 } });
        return jsonResponse({
          sent: true,
          report_held: true,
          invoice: { id: 'inv-cert', invoice_number: 'INV-2001', total: 425 },
        });
      }
      if (u.includes('/admin/projects/cert-1/close')) {
        return jsonResponse({
          project: { id: 'cert-1', project_type: 'pre_treatment_termite_certificate', status: 'closed' },
        });
      }
      return jsonResponse({});
    }));
  });

  it('loads planned service products into the primary and additional application rows', async () => {
    renderCertificateSheet();

    expect(await screen.findByDisplayValue('Termidor SC')).toBeTruthy();
    expect(screen.getByDisplayValue('Bora-Care')).toBeTruthy();
    expect(screen.getByText(/2 planned applications found on the scheduled service/)).toBeTruthy();
    expect(screen.getByText(/Scheduled · Termite Pretreatment Service/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Add unplanned application' })).toBeTruthy();
  });

  it('uses the saved applicator attestation, sends the invoice, holds the certificate, and closes the service', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    renderCertificateSheet({ onCreated, onClose });

    await screen.findByText('Treatment address');
    fireEvent.click(screen.getByRole('button', { name: 'Save Certificate' }));

    await screen.findByText('✓ Certificate saved');
    expect(screen.queryByTestId('sign-pad')).toBeNull();
    expect(screen.getByText(/Applicator attestation saved/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Send invoice & hold certificate' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cert-1', status: 'closed' }),
      expect.objectContaining({
        completed: true,
        invoice: expect.objectContaining({ id: 'inv-cert' }),
      }),
    ));
    expect(onClose).toHaveBeenCalledTimes(1);
    const sendCalls = fetch.mock.calls.filter(([url]) => String(url).includes('/send-with-invoice'));
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls.every(([, opts]) => JSON.parse(opts.body).hold_report_until_paid === true)).toBe(true);
  });

  it('offers a saved-card path that charges once, delivers the certificate, and closes', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    vi.stubGlobal('fetch', vi.fn((url, opts = {}) => {
      const u = String(url);
      if (u.includes('/admin/projects/types')) return jsonResponse({ types: PROJECT_TYPES });
      if (u.includes('/estimates-summary')) return jsonResponse({ customer: customerPayload, estimates: [] });
      if (u.includes('/admin/customers/9/cards')) {
        return jsonResponse({ cards: [{ id: 'pm-card', method_type: 'card', brand: 'visa', last_four: '4242' }] });
      }
      if (u.includes('/admin/projects/scheduled-service/55/application-prefill')) return jsonResponse({ applications: [] });
      if (/\/admin\/projects$/.test(u) && opts.method === 'POST') {
        return jsonResponse({ project: { id: 'cert-1', project_type: 'pre_treatment_termite_certificate' } });
      }
      if (u.includes('/admin/projects/cert-1/send-with-invoice')) {
        const body = JSON.parse(opts.body || '{}');
        if (body.prepare_invoice) {
          return jsonResponse({ prepared: true, invoice: { id: 'inv-card', total: 425, payer_billed: false } });
        }
      }
      if (u.includes('/admin/invoices/inv-card/charge-card-quote')) {
        return jsonResponse({ quote: { base: 425, surcharge: 12.33, total: 437.33, rateBps: 290, funding: 'credit' } });
      }
      if (u.endsWith('/admin/invoices/inv-card/charge-card')) return jsonResponse({ ok: true });
      if (u.endsWith('/admin/projects/cert-1/send')) return jsonResponse({ sent: true });
      if (u.includes('/admin/projects/cert-1/close')) {
        return jsonResponse({ project: { id: 'cert-1', project_type: 'pre_treatment_termite_certificate', status: 'closed' } });
      }
      return jsonResponse({});
    }));

    renderCertificateSheet({ onCreated, onClose });
    await screen.findByRole('button', { name: 'Save Certificate' });
    fireEvent.click(screen.getByRole('button', { name: 'Save Certificate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Charge Visa •••• 4242 & finish service' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cert-1', status: 'closed' }),
      expect.objectContaining({ completed: true, invoice: expect.objectContaining({ id: 'inv-card' }) }),
    ));
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/charge-card'))).toHaveLength(1);
    const chargeBody = JSON.parse(fetch.mock.calls.find(([url]) => String(url).endsWith('/charge-card'))[1].body);
    expect(chargeBody.expectedTotal).toBe(437.33);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/admin/projects/cert-1/send'))).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not offer an expired saved card as a completion payment method', async () => {
    vi.stubGlobal('fetch', vi.fn((url, opts = {}) => {
      const u = String(url);
      if (u.includes('/admin/projects/types')) return jsonResponse({ types: PROJECT_TYPES });
      if (u.includes('/estimates-summary')) return jsonResponse({ customer: customerPayload, estimates: [] });
      if (u.includes('/admin/customers/9/cards')) {
        return jsonResponse({
          cards: [{
            id: 'pm-expired', method_type: 'card', brand: 'visa', last_four: '1111', exp_month: 1, exp_year: 2020,
          }],
        });
      }
      if (u.includes('/admin/projects/scheduled-service/55/application-prefill')) return jsonResponse({ applications: [] });
      if (/\/admin\/projects$/.test(u) && opts.method === 'POST') {
        return jsonResponse({ project: { id: 'cert-1', project_type: 'pre_treatment_termite_certificate' } });
      }
      return jsonResponse({});
    }));

    renderCertificateSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Save Certificate' }));

    expect(await screen.findByRole('button', { name: 'Send invoice & hold certificate' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Charge .*1111/ })).toBeNull();
  });

  it('retries closeout after payment without charging or delivering twice', async () => {
    const onCreated = vi.fn();
    let closeAttempts = 0;
    vi.stubGlobal('fetch', vi.fn((url, opts = {}) => {
      const u = String(url);
      if (u.includes('/admin/projects/types')) return jsonResponse({ types: PROJECT_TYPES });
      if (u.includes('/estimates-summary')) return jsonResponse({ customer: customerPayload, estimates: [] });
      if (u.includes('/admin/customers/9/cards')) {
        return jsonResponse({ cards: [{ id: 'pm-card', method_type: 'card', brand: 'visa', last_four: '4242' }] });
      }
      if (u.includes('/admin/projects/scheduled-service/55/application-prefill')) return jsonResponse({ applications: [] });
      if (/\/admin\/projects$/.test(u) && opts.method === 'POST') {
        return jsonResponse({ project: { id: 'cert-1', project_type: 'pre_treatment_termite_certificate' } });
      }
      if (u.includes('/admin/projects/cert-1/send-with-invoice')) {
        const body = JSON.parse(opts.body || '{}');
        if (body.prepare_invoice) {
          return jsonResponse({ prepared: true, invoice: { id: 'inv-card', total: 425, payer_billed: false } });
        }
      }
      if (u.includes('/admin/invoices/inv-card/charge-card-quote')) {
        return jsonResponse({ quote: { base: 425, surcharge: 12.33, total: 437.33, rateBps: 290, funding: 'credit' } });
      }
      if (u.endsWith('/admin/invoices/inv-card/charge-card')) return jsonResponse({ ok: true });
      if (u.endsWith('/admin/projects/cert-1/send')) return jsonResponse({ sent: true });
      if (u.includes('/admin/projects/cert-1/close')) {
        closeAttempts += 1;
        if (closeAttempts === 1) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ error: 'Temporary closeout failure' }),
          });
        }
        return jsonResponse({ project: { id: 'cert-1', project_type: 'pre_treatment_termite_certificate', status: 'closed' } });
      }
      return jsonResponse({});
    }));

    renderCertificateSheet({ onCreated });
    fireEvent.click(await screen.findByRole('button', { name: 'Save Certificate' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Charge Visa •••• 4242 & finish service' }));

    expect(await screen.findByText('Temporary closeout failure')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Finish service' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/charge-card'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/admin/projects/cert-1/send'))).toHaveLength(1);
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/admin/projects/cert-1/close'))).toHaveLength(2);
  });
});

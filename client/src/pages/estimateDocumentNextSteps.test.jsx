// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ACCEPT_MODE_LABELS, NextSteps, acceptanceModeOf, resolveDocNextSteps } from './estimateDocumentNextSteps';

const URL_ = 'https://portal.wavespestcontrol.com/estimate/tok-1';

describe('acceptanceModeOf', () => {
  it('reads estimate.acceptance.mode and defaults to the standard slot pick', () => {
    expect(acceptanceModeOf({ estimate: { acceptance: { mode: 'invoice_only' } } })).toBe('invoice_only');
    expect(acceptanceModeOf({ estimate: {} })).toBe('standard_slot_pick');
    expect(acceptanceModeOf({ estimate: { acceptance: { mode: '' } } })).toBe('standard_slot_pick');
    expect(acceptanceModeOf(null)).toBe('standard_slot_pick');
    // The accepted-terms record (data.acceptance) is a different object.
    expect(acceptanceModeOf({ acceptance: { mode: 'contact_office' }, estimate: {} })).toBe('standard_slot_pick');
  });
});

describe('resolveDocNextSteps', () => {
  const resolve = (input) => resolveDocNextSteps(input);

  it.each([
    ['standard_slot_pick', 'accepted_visit', 'See your visit details'],
    ['existing_appointment', 'accepted_visit', 'See your visit details'],
    ['invoice_only', 'accepted_neutral', 'View your estimate'],
    ['contact_office', 'accepted_neutral', 'View your estimate'],
    ['commercial_site_confirmation', 'accepted_neutral', 'View your estimate'],
    ['quote_required', 'accepted_neutral', 'View your estimate'],
  ])('accepted + %s', (acceptanceMode, variant, primaryLabel) => {
    expect(resolve({ cta: { terminalState: 'accepted' }, acceptanceMode })).toEqual({ variant, primaryLabel });
  });

  it('declined and expired: their own text, no action button, whatever the mode', () => {
    for (const mode of ['standard_slot_pick', 'invoice_only', 'contact_office']) {
      expect(resolve({ cta: { terminalState: 'declined' }, acceptanceMode: mode })).toEqual({ variant: 'declined', primaryLabel: null });
      expect(resolve({ cta: { terminalState: 'expired' }, acceptanceMode: mode })).toEqual({ variant: 'expired', primaryLabel: null });
    }
  });

  it('terminal states outrank an authored proposal, which outranks quote/review gating, which outranks the mode', () => {
    expect(resolve({ cta: { terminalState: 'accepted' }, authoredProposal: true }).variant).toBe('accepted_visit');
    expect(resolve({ authoredProposal: true, cta: { quoteRequired: true }, acceptanceMode: 'invoice_only' }))
      .toEqual({ variant: 'authored', primaryLabel: 'View estimate online' });
    expect(resolve({ cta: { quoteRequired: true }, acceptanceMode: 'invoice_only' }))
      .toEqual({ variant: 'team_confirms', primaryLabel: 'View estimate online' });
    expect(resolve({ cta: { reviewBeforeBooking: true }, acceptanceMode: 'standard_slot_pick' }).variant).toBe('team_confirms');
  });

  it.each(Object.keys(ACCEPT_MODE_LABELS))('open + %s: go ahead with that mode\'s label', (mode) => {
    expect(resolve({ acceptanceMode: mode })).toEqual({ variant: 'go_ahead', primaryLabel: ACCEPT_MODE_LABELS[mode] });
  });

  it('modes with no online accept: contact_office has its own text, the rest hand off to the team; neither gets a button', () => {
    expect(resolve({ acceptanceMode: 'contact_office' })).toEqual({ variant: 'contact_office', primaryLabel: null });
    for (const mode of ['quote_required', 'inspection_request', 'some_future_mode']) {
      expect(resolve({ acceptanceMode: mode })).toEqual({ variant: 'team_confirms', primaryLabel: null });
    }
  });

  it('with no input at all it is the standard open estimate', () => {
    expect(resolve()).toEqual({ variant: 'go_ahead', primaryLabel: 'Accept & pick a start date' });
  });
});

describe('NextSteps', () => {
  const text = (props) => {
    const { container } = render(<NextSteps estimateUrl={URL_} estimateNumber="EST-1" {...props} />);
    return { container, text: container.textContent };
  };

  it('every paragraph is 14px and the valid-through line only shows on an open estimate', () => {
    const open = text({ validThroughText: 'September 6, 2026' });
    const ps = [...open.container.querySelectorAll('p')];
    expect(ps).toHaveLength(2);
    expect(ps.every((p) => p.style.fontSize === '14px')).toBe(true);
    expect(open.container.querySelector('[data-testid="doc-valid-through-line"]').textContent).toBe('Price valid through September 6, 2026.');
    expect(text({ cta: { terminalState: 'accepted' }, validThroughText: 'September 6, 2026' }).container.querySelector('[data-testid="doc-valid-through-line"]')).toBeNull();
  });

  it('the accepted wording differs by mode and always links to the estimate', () => {
    const visit = text({ cta: { terminalState: 'accepted' }, acceptanceMode: 'existing_appointment' });
    const neutral = text({ cta: { terminalState: 'accepted' }, acceptanceMode: 'invoice_only' });
    expect(visit.text).toContain('has your visit details');
    expect(neutral.text).toContain('has the details');
    expect(neutral.text).not.toContain('visit details');
    expect(neutral.container.querySelector(`a[href="${URL_}"]`)).not.toBeNull();
  });

  it('the go-ahead sentence names the mode\'s label and promises nothing the mode does not', () => {
    const invoice = text({ acceptanceMode: 'invoice_only' });
    expect(invoice.text).toContain('tap Accept + send invoice above');
    expect(invoice.text).not.toMatch(/start date/);
    expect(text({ acceptanceMode: 'standard_slot_pick' }).text).toContain('pick a start date with you');
  });
});

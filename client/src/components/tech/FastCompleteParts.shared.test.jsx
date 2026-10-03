// @vitest-environment jsdom
// The Fast Complete building blocks every sheet shares live in
// FastCompleteParts.jsx and hooks/useFastCompleteSubmit.js; the pest sheet
// still re-exports what other files imported from it. A pure-move guard for
// the lawn Fast Complete sheet to build on.
import React from 'react';
import { afterEach, describe, it, expect } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import * as Parts from './FastCompleteParts';
import * as Sheet from './FastCompleteSheet';
import useFastCompleteSubmit, * as Submit from '../../hooks/useFastCompleteSubmit';

const PARTS = [
  'Chip', 'ChoiceSection', 'VisitNote', 'TipSection', 'useTipLibrary', 'techTipsOf', 'toggleInSet',
  'FastCompleteFrame', 'SheetHeader', 'SavedView', 'CompleteFooter', 'AmountEntry', 'OtherProductButton', 'useProductPicker',
  'visitChangedSinceSchedule', 'customerNameOf', 'CLOSED_VISIT_STATUSES',
  'AmountRow', 'ProductTileButton', 'usePhotoManager', 'withFreshStock', 'isSendableRateUnit', 'methodLabel', 'unitLabel',
];

describe('Fast Complete shared parts', () => {
  afterEach(cleanup);

  it.each(PARTS)('FastCompleteParts exports %s', (name) => {
    expect(Parts[name]).toBeDefined();
  });

  it('exports the submit hook and its failure helpers', () => {
    expect(typeof useFastCompleteSubmit).toBe('function');
    expect(typeof Submit.completionFailureOutcome).toBe('function');
    expect(typeof Submit.outcomeMessage).toBe('function');
    expect(typeof Submit.genIdempotencyKey).toBe('function');
  });

  it('keeps the pest sheet import path for isSendableRateUnit', () => {
    expect(Sheet.isSendableRateUnit).toBe(Parts.isSendableRateUnit);
    expect(Sheet.isSendableRateUnit('Fl_Oz ')).toBe(true);
    expect(Sheet.isSendableRateUnit('ml')).toBe(false);
    expect(Sheet.isSendableRateUnit('percent_solution')).toBe(false);
  });

  it('classifies failures into the four outcomes', () => {
    const { completionFailureOutcome } = Submit;
    expect(completionFailureOutcome({ status: 409, code: 'service_already_completed' })).toBe('saved');
    expect(completionFailureOutcome({ status: 500 })).toBe('retry');
    expect(completionFailureOutcome({ status: 409, code: 'report_rules_review' })).toBe('terminal');
    expect(completionFailureOutcome({ status: 409, code: 'report_rules_review' }, { confirmable: true })).toBe('confirm');
  });

  it('names methods the way the sheets did', () => {
    expect(Parts.methodLabel('granular_broadcast')).toBe('Granular broadcast');
    expect(Parts.unitLabel('fl_oz')).toBe('fl oz');
  });

  it('renders a product tile with the stock flag and its aria props', () => {
    const row = { name: 'Taurus SC', active: true, added: false, product: { inventory_on_hand: 0, inventory_unit: 'oz' } };
    render(<Parts.ProductTileButton row={row} detail="4 fl oz" ariaProps={{ 'aria-pressed': true }} onClick={() => {}} />);
    const tile = screen.getByRole('button', { name: /Taurus SC/ });
    expect(tile.getAttribute('aria-pressed')).toBe('true');
    expect(tile.className).toContain('tech-visit-product--stock');
    expect(tile.textContent).toContain('4 fl oz');
    expect(tile.textContent).toContain('0 in stock');
  });
});

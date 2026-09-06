// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DispatchReadinessStrip from './DispatchReadinessStrip';
afterEach(cleanup);

describe('dispatch readiness', () => {
  it('opens the existing Job Card without invoking the appointment or drag action', () => {
    const open = vi.fn();
    const edit = vi.fn();
    const drag = vi.fn();
    render(<div onClick={edit} onPointerDown={drag}>
      <DispatchReadinessStrip readiness={{ issues: [{ status: 'hold', label: 'Weather hold' }, { status: 'unknown', label: 'Stock unverified' }] }} onOpen={open} />
    </div>);
    const button = screen.getByRole('button', { name: /Weather hold.*Stock unverified.*Open Job Card/ });
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(open).toHaveBeenCalledOnce();
    expect(edit).not.toHaveBeenCalled();
    expect(drag).not.toHaveBeenCalled();
  });

  it('preserves the full accessible warning on a short appointment', () => {
    render(<DispatchReadinessStrip readiness={{ issues: [{ status: 'hold', label: 'Company stock short' }] }} onOpen={() => {}} compact iconOnly />);
    const button = screen.getByRole('button', { name: 'Company stock short. Open Job Card' });
    expect(button.title).toContain('Company stock is not a truck count');
  });

  it('never turns an empty exception list into application clearance', () => {
    render(<DispatchReadinessStrip readiness={{ issues: [] }} onOpen={() => {}} />);
    expect(screen.getByRole('button').textContent).toBe('View Job Card');
  });

  it('renders missing evidence as a neutral unknown', () => {
    render(<DispatchReadinessStrip readiness={{ issues: [{ status: 'unknown', label: 'Weather unknown' }] }} onOpen={() => {}} />);
    const button = screen.getByRole('button', { name: 'Weather unknown. Open Job Card' });
    expect(button.className).not.toContain('text-alert-fg');
    expect(button.querySelector('svg')).not.toBeNull();
  });
});

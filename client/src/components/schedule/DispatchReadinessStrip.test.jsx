// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DispatchReadinessStrip from './DispatchReadinessStrip';
afterEach(cleanup);

describe('dispatch readiness', () => {
  it('opens the existing Job Card without invoking the appointment or drag action', () => {
    let focusedAtOpen = null;
    const open = vi.fn(() => { focusedAtOpen = document.activeElement; });
    const edit = vi.fn();
    const drag = vi.fn();
    render(<div onClick={edit} onPointerDown={drag}>
      <DispatchReadinessStrip readiness={{ issues: [{ status: 'hold', label: 'Weather hold' }, { status: 'unknown', label: 'Stock unverified' }] }} onOpen={open} />
    </div>);
    const button = screen.getByRole('button', { name: /Weather hold.*Stock unverified.*Open Job Card/ });
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(open).toHaveBeenCalledOnce();
    expect(focusedAtOpen).toBe(button);
    expect(edit).not.toHaveBeenCalled();
    expect(drag).not.toHaveBeenCalled();
  });

  it('preserves the full accessible warning on a short appointment', () => {
    render(<DispatchReadinessStrip readiness={{ issues: [{ status: 'hold', label: 'Company stock short' }] }} onOpen={() => {}} compact iconOnly />);
    const button = screen.getByRole('button', { name: 'Company stock short. Open Job Card' });
    expect(button.title).toContain('Company stock is not a truck count');
  });

  // Truck kit (GATE_TRUCK_KIT): the tools exception from services/truck-kit.js
  // is a hold like stock or weather; the strip derives its state from the
  // issue list alone, so an appended hold reads as a hold.
  it('shows a missing truck tool as a hold', () => {
    render(<DispatchReadinessStrip readiness={{ issues: [{ kind: 'tools', status: 'hold', label: 'Truck lacks Moisture meter' }] }} onOpen={() => {}} />);
    const button = screen.getByRole('button', { name: 'Truck lacks Moisture meter. Open Job Card' });
    expect(button.className).toContain('text-alert-fg');
  });

  it('never turns an empty exception list into application clearance', () => {
    render(<DispatchReadinessStrip readiness={{ issues: [] }} onOpen={() => {}} />);
    expect(screen.getByRole('button').textContent).toBe('View Job Card');
  });

  // GATE_SPRAY_RAIN_RULES: a rain caution keeps the dose, so it is not a hold: neutral, with a rain icon.
  it('renders a rain caution neutral, with a rain icon', () => {
    render(<DispatchReadinessStrip readiness={{ issues: [{ kind: 'weather', status: 'caution', label: 'Rain likely 2 pm · label: no spraying in rain' }] }} onOpen={() => {}} />);
    const button = screen.getByRole('button', { name: 'Rain likely 2 pm · label: no spraying in rain. Open Job Card' });
    expect(button.className).not.toContain('text-alert-fg');
    expect(button.querySelector('svg').getAttribute('class')).toContain('cloud-rain');
  });

  it('renders missing evidence as a neutral unknown', () => {
    render(<DispatchReadinessStrip readiness={{ issues: [{ status: 'unknown', label: 'Weather unknown' }] }} onOpen={() => {}} />);
    const button = screen.getByRole('button', { name: 'Weather unknown. Open Job Card' });
    expect(button.className).not.toContain('text-alert-fg');
    expect(button.querySelector('svg')).not.toBeNull();
  });
});

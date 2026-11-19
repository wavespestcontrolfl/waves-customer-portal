// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import SprinklerTimerCard from './SprinklerTimerCard';

afterEach(cleanup);

it('records a Hunter model as one change: brand, model and a cleared app answer', () => {
  const onChange = vi.fn();
  render(<SprinklerTimerCard onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: /^X2/ }));
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(onChange).toHaveBeenCalledWith({ irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: null });
});

it('records a Rain Bird with no model', () => {
  const onChange = vi.fn();
  render(<SprinklerTimerCard onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Rain Bird' }));
  fireEvent.click(screen.getByRole('button', { name: 'My timer is a Rain Bird' }));
  expect(onChange).toHaveBeenCalledWith({ irrigationControllerBrand: 'rain_bird', irrigationControllerModel: null, irrigationControllerApp: null });
});

it('shows the timer on file with its guide and saves the phone-app answer alone', () => {
  const onChange = vi.fn();
  render(<SprinklerTimerCard brand="hunter" model="x2" app="no" onChange={onChange} />);
  expect(screen.getByText('Hunter X2')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'How to run it on a Hunter' })).toHaveAttribute('href', 'https://www.wavespestcontrol.com/sprinkler-timers/hunter/');
  expect(screen.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
  expect(onChange).toHaveBeenCalledWith({ irrigationControllerApp: 'yes' });
});

it('asks no phone-app question for a timer that has no app, or for another brand', () => {
  const { rerender } = render(<SprinklerTimerCard brand="hunter" model="x_core" onChange={vi.fn()} />);
  expect(screen.getByText('Hunter X-Core')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Not sure' })).not.toBeInTheDocument();
  rerender(<SprinklerTimerCard brand="other" onChange={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Not sure' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'See our timer guides' })).toHaveAttribute('href', 'https://www.wavespestcontrol.com/sprinkler-timers/');
});

it('asks a Rain Bird owner about the Rain Bird app', () => {
  render(<SprinklerTimerCard brand="rain_bird" onChange={vi.fn()} />);
  expect(screen.getByText('Do you run it from the Rain Bird phone app?')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'How to run it on a Rain Bird' })).toHaveAttribute('href', 'https://www.wavespestcontrol.com/sprinkler-timers/rain-bird/');
});

it('keeps the timer on file when the customer backs out of a change, or picks the same one', () => {
  const onChange = vi.fn();
  render(<SprinklerTimerCard brand="hunter" model="x2" app="yes" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Change my timer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep my timer' }));
  expect(screen.getByText('Hunter X2')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Change my timer' }));
  fireEvent.click(screen.getByRole('button', { name: /^X2/ }));
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Yes' })).toHaveAttribute('aria-pressed', 'true');
});

it('opens the model list for a Hunter that staff recorded without a model', () => {
  render(<SprinklerTimerCard brand="hunter" onChange={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Hunter' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /^Pro-C/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Keep my timer' })).not.toBeInTheDocument();
});

it('never says the portal connects to, pauses or starts a timer', () => {
  const states = [{}, { brand: 'hunter', model: 'x2' }, { brand: 'hunter', model: 'hydrawise', app: 'yes' }, { brand: 'rain_bird' }, { brand: 'other' }];
  for (const state of states) {
    const { container, unmount } = render(<SprinklerTimerCard {...state} onChange={vi.fn()} />);
    expect(container.textContent).not.toMatch(/connect|pause|we'll (run|start|water)|Wi-Fi|module/i);
    unmount();
  }
});

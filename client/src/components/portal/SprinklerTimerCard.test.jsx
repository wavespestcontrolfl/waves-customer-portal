// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CONTROLLER_MODELS, controllerAsksAboutApp } from '@waves/irrigation-runtime';
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

it('shows the timer on file with its guide, and a phone-app answer saves with the timer it was given for', () => {
  const onChange = vi.fn();
  const { rerender } = render(<SprinklerTimerCard brand="hunter" model="x2" app="no" onChange={onChange} />);
  expect(screen.getByText('Hunter X2')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'How to run it on a Hunter' })).toHaveAttribute('href', 'https://www.wavespestcontrol.com/sprinkler-timers/hunter/');
  expect(screen.getByRole('button', { name: 'No' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
  expect(onChange).toHaveBeenLastCalledWith({ irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: 'yes' });
  // Tapping the chosen answer again takes it back; a Rain Bird has no model to send.
  fireEvent.click(screen.getByRole('button', { name: 'No' }));
  expect(onChange).toHaveBeenLastCalledWith({ irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: null });
  rerender(<SprinklerTimerCard brand="rain_bird" model={null} app={null} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Not sure' }));
  expect(onChange).toHaveBeenLastCalledWith({ irrigationControllerBrand: 'rain_bird', irrigationControllerModel: null, irrigationControllerApp: 'unknown' });
});

it('asks the phone-app question for exactly the timers the server takes an answer for', () => {
  const timers = [...Object.keys(CONTROLLER_MODELS).map((model) => ['hunter', model]), ['rain_bird', null], ['other', null]];
  for (const [brand, model] of timers) {
    const { unmount } = render(<SprinklerTimerCard brand={brand} model={model} onChange={vi.fn()} />);
    expect(!!screen.queryByRole('button', { name: 'Not sure' })).toBe(controllerAsksAboutApp(brand, model));
    unmount();
  }
});

it('says why when the server refused the timer, and makes no claim about the save otherwise', () => {
  const { rerender } = render(<SprinklerTimerCard brand="hunter" model="x2" error="The home on this account changed. Reload, then set the sprinkler timer again." onChange={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent('We could not save your timer. The home on this account changed.');
  rerender(<SprinklerTimerCard brand="hunter" model="x2" onChange={vi.fn()} />);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  // The tab's save banner reports saves; the card cannot know the server's state across queued saves and retries.
  expect(screen.queryByText(/on file|saved/i)).not.toBeInTheDocument();
});

it('asks no phone-app question for a timer that has no app, or for another brand', () => {
  const { rerender } = render(<SprinklerTimerCard brand="hunter" model="x_core" onChange={vi.fn()} />);
  expect(screen.getByText('Hunter X-Core')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Not sure' })).not.toBeInTheDocument();
  rerender(<SprinklerTimerCard brand="other" onChange={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Not sure' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'See the Waves timer guides' })).toHaveAttribute('href', 'https://www.wavespestcontrol.com/sprinkler-timers/');
});

it('asks a Rain Bird owner about the Rain Bird app', () => {
  render(<SprinklerTimerCard brand="rain_bird" onChange={vi.fn()} />);
  expect(screen.getByText('Do you run it from the Rain Bird phone app?')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'How to run it on a Rain Bird' })).toHaveAttribute('href', 'https://www.wavespestcontrol.com/sprinkler-timers/rain-bird/');
});

it('keeps the timer when the customer backs out, and picking the same timer sends it again with its answer', () => {
  const onChange = vi.fn();
  render(<SprinklerTimerCard brand="hunter" model="x2" app="yes" onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Change my timer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Keep my timer' }));
  expect(screen.getByText('Hunter X2')).toBeInTheDocument();
  expect(onChange).not.toHaveBeenCalled();
  // The same timer again is the retry after a failed save: it keeps its answer.
  fireEvent.click(screen.getByRole('button', { name: 'Change my timer' }));
  fireEvent.click(screen.getByRole('button', { name: /^X2/ }));
  expect(onChange).toHaveBeenCalledWith({ irrigationControllerBrand: 'hunter', irrigationControllerModel: 'x2', irrigationControllerApp: 'yes' });
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

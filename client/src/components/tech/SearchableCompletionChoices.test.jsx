// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SearchableCompletionChoices from './SearchableCompletionChoices';
import useModalFocus from '../../hooks/useModalFocus';

afterEach(cleanup);

const OPTIONS = [
  {
    id: 'canopy',
    label: 'Monitor canopy response',
    group: 'Palms',
    detail: 'Review new growth next visit',
    keywords: ['fronds', 'yellowing'],
  },
  {
    id: 'irrigation',
    label: 'Check irrigation coverage',
    group: 'Water',
    detail: 'Confirm coverage in the affected bed',
    keywords: ['dry', 'sprinklers'],
  },
];

function ControlledChoices({ initialValues = [], onValueChange = vi.fn(), ...props }) {
  const [values, setValues] = useState(initialValues);
  return (
    <SearchableCompletionChoices
      label="Recommendations"
      options={OPTIONS}
      values={values}
      onChange={(next) => {
        onValueChange(next);
        setValues(next);
      }}
      {...props}
    />
  );
}

describe('SearchableCompletionChoices', () => {
  it('preserves modal Escape for ordinary static listboxes', () => {
    const close = vi.fn();
    function Dialog() {
      const ref = useModalFocus(true, close);
      return <div role="dialog" ref={ref}><div role="listbox"><button role="option">Calendar day</button></div></div>;
    }
    render(<Dialog />);
    fireEvent.keyDown(screen.getByRole('option'), { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the choices before allowing Escape to close the containing dialog', () => {
    const close = vi.fn();
    function Dialog() {
      const ref = useModalFocus(true, close);
      return <div role="dialog" ref={ref}><ControlledChoices /></div>;
    }
    render(<Dialog />);
    const search = screen.getByRole('combobox', { name: 'Search recommendations' });
    fireEvent.focus(search);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const option = screen.getAllByRole('option')[0];
    expect(option).toHaveFocus();
    fireEvent.keyDown(option, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(search).toHaveFocus();

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[0]).toHaveFocus();
    fireEvent.keyDown(screen.getAllByRole('option')[0], { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(search).toHaveAttribute('aria-expanded', 'false');
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('filters by labels, details, groups, and keywords without auto-selecting a result', () => {
    const onChange = vi.fn();
    render(<ControlledChoices onValueChange={onChange} allowCustom={false} />);

    const search = screen.getByRole('combobox', { name: 'Search recommendations' });
    fireEvent.focus(search);
    expect(screen.getAllByRole('option')).toHaveLength(2);

    fireEvent.change(search, { target: { value: 'yellowing palms' } });
    expect(screen.getByRole('option', { name: /Monitor canopy response/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Check irrigation coverage/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Selected recommendations')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(search, { target: { value: 'bed affected' } });
    expect(screen.getByRole('option', { name: /Check irrigation coverage/ })).toBeInTheDocument();
  });

  it('moves through options with Arrow keys, Home, and End while leaving Enter to the button', () => {
    const onChange = vi.fn();
    const options = [
      { label: 'First choice' },
      { label: 'Second choice' },
      { label: 'Third choice' },
      { label: 'Fourth choice' },
    ];
    render(<ControlledChoices options={options} onValueChange={onChange} allowCustom={false} />);

    const search = screen.getByRole('combobox', { name: 'Search recommendations' });
    search.focus();
    expect(fireEvent.keyDown(search, { key: 'Home' })).toBe(true);
    expect(fireEvent.keyDown(search, { key: 'End' })).toBe(true);
    expect(search).toHaveFocus();

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const choices = screen.getAllByRole('option');
    expect(choices[0]).toHaveFocus();
    fireEvent.keyDown(choices[0], { key: 'ArrowDown' });
    expect(choices[1]).toHaveFocus();
    fireEvent.keyDown(choices[1], { key: 'End' });
    expect(choices[3]).toHaveFocus();
    fireEvent.keyDown(choices[3], { key: 'ArrowDown' });
    expect(choices[3]).toHaveFocus();
    fireEvent.keyDown(choices[3], { key: 'Home' });
    expect(choices[0]).toHaveFocus();
    fireEvent.keyDown(choices[0], { key: 'ArrowUp' });
    expect(choices[0]).toHaveFocus();

    expect(fireEvent.keyDown(choices[0], { key: 'Enter' })).toBe(true);
    fireEvent.click(choices[0]);
    expect(onChange).toHaveBeenLastCalledWith(['First choice']);
  });

  it('skips disabled options when navigating the list', () => {
    const options = [
      { label: 'Selected first' },
      { label: 'Blocked middle' },
      { label: 'Selected last' },
    ];
    render(
      <ControlledChoices
        options={options}
        initialValues={['Selected first', 'Selected last']}
        maxSelections={2}
        allowCustom={false}
      />,
    );

    const search = screen.getByRole('combobox', { name: 'Search recommendations' });
    fireEvent.focus(search);
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    const first = screen.getByRole('option', { name: /Selected first/ });
    const blocked = screen.getByRole('option', { name: /Blocked middle/ });
    const last = screen.getByRole('option', { name: /Selected last/ });
    expect(first).toHaveFocus();
    expect(blocked).toBeDisabled();

    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'ArrowUp' });
    expect(first).toHaveFocus();
  });

  it('selects and removes a suggested entry only through explicit taps', () => {
    const onChange = vi.fn();
    render(<ControlledChoices onValueChange={onChange} />);

    const search = screen.getByRole('combobox', { name: 'Search recommendations' });
    fireEvent.focus(search);
    fireEvent.click(screen.getByRole('option', { name: /Monitor canopy response/ }));

    expect(onChange).toHaveBeenLastCalledWith(['Monitor canopy response']);
    expect(screen.getByLabelText('Selected recommendations')).toHaveTextContent('Monitor canopy response');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Monitor canopy response' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(screen.queryByLabelText('Selected recommendations')).not.toBeInTheDocument();
  });

  it('adds a custom entry with Enter and does not add it when the selection limit is reached', () => {
    const onChange = vi.fn();
    render(<ControlledChoices onValueChange={onChange} />);
    const search = screen.getByRole('combobox', { name: 'Search recommendations' });

    fireEvent.change(search, { target: { value: 'Inspect the irrigation timer' } });
    expect(screen.getByRole('option', { name: 'Add “Inspect the irrigation timer”' })).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['Inspect the irrigation timer']);
    expect(screen.getByLabelText('Selected recommendations')).toHaveTextContent('Inspect the irrigation timer');

    cleanup();
    const atLimit = vi.fn();
    render(<ControlledChoices initialValues={['Monitor canopy response']} onValueChange={atLimit} maxSelections={1} />);
    const limitedSearch = screen.getByRole('combobox', { name: 'Search recommendations' });
    fireEvent.change(limitedSearch, { target: { value: 'Another recommendation' } });
    expect(screen.getByRole('option', { name: 'Add “Another recommendation”' })).toBeDisabled();
    fireEvent.keyDown(limitedSearch, { key: 'Enter' });
    expect(atLimit).not.toHaveBeenCalled();
    expect(screen.getByText('Up to 1 selections.')).toBeInTheDocument();
  });

  it('supports keyboard entry into the option list and Escape, while disabled controls stay inert', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SearchableCompletionChoices
        label="Recommendations"
        options={OPTIONS}
        values={['Monitor canopy response']}
        onChange={onChange}
        maxSelections={1}
      />,
    );
    const search = screen.getByRole('combobox', { name: 'Search recommendations' });
    fireEvent.focus(search);
    const selectedOption = screen.getByRole('option', { name: /Monitor canopy response/ });
    const blockedOption = screen.getByRole('option', { name: /Check irrigation coverage/ });
    expect(blockedOption).toBeDisabled();

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(selectedOption);
    fireEvent.keyDown(selectedOption, { key: 'Escape' });
    expect(search).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <SearchableCompletionChoices
        label="Recommendations"
        options={OPTIONS}
        values={['Monitor canopy response']}
        onChange={onChange}
        disabled
      />,
    );
    expect(screen.getByRole('combobox', { name: 'Search recommendations' })).toBeDisabled();
    const remove = screen.getByRole('button', { name: 'Remove Monitor canopy response' });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(onChange).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom
import React, { useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';
import { Sheet } from './Sheet';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

describe('shared overlay click boundaries', () => {
  it.each([Dialog, Sheet])('%s keeps internal and backdrop clicks inside its boundary', (Overlay) => {
    const ancestor = vi.fn(), close = vi.fn(), action = vi.fn();
    render(
      <div onClick={ancestor}>
        <Overlay open onClose={close} aria-label="Task" ariaLabel="Task">
          <button onClick={action}>Act</button>
        </Overlay>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Act' }));
    expect(action).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('dialog', { name: 'Task' }).firstChild);
    expect(close).toHaveBeenCalledTimes(1);
    expect(ancestor).not.toHaveBeenCalled();
  });

  it.each([[Dialog, Sheet], [Sheet, Dialog]])('keeps nested overlay actions, closing and focus scoped to the top overlay', (Parent, Child) => {
    const ancestor = vi.fn();
    function Task() {
      const [open, setOpen] = useState(false);
      return <div onClick={ancestor}>
        <Parent open onClose={ancestor} aria-label="Parent" ariaLabel="Parent">
          <button onClick={() => setOpen(true)}>Open child</button>
          <Child open={open} onClose={() => setOpen(false)} layer={130} aria-label="Child" ariaLabel="Child">
            <button>Child action</button>
          </Child>
        </Parent>
      </div>;
    }
    render(<Task />);
    const trigger = screen.getByRole('button', { name: 'Open child' });
    trigger.focus();
    fireEvent.click(trigger);
    const child = screen.getByRole('dialog', { name: 'Child' });
    fireEvent.click(within(child).getByRole('button', { name: 'Child action' }));
    fireEvent.click(child.firstChild);
    expect(screen.queryByRole('dialog', { name: 'Child' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Parent' })).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.body).toHaveStyle({ overflow: 'hidden' });
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Child' })).not.toBeInTheDocument();
    expect(ancestor).not.toHaveBeenCalled();
  });
});

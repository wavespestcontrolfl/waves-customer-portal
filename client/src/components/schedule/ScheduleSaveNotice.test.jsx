// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ScheduleSaveNotice, { showScheduleSaveNotice } from './ScheduleSaveNotice';

afterEach(cleanup);

describe('ScheduleSaveNotice', () => {
  it('keeps every save event, including two with identical text, until dismissed (Codex #4091 P2)', () => {
    render(<ScheduleSaveNotice />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => {
      showScheduleSaveNotice('Moved.\n\nOverlaps another visit at 9:00.');
      showScheduleSaveNotice('Moved.\n\nOverlaps another visit at 9:00.');
      showScheduleSaveNotice('Saved.');
    });
    const notices = screen.getByRole('status').querySelectorAll('p');
    expect(notices).toHaveLength(3);
    expect([...notices].map((p) => p.textContent)).toEqual([
      'Moved.\n\nOverlaps another visit at 9:00.', 'Moved.\n\nOverlaps another visit at 9:00.', 'Saved.',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notices' }));
    expect(screen.queryByRole('status')).toBeNull();
    act(() => showScheduleSaveNotice('Saved.'));
    expect(screen.getByRole('status').querySelectorAll('p')).toHaveLength(1);
  });
});

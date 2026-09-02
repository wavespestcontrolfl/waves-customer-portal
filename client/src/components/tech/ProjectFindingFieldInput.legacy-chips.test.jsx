// @vitest-environment jsdom
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import ProjectFindingFieldInput from './ProjectFindingFieldInput';

describe('legacy chip values', () => {
  test('an off-list stored treatment area remains visible and removable', () => {
    const onChange = vi.fn();
    render(
      <ProjectFindingFieldInput
        field={{ key: 'areas_treated', type: 'chips', options: ['Foundation perimeter'] }}
        id="areas-treated"
        name="areas_treated"
        value="Garage slab"
        onChange={onChange}
      />,
    );

    const legacy = screen.getByRole('button', { name: 'Remove legacy value Garage slab' });
    expect(legacy.textContent).toContain('Garage slab');
    fireEvent.click(legacy);
    expect(onChange).toHaveBeenCalledWith('');
  });
});

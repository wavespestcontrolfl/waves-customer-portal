// @vitest-environment jsdom
import React from 'react';
import { render } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

// Server dictation (GATE_SERVER_DICTATION) spells the customer's name from the
// record ids the mic sends; a finding field that dropped them would transcribe
// with no customer in the word list.
const micProps = vi.hoisted(() => []);
vi.mock('./DictationButton', () => ({
  default: (props) => {
    micProps.push(props);
    return null;
  },
}));

import ProjectFindingFieldInput from './ProjectFindingFieldInput';

const CONTEXT = { customerId: '11111111-1111-4111-8111-111111111111', serviceId: '22222222-2222-4222-8222-222222222222' };

describe('finding field mic context', () => {
  test.each([
    ['textarea', { key: 'notes', type: 'textarea' }],
    ['text', { key: 'location', type: 'text' }],
  ])('a %s field forwards the record context to its mic', (_label, field) => {
    micProps.length = 0;
    render(<ProjectFindingFieldInput field={field} id="f" name="f" value="" onChange={vi.fn()} dictationContext={CONTEXT} />);
    expect(micProps.length).toBeGreaterThan(0);
    expect(micProps.at(-1).dictationContext).toEqual(CONTEXT);
  });
});

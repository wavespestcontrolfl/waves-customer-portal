// @vitest-environment jsdom
// A mic (the recommendations box or a finding field) still recording or transcribing holds
// Save: the words are on the way, so the save must not read the fields without them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { setDictationPending } from '../../hooks/dictationPending';

vi.mock('./WdoIntelligenceBar', () => ({ default: () => null }));
vi.mock('./DictationButton', () => ({ default: () => null }));
vi.mock('../AddressAutocomplete', () => ({ default: () => null }));
vi.mock('./WdoSignaturePad', () => ({ default: () => null }));

import CreateProjectModal from './CreateProjectModal';
import * as projectTypesModule from '../../../../server/services/project-types.js';

const PROJECT_TYPES = projectTypesModule.PROJECT_TYPES || projectTypesModule.default?.PROJECT_TYPES;
const json = (payload) => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) });

beforeEach(() => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  vi.stubGlobal('fetch', vi.fn((url) => {
    const u = String(url);
    if (u.includes('/admin/projects/types')) return json({ types: PROJECT_TYPES });
    if (u.includes('/estimates-summary')) return json({ customer: { id: 9, first_name: 'Test', last_name: 'Customer', phone: '+15555550100', address_line1: '1 Example St', city: 'Bradenton', state: 'FL', zip: '34212' }, estimates: [] });
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  setDictationPending('mic-under-test', false);
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('CreateProjectModal with a dictation in flight', () => {
  it('holds Save Report from the tap until the words land', async () => {
    render(
      <CreateProjectModal
        theme="light" presentation="sheet" defaultCustomerId="9" defaultCustomerLabel="Test Customer"
        defaultScheduledServiceId="55" defaultProjectDate="2026-07-16" defaultInspectionFee={175}
        defaultProjectType="wdo_inspection" allowedProjectTypes={['wdo_inspection']}
        onClose={() => {}} onCreated={() => {}}
      />,
    );
    const save = await screen.findByRole('button', { name: 'Save Report' });
    await waitFor(() => expect(save).toBeEnabled());
    act(() => setDictationPending('mic-under-test', true));
    expect(screen.getByRole('button', { name: 'Save Report' })).toBeDisabled();
    act(() => setDictationPending('mic-under-test', false));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save Report' })).toBeEnabled());
  });
});

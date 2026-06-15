// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/adminAuth', () => ({ getAdminAuthToken: () => 'test-token' }));

import TechLawnDiagnosticPage from './TechLawnDiagnosticPage';

afterEach(() => cleanup());

describe('TechLawnDiagnosticPage', () => {
  it('renders the capture step with analyze disabled until a photo is added', () => {
    render(<TechLawnDiagnosticPage />);
    expect(screen.getByRole('heading', { name: /lawn diagnostic/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add photo/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /analyze lawn/i })).toBeDisabled();
  });

  it('reveals prospect contact + address fields when expanded', () => {
    render(<TechLawnDiagnosticPage />);
    fireEvent.click(screen.getByRole('button', { name: /prospect details/i }));
    expect(screen.getByPlaceholderText('Name')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Email')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Street address')).toBeInTheDocument();
  });
});

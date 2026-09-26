// @vitest-environment jsdom
// "Want us to come look first?" section — renders ONLY from the server-
// composed `consultationOffer` field (consultation-first lane, owner ruling
// 2026-09-23). Every eligibility decision is server-side; this component
// makes none of its own.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ConsultationOfferSection } from './EstimateViewPage';

afterEach(() => cleanup());

describe('ConsultationOfferSection', () => {
  it('renders nothing without a consultationOffer', () => {
    const { container } = render(<ConsultationOfferSection consultationOffer={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the field has no url', () => {
    const { container } = render(<ConsultationOfferSection consultationOffer={{}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when url is an empty string (falsy, not just missing)', () => {
    const { container } = render(<ConsultationOfferSection consultationOffer={{ url: '' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when consultationOffer itself is undefined (prop omitted)', () => {
    const { container } = render(<ConsultationOfferSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the section and links to the server-provided url in a new tab', () => {
    render(<ConsultationOfferSection consultationOffer={{ url: 'https://portal.wavespestcontrol.com/inspection/abc.123.sig' }} />);
    expect(screen.getByText('Want us to come look first?')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Pick a time' });
    expect(link).toHaveAttribute('href', 'https://portal.wavespestcontrol.com/inspection/abc.123.sig');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('never claims a specific technician by name (sender voice is "Waves", never "Adam")', () => {
    render(<ConsultationOfferSection consultationOffer={{ url: 'https://portal.wavespestcontrol.com/inspection/abc.123.sig' }} />);
    expect(screen.queryByText(/\bAdam\b/)).not.toBeInTheDocument();
    expect(screen.getByText(/A Waves technician/)).toBeInTheDocument();
  });
});

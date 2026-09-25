// @vitest-environment jsdom
// PrepGuidePage block rendering: `list` blocks and inline markdown links
// ([label](url)) in paragraph / list-item / callout / details-row text.
// Covers the two things the email template library already supports that
// this public surface didn't (list blocks; inline links), plus the
// javascript: href rejection that keeps a payload-driven href inert.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../glass/glass-engine', () => ({ useGlassSurface: () => {} }));

import PrepGuidePage from './PrepGuidePage';

vi.mock('react-router-dom', () => ({
  useParams: () => ({ token: 'prep-token-1' }),
}));

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

const BASE_PAYLOAD = {
  customerFirstName: 'Pat',
  customerName: 'Pat Rivera',
  serviceContactNames: [],
  projectTypeLabel: 'Flea Control',
  serviceDate: 'Sep 30',
  propertyAddress: '123 Palm Ave, Bradenton, FL',
  technicianName: 'Adam',
  supportPhone: '(941) 555-0100',
  upcomingVisits: [],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PrepGuidePage block rendering', () => {
  it('renders list blocks and linkifies safe inline markdown links', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...BASE_PAYLOAD,
      blocks: [
        { type: 'paragraph', content: 'See our [prep checklist](https://wavespestcontrol.com/prep) before we arrive.' },
        {
          type: 'list',
          items: [
            'Remove pet bowls from the yard',
            '   ',
            'Clear access to the [garage](https://wavespestcontrol.com/garage)',
          ],
        },
        {
          type: 'details',
          rows: [{ label: 'Questions', value: 'Email [us](mailto:office@wavespestcontrol.com)' }],
        },
        { type: 'callout', content: 'Call [our office](tel:+19415550100) any time.' },
      ],
    })));

    render(<PrepGuidePage />);

    await waitFor(() => expect(screen.getByText(/Flea Control Prep Guide/i)).toBeInTheDocument());

    // Blank items drop (match the email renderer + PDF): two rows, not three.
    expect(screen.getAllByRole('listitem')).toHaveLength(2);

    // Paragraph link: safe https href, opens in a new tab, no opener leak.
    const checklistLink = screen.getByRole('link', { name: 'prep checklist' });
    expect(checklistLink).toHaveAttribute('href', 'https://wavespestcontrol.com/prep');
    expect(checklistLink).toHaveAttribute('target', '_blank');
    expect(checklistLink).toHaveAttribute('rel', 'noopener noreferrer');

    // List block renders as a real list with both items, second one linked.
    const list = screen.getByText('Remove pet bowls from the yard').closest('ul');
    expect(list).toBeTruthy();
    expect(list.querySelectorAll('li')).toHaveLength(2);
    const garageLink = screen.getByRole('link', { name: 'garage' });
    expect(garageLink).toHaveAttribute('href', 'https://wavespestcontrol.com/garage');

    // Details row value: mailto link.
    const mailLink = screen.getByRole('link', { name: 'us' });
    expect(mailLink).toHaveAttribute('href', 'mailto:office@wavespestcontrol.com');

    // Callout: tel link.
    const telLink = screen.getByRole('link', { name: 'our office' });
    expect(telLink).toHaveAttribute('href', 'tel:+19415550100');
  });

  it('refuses to linkify an unsafe href scheme, rendering the markdown as plain text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...BASE_PAYLOAD,
      blocks: [
        { type: 'callout', content: 'Unsafe: [click me](javascript:alert(1)) should never be live.' },
        { type: 'paragraph', content: 'Also unsafe: [data link](data:text/html,<script>1</script>) stays text.' },
      ],
    })));

    render(<PrepGuidePage />);

    await waitFor(() => expect(screen.getByText(/Flea Control Prep Guide/i)).toBeInTheDocument());

    expect(screen.queryByRole('link', { name: 'click me' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'data link' })).not.toBeInTheDocument();
    expect(screen.getByText(/\[click me\]\(javascript:alert\(1\)\)/)).toBeInTheDocument();
    expect(screen.getByText(/\[data link\]\(data:text\/html/)).toBeInTheDocument();
  });

  it('renders nothing for an empty list block and skips unknown block types', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      ...BASE_PAYLOAD,
      blocks: [
        { type: 'list', items: [] },
        { type: 'cta', label: 'Open', url: 'https://wavespestcontrol.com' },
        { type: 'paragraph', content: 'Plain paragraph, no links.' },
      ],
    })));

    render(<PrepGuidePage />);

    await waitFor(() => expect(screen.getByText('Plain paragraph, no links.')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Open' })).not.toBeInTheDocument();
  });
});

// @vitest-environment jsdom
// Pins ServiceReportDocument's photo gallery to the server's cacheability probe
// (server/services/service-report/rendered-image-urls.js, collectRenderedImageUrls).
// The two cannot share code (this file is ESM bundled by Vite, the probe is
// CommonJS), so this test renders the document for several payloads and fails if
// the images it prints differ from the URLs the probe would check. A photo the
// document prints but the probe skips could be cached as a healthy PDF with a
// placeholder in it; a URL the probe checks but the document never prints only
// costs a re-render.
import React from 'react';
import { createRequire } from 'node:module';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ServiceReportDocument from './ServiceReportDocument';

const require = createRequire(import.meta.url);
const { collectRenderedImageUrls } = require('../../../server/services/service-report/rendered-image-urls.js');

afterEach(cleanup);

const U = (name) => `https://cdn.example.com/${name}.jpg`;
const BASE = {
  serviceRecordId: '00000000-0000-4000-8000-000000000002',
  serviceDate: '2026-09-30T00:00:00.000Z',
  serviceDisplayName: 'Lawn Care Treatment Program',
  serviceLine: 'lawn',
  technicianName: 'Adam',
  customerName: 'Test Customer',
  serviceAddress: '1 Test Way, Bradenton, FL 34209',
  visitTiming: { arrivedAt: '2026-09-30T20:00:00.000Z', exitedAt: '2026-09-30T20:30:00.000Z' },
  typedReport: { todaysResult: { headline: 'Lawn looks steady.', body: 'We finished the visit.' }, findings: [], nextStepChips: [] },
  applications: [],
  zones: [],
};
const SET = [
  { url: U('set-front'), shot: 'front', label: 'Front yard' },
  { url: U('set-back'), shot: 'back', label: 'Back yard' },
  { url: U('set-close'), shot: 'close_up', label: 'Close-up' },
];
const GALLERY = [
  { id: 'p1', url: U('service-photo'), caption: 'Gate latch fixed' },
  { id: 'lawn-1', url: U('turf-copy-1') },
  { id: 'lawn-2', url: U('turf-copy-2') },
];
const payload = (reportV2, extra = {}) => ({ ...BASE, photos: GALLERY, reportV2, ...extra });

const CASES = {
  'a set replaces the lawn copies and the strip': payload({ photoSet: SET, photos: [{ url: U('strip-1') }, { url: U('strip-2') }] }),
  'no set: the gallery, the lawn copies and the strip': payload({ photos: [{ url: U('strip-1') }, { imageUrl: U('strip-2') }] }),
  'a set with moments and the gauge photo': payload(
    { photoSet: SET, photos: [{ url: U('strip-1') }] },
    {
      proofMoments: [{ id: 'm1', mediaUrl: U('moment'), mediaType: 'image', customerCaption: 'Entry sealed' }, { id: 'm2', mediaUrl: U('video'), mediaType: 'video' }],
      mowingHeight: { heightIn: 3.5, photoUrl: U('gauge') },
    },
  ),
  'a set entry with no link is ignored': payload({ photoSet: [...SET, { url: '', shot: 'trouble', label: 'Trouble spot' }], photos: [{ url: U('strip-1') }] }),
  'an empty set behaves as no set': payload({ photoSet: [], photos: [{ url: U('strip-1') }] }),
  'a set URL that repeats a service photo URL prints once': payload({ photoSet: [{ url: U('service-photo'), shot: 'front', label: 'Front yard' }, ...SET.slice(1)] }),
};

describe('ServiceReportDocument prints exactly the images the cacheability probe checks', () => {
  for (const [name, data] of Object.entries(CASES)) {
    it(name, () => {
      const { container } = render(<ServiceReportDocument data={data} token="tok123" />);
      const printed = [...container.querySelectorAll('img')]
        .map((img) => img.getAttribute('src'))
        .filter((src) => /^https?:\/\//i.test(src || ''));
      expect([...new Set(printed)].sort()).toEqual(collectRenderedImageUrls(data).sort());
    });
  }
});

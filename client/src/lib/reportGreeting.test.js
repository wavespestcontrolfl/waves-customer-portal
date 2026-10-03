import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { reportGreetingFirstName } from './reportGreeting';

describe('reportGreetingFirstName', () => {
  it('prefers the payload\'s own first name over the composed name', () => {
    expect(reportGreetingFirstName({ customerName: 'Sample Example', customerFirstName: 'Sample' })).toBe('Sample');
  });

  it('a blank first name (null) is empty, never the surname', () => {
    expect(reportGreetingFirstName({ customerName: 'Example', customerFirstName: null })).toBe('');
    expect(reportGreetingFirstName({ customerName: 'Example', customerFirstName: '  ' })).toBe('');
  });

  it('a cached older payload without the key keeps the first token of customerName', () => {
    expect(reportGreetingFirstName({ customerName: 'Sample Example' })).toBe('Sample');
    expect(reportGreetingFirstName({})).toBe('');
    expect(reportGreetingFirstName(undefined)).toBe('');
  });
});

describe('report pages greet through the helper', () => {
  const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const SPLIT_ON_NAME = /data\??\.customerName[^;\n]*\.split\(/;

  it('ReportViewPage and ProjectReportViewPage no longer split the composed name', () => {
    expect(read('../pages/ReportViewPage.jsx')).not.toMatch(SPLIT_ON_NAME);
    expect(read('../pages/ProjectReportViewPage.jsx')).not.toMatch(SPLIT_ON_NAME);
  });
});

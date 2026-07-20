/**
 * P2 (07-19 admin audit, email-preview XSS): CTA/image hrefs are escaped but
 * escapeHtml does not stop a `javascript:`/`data:` scheme, so a template- or
 * payload-supplied URL could become an executable href in the (now sandboxed)
 * preview or the sent email. safeUrl allowlists safe navigation schemes.
 */

const { safeUrl } = require('../services/email-template-library');

describe('safeUrl', () => {
  test('passes through http/https/mailto/tel and relative/anchor links', () => {
    expect(safeUrl('https://waves.example/pay')).toBe('https://waves.example/pay');
    expect(safeUrl('http://waves.example')).toBe('http://waves.example');
    expect(safeUrl('mailto:office@waves.example')).toBe('mailto:office@waves.example');
    expect(safeUrl('tel:+19415551234')).toBe('tel:+19415551234');
    expect(safeUrl('/admin/estimates')).toBe('/admin/estimates');
    expect(safeUrl('#section')).toBe('#section');
    expect(safeUrl('?tab=1')).toBe('?tab=1');
  });

  test('collapses javascript:/data:/vbscript: and other schemes to #', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('#');
    expect(safeUrl('  JavaScript:alert(1)')).toBe('#'); // trimmed + case-insensitive
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
    expect(safeUrl('vbscript:msgbox(1)')).toBe('#');
    expect(safeUrl('file:///etc/passwd')).toBe('#');
  });

  test('empty / null input returns an empty string', () => {
    expect(safeUrl('')).toBe('');
    expect(safeUrl(null)).toBe('');
    expect(safeUrl(undefined)).toBe('');
  });
});

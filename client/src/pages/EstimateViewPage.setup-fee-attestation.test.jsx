// @vitest-environment node
// GATE_PAF_SETUP_FEE (GitHub Codex #5485 r2): the accept PUT attests whether
// THIS TAB RENDERED the "setup fee billed with your first visit" promise, and a
// SETUP_FEE_TERMS_REFRESH 409 carries the answer the accept would apply so the
// next confirm attests it instead of refusing again. The page is far too heavy
// to mount for this, so the wiring is pinned from source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'EstimateViewPage.jsx'), 'utf8');

describe('EstimateViewPage setup-fee promise attestation', () => {
  it('attests the promise from the same value that renders the copy', () => {
    expect(src).toMatch(/setupFeeAfterVisitShownRef\.current = !!setupFeeAfterVisitCopy;/);
    expect(src).toMatch(/setupFeeAfterFirstVisitShown: setupFeeAfterVisitShownRef\.current \? true : undefined,/);
  });

  it('a SETUP_FEE_TERMS_REFRESH drops the captured card authorization so the refreshed terms are agreed to fresh', () => {
    expect(src).toMatch(/body\.code === 'SETUP_FEE_TERMS_REFRESH'\) \{[\s\S]{0,1200}recurringCardSetupIntentIdRef\.current = null;\s*setInlineCardIntent\(null\);[\s\S]{0,200}await loadEstimate\(\{ preserveSelection: true \}\);/);
  });

  it('the 409 answer wins for THIS selection only, so a lane /data could not predict does not loop', () => {
    expect(src).toMatch(/if \(typeof body\.setupFeePromise === 'boolean'\) \{\s*setSetupFeePromiseOverride\(\{ key: setupFeeSelectionKeyRef\.current, value: body\.setupFeePromise \}\);/);
    expect(src).toMatch(/setupFeeSelectionKeyRef\.current = afterVisitSelectionKey;/);
    expect(src).toMatch(/const setupFeeServerAnswer = setupFeePromiseOverride\?\.key === afterVisitSelectionKey \? setupFeePromiseOverride\.value : null;/);
    expect(src).toMatch(/const setupFeePromiseEnabled = setupFeeServerAnswer \?\? !!data\?\.recurringCardPolicy\?\.setupFeeAfterFirstVisit;/);
    expect(src).toMatch(/enabled: setupFeePromiseEnabled,/);
    // Both payment-option surfaces read the same override-aware value.
    expect(src.match(/setupFeeAfterFirstVisit=\{setupFeePromiseEnabled\}/g)).toHaveLength(2);
    expect(src).not.toMatch(/setupFeeAfterFirstVisit=\{!!data/);
  });
});

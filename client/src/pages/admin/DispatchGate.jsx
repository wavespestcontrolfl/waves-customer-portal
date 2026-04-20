import React, { lazy, Suspense } from 'react';

// V1 SchedulePage is deprecated but retained as a module of named exports
// (CompletionPanel, RescheduleModal, EditServiceModal, ProtocolPanel,
// MONTH_NAMES, PRODUCT_DESCRIPTIONS, TRACK_SAFETY_RULES,
// stripLegacyBoilerplate) still consumed by DispatchPageV2 and
// ProtocolReferenceTabV2. It is no longer reachable as a page.

const DispatchPageV2 = lazy(() => import('./DispatchPageV2'));

export default function DispatchGate() {
  return (
    <Suspense fallback={<div className="p-16 text-center text-13 text-ink-secondary">Loading dispatch…</div>}>
      <DispatchPageV2 />
    </Suspense>
  );
}

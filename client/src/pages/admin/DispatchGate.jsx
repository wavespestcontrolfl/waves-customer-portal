import React, { lazy, Suspense } from 'react';
import SchedulePage from './SchedulePage';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';

const DispatchPageV2 = lazy(() => import('./DispatchPageV2'));

export default function DispatchGate() {
  const v2 = useFeatureFlag('dispatch-v2');
  if (!v2) return <SchedulePage />;
  return (
    <Suspense fallback={<div className="p-16 text-center text-13 text-ink-secondary">Loading dispatch…</div>}>
      <DispatchPageV2 />
    </Suspense>
  );
}

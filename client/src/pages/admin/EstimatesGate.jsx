import React, { lazy, Suspense } from 'react';
import EstimatePage from './EstimatePage';
import { useFeatureFlagReady } from '../../hooks/useFeatureFlag';

const EstimatesPageV2 = lazy(() => import('./EstimatesPageV2'));

export default function EstimatesGate() {
  const { enabled: v2, ready } = useFeatureFlagReady('estimates-v2', true);
  if (!ready) {
    return <div className="p-16 text-center text-13 text-ink-secondary">Loading estimates…</div>;
  }
  if (!v2) return <EstimatePage />;
  return (
    <Suspense fallback={<div className="p-16 text-center text-13 text-ink-secondary">Loading estimates…</div>}>
      <EstimatesPageV2 />
    </Suspense>
  );
}

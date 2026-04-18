import React, { lazy, Suspense } from 'react';
import EstimatePage from './EstimatePage';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';

const EstimatesPageV2 = lazy(() => import('./EstimatesPageV2'));

export default function EstimatesGate() {
  const v2 = useFeatureFlag('estimates-v2');
  if (!v2) return <EstimatePage />;
  return (
    <Suspense fallback={<div className="p-16 text-center text-13 text-ink-secondary">Loading estimates…</div>}>
      <EstimatesPageV2 />
    </Suspense>
  );
}

import React, { lazy, Suspense } from 'react';
import DashboardPage from './DashboardPage';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';

const DashboardPageV2 = lazy(() => import('./DashboardPageV2'));

export default function DashboardGate() {
  const v2 = useFeatureFlag('dashboard-v2');
  if (!v2) return <DashboardPage />;
  return (
    <Suspense fallback={<div className="p-16 text-center text-13 text-ink-secondary">Loading dashboard…</div>}>
      <DashboardPageV2 />
    </Suspense>
  );
}

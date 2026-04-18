import React, { lazy, Suspense } from 'react';
import CustomersPage from './CustomersPage';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';

const CustomersPageV2 = lazy(() => import('./CustomersPageV2'));

export default function CustomersGate() {
  const v2 = useFeatureFlag('customers-v2');
  if (!v2) return <CustomersPage />;
  return (
    <Suspense fallback={<div className="p-16 text-center text-13 text-ink-secondary">Loading customers…</div>}>
      <CustomersPageV2 />
    </Suspense>
  );
}

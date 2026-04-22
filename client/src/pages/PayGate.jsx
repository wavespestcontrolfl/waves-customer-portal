import React, { lazy, Suspense } from 'react';
import PayPage from './PayPage';
import { usePairedFeatureFlag } from '../hooks/useFeatureFlag';

const PayPageV2 = lazy(() => import('./PayPageV2'));

export default function PayGate() {
  const { enabled: v2, ready } = usePairedFeatureFlag(
    'ff_customer_pay_v2',
    'ff_customer_receipt_v2',
    true,
  );
  if (!ready) return <PayPage />;
  if (!v2) return <PayPage />;
  return (
    <Suspense fallback={<PayPage />}>
      <PayPageV2 />
    </Suspense>
  );
}

import React, { lazy, Suspense } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { usePairedFeatureFlag } from '../hooks/useFeatureFlag';

const ReceiptPage = lazy(() => import('./ReceiptPage'));

// /receipt/:token is a V2-only surface — it didn't exist before the paired
// release. If both flags are off (or mismatched → treated as off), we fall
// back to /pay/:token which the V1 PayPage already handles as a
// post-payment view.
export default function ReceiptGate() {
  const { token } = useParams();
  const { enabled: v2, ready } = usePairedFeatureFlag(
    'ff_customer_pay_v2',
    'ff_customer_receipt_v2',
    true,
  );
  if (!ready) return null;
  if (!v2) return <Navigate to={`/pay/${token}`} replace />;
  return (
    <Suspense fallback={null}>
      <ReceiptPage />
    </Suspense>
  );
}

import React, { lazy, Suspense } from 'react';
import LoginPage from './LoginPage';
import { useFeatureFlagReady } from '../hooks/useFeatureFlag';

const LoginPageV2 = lazy(() => import('./LoginPageV2'));

// Customer-tier V2 login gate. Default-off per Option B directive — wait for
// Virginia UAT before flipping ff_customer_login_v2 on.
export default function LoginGate() {
  const { enabled: v2, ready } = useFeatureFlagReady('ff_customer_login_v2', false);
  if (!ready) return <LoginPage />;
  if (!v2) return <LoginPage />;
  return (
    <Suspense fallback={<LoginPage />}>
      <LoginPageV2 />
    </Suspense>
  );
}

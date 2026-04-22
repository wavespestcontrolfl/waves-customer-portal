import React, { lazy, Suspense } from 'react';
import LoginPage from './LoginPage';
import { useFeatureFlagReady } from '../hooks/useFeatureFlag';

const LoginPageV2 = lazy(() => import('./LoginPageV2'));

// Customer-tier V2 login gate. Default-on — users (and anonymous visitors,
// whose flag cache is empty and falls through to the default) get V2; an
// explicit enabled:false row on a signed-in admin pins that user to V1.
export default function LoginGate() {
  const { enabled: v2, ready } = useFeatureFlagReady('ff_customer_login_v2', true);
  if (!ready) return <LoginPage />;
  if (!v2) return <LoginPage />;
  return (
    <Suspense fallback={<LoginPage />}>
      <LoginPageV2 />
    </Suspense>
  );
}

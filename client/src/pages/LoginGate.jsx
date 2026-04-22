import React, { lazy, Suspense } from 'react';
import LoginPage from './LoginPage';
import { useFeatureFlagReady } from '../hooks/useFeatureFlag';

const LoginPageV2 = lazy(() => import('./LoginPageV2'));

// Customer-tier V2 login gate. Default-on — users with no flag row get V2;
// an explicit enabled:false row still pins that user to V1.
// Caveat: anonymous visitors can't load flags (no waves_admin_token), so they
// always hit V1 here regardless of default. Only authenticated admins see V2.
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

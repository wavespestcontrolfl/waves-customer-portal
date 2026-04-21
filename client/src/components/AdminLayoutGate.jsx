import React, { lazy, Suspense } from 'react';
import AdminLayout from './AdminLayout';
import { useFeatureFlagReady } from '../hooks/useFeatureFlag';

const AdminLayoutV2 = lazy(() => import('./AdminLayoutV2'));

export default function AdminLayoutGate() {
  const { enabled: v2, ready } = useFeatureFlagReady('admin-shell-v2', true);
  if (!ready) return <div />;
  if (!v2) return <AdminLayout />;
  return (
    <Suspense fallback={<div />}>
      <AdminLayoutV2 />
    </Suspense>
  );
}

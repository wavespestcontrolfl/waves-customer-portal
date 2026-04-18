import React, { lazy, Suspense } from 'react';
import AdminLayout from './AdminLayout';
import { useFeatureFlag } from '../hooks/useFeatureFlag';

const AdminLayoutV2 = lazy(() => import('./AdminLayoutV2'));

export default function AdminLayoutGate() {
  const v2 = useFeatureFlag('admin-shell-v2');
  if (!v2) return <AdminLayout />;
  return (
    <Suspense fallback={<div />}>
      <AdminLayoutV2 />
    </Suspense>
  );
}

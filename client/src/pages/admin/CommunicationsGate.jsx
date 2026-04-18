import React, { lazy, Suspense } from 'react';
import CommunicationsPage from './CommunicationsPage';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';

const CommunicationsPageV2 = lazy(() => import('./CommunicationsPageV2'));

export default function CommunicationsGate() {
  const v2 = useFeatureFlag('comms-v2');
  if (!v2) return <CommunicationsPage />;
  return (
    <Suspense
      fallback={
        <div className="p-16 text-center text-13 text-ink-secondary">
          Loading communications…
        </div>
      }
    >
      <CommunicationsPageV2 />
    </Suspense>
  );
}

import React, { lazy, Suspense } from 'react';
import CommunicationsPage from './CommunicationsPage';
import { useFeatureFlagReady } from '../../hooks/useFeatureFlag';

const CommunicationsPageV2 = lazy(() => import('./CommunicationsPageV2'));

export default function CommunicationsGate() {
  const { enabled: v2, ready } = useFeatureFlagReady('comms-v2');
  if (!ready) {
    return (
      <div className="p-16 text-center text-13 text-ink-secondary">
        Loading communications…
      </div>
    );
  }
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

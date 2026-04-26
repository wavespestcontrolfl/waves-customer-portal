// client/src/pages/admin/CommunicationsGate.jsx
//
// Feature-flag router for /admin/communications. Reads the `comms-v2`
// flag (DB-backed) and routes to either:
//   - CommunicationsPageV2 (Tier 1 V2 monochrome, all 6 tabs reskinned)
//   - CommunicationsPage   (V1 legacy)
//
// Default `true` for users without an explicit row in user_feature_flags.
// V2 is lazy-loaded behind Suspense.
//
// Daily driver: Virginia (CSR) — 8 hrs/day in this surface. SMS volume
// is the dominant traffic; voice is secondary. Twilio inbound webhooks
// land here via the server route family.
//
// Audit focus:
// - Default flag value: passing `true` as the second arg means new
//   admins land on V2. Confirm V2 handles edge cases that V1 used to
//   absorb silently (empty inbox, unread badge race, missing customer
//   for a number).
// - Suspense fallback: same loading message as the flag-not-ready
//   state. Worth distinguishing so an actual stuck import is visible.
// - V1/V2 reuse: V2 imports several panels and constants from V1
//   (ALL_NUMBERS, NUMBER_LABEL_MAP, call dispositions, blocked-number
//   list, etc). If V1 ever gets deleted those exports must move first.
import React, { lazy, Suspense } from 'react';
import CommunicationsPage from './CommunicationsPage';
import { useFeatureFlagReady } from '../../hooks/useFeatureFlag';

const CommunicationsPageV2 = lazy(() => import('./CommunicationsPageV2'));

export default function CommunicationsGate() {
  const { enabled: v2, ready } = useFeatureFlagReady('comms-v2', true);
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

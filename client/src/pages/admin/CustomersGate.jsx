// client/src/pages/admin/CustomersGate.jsx
//
// Feature-flag router for /admin/customers. Reads the `customers-v2`
// flag (DB-backed via useFeatureFlagReady) and routes to either:
//   - CustomersPageV2 (Tier 1 V2 monochrome, Tailwind + ui primitives)
//   - CustomersPage   (V1 legacy with inline styles + D palette)
//
// Default `true` for users without an explicit row in user_feature_flags.
// V2 is lazy-loaded behind Suspense — keeps the cold-start bundle for
// flag-off users from carrying the V2 code.
//
// Audit focus:
// - Default flag value: passing `true` as the second arg means new
//   admins land on V2. Confirm that's the operator's intent and that
//   the V2 page handles edge-case data (e.g. customers with no tier,
//   no city, no address) without crashing.
// - Suspense fallback: a slow lazy import shows the same loading
//   message as the flag-not-ready state. Worth distinguishing so an
//   actual stuck import is visible.
// - V1/V2 import boundary: CustomersPageV2 imports several reusable
//   panels (CustomerMap, CustomerHealthSection, CustomerIntelligenceTab,
//   STAGE_MAP, LEAD_SOURCES) FROM CustomersPage. If V1 ever gets
//   deleted, those exports need to move first.
import React, { lazy, Suspense } from 'react';
import CustomersPage from './CustomersPage';
import { useFeatureFlagReady } from '../../hooks/useFeatureFlag';

const CustomersPageV2 = lazy(() => import('./CustomersPageV2'));

export default function CustomersGate() {
  const { enabled: v2, ready } = useFeatureFlagReady('customers-v2', true);
  if (!ready) {
    return <div className="p-16 text-center text-13 text-ink-secondary">Loading customers…</div>;
  }
  if (!v2) return <CustomersPage />;
  return (
    <Suspense fallback={<div className="p-16 text-center text-13 text-ink-secondary">Loading customers…</div>}>
      <CustomersPageV2 />
    </Suspense>
  );
}

import { Navigate } from 'react-router-dom';

/**
 * Compatibility entry for stale lazy chunks and direct imports.
 *
 * Field estimates must use the canonical admin builder: it calculates through
 * the server pricing engine, persists an estimate, and sends through the
 * audited estimate-delivery endpoints. Keeping this component as a redirect
 * prevents the retired client-side price table from returning through an old
 * import or bookmark.
 */
export default function TechEstimatorPage() {
  return <Navigate to="/admin/estimates?tab=new" replace />;
}

import React from "react";
import { Navigate, useLocation, useParams } from "react-router-dom";

// Path-style detail links (/admin/customers/:id, /admin/invoices/:id,
// /admin/estimates/:id) were never real routes, so the admin catch-all
// dropped staff on the dashboard. Hundreds of stored notification rows
// already carry that shape; rewrite them to the query param the target
// page actually reads, keeping any other query and the hash.
export default function AdminDetailRedirect({ to, queryKey, tab }) {
  const { id } = useParams();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set(queryKey, id);
  if (tab && !params.get("tab")) params.set("tab", tab);
  return <Navigate to={`${to}?${params}${location.hash}`} replace />;
}

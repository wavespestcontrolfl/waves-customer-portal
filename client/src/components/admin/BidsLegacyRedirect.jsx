import { Navigate, useLocation } from "react-router-dom";

// /admin/bid-desk and /admin/bid-kit became tabs of /admin/bids. Admin notifications and ops bells already hold the old
// links (?bid=<id>, ?item=<id>), so the whole query string and the hash carry over to the new address.
export default function BidsLegacyRedirect({ tab = "" }) {
  const { search, hash } = useLocation();
  const params = new URLSearchParams(search);
  if (tab) params.set("tab", tab);
  const query = params.toString();
  return <Navigate to={`/admin/bids${query ? `?${query}` : ""}${hash || ""}`} replace />;
}

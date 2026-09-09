import { Link } from "react-router-dom";

// Dashboard card rows link to admin routes. A raw <a href> full-reloads the
// SPA on every click; an in-app path goes through the router, an absolute
// URL keeps the anchor, and a row with no destination is not a link at all.
export function RowLink({ href, className, children }) {
  // "/path" is in-app; "//host/path" is protocol-relative and external.
  if (typeof href === "string" && href.startsWith("/") && !href.startsWith("//")) {
    return (
      <Link to={href} className={className}>
        {children}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return <div className={className}>{children}</div>;
}

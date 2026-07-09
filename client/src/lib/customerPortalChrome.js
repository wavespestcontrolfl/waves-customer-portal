const PUBLIC_ROUTE_PREFIXES = [
  '/book',
  '/contract',
  '/estimate',
  '/newsletter',
  '/pay',
  '/quote',
  '/rate',
  '/receipt',
  '/report',
  '/review',
  '/track',
];

export function isLoginOrCustomerPortalPath(pathname = '/') {
  const path = pathname || '/';
  if (path === '/login') return true;
  if (path.startsWith('/admin') || path.startsWith('/tech')) return false;

  return !PUBLIC_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

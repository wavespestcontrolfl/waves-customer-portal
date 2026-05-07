const SHORT_TOKEN_LENGTH = 12;
const FULL_TOKEN_RE = /^[a-f0-9]{32}$/;
const VANITY_TOKEN_RE = /-([a-f0-9]{12})$/;

function slugifyName(...parts) {
  const slug = parts
    .filter(Boolean)
    .join(' ')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'customer';
}

function tokenPrefix(token) {
  return String(token || '').slice(0, SHORT_TOKEN_LENGTH);
}

function projectReportPath({ firstName, lastName, sequence = 1, token }) {
  const fullToken = String(token || '').toLowerCase();
  if (!FULL_TOKEN_RE.test(fullToken)) return '';
  const base = slugifyName(firstName, lastName);
  const numbered = Number(sequence) > 1 ? `${base}-${Number(sequence)}` : base;
  return `/report/project/${numbered}-${tokenPrefix(fullToken)}`;
}

function extractProjectReportTokenLookup(segment) {
  const value = String(segment || '').toLowerCase();
  if (FULL_TOKEN_RE.test(value)) return { type: 'full', value };
  const match = VANITY_TOKEN_RE.exec(value);
  if (match) return { type: 'prefix', value: match[1] };
  return null;
}

async function projectReportSequence(db, project) {
  if (!project?.customer_id || !project?.id) return 1;
  try {
    const rows = await db('projects')
      .where({ customer_id: project.customer_id })
      .whereNotNull('report_token')
      .whereIn('status', ['sent', 'closed'])
      .orderByRaw('COALESCE(sent_at, created_at) asc')
      .orderBy('id', 'asc')
      .select('id');
    const index = rows.findIndex(row => String(row.id) === String(project.id));
    return index >= 0 ? index + 1 : rows.length + 1;
  } catch {
    return 1;
  }
}

async function projectReportPathForProject(db, project, customer = {}) {
  const token = project?.report_token;
  const sequence = await projectReportSequence(db, project);
  return projectReportPath({
    firstName: customer.first_name,
    lastName: customer.last_name,
    sequence,
    token,
  });
}

module.exports = {
  FULL_TOKEN_RE,
  SHORT_TOKEN_LENGTH,
  extractProjectReportTokenLookup,
  projectReportPath,
  projectReportPathForProject,
  projectReportSequence,
  slugifyName,
};

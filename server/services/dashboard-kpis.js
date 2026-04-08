/**
 * Role-based KPI configuration
 * Returns ordered KPI cards based on the authenticated user's role.
 */

function fmt$(val) {
  return '$' + Number(val || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function pct(val) {
  const n = Number(val || 0);
  return (n >= 0 ? '+' : '') + n + '%';
}

function getKpisForRole(role, data = {}) {
  if (role === 'admin' || role === 'owner') {
    return [
      {
        key: 'revenue',
        label: 'Revenue MTD',
        value: fmt$(data.revenueMTD),
        trend: pct(data.revenueChangePercent),
        color: '#10b981',
        icon: 'dollar',
      },
      {
        key: 'services',
        label: 'Services This Week',
        value: `${data.servicesCompleted || 0}/${data.servicesTotal || 0}`,
        trend: null,
        color: '#0ea5e9',
        icon: 'clipboard',
      },
      {
        key: 'customers',
        label: 'Active Customers',
        value: String(data.activeCustomers || 0),
        trend: data.newCustomersThisMonth ? `+${data.newCustomersThisMonth} this month` : null,
        color: '#8b5cf6',
        icon: 'users',
      },
      {
        key: 'estimates',
        label: 'Pending Estimates',
        value: String(data.estimatesPending || 0),
        trend: null,
        color: '#f59e0b',
        icon: 'file-text',
      },
      {
        key: 'reviews',
        label: 'Google Reviews',
        value: `${data.googleReviewRating || '--'} (${data.googleReviewCount || 0})`,
        trend: data.googleUnresponded ? `${data.googleUnresponded} unresponded` : null,
        color: '#eab308',
        icon: 'star',
      },
      {
        key: 'mrr',
        label: 'MRR',
        value: fmt$(data.mrr),
        trend: null,
        color: '#10b981',
        icon: 'trending-up',
      },
      {
        key: 'closeRate',
        label: 'Close Rate',
        value: data.closeRate ? `${data.closeRate}%` : '--',
        trend: null,
        color: '#06b6d4',
        icon: 'target',
      },
      {
        key: 'healthAtRisk',
        label: 'At-Risk Customers',
        value: String(data.healthAtRisk || 0),
        trend: null,
        color: '#ef4444',
        icon: 'alert-triangle',
      },
    ];
  }

  if (role === 'technician') {
    return [
      {
        key: 'myStops',
        label: 'My Stops Today',
        value: String(data.myStops || 0),
        trend: null,
        color: '#0ea5e9',
        icon: 'map-pin',
      },
      {
        key: 'myCompleted',
        label: 'Completed',
        value: String(data.myCompleted || 0),
        trend: data.myStops ? `${Math.round((data.myCompleted / data.myStops) * 100)}%` : null,
        color: '#10b981',
        icon: 'check-circle',
      },
      {
        key: 'myRevenue',
        label: 'My Revenue Today',
        value: fmt$(data.myRevenue),
        trend: null,
        color: '#8b5cf6',
        icon: 'dollar',
      },
      {
        key: 'avgTime',
        label: 'Avg Time on Site',
        value: data.avgTimeOnSite ? `${data.avgTimeOnSite} min` : '--',
        trend: null,
        color: '#f59e0b',
        icon: 'clock',
      },
    ];
  }

  if (role === 'dispatcher') {
    return [
      {
        key: 'unassigned',
        label: 'Unassigned',
        value: String(data.unassigned || 0),
        trend: null,
        color: data.unassigned > 0 ? '#ef4444' : '#10b981',
        icon: 'alert-circle',
      },
      {
        key: 'servicesToday',
        label: 'Services Today',
        value: String(data.servicesToday || 0),
        trend: null,
        color: '#0ea5e9',
        icon: 'calendar',
      },
      {
        key: 'unreadMessages',
        label: 'Unread Messages',
        value: String(data.unreadMessages || 0),
        trend: null,
        color: data.unreadMessages > 0 ? '#f59e0b' : '#10b981',
        icon: 'message-circle',
      },
      {
        key: 'overdueInvoices',
        label: 'Overdue Invoices',
        value: String(data.overdueInvoices || 0),
        trend: null,
        color: data.overdueInvoices > 0 ? '#ef4444' : '#10b981',
        icon: 'alert-triangle',
      },
    ];
  }

  // Fallback — return empty array for unknown roles
  return [];
}

module.exports = { getKpisForRole };

/**
 * Schedule Intelligence Bar — V2 (thin wrapper)
 * client/src/components/admin/ScheduleIntelligenceBarV2.jsx
 *
 * Forwards date + scheduleData → pageData. Inline stats (stops / done /
 * unassigned) render in the header when collapsed. Refreshes schedule after
 * any write-tool invocation.
 */

import { useCallback, useMemo } from 'react';
import IntelligenceBarShell from './IntelligenceBarShell';

const FALLBACK_ACTIONS = [
  { id: 'day_briefing', group: 'Plan', label: 'Day Briefing', prompt: 'Give me a full briefing for today' },
  { id: 'gaps', group: 'Plan', label: 'Gaps This Week', prompt: 'Where do we have open capacity this week?' },
  { id: 'optimize', group: 'Optimize', label: 'Optimize Routes', prompt: 'Optimize all routes for today' },
  { id: 'zone_density', group: 'Optimize', label: 'Zone Density', prompt: 'Analyze zone density — any consolidation opportunities?' },
  { id: 'far_out', group: 'Optimize', label: 'Far-Out Appts', prompt: 'Find appointments more than 30 days out that we could move sooner' },
  { id: 'unassigned', group: 'Fix', label: 'Unassigned', prompt: 'Show me unassigned stops and suggest tech assignments' },
];

const WRITE_TOOLS = [
  'optimize_all_routes',
  'optimize_tech_route',
  'assign_technician',
  'move_stops_to_day',
  'swap_tech_assignments',
  'create_appointment',
  'reschedule_appointment',
  'cancel_appointment',
];

export default function ScheduleIntelligenceBarV2({ date, scheduleData, onRefresh }) {
  const buildPageData = useCallback(() => {
    const pd = {
      current_date: date,
      current_date_formatted: new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      }),
    };

    if (scheduleData) {
      pd.total_services = scheduleData.services?.length || 0;
      pd.completed = scheduleData.services?.filter((s) => s.status === 'completed').length || 0;
      pd.remaining = pd.total_services - pd.completed;
      pd.unassigned_count = scheduleData.unassigned?.length || 0;

      if (scheduleData.techSummary) {
        pd.technicians = scheduleData.techSummary.map((t) => ({
          name: t.techName || t.name,
          stops: t.totalServices || t.services?.length || 0,
          completed: t.completedServices || 0,
          zones: t.zones || {},
        }));
      }

      if (scheduleData.unassigned?.length > 0) {
        pd.unassigned_stops = scheduleData.unassigned.slice(0, 10).map((s) => ({
          id: s.id,
          customer: `${s.firstName || s.first_name || ''} ${s.lastName || s.last_name || ''}`.trim(),
          city: s.city,
          service_type: s.serviceType || s.service_type,
        }));
      }

      if (scheduleData.weather) pd.weather = scheduleData.weather;
    }

    return pd;
  }, [date, scheduleData]);

  const handleAfterSubmit = useCallback((data) => {
    const didWrite = (data.toolCalls || []).some((tc) => WRITE_TOOLS.includes(tc.name));
    if (didWrite && onRefresh) setTimeout(() => onRefresh(), 500);
  }, [onRefresh]);

  const promotions = useMemo(() => {
    const p = {};
    const unassigned = scheduleData?.unassigned?.length || 0;
    if (unassigned > 0) {
      p.unassigned = { reason: `${unassigned} unassigned today` };
    }
    const rain = scheduleData?.weather?.rain_chance;
    if (typeof rain === 'number' && rain >= 40) {
      p.optimize = { reason: `${rain}% rain forecast — consider reshuffling` };
    }
    return p;
  }, [scheduleData]);

  const totalServices = scheduleData?.services?.length || 0;
  const completedCount = scheduleData?.services?.filter((s) => s.status === 'completed').length || 0;
  const unassignedCount = scheduleData?.unassigned?.length || 0;

  return (
    <IntelligenceBarShell
      context="schedule"
      buildPageData={buildPageData}
      fallbackActions={FALLBACK_ACTIONS}
      onAfterSubmit={handleAfterSubmit}
      promotions={promotions}
      followupPlaceholder="Follow up — 'do it', 'assign to Adam', 'move to Thursday'…"
      loadingLabel="thinking…"
      responseMaxHeight="420px"
      skeletonBars={[90, 70, 85]}
      headerSlot={({ expanded }) =>
        totalServices > 0 && !expanded ? (
          <div className="flex gap-3 u-nums text-11 text-ink-secondary flex-shrink-0">
            <span><strong className="text-ink-primary font-medium">{totalServices}</strong> stops</span>
            <span><strong className="text-ink-primary font-medium">{completedCount}</strong> done</span>
            {unassignedCount > 0 && (
              <span><strong className="text-alert-fg font-medium">{unassignedCount}</strong> unassigned</span>
            )}
          </div>
        ) : null
      }
    />
  );
}

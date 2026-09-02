import legacyLawnReport from './legacy-lawn-report.json';
import { SERVICE_COMPLETION_PRESETS } from '../../lib/service-completion-presets';

const CASES = {
  fire_ant: { name: 'Fire Ant Treatment', area: 'Front lawn', finding: 'Active mounds observed', action: 'Individual mound treatment', line: 'pest' },
  tick_control: { name: 'Tick Control Service', area: 'Pet resting area', finding: 'Brown dog tick', action: 'Targeted exterior habitat treatment', line: 'pest' },
  bee_wasp_removal: { name: 'Yellowjacket Removal', area: 'Ground cavity', finding: 'Yellowjacket', action: 'Ground nest treated', line: 'pest' },
  mud_dauber_removal: { name: 'Mud Dauber Removal', area: 'Lanai / pool cage', finding: 'Active mud nests', action: 'Active nests treated and removed', line: 'pest' },
  bed_bug_treatment: { name: 'Bed Bug Hybrid Treatment', area: 'Primary bedroom', finding: 'Live adults', action: 'Hybrid heat and chemical treatment', line: 'pest' },
  mosquito: { name: 'Seasonal Mosquito Service', area: 'Planters / bromeliads', finding: 'Removable standing water found', action: 'Standing water removed where practical', line: 'pest' },
  dethatching: { name: 'Lawn Dethatching', area: 'Heavy-thatch areas', finding: 'Heavy debris removed', action: 'Double-pass dethatching completed', line: 'lawn' },
  plugging: { name: 'Lawn Plugging', area: 'Thin turf areas', finding: '9-inch spacing', action: 'Sod plugs installed at quoted spacing', line: 'lawn' },
};

export const SPECIALTY_SERVICE_REPORT_FIXTURES = Object.entries(CASES).map(([key, sample], index) => {
  const preset = SERVICE_COMPLETION_PRESETS[key];
  if (!preset?.areas.includes(sample.area)) throw new Error(`${key}: fixture area is not in completion preset`);
  if (!preset?.protocols.some((action) => action.label === sample.action)) throw new Error(`${key}: fixture action is not in completion preset`);
  if (!preset?.findingGroups.some((group) => group.options.some((option) => option.value === sample.finding))) {
    throw new Error(`${key}: fixture finding is not in completion preset`);
  }

  const payload = JSON.parse(JSON.stringify(legacyLawnReport));
  payload.serviceRecordId = `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`;
  payload.serviceLine = sample.line;
  payload.serviceLineDisplay = sample.line === 'lawn' ? 'Lawn Service Visit' : 'Pest Control Visit';
  payload.serviceDisplayName = sample.name;
  payload.summary = `We completed ${sample.action.toLowerCase()} in ${sample.area}. The technician noted ${sample.finding.toLowerCase()}.`;
  payload.summarySource = 'technician_report';
  payload.serviceAreas = [sample.area];
  payload.serviceLocations = [];
  payload.serviceCoverage = {
    enabled: true,
    serviceLine: sample.line,
    title: 'Service Coverage',
    intro: 'Where your technician serviced today.',
    summary: { completedCount: 1, inspectedCount: 0, inaccessibleCount: 0, needsAttentionCount: 0, skippedCount: 0 },
    items: [{
      id: `area-${key}`,
      markerLabel: 'A',
      areaName: sample.area,
      status: 'completed',
      statusLabel: 'Completed',
      customerDescription: `${sample.area} serviced.`,
    }],
  };
  delete payload.lawnAssessment;
  delete payload.lawnProgramOverview;
  delete payload.reportV2;
  delete payload.pestReportV2;
  delete payload.mosquitoReportV2;
  return { key, ...sample, payload };
});

const beeRemoval = SPECIALTY_SERVICE_REPORT_FIXTURES.find(({ key }) => key === 'bee_wasp_removal');
export const SPECIALTY_INSPECTION_REPORT_FIXTURE = {
  ...beeRemoval,
  name: 'Bee / Yellowjacket Inspection',
  finding: 'Flying activity with no nest located',
  action: 'Inspection and identification only',
  payload: {
    ...JSON.parse(JSON.stringify(beeRemoval.payload)),
    serviceDisplayName: 'Bee / Yellowjacket Inspection',
    summary: 'We completed an inspection in Eaves / soffit. Flying activity was observed, but no nest was located. No treatment was applied during this visit.',
    serviceAreas: ['Eaves / soffit'],
    applications: [],
    dynamicContext: {},
    serviceCoverage: {
      ...beeRemoval.payload.serviceCoverage,
      summary: { completedCount: 0, inspectedCount: 1, inaccessibleCount: 0, needsAttentionCount: 0, skippedCount: 0 },
      items: [{
        id: 'area-bee-inspection', markerLabel: 'A', areaName: 'Eaves / soffit',
        status: 'inspected', statusLabel: 'Inspected', customerDescription: 'Eaves / soffit inspected; no nest was located.',
      }],
    },
  },
};

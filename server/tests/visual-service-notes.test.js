const {
  canCreateVisualServiceMoment,
  customerCaptionForMoment,
  formatVisualMoment,
  invalidateVisualMomentReportPdfCache,
  isVisualServiceNotesEnabled,
  serviceTypeKey,
  templateCaptionForMoment,
} = require('../services/visual-service-notes');

describe('visual service notes', () => {
  test('creation is disabled until the feature flag or setting is enabled', () => {
    const result = canCreateVisualServiceMoment({
      enabled: false,
      technicianId: 'tech-1',
      techRole: 'technician',
      job: { id: 'job-1', technician_id: 'tech-1', status: 'on_site' },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      error: 'Visual Service Notes are disabled',
    });
  });

  test('global setting enables visual notes without a per-user flag row', async () => {
    const knex = (table) => {
      expect(table).toBe('system_settings');
      return {
        where(criteria) {
          expect(criteria).toEqual({ key: 'visualServiceNotesEnabled' });
          return this;
        },
        first() {
          return Promise.resolve({ value: 'true' });
        },
      };
    };

    await expect(isVisualServiceNotesEnabled('tech-1', knex)).resolves.toBe(true);
  });

  test('unassigned tech cannot create a visual moment for another tech job', () => {
    const result = canCreateVisualServiceMoment({
      enabled: true,
      technicianId: 'tech-1',
      techRole: 'technician',
      job: { id: 'job-1', technician_id: 'tech-2', status: 'on_site' },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  test('assigned tech can create moments only when the job is active on property', () => {
    expect(canCreateVisualServiceMoment({
      enabled: true,
      technicianId: 'tech-1',
      techRole: 'technician',
      job: { id: 'job-1', technician_id: 'tech-1', status: 'on_site' },
    })).toEqual({ ok: true });

    expect(canCreateVisualServiceMoment({
      enabled: true,
      technicianId: 'tech-1',
      techRole: 'technician',
      job: { id: 'job-1', technician_id: 'tech-1', status: 'en_route' },
    })).toMatchObject({
      ok: false,
      status: 409,
    });
  });

  test('template captions stay simple and customer-safe', () => {
    expect(templateCaptionForMoment({
      tag_code: 'weeds',
      location_area: 'Driveway Edge',
    })).toBe('Weed pressure was observed near Driveway Edge.');

    expect(customerCaptionForMoment({
      tag_code: 'recommendation',
      location_area: 'Lanai',
      note: 'Trim branches touching screen',
    })).toBe('Your technician noted a recommendation near Lanai: Trim branches touching screen');
  });

  test('public formatting omits raw technician notes', () => {
    const row = {
      id: 'moment-1',
      job_id: 'job-1',
      tag_code: 'weeds',
      tag_label: 'Weeds',
      tag_group: 'observation',
      service_type: 'lawn',
      location_area: 'Driveway Edge',
      note: 'Raw internal note with customer-sensitive wording',
      media_type: 'none',
      visibility_status: 'approved_customer',
      customer_caption: 'Customer-safe caption.',
      captured_at: '2026-05-15T14:15:00.000Z',
      created_at: '2026-05-15T14:15:00.000Z',
    };

    expect(formatVisualMoment(row, { includeInternal: false })).not.toHaveProperty('note');
    expect(formatVisualMoment(row, { includeInternal: true })).toMatchObject({
      note: row.note,
    });
  });

  test('service type normalization keeps report grouping stable', () => {
    expect(serviceTypeKey('Quarterly Pest Control')).toBe('pest');
    expect(serviceTypeKey('WaveGuard Lawn Visit')).toBe('lawn');
    expect(serviceTypeKey('Rodent Exclusion Follow Up')).toBe('rodent');
    expect(serviceTypeKey('Tree & Shrub Care')).toBe('tree_shrub');
  });

  test('report pdf cache is cleared for service records tied to the visual-note job', async () => {
    const calls = [];
    const knex = (table) => {
      calls.push(['table', table]);
      return {
        where(criteria) {
          calls.push(['where', criteria]);
          return this;
        },
        update(payload) {
          calls.push(['update', payload]);
          return Promise.resolve(1);
        },
      };
    };

    await invalidateVisualMomentReportPdfCache('scheduled-1', knex);

    expect(calls).toEqual([
      ['table', 'service_records'],
      ['where', { scheduled_service_id: 'scheduled-1' }],
      ['update', { pdf_storage_key: null }],
    ]);
  });
});

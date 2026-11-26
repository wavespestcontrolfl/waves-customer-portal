const {
  canCreateVisualServiceMoment,
  customerCaptionForMoment,
  formatVisualMoment,
  invalidateVisualMomentReportPdfCache,
  isVisualServiceNotesEnabled,
  normalizeMomentInsert,
  youtubeOkColumns,
  youtubeOkFields,
  countOkClipsThisWeek,
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

  describe('OK to post mark', () => {
    const job = { id: 'job-1', customer_id: null, technician_id: 'tech-1' };
    const insertFor = (media, body) => normalizeMomentInsert({
      body: { tagCode: 'bugs_seen', ...body }, job, technicianId: 'tech-1', media,
    });

    test('a video clip with youtubeOk true is stamped, and customer visibility stays internal', () => {
      const row = insertFor({ mediaType: 'video' }, { youtubeOk: 'true' });
      expect(row.youtube_ok_at).toBeInstanceOf(Date);
      expect(row.youtube_ok_by).toBe('tech-1');
      expect(row.visibility_status).toBe('internal_only');
    });

    test('a photo or a note with no media ignores youtubeOk', () => {
      for (const mediaType of ['photo', 'none']) {
        const row = insertFor({ mediaType }, { youtubeOk: 'true' });
        expect(row).not.toHaveProperty('youtube_ok_at');
        expect(row).not.toHaveProperty('youtube_ok_by');
      }
    });

    test('youtubeOk false on a clip clears both columns; an absent field changes nothing', () => {
      expect(youtubeOkColumns({ mediaType: 'video', youtubeOk: false, technicianId: 't' }))
        .toEqual({ youtube_ok_at: null, youtube_ok_by: null });
      expect(youtubeOkColumns({ mediaType: 'video', youtubeOk: 'false', technicianId: 't' }))
        .toEqual({ youtube_ok_at: null, youtube_ok_by: null });
      expect(youtubeOkColumns({ mediaType: 'video', technicianId: 't' })).toEqual({});
      expect(youtubeOkColumns({ mediaType: 'video', youtubeOk: 'maybe', technicianId: 't' })).toEqual({});
    });

    test('the shared formatter (public report) never carries the YouTube mark; staff fields do', () => {
      const at = new Date('2026-11-24T15:00:00Z');
      const row = { id: 'm', youtube_ok_at: at, youtube_ok_by: 'tech-1', media_type: 'video', visibility_status: 'approved_customer' };
      for (const includeInternal of [false, true]) {
        const formatted = formatVisualMoment(row, { includeInternal });
        expect(formatted).not.toHaveProperty('youtubeOk');
        expect(formatted).not.toHaveProperty('youtubeOkAt');
        expect(JSON.stringify(formatted)).not.toMatch(/youtube/i);
      }
      expect(youtubeOkFields(row)).toEqual({ youtubeOk: true, youtubeOkAt: at });
      expect(youtubeOkFields({ id: 'm', youtube_ok_at: null })).toEqual({ youtubeOk: false, youtubeOkAt: null });
    });
  });

  describe('clip week count', () => {
    function fakeKnex(count) {
      const seen = { where: null, raw: [] };
      const q = {
        where(c) { seen.where = c; return q; },
        whereNull() { return q; },
        whereNotNull() { return q; },
        whereRaw(sql, bindings) { seen.raw.push([sql, bindings]); return q; },
        count() { return q; },
        first() { return Promise.resolve({ n: String(count) }); },
      };
      return { knex: () => q, seen };
    }

    test.each([
      ['Sunday 11:30 PM ET is still the old week', '2026-11-23T04:30:00Z', '2026-11-16'],
      ['Monday 00:10 ET starts the new week', '2026-11-23T05:10:00Z', '2026-11-23'],
      ['fall-back Sunday (DST ends) belongs to the week before', '2026-11-01T12:00:00Z', '2026-10-26'],
      ['Monday after fall-back', '2026-11-02T05:10:00Z', '2026-11-02'],
      ['spring-forward Sunday belongs to the week before', '2026-03-08T15:00:00Z', '2026-03-02'],
    ])('%s', async (_name, nowIso, weekStart) => {
      const { knex, seen } = fakeKnex(2);
      const out = await countOkClipsThisWeek('tech-1', { knex, now: new Date(nowIso) });
      expect(out).toEqual({ weekStart, okClips: 2, goalMin: 1, goalMax: 3 });
      expect(seen.where).toEqual({ technician_id: 'tech-1', media_type: 'video' });
      expect(seen.raw.every(([sql, b]) => sql.includes('America/New_York') && b[0] === weekStart)).toBe(true);
    });

    test('no technician id counts zero without a query', async () => {
      const knex = () => { throw new Error('no query expected'); };
      await expect(countOkClipsThisWeek(null, { knex, now: new Date('2026-11-24T15:00:00Z') }))
        .resolves.toMatchObject({ okClips: 0, goalMin: 1, goalMax: 3 });
    });
  });
});

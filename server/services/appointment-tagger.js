const db = require('../models/db');
const { sendCustomerMessage } = require('./messaging/send-customer-message');
const logger = require('./logger');
const MODELS = require('../config/models');
const { dispatchWithFallback } = require('./llm/call');
const { lookupPropertyFromAITrio } = require('./property-lookup/ai-property-lookup');
const { sendNewRecurringWelcome, isNewRecurringSignupCandidate } = require('./new-recurring-welcome-sms');
const { renderSmsTemplate } = require('./sms-template-renderer');
const { isEnabled } = require('../config/feature-gates');
const { formatDisplayDate, dateOnlyString } = require('../utils/date-only');
const { etDateString } = require('../utils/datetime-et');
const { portalUrl } = require('../utils/portal-url');

// Pest types whose booking triggers an automatic prep guide email
// (email_template_automations, appointment.booked trigger).
const PREP_AUTOMATION_BY_PEST_TYPE = Object.freeze({
  cockroach: 'prep.cockroach',
  bed_bug: 'prep.bed_bug',
  flea: 'prep.flea',
});

// Pest types whose FIRST-TIME booking also auto-enrolls the customer in the
// matching Automations-tab sequence (automation_templates — the SendGrid
// runner sends steps per their delays). Separate stack from the transactional
// prep guide above. Wire a pest by adding its template key here; the
// treatmentAutomationEnroll gate stays the single kill switch. german_roach
// bookings route through pestType 'cockroach' (onServiceScheduled), so they
// enroll the cockroach sequence too.
const TREATMENT_AUTOMATION_BY_PEST_TYPE = Object.freeze({
  bed_bug: 'bed_bug',
  cockroach: 'cockroach',
  flea: 'flea',
});

// Mirrors ASSIGNMENT_TERMINAL_STATUSES in routes/admin-schedule.js — an
// appointment in any of these states is no longer an upcoming visit
// (rescheduled rows are phantom placeholders kept while staff rebooks).
const PREP_TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'rescheduled', 'skipped', 'no_show']);

class AppointmentTagger {

  // opts.suppressWelcome skips the new-recurring welcome branch. Callers
  // pass it when the triggering row is not a fresh booking they own the
  // welcome decision for: the admin regenerate-brief endpoint replays old
  // appointments, and the estimate-accept route can reuse an existing
  // appointment row AND already fires the converter's pre-conversion-gated
  // welcome post-commit. The welcome's history checks are scoped to rows
  // created before the triggering booking, which is only meaningful for a
  // just-inserted row. Prep flows carry their own dedupe and always run.
  async onServiceScheduled(scheduledServiceId, { suppressWelcome = false } = {}) {
    const service = await db('scheduled_services')
      .where('scheduled_services.id', scheduledServiceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name',
        'customers.phone', 'customers.email', 'customers.address_line1',
        'customers.city', 'customers.zip', 'customers.waveguard_tier',
        'customers.nearest_location_id')
      .first();

    if (!service) return;

    const type = this.classifyAppointmentType(service.service_type);
    await db('scheduled_services').where({ id: scheduledServiceId }).update({ appointment_type: type.tag });

    try {
      switch (type.tag) {
        case 'wdo_inspection': await this.triggerWDOPrep(service); break;
        case 'german_roach': case 'cockroach': await this.triggerPestPrep(service, 'cockroach'); break;
        case 'bed_bug': await this.triggerPestPrep(service, 'bed_bug'); break;
        case 'flea': await this.triggerPestPrep(service, 'flea'); break;
      }
    } catch (err) {
      logger.error('[appointment-tagger] Appointment automation failed', {
        appointmentType: type.tag,
        serviceId: scheduledServiceId,
        errorName: err?.name || 'Error',
      });
    }

    // Welcome text on the customer's first RECURRING service. All WaveGuard
    // tiers are included (Bronze too) so the experience matches the
    // estimate-converter self-accept path; the is_recurring guard keeps the
    // auto_new_recurring text off one-time/standalone first appointments
    // (onServiceScheduled runs for those jobs as well). New-customer
    // candidacy uses the same shared gate as every other booking path,
    // scoped to history that predates this booking — a raw service_records
    // count is blind to imported customers whose visit history lives only
    // in scheduled_services (2026-07-16 misfire). Idempotent via
    // sendNewRecurringWelcome.
    if (!suppressWelcome && service.waveguard_tier && service.is_recurring) {
      const isNewSignup = await isNewRecurringSignupCandidate(service.customer_id, {
        excludeServiceId: service.id,
      });
      if (isNewSignup) {
        await this.triggerWelcomeSequence(service);
      }
    }
  }

  classifyAppointmentType(serviceType) {
    const s = (serviceType || '').toLowerCase();
    if (s.includes('wdo') || s.includes('wood destroying') || s.includes('termite inspection') || s.includes('real estate inspection')) return { tag: 'wdo_inspection', label: 'WDO Inspection' };
    if (s.includes('german') || (s.includes('roach') && s.includes('interior'))) return { tag: 'german_roach', label: 'German Roach Treatment' };
    if (s.includes('cockroach') || s.includes('roach')) return { tag: 'cockroach', label: 'Cockroach Treatment' };
    if (s.includes('bed bug')) return { tag: 'bed_bug', label: 'Bed Bug Treatment' };
    if (s.includes('flea')) return { tag: 'flea', label: 'Flea Treatment' };
    if (s.includes('fumigat') || s.includes('tent')) return { tag: 'tent_fumigation', label: 'Tent Fumigation' };
    if (s.includes('termite') && !s.includes('inspect') && !s.includes('monitor')) return { tag: 'termite_treatment', label: 'Termite Treatment' };
    if (s.includes('rodent') && s.includes('exclusion')) return { tag: 'rodent_exclusion', label: 'Rodent Exclusion' };
    if (s.includes('mosquito')) return { tag: 'mosquito', label: 'Mosquito Treatment' };
    if (s.includes('lawn') || s.includes('turf')) return { tag: 'lawn', label: 'Lawn Care' };
    if (s.includes('tree') || s.includes('shrub')) return { tag: 'tree_shrub', label: 'Tree & Shrub' };
    if (s.includes('pest')) return { tag: 'pest_general', label: 'Pest Control' };
    return { tag: 'general', label: 'General Service' };
  }

  // WDO — AI property search + AI pre-inspection brief
  async triggerWDOPrep(service) {
    const address = `${service.address_line1}, ${service.city}, FL ${service.zip}`;

    try {
      const propertyData = await lookupPropertyFromAITrio(address).catch((err) => {
        logger.warn('[appointment-tagger] WDO property search failed', {
          serviceId: service.id,
          errorName: err?.name || 'Error',
        });
        return null;
      });

      // Generate brief — AI when EITHER provider key exists
      // (dispatchWithFallback handles a per-provider no_key miss);
      // deterministic template only when no provider is configured.
      let brief;
      if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
        brief = await this.generateWDOBriefAI(service, propertyData);
      } else {
        brief = this.generateWDOBriefTemplate(service, propertyData);
      }

      await db('scheduled_services').where({ id: service.id }).update({
        pre_service_brief: JSON.stringify(brief),
        pre_service_brief_type: 'wdo_inspection',
        pre_service_brief_generated_at: new Date(),
      });

      await db('customer_interactions').insert({
        customer_id: service.customer_id, interaction_type: 'note',
        subject: 'WDO pre-inspection brief generated',
        body: `Risk: ${brief.risk_score}. Priorities: ${(brief.top_3_priorities || []).join(', ')}`,
      });

      logger.info('[appointment-tagger] WDO brief generated', { serviceId: service.id });
    } catch (err) {
      logger.error('[appointment-tagger] WDO prep failed', {
        serviceId: service.id,
        errorName: err?.name || 'Error',
      });
    }
  }

  generateWDOBriefTemplate(service, rc) {
    const yearBuilt = rc?.yearBuilt || 'Unknown';
    const sqft = rc?.squareFootage || 'Unknown';
    const stories = rc?.stories || 1;
    const foundation = rc?.foundationType || 'Unknown';
    const exterior = rc?.exteriorType || rc?.constructionMaterial || 'Unknown';
    const pool = rc?.features?.pool || rc?.hasPool || false;
    const garage = rc?.garageType || 'Unknown';

    const age = yearBuilt !== 'Unknown' ? new Date().getFullYear() - parseInt(yearBuilt) : null;
    let riskScore = 'Low';
    const vulnerabilities = [];

    if (age && age > 20) { riskScore = 'Moderate'; vulnerabilities.push('Structure 20+ years old — increased exposure time'); }
    if (age && age > 40) { riskScore = 'High'; vulnerabilities.push('Structure 40+ years old — significantly increased risk'); }
    if (String(foundation).toLowerCase().includes('slab')) vulnerabilities.push('Slab foundation — concealed below-grade termite entry possible');
    if (String(exterior).toLowerCase().includes('stucco')) vulnerabilities.push('Stucco exterior — may mask moisture damage at penetrations');
    if (String(exterior).toLowerCase().includes('wood')) { riskScore = 'High'; vulnerabilities.push('Wood exterior — direct WDO target'); }
    if (pool) vulnerabilities.push('Pool area — increased moisture, conducive conditions near deck/cage');

    if (vulnerabilities.length >= 3) riskScore = 'High';
    else if (vulnerabilities.length >= 1) riskScore = 'Moderate';

    return {
      property_summary: { address: `${service.address_line1}, ${service.city}, FL ${service.zip}`, yearBuilt, sqft, stories, foundation, exterior, pool, garage },
      risk_score: riskScore,
      risk_reason: vulnerabilities.length ? vulnerabilities[0] : 'No significant risk factors identified from available data.',
      top_3_priorities: [
        'Inspect foundation perimeter and slab edges for mud tubes',
        `Check ${exterior} to foundation transition for moisture entry`,
        'Inspect garage, utility penetrations, and any wood-to-soil contact',
      ],
      top_3_unknowns: [
        'Prior termite treatment history (ask homeowner)',
        'Attic accessibility and condition',
        'Any additions or modifications since original construction',
      ],
      vulnerabilities,
      homeowner_questions: [
        'Any prior termite treatment or bait stations?',
        'History of roof leaks or plumbing leaks?',
        'Is the attic fully accessible?',
        'Any wood fencing, pergola, or detached structures?',
        'Any areas where you\'ve noticed moisture or soft wood?',
      ],
      property_data: rc ? { yearBuilt: rc.yearBuilt, sqft: rc.squareFootage, lot: rc.lotSize, stories: rc.stories, foundation: rc.foundationType, exterior } : null,
    };
  }

  async generateWDOBriefAI(service, rc) {
    try {
      const resp = await dispatchWithFallback(MODELS.TEXT_POLICIES.deepAnalysis, {
        // Documented DEEP floor — MODEL_DEEP may point at a thinking model
        // (fable line) where thinking spends from the same token budget.
        maxTokens: 4096,
        jsonMode: true,
        system: 'You are a pre-inspection research assistant for a Florida pest control company. Analyze public property data and return a JSON WDO pre-inspection brief with: risk_score (Low/Moderate/High), risk_reason, top_3_priorities, top_3_unknowns, vulnerabilities, homeowner_questions. Return VALID JSON ONLY.',
        text: `WDO brief for ${service.address_line1}, ${service.city}, FL ${service.zip}. Client: ${service.first_name} ${service.last_name}. Date: ${service.scheduled_date}.\n\nProperty data: ${JSON.stringify(rc)}`,
      });
      if (!resp.ok || !resp.json) throw new Error('WDO brief providers unavailable');
      return resp.json;
    } catch (err) {
      logger.error('[appointment-tagger] AI WDO brief failed', {
        serviceId: service.id,
        errorName: err?.name || 'Error',
      });
      return this.generateWDOBriefTemplate(service, rc);
    }
  }

  // Pest prep — email prep guide (prep.cockroach / prep.bed_bug / prep.flea
  // automations) plus a treatment-prep SMS. First-time treatments only (owner
  // directive 2026-07-06): a follow-up booking in the same infestation series
  // must not re-send "let's get started" prep messaging.
  //
  // Which SMS copy sends depends on whether the email queued:
  //   • email queued → companion text pointing to the emailed guide
  //     (auto_bed_bug / auto_cockroach / auto_flea).
  //   • no email on file (phone-only customer, e.g. a manual-SMS booking)
  //     with the visit still upcoming/open → self-contained prep text that
  //     carries the steps inline (auto_*_no_email), so these customers still
  //     get prep instead of nothing.
  //   • any other non-queue reason (gate off, terminal/past visit, dedupe,
  //     inactive automation, error) → no SMS, matching the email decision.
  async triggerPestPrep(service, pestType) {
    if (await this.hasPriorSameTypeBooking(service, pestType)) return;

    // Exactly ONE guide email per first-time booking (owner directive
    // 2026-07-11: two is overkill). For sequence-wired pests with the gate on,
    // the Automations-tab sequence IS that email — its step-0 carries the prep
    // guide, editable in the tab — so the transactional prep.<pest> email is
    // skipped and the SMS legs key off the enrollment instead. Gate off (or an
    // unwired pest) runs the transactional lane unchanged, so unsetting
    // GATE_TREATMENT_AUTOMATION_ENROLL reverts to the proven prep email.
    //
    // The companion SMS copy asserts "we emailed your treatment guide" — only
    // send it when the guide email actually queued (either source). When the
    // email was skipped solely because there's no email on file, fall back to
    // the self-contained prep text instead. Codex review 2026-07-06.
    const sequenceWired = !!TREATMENT_AUTOMATION_BY_PEST_TYPE[pestType] && isEnabled('treatmentAutomationEnroll');
    const emailResult = sequenceWired
      ? await this.enrollTreatmentSequence(service, pestType)
      : await this.triggerPrepEmailGuide(service, pestType);
    let smsVariant;
    if (emailResult.queued) {
      smsVariant = 'companion';
    } else if (emailResult.reason === 'no_email') {
      smsVariant = 'standalone';
    } else {
      return;
    }

    // Idempotency: onServiceScheduled can be replayed (e.g. regenerate-brief
    // re-runs it). The email leg dedupes itself on appointment_booked:<id>,
    // but the SMS leg's only guard is the prep-SMS marker interaction. A prior
    // marker suppresses BOTH variants: the standalone (no per-appointment
    // guard at all) and the companion (a customer who already got the
    // self-contained steps — automated or via the manual Communications button
    // — must not get a second prep text when an email lands later; the queued
    // guide email alone is the right follow-up).
    if (smsVariant === 'companion') {
      if (await this.hasSentPrepSms(service.customer_id, pestType)) return;
      await this.sendPrepSmsAndLog(service, pestType, smsVariant);
      return;
    }

    // Standalone path: serialize concurrent runs for the same customer + pest
    // (booking hook racing a near-simultaneous regenerate-brief) so both can't
    // pass the marker check before either writes it. The advisory lock is
    // released when the transaction that inserted the marker commits.
    await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`prep_sms:${service.customer_id}:${pestType}`]);
      if (await this.hasSentPrepSms(service.customer_id, pestType, trx)) return;
      await this.sendPrepSmsAndLog(service, pestType, smsVariant, trx);
    });
  }

  // Renders + sends the prep SMS and writes the prep-SMS marker interaction.
  // `dbh` lets the standalone path write the marker inside its dedupe
  // transaction; the companion path uses the default connection.
  async sendPrepSmsAndLog(service, pestType, smsVariant, dbh = db) {
    const prepSMS = await this.getPrepSMS(pestType, service, smsVariant);
    if (!prepSMS) return;

    const prepResult = await sendCustomerMessage({
      to: service.phone,
      body: prepSMS,
      channel: 'sms',
      audience: 'customer',
      purpose: 'appointment',
      customerId: service.customer_id,
      appointmentId: service.id,
      identityTrustLevel: 'phone_matches_customer',
      metadata: { original_message_type: 'prep_info', pest_type: pestType, prep_variant: smsVariant },
    });
    if (!prepResult.sent) {
      logger.warn(`[appointment-tagger] Prep SMS blocked/failed for customer ${service.customer_id}: ${prepResult.code || prepResult.reason || 'unknown'}`);
      return;
    }

    // Beehiiv tag if email available
    if (service.email && process.env.BEEHIIV_API_KEY) {
      try {
        await fetch(`https://api.beehiiv.com/v2/publications/${process.env.BEEHIIV_PUBLICATION_ID}/subscriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.BEEHIIV_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: service.email, reactivate_existing: true, send_welcome_email: false,
            tags: [`prep_${pestType}`],
            custom_fields: [{ name: 'first_name', value: service.first_name }, { name: 'service_date', value: service.scheduled_date }],
          }),
        });
      } catch (e) { logger.error(`Beehiiv tag failed: ${e.message}`); }
    }

    await dbh('customer_interactions').insert({
      customer_id: service.customer_id, interaction_type: 'sms_outbound',
      subject: `${pestType} prep info sent`,
      body: smsVariant === 'standalone'
        ? `Prep SMS sent for ${pestType} treatment (self-contained; no email on file).`
        : `Prep SMS sent for ${pestType} treatment.`,
    });
  }

  // Automations-tab sequence enrollment — for wired pests with the gate on,
  // this REPLACES triggerPrepEmailGuide as the guide-email source (one email
  // per booking; the sequence's step-0 carries the prep guide, editable in the
  // tab). Returns the same { queued, reason } contract so triggerPestPrep's
  // SMS logic (companion on queued / standalone on no_email / silence
  // otherwise) works identically for both sources.
  // Guards, in order:
  //   • upcoming open visits only — regenerate-brief replays onServiceScheduled
  //     for past/cancelled jobs too (same terminal/past rule as the
  //     transactional path); first-time-only is checked by the caller;
  //   • once EVER per customer+template from this hook: enrollCustomer alone
  //     only no-ops while an enrollment is ACTIVE, so a replay after the
  //     sequence completed would reactivate and re-send — skip when any prior
  //     enrollment row exists. The manual Send button intentionally keeps
  //     re-send ability (it calls the route, not this hook).
  // Recipient routes like prep: service contact first (the on-site person),
  // then primary. Sequences are SendGrid emails, so a phone-only customer
  // reports 'no_email' — but only while the sequence is actually sendable
  // (template enabled + real step content); a paused/empty sequence silences
  // BOTH channels, same kill-switch parity the transactional path has.
  async enrollTreatmentSequence(service, pestType) {
    const templateKey = TREATMENT_AUTOMATION_BY_PEST_TYPE[pestType] || null;
    if (!templateKey) return { queued: false, reason: 'no_automation' };
    if (!isEnabled('treatmentAutomationEnroll')) return { queued: false, reason: 'gate_off' };
    if (!service.customer_id) return { queued: false, reason: 'not_queued' };

    const status = String(service.status || '').toLowerCase();
    if (PREP_TERMINAL_STATUSES.has(status)) return { queued: false, reason: 'terminal' };
    const serviceDateStr = dateOnlyString(service.scheduled_date);
    if (!serviceDateStr || serviceDateStr < etDateString()) return { queued: false, reason: 'past' };

    try {
      // Read-only prechecks run BEFORE the lock transaction so the locked
      // connection never waits on a second pooled connection (concurrent
      // enrollments each pinning one connection while needing another can
      // starve a saturated pool).
      //
      // Sendability first: enrollCustomer only requires an enabled step, but
      // the scheduler starts at step 0 and skips empty bodies — the FIRST
      // enabled step must carry the guide, or the companion text promises an
      // email that isn't the guide (or nothing sends at all).
      if (!(await this.isTreatmentSequenceSendable(templateKey))) {
        return { queued: false, reason: 'not_queued' };
      }

      const { resolveProjectEmailRecipient } = require('./project-email');
      const customer = await db('customers').where({ id: service.customer_id }).first();
      const recipient = customer
        ? resolveProjectEmailRecipient(customer)
        : { email: String(service.email || '').trim(), name: String(service.first_name || '').trim() };
      if (!recipient.email) {
        logger.info(`[appointment-tagger] No valid email on file; ${templateKey} sequence enrollment skipped for service ${service.id}`);
        // Sequence confirmed sendable above — the phone-only standalone
        // fallback may fire.
        return { queued: false, reason: 'no_email' };
      }
      const nameParts = String(recipient.name || '').trim().split(/\s+/).filter(Boolean);

      // Serialize per customer+template: two overlapping hooks (booking racing
      // a regenerate-brief replay) could both pass the prior-enrollment check —
      // enrollCustomer's onConflict-merge reports enrolled:true to BOTH, and
      // each would send a companion SMS. Everything inside runs on the trx
      // (enrollCustomer takes dbh), so the lock holder needs no second pooled
      // connection.
      const outcome = await db.transaction(async (trx) => {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`treatment_enroll:${service.customer_id}:${templateKey}`]);

        // Once per customer — but only rows that delivered (or still can):
        // 'active'/'completed' (including an operator's manual tab-send),
        // 'cancelled' (unsub/bounce — a re-enroll would be re-cancelled at
        // send time while the companion falsely claims an email is coming),
        // and a 'failed' row that already sent at least one step
        // (last_sent_at set — the guide went out before a later step
        // errored; re-enrolling would resend it). Only a failed row that
        // never sent anything may be retried by a new first-time booking.
        const priorEnrollment = await trx('automation_enrollments')
          .where({ template_key: templateKey, customer_id: service.customer_id })
          .where(function priorDelivered() {
            this.whereNot('status', 'failed').orWhereNotNull('last_sent_at');
          })
          .first('id');
        if (priorEnrollment) return { queued: false, reason: 'not_queued' };

        const AutomationRunner = require('./automation-runner');
        const result = await AutomationRunner.enrollCustomer({
          templateKey,
          customer: {
            id: service.customer_id,
            email: recipient.email,
            first_name: nameParts[0] || service.first_name || null,
            last_name: nameParts.slice(1).join(' ') || service.last_name || null,
          },
          dbh: trx,
        });
        if (result?.enrolled) {
          logger.info(`[appointment-tagger] enrolled customer ${service.customer_id} in ${templateKey} sequence (service ${service.id})`);
          return { queued: true, reason: 'queued' };
        }
        // disabled template / no steps / already active — no guide email is
        // coming from this run, so the SMS stays silent too.
        return { queued: false, reason: 'not_queued' };
      });
      if (outcome?.queued) {
        // Sequence-lane parity with the transactional lane: mint the
        // visit's public prep token now (outside the lock transaction — the
        // lock holder must not pin a second pooled connection). The
        // automation-runner stamps prep_sent_at on this row when the
        // step-0 guide actually sends, which is what lights up the
        // tracker's prep link. Fail-soft.
        try {
          const { ensureServicePrepToken } = require('./project-email');
          await ensureServicePrepToken(service.id, PREP_AUTOMATION_BY_PEST_TYPE[pestType]);
        } catch (tokenErr) {
          logger.warn(`[appointment-tagger] prep token mint failed for service ${service.id}: ${tokenErr.message}`);
        }
      }
      return outcome;
    } catch (err) {
      logger.error(`[appointment-tagger] ${templateKey} sequence enroll failed for service ${service.id}: ${err.message}`);
      return { queued: false, reason: 'error' };
    }
  }

  // True only when the sequence would actually send the GUIDE: template
  // enabled AND the FIRST enabled step has real content. hasLocalContent
  // accepts a contentful step anywhere in the sequence, but the runner starts
  // at step 0 — a later-step-only sequence would make the companion text
  // promise a guide email that isn't what sends (or nothing sends soon).
  // Mirrors isPrepAutomationActive for the transactional path — the
  // standalone no-email SMS must respect the same pause as the email channel.
  // Fails CLOSED.
  async isTreatmentSequenceSendable(templateKey) {
    try {
      const template = await db('automation_templates').where({ key: templateKey }).first();
      if (!template || !template.enabled) return false;
      const firstStep = await db('automation_steps')
        .where({ template_key: templateKey, enabled: true })
        .orderBy('step_order', 'asc')
        .first();
      return !!(firstStep && (String(firstStep.html_body || '').trim() || String(firstStep.text_body || '').trim()));
    } catch (err) {
      logger.warn(`[appointment-tagger] sequence sendable-check failed for ${templateKey}: ${err.message}`);
      return false;
    }
  }

  // Emit the appointment.booked trigger for the matching prep automation
  // (email_template_automations). The run is queued and sent by the
  // every-minute automation scheduler tick — not inline — so appointment
  // creation stays fast and sends get the executor's retry policy. The
  // automation's own conditions (service_type_contains) and exit checks
  // (appointment.cancelled, re-evaluated against the live row at send time)
  // still apply, and the once-per-appointment idempotency key makes re-runs
  // of onServiceScheduled (e.g. regenerate-brief) safe.
  // Returns { queued, reason }. queued is true only when the prep-guide email
  // automation was queued — the companion SMS copy depends on it. reason lets
  // triggerPestPrep tell the "no email on file" case (fall back to the
  // self-contained prep SMS, since the visit is still upcoming/open by the
  // time that check is reached) apart from the gate/terminal/past/dedupe cases
  // (send nothing).
  async triggerPrepEmailGuide(service, pestType) {
    const automationKey = PREP_AUTOMATION_BY_PEST_TYPE[pestType] || null;
    if (!automationKey) return { queued: false, reason: 'no_automation' };
    if (!isEnabled('emailTemplateAutomations')) return { queued: false, reason: 'gate_off' };

    // Upcoming open visits only: regenerate-brief re-runs onServiceScheduled
    // for past/closed appointments too, and "prepare for your treatment"
    // must never land after the visit. The automation's exit conditions
    // (appointment.closed / appointment.past) re-check this against the live
    // row at send time for queued runs.
    const status = String(service.status || '').toLowerCase();
    if (PREP_TERMINAL_STATUSES.has(status)) return { queued: false, reason: 'terminal' };
    const serviceDateStr = dateOnlyString(service.scheduled_date);
    if (!serviceDateStr || serviceDateStr < etDateString()) return { queued: false, reason: 'past' };

    try {
      // Route like the other prep/project emails: service contact first (the
      // on-site person who actually does the prep), then primary contact.
      const { resolveProjectEmailRecipient } = require('./project-email');
      const customer = service.customer_id
        ? await db('customers').where({ id: service.customer_id }).first()
        : null;
      const recipient = customer
        ? resolveProjectEmailRecipient(customer)
        : { email: String(service.email || '').trim(), name: String(service.first_name || '').trim(), role: 'primary' };
      if (!recipient.email) {
        logger.info(`[appointment-tagger] No valid email on file; ${automationKey} prep email skipped for service ${service.id}`);
        // The no-email standalone-SMS fallback fires on reason:'no_email'. But
        // this check runs BEFORE processTrigger, so a disabled/inactive
        // automation is not yet observed — an email-capable customer would get
        // zero executor results (no SMS), so a phone-only customer must be held
        // to the same pause. Only advertise 'no_email' when the automation is
        // actually active; otherwise report 'not_queued' so no standalone sends.
        const active = await this.isPrepAutomationActive(automationKey);
        return { queued: false, reason: active ? 'no_email' : 'not_queued' };
      }
      const firstName = String(recipient.name || '').trim().split(/\s+/)[0]
        || String(service.first_name || '').trim()
        || 'there';

      const executor = require('./email-template-automation-executor');
      // Tokened public prep page (2026-07-14 audit): the guide email's CTA
      // must land on the durable, printable /prep/:token page — not the
      // login-gated portal visits tab. Mint fails soft: a token hiccup
      // degrades the CTA back to the portal link rather than blocking the
      // send.
      const portalVisitsUrl = portalUrl('/?tab=visits');
      let prepUrl = portalVisitsUrl;
      try {
        const { ensureServicePrepToken } = require('./project-email');
        prepUrl = portalUrl(`/prep/${await ensureServicePrepToken(service.id, automationKey)}`);
      } catch (tokenErr) {
        logger.warn(`[appointment-tagger] prep token mint failed for service ${service.id}: ${tokenErr.message}`);
      }
      const trigger = await executor.processTrigger({
        triggerEventKey: 'appointment.booked',
        triggerEventId: `appointment_booked:${service.id}`,
        automationKey,
        entityType: 'scheduled_service',
        entityId: service.id,
        recipient: { email: recipient.email, type: 'customer', id: service.customer_id || '' },
        payload: {
          scheduled_service_id: service.id,
          customer_id: service.customer_id || '',
          customer_email: recipient.email,
          first_name: firstName,
          service_type: service.service_type || '',
          project_type: this.classifyAppointmentType(service.service_type).label,
          service_date: formatDisplayDate(service.scheduled_date, { fallback: '' }),
          service_date_ymd: serviceDateStr,
          property_address: [service.address_line1, service.city, service.zip].filter(Boolean).join(', '),
          prep_url: prepUrl,
          customer_portal_url: portalVisitsUrl,
        },
        executeImmediately: false,
      });
      // "Queued" means a NEW run was created and not condition-skipped —
      // an inactive automation (zero results), an idempotency dedupe
      // (re-run of the same appointment), or a skipped run means no guide
      // email is coming, so the companion SMS that references it must not send.
      // These are NOT the "no email on file" case, so no standalone fallback
      // either — a disabled automation or a re-run should stay silent.
      // No prep_sent_at stamp here: "queued" is not "delivered" — the
      // executor stamps it (markServicePrepSent) when the run actually
      // reaches 'sent', so the tracker never links a guide that a later
      // skip/suppress/failure kept from the customer.
      const queued = (trigger?.results || []).some(
        (r) => !r.deduped && String(r.run?.status || '') !== 'skipped',
      );
      return { queued, reason: queued ? 'queued' : 'not_queued' };
    } catch (err) {
      logger.error(`[appointment-tagger] Prep email automation failed for service ${service.id}: ${err.message}`);
      return { queued: false, reason: 'error' };
    }
  }

  // True only when the prep automation for this key is live. Matches the
  // executor's own selector (email_template_automations, trigger
  // appointment.booked, status 'active') so the standalone-SMS fallback
  // respects the same per-prep pause the email path already honors. Fails
  // CLOSED — if we can't confirm the automation is active, don't send (the
  // email path fails closed on the same lookup error too, so both channels
  // stay silent together and the kill switch is never bypassed on a hiccup).
  async isPrepAutomationActive(automationKey) {
    try {
      const row = await db('email_template_automations')
        .where({ automation_key: automationKey, trigger_event_key: 'appointment.booked', status: 'active' })
        .first('id');
      return !!row;
    } catch (err) {
      logger.warn(`[appointment-tagger] prep automation active-check failed for ${automationKey}: ${err.message}`);
      return false;
    }
  }

  // True when this customer already had an earlier booking of the same pest
  // family — the prep messaging is for first-time treatments only. Prior rows
  // carry the appointment_type tag this tagger stamped when they were booked
  // (german_roach and cockroach are the same family for prep purposes).
  // Cancelled rows don't count (the customer never got that visit);
  // rescheduled placeholders and completed visits do.
  async hasPriorSameTypeBooking(service, pestType) {
    const PREP_FAMILY_TAGS = {
      cockroach: ['german_roach', 'cockroach'],
      bed_bug: ['bed_bug'],
      flea: ['flea'],
    };
    const tags = PREP_FAMILY_TAGS[pestType];
    if (!service?.customer_id || !tags) return false;
    try {
      const prior = await db('scheduled_services')
        .where({ customer_id: service.customer_id })
        .whereIn('appointment_type', tags)
        .whereNot('id', service.id)
        .whereNotIn('status', ['cancelled'])
        .where('created_at', '<', service.created_at || new Date())
        .first('id');
      return !!prior;
    } catch (err) {
      // Fail open (treat as first-time) — a lookup hiccup must not silently
      // drop prep messaging for a genuine first treatment.
      logger.warn(`[appointment-tagger] prior-booking lookup failed for service ${service.id}: ${err.message}`);
      return false;
    }
  }

  // True when a prep SMS for this customer + pest was already logged — the
  // SMS leg's replay guard. Matches the marker interaction written by
  // sendPrepSmsAndLog above AND by the manual Communications send
  // (prep-guide-sender writes the same subject when its SMS goes out, so a
  // manual send suppresses a later automated replay too). Fails OPEN (a check
  // hiccup must not drop a genuine first-time send); the realistic replay
  // vector (regenerate-brief after a successful send) always has the marker,
  // so the fail-open window is limited to the rare case where the marker
  // write itself failed.
  async hasSentPrepSms(customerId, pestType, dbh = db) {
    if (!customerId) return false;
    try {
      const row = await dbh('customer_interactions')
        .where({ customer_id: customerId, interaction_type: 'sms_outbound', subject: `${pestType} prep info sent` })
        .first('id');
      return !!row;
    } catch (err) {
      logger.warn(`[appointment-tagger] prep-SMS dedupe check failed for customer ${customerId}: ${err.message}`);
      return false;
    }
  }

  async getPrepSMS(pestType, service, variant = 'companion') {
    // Deliberately date-free: the pest_prep_* predecessors embedded the
    // visit date, which went stale whenever the appointment moved (the
    // reason 20260602000002 removed them).
    //   • companion  → auto_*     — references the emailed treatment guide.
    //   • standalone → auto_*_no_email — carries the prep steps inline for a
    //     phone-only customer with no email to reference.
    const COMPANION_KEYS = { cockroach: 'auto_cockroach', bed_bug: 'auto_bed_bug', flea: 'auto_flea' };
    const STANDALONE_KEYS = {
      cockroach: 'auto_cockroach_no_email',
      bed_bug: 'auto_bed_bug_no_email',
      flea: 'auto_flea_no_email',
    };
    const templateKey = (variant === 'standalone' ? STANDALONE_KEYS : COMPANION_KEYS)[pestType] || null;
    if (!templateKey) return null;
    const body = await renderSmsTemplate(templateKey, {
      first_name: service.first_name || 'there',
    }, {
      workflow: 'appointment_tagger_prep',
      entity_type: 'scheduled_service',
      entity_id: service.id,
    });
    if (!body) {
      logger.warn(`[appointment-tagger] ${templateKey} template missing/disabled; prep SMS skipped for service ${service.id}`);
    }
    return body;
  }

  // Welcome sequence for new recurring customers
  async triggerWelcomeSequence(service) {
    const welcomeResult = await sendNewRecurringWelcome({
      customer: {
        id: service.customer_id,
        first_name: service.first_name,
        last_name: service.last_name,
        phone: service.phone,
      },
      scheduledServiceId: service.id,
      recurringPattern: service.recurring_pattern,
      entryPoint: 'appointment_tagger_welcome',
    });
    if (!welcomeResult.sent) {
      return;
    }
  }
}

module.exports = new AppointmentTagger();

const db = require('../models/db');
const RULES = require('../config/reschedule-rules');
const logger = require('./logger');

class SmartRebooker {
  async findRescheduleOptions(serviceId, reason) {
    const service = await db('scheduled_services')
      .where('scheduled_services.id', serviceId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select('scheduled_services.*', 'customers.first_name', 'customers.last_name',
        'customers.city', 'customers.zip', 'customers.waveguard_tier')
      .first();

    if (!service) throw new Error('Service not found');

    const options = [];
    const today = new Date();

    for (let d = 1; d <= 10; d++) {
      const candidateDate = new Date(today);
      candidateDate.setDate(today.getDate() + d);

      const dateStr = candidateDate.toISOString().split('T')[0];

      const dayLoad = await db('scheduled_services')
        .where('scheduled_date', dateStr)
        .whereIn('status', ['pending', 'confirmed'])
        .count('* as count').first();

      const nearbyServices = await db('scheduled_services')
        .where('scheduled_date', dateStr)
        .whereIn('status', ['pending', 'confirmed'])
        .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
        .select('customers.zip', 'customers.city');

      const sameAreaCount = nearbyServices.filter(s =>
        s.zip === service.zip || (s.city || '').toLowerCase() === (service.city || '').toLowerCase()
      ).length;

      let score = 100;
      const load = parseInt(dayLoad.count);
      if (load > 8) score -= 30;
      else if (load > 6) score -= 15;
      else if (load > 4) score -= 5;

      score += sameAreaCount * 10; // Route density bonus
      score += Math.max(0, (8 - d)) * 5; // Sooner is better
      if (candidateDate.getDay() === new Date(service.scheduled_date).getDay()) score += 8; // Same day of week

      const window = this.findBestWindow(service);

      options.push({
        date: dateStr,
        dayOfWeek: candidateDate.toLocaleDateString('en-US', { weekday: 'long' }),
        displayDate: candidateDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }),
        currentLoad: load,
        sameAreaServices: sameAreaCount,
        suggestedWindow: window,
        score,
      });
    }

    options.sort((a, b) => b.score - a.score);
    return options.slice(0, 3);
  }

  findBestWindow(service) {
    const s = (service.service_type || '').toLowerCase();
    if (s.includes('lawn') || s.includes('mosquito')) return { start: '08:00', end: '10:00', display: '8:00-10:00 AM' };
    return { start: '09:00', end: '12:00', display: '9:00 AM-12:00 PM' };
  }

  async reschedule(serviceId, newDate, newWindow, reason, initiatedBy) {
    const service = await db('scheduled_services').where({ id: serviceId }).first();
    if (!service) throw new Error('Service not found');

    const originalDate = service.scheduled_date;

    await db('scheduled_services').where({ id: serviceId }).update({
      scheduled_date: newDate,
      window_start: newWindow?.start || service.window_start,
      window_end: newWindow?.end || service.window_end,
      status: 'confirmed',
    });

    await db('reschedule_log').insert({
      scheduled_service_id: serviceId,
      customer_id: service.customer_id,
      original_date: originalDate,
      new_date: newDate,
      reason_code: reason,
      initiated_by: initiatedBy,
      original_window: service.window_start ? `${service.window_start}-${service.window_end}` : null,
      new_window: newWindow ? `${newWindow.start}-${newWindow.end}` : null,
    });

    // Check escalation
    const count = await db('reschedule_log')
      .where({ scheduled_service_id: serviceId })
      .count('* as count').first();

    if (parseInt(count.count) >= RULES.escalation.max_auto_reschedules_per_service) {
      const customer = await db('customers').where({ id: service.customer_id }).first();
      logger.warn(`Service ${serviceId} for ${customer.first_name} ${customer.last_name} has been rescheduled ${count.count} times — needs manual review`);
      await db('reschedule_log').where({ scheduled_service_id: serviceId }).orderBy('created_at', 'desc').first()
        .then(log => log && db('reschedule_log').where({ id: log.id }).update({ escalated: true }));
    }

    return { success: true, originalDate, newDate };
  }
}

module.exports = new SmartRebooker();

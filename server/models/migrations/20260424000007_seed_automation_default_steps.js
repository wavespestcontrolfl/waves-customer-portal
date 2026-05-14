/**
 * Seeds a starter step (step_order=0, delay_hours=0) for each automation
 * template so the local SendGrid sender has sendable content the moment
 * Beehiiv is removed. Each email is intentionally short, SWFL-flavored,
 * and uses {{first_name}} — operator can edit or AI-redraft in the
 * Automations editor at any time.
 *
 * Idempotent on (template_key, step_order) — re-running this migration
 * will not clobber operator edits because the unique constraint refuses
 * a second row at step_order=0, and the INSERT uses ON CONFLICT DO
 * NOTHING.
 */

const BRAND_FOOTER = `
<p>— The Waves Pest Control team</p>
<p style="color:#71717A;font-size:12px;margin-top:16px;">Reply to this email anytime — it goes straight to our team.</p>`;

const STEPS = [
  {
    template_key: 'new_recurring',
    subject: 'Welcome to Waves, {{first_name}} — here\'s what happens next',
    preview_text: 'A quick primer on your new service + what to expect on the first visit.',
    html_body: `<h2>Welcome aboard, {{first_name}}!</h2>
<p>We're glad to have you on our route. Here's the short version of what to expect from your new recurring service with Waves.</p>

<h2>What happens on our first visit</h2>
<p>Our tech will do a full perimeter inspection, treat the exterior and entry points, and sweep any cobwebs and wasp nests from around the house. Most first visits take 30–45 minutes.</p>

<h2>After that</h2>
<p>You'll get a text reminder the day before each service and a text when our truck is on the way. If we ever miss something or you spot new activity, reply to that text and we'll come back — no extra charge.</p>

<p>Questions before the first visit? Just reply to this email.</p>
${BRAND_FOOTER}`,
    text_body: 'Welcome aboard, {{first_name}}! Our tech will do a full perimeter inspection on the first visit, treat the exterior and entry points, and sweep cobwebs. You\'ll get a text reminder the day before each service. If you spot new activity between visits, reply to the text and we\'ll come back — no extra charge. — The Waves Pest Control team',
  },
  {
    template_key: 'lawn_service',
    subject: '{{first_name}}, your Waves lawn care plan — the 90-second primer',
    preview_text: 'What we\'ll do on the first visit + how to set your lawn up for results.',
    html_body: `<h2>Welcome to the Waves lawn program, {{first_name}}!</h2>
<p>SWFL lawns are tough to manage — sandy soil, heavy rain in summer, nitrogen blackout June through September. Our plan is built around what actually works in this climate.</p>

<h2>Before the first visit</h2>
<ul>
  <li>Mow at the tallest setting your mower allows (3.5–4" for St. Augustine)</li>
  <li>Water deeply 1–2x per week, early morning — skip if rain is forecast</li>
  <li>Don't apply any store-bought "weed & feed" between visits</li>
</ul>

<h2>What we'll do</h2>
<p>Fertilization, weed control, and pest/fungus treatments on a schedule tuned to the season. Chinch bugs and sod webworms peak in our service window, so expect focused treatment when we see pressure.</p>

<p>Reply with any questions about your yard — we're happy to take a look at photos.</p>
${BRAND_FOOTER}`,
    text_body: 'Welcome to the Waves lawn program, {{first_name}}! SWFL lawns are tough — sandy soil, heavy summer rain, nitrogen blackout June–Sept. Before the first visit: mow at 3.5–4", water deeply 1–2x per week early AM, and skip any store-bought weed & feed. We handle fertilization, weed control, and pest/fungus treatments on a seasonal schedule. Reply with photos if you have questions. — The Waves Pest Control team',
  },
  {
    template_key: 'new_appointment',
    subject: 'Your Waves appointment — what to expect',
    preview_text: 'A quick rundown so you know what happens on our visit.',
    html_body: `<h2>Hi {{first_name}} — thanks for booking with Waves</h2>
<p>Here's what you need to know before we show up.</p>

<h2>Timing</h2>
<p>We'll text you the day before to confirm and again when our truck is on the way. Most one-time visits take 30–60 minutes.</p>

<h2>Prep</h2>
<ul>
  <li>Put pets inside during the treatment</li>
  <li>Make sure side gates are unlocked</li>
  <li>If we're treating indoors, clear the counters and floors along the walls</li>
</ul>

<h2>After</h2>
<p>Wait about an hour after interior treatment before walking barefoot or letting pets back in. For exterior work, you can resume normal activity as soon as the product has dried (usually within 30 minutes).</p>

<p>Questions? Reply here.</p>
${BRAND_FOOTER}`,
    text_body: 'Hi {{first_name}} — thanks for booking with Waves. We\'ll text the day before and when our truck is on the way. Most visits take 30–60 minutes. Before we arrive: put pets inside, unlock side gates, and clear floors along walls for any interior work. After: wait ~1 hour before walking barefoot indoors or letting pets back in; exterior dries in ~30 minutes. — The Waves Pest Control team',
  },
  {
    template_key: 'bed_bug',
    subject: 'Your bed bug treatment prep guide',
    preview_text: 'Follow this checklist so the first treatment works the first time.',
    html_body: `<h2>Hi {{first_name}} — let's get your home bed bug-free</h2>
<p>Bed bug treatments work best when the home is prepped properly. This list isn't optional — skipping steps is the #1 reason a treatment needs a follow-up.</p>

<h2>Before we arrive</h2>
<ul>
  <li>Strip all bedding — sheets, pillowcases, comforters. Wash hot, dry hot for 30+ minutes.</li>
  <li>Vacuum mattresses, box springs, and the floor along baseboards. Empty the vacuum outside.</li>
  <li>Clear the floor of clutter (clothes, shoes, toys) in the affected rooms</li>
  <li>Pull furniture 12–18 inches from the walls</li>
  <li>Bag clean laundry in sealed plastic bags until the treatment is complete</li>
</ul>

<h2>Day of treatment</h2>
<p>Plan to be out of the home for 3–4 hours. Pets too — including fish tanks covered and pumps off for the duration.</p>

<h2>After</h2>
<p>We'll schedule a follow-up visit at 14 days to catch any eggs that hatched post-treatment. Don't re-wash bedding until after that second visit.</p>

<p>Reply to this email if anything on the list is unclear — we'd rather answer now than re-treat later.</p>
${BRAND_FOOTER}`,
    text_body: 'Hi {{first_name}} — let\'s get your home bed bug-free. Before we arrive: strip bedding (hot wash + hot dry 30+ min), vacuum mattresses/box springs/baseboards and empty the vacuum outside, clear floor clutter, pull furniture 12–18" from walls, bag clean laundry until treatment is done. Day of: be out 3–4 hours, pets too. Follow-up visit in 14 days. — The Waves Pest Control team',
  },
  {
    template_key: 'cockroach',
    subject: 'Your cockroach treatment prep guide',
    preview_text: 'Here\'s what to do before we arrive so the treatment hits hard.',
    html_body: `<h2>Hi {{first_name}} — let's clear out the roaches</h2>
<p>German cockroach treatments are more effective when their hiding spots are accessible. Spend 20 minutes on this and we'll spend 20 minutes less chasing them.</p>

<h2>Before we arrive</h2>
<ul>
  <li>Empty kitchen cabinets and drawers — especially under the sink</li>
  <li>Pull the fridge forward a foot if you can (they hide behind the motor)</li>
  <li>Clear countertops and wipe up grease + crumbs</li>
  <li>Remove pet food bowls and bag dry pet food in sealed containers</li>
  <li>Take trash out the morning of the visit</li>
</ul>

<h2>Day of</h2>
<p>Plan to be out of the kitchen for 2 hours after we apply the bait and gel. Pets out too. The product is non-repellent — roaches walk through it, go back to the nest, and spread it — so don't spray over-the-counter products between our visits or you'll scatter them without killing them.</p>

<h2>Follow-up</h2>
<p>We come back in 10–14 days to hit the second generation that hatches from existing eggs. Expect to still see a few roaches for the first 2–3 weeks — that's the bait working.</p>

<p>Questions? Reply here.</p>
${BRAND_FOOTER}`,
    text_body: 'Hi {{first_name}} — let\'s clear out the roaches. Before we arrive: empty kitchen cabinets (especially under sink), pull fridge forward a foot, clear and wipe counters, bag dry pet food, take trash out morning of. Day of: be out of kitchen 2 hrs after treatment, pets too. DON\'T spray store-bought sprays between our visits — you\'ll scatter them. Follow-up in 10–14 days. Expect to still see a few for 2–3 weeks — that\'s the bait working. — The Waves Pest Control team',
  },
  {
    template_key: 'new_lead',
    subject: 'Thanks for reaching out to Waves, {{first_name}}',
    preview_text: 'Here\'s what makes us different — and how we like to help.',
    html_body: `<h2>Hi {{first_name}} — thanks for your interest in Waves</h2>
<p>We're a family-owned pest control and lawn care company based right here in Bradenton. Our trucks run Manatee, Sarasota, and Charlotte counties — and our techs are the ones you'll actually see at your door.</p>

<h2>How we work</h2>
<ul>
  <li><strong>No commitment contracts.</strong> You can pause or cancel anytime.</li>
  <li><strong>No up-sells at the door.</strong> Quotes come from the office, not from whoever's at your house.</li>
  <li><strong>Free re-services.</strong> If you see activity between visits, we come back — no extra charge.</li>
</ul>

<h2>What's next</h2>
<p>If you'd like a quote or a free inspection, just reply to this email with your address and a good time for us to swing by. Or give us a call at <a href="tel:+19412101983">(941) 210-1983</a>.</p>
${BRAND_FOOTER}`,
    text_body: 'Hi {{first_name}} — thanks for your interest in Waves. We\'re a family-owned pest control + lawn care company in Bradenton, serving Manatee, Sarasota, and Charlotte counties. No commitment contracts. No door-step upsells. Free re-services between visits. Reply with your address and a good time and we\'ll swing by, or call (941) 210-1983. — The Waves Pest Control team',
  },
  {
    template_key: 'cold_lead',
    subject: 'Checking in, {{first_name}} — still thinking it over?',
    preview_text: 'No pressure. A few reasons folks come back to us later.',
    html_body: `<h2>Hi {{first_name}} — no pressure, just checking in</h2>
<p>We understand timing doesn't always work out. If pests or lawn issues pick up later, a few things worth knowing:</p>

<ul>
  <li>The quote we gave you is still good — no need to re-do paperwork</li>
  <li>First-month service is flat-rate; no hidden fees, no commitment</li>
  <li>We're local to Bradenton — if you're in Manatee, Sarasota, or Charlotte counties we can usually fit you in within a few days</li>
</ul>

<p>If now's not the right time, that's fine — we're not going anywhere. Reply here whenever you're ready, or just delete this email.</p>
${BRAND_FOOTER}`,
    text_body: 'Hi {{first_name}} — no pressure, just checking in. If pests or lawn issues pick up: your original quote is still good, first month is flat-rate, no commitment, and we can usually fit you in within a few days across Manatee/Sarasota/Charlotte. Reply when you\'re ready, or delete this email. — The Waves Pest Control team',
  },
  {
    template_key: 'service_renewal',
    subject: 'Your Waves service is coming up for renewal',
    preview_text: 'Nothing changes automatically — here\'s what to know.',
    html_body: `<h2>Hi {{first_name}} — quick renewal note</h2>
<p>Your current service term with Waves is coming up. There's nothing you need to do today — this is a heads-up, not a bill.</p>

<h2>What happens next</h2>
<p>We'll continue on the same schedule at your current rate unless you tell us otherwise. If you want to pause, change frequency, add lawn care, or drop a service, just reply to this email or call <a href="tel:+19412101983">(941) 210-1983</a>.</p>

<h2>If you've had a change of address or billing</h2>
<p>Let us know. We'd rather update it now than have a bounced payment or a missed visit.</p>

<p>Thanks for trusting us with your home.</p>
${BRAND_FOOTER}`,
    text_body: 'Hi {{first_name}} — your current service term with Waves is coming up. Nothing you need to do today. We\'ll continue on the same schedule at your current rate unless you tell us otherwise. To pause, change frequency, add services, or update billing/address, reply to this email or call (941) 210-1983. — The Waves Pest Control team',
  },
  {
    template_key: 'pricing_update',
    subject: 'A small update to your Waves service pricing',
    preview_text: 'Straightforward info on what\'s changing and why.',
    html_body: `<h2>Hi {{first_name}} — a note on pricing</h2>
<p>We don't like price letters any more than you do, so we'll keep this short.</p>

<p>Starting with your next service, your rate will be adjusted to reflect increased product and labor costs across SWFL. The change is modest and keeps us below what the national chains charge for equivalent service.</p>

<h2>What this changes</h2>
<p>Nothing about what we do. Same tech, same service, same free re-service guarantee. Same no-commitment policy — if the new rate doesn't work for you, reply and we'll cancel with no fee.</p>

<p>If you have questions, reply here and someone from the office will get back to you within a business day.</p>
${BRAND_FOOTER}`,
    text_body: 'Hi {{first_name}} — short note: starting next service, your rate is adjusting for increased product + labor costs. We stay below national chain pricing for equivalent service. Same tech, same free re-service guarantee, same no-commitment policy — reply to cancel with no fee if it doesn\'t work. — The Waves Pest Control team',
  },
  {
    template_key: 'payment_failed',
    subject: 'Heads up — your last Waves payment didn\'t go through',
    preview_text: 'No rush. Here\'s how to update your card.',
    html_body: `<h2>Hi {{first_name}} — quick billing note</h2>
<p>Your autopay payment for your Waves service didn't go through. This usually means:</p>

<ul>
  <li>The card on file expired or was replaced</li>
  <li>The bank flagged it as an unusual charge</li>
  <li>There was a temporary processor hiccup</li>
</ul>

<h2>What to do</h2>
<p>Log into your portal to update your card, or reply to this email and we'll send a secure payment link. We'll retry the charge automatically in 3 business days — no need to do anything if you've already fixed it.</p>

<p>No service interruption right now, and no late fee. Just wanted you to know.</p>
${BRAND_FOOTER}`,
    text_body: 'Hi {{first_name}} — your last Waves autopay didn\'t go through. Usually means expired card, bank flag, or a processor hiccup. Log into your portal to update your card, or reply and we\'ll send a secure payment link. We retry in 3 business days. No service interruption, no late fee. — The Waves Pest Control team',
  },
  {
    template_key: 'referral_nudge',
    subject: '{{first_name}}, know anyone else dealing with pests or lawn issues?',
    preview_text: 'Refer a neighbor, we both get $25 off next service.',
    html_body: `<h2>Hi {{first_name}}!</h2>
<p>Hope our last service was solid. If it was, we'd love your help growing by word-of-mouth — that's how almost every customer on our route today found us.</p>

<h2>The referral deal</h2>
<p>Tell a neighbor, friend, or family member about Waves. When they book their first service and mention your name, you both get <strong>$25 off</strong> your next visit. No cap — refer as many as you want.</p>

<h2>Easiest way to do it</h2>
<p>Forward this email to someone who might need us. Or just reply with their name and we'll reach out personally (no spam — one contact, then we drop off).</p>

<p>Thanks for being on our route.</p>
${BRAND_FOOTER}`,
    text_body: 'Hi {{first_name}}! If our last service was solid, we\'d love your help growing by word-of-mouth. Refer a neighbor — when they book their first service and mention your name, you both get $25 off. No cap. Forward this email, or reply with their name and we\'ll reach out (one contact, no spam). Thanks for being on our route. — The Waves Pest Control team',
  },
  // Review thank-yous — one content, personalized by city in subject.
  ...['lwr', 'venice', 'sarasota', 'parrish'].map((slug) => {
    const cityDisplay = { lwr: 'Lakewood Ranch', venice: 'Venice', sarasota: 'Sarasota', parrish: 'Parrish' }[slug];
    return {
      template_key: `review_thank_you_${slug}`,
      subject: 'Thanks for the kind words, {{first_name}} ☀️',
      preview_text: `Your review means a lot to a small local shop like ours.`,
      html_body: `<h2>Hi {{first_name}} — thank you</h2>
<p>We saw your Google review this morning. It genuinely made our day.</p>

<p>Small family-owned companies like ours live or die by what neighbors say about us in ${cityDisplay}, so taking a minute to leave that review means more than you probably realize. Thank you.</p>

<p>If there's ever anything you need from us — extra service, a question about your yard, or just a recommendation on another local business — just reply here. We've got you.</p>
${BRAND_FOOTER}`,
      text_body: `Hi {{first_name}} — thank you for your Google review this morning. It made our day. Small family-owned companies like ours live or die by word-of-mouth in ${cityDisplay}, so taking a minute to leave that review means more than you probably realize. If there\'s ever anything you need — extra service, a yard question, or a recommendation on another local business — reply here. — The Waves Pest Control team`,
    };
  }),
];

exports.up = async function (knex) {
  for (const step of STEPS) {
    // Only seed if the template exists and has no step at order 0 yet.
    const template = await knex('automation_templates').where({ key: step.template_key }).first();
    if (!template) continue;
    const existing = await knex('automation_steps').where({ template_key: step.template_key, step_order: 0 }).first();
    if (existing) continue;
    await knex('automation_steps').insert({
      template_key: step.template_key,
      step_order: 0,
      delay_hours: 0,
      subject: step.subject,
      preview_text: step.preview_text,
      html_body: step.html_body,
      text_body: step.text_body,
      from_name: 'Waves Pest Control',
      from_email: 'automations@wavespestcontrol.com',
      reply_to: 'contact@wavespestcontrol.com',
      enabled: true,
    });
  }
};

exports.down = async function (knex) {
  const keys = STEPS.map((s) => s.template_key);
  await knex('automation_steps').whereIn('template_key', keys).where('step_order', 0).del();
};

/**
 * Which phone lines prove a website visit.
 *
 * Shared lines: the main line and the four office (location) lines. They are
 * also on Google Business Profiles, citations, texts and invoices, so a call
 * to one of them cannot prove how the caller found Waves.
 *
 * Website-only lines: every registered pest and lawn domain-tracking line
 * that is not shared (the spoke-site numbers, the hub page lines, the main
 * site's web-only line). Only a website shows them, so a call to one proves a
 * website visit. Any other number (the AI toll-free line, a hand-made row)
 * proves nothing.
 *
 * Used by the Calls screen (services/call-log-analytics.js) and the Leads
 * screen (services/lead-source-evidence.js). Pure functions of the registry
 * (config/twilio-numbers.js), passed in by the caller:
 *   - a request handler never calls into a twilio-named module, which the
 *     Intelligence Bar read scanner blocks as a possible outside call;
 *   - suites that mock the registry with only a few fields keep loading.
 */
function sharedLineNumbers(registry) {
  return [registry.mainLine.number, ...Object.values(registry.locations).map((line) => line.number)];
}

// The registry entries ({ number, domain, label?, ... }) of the website-only lines.
function websiteOnlyLines(registry) {
  const shared = new Set(sharedLineNumbers(registry));
  return [...registry.domainTracking, ...registry.lawnDomainTracking].filter((line) => !shared.has(line.number));
}

module.exports = { sharedLineNumbers, websiteOnlyLines };

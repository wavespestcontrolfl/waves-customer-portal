// Shared with the dedicated page and platform registry. This workflow permits
// property/pricing reads and one lead-bound draft write, under its own gate.
module.exports = new Set([
  'lookup_property',
  'compute_estimate',
  'read_pricing_config',
  'recent_pricing_changes',
  'find_similar_estimates',
  'match_existing_customer',
  'get_waveguard_tiers',
  'get_neighborhood_grass_profile',
  'create_agent_estimate_draft',
  'get_protocol',
  'get_product_info',
  'search_knowledge_base',
  'query_products',
  'analyze_margins',
  'query_stock',
]);

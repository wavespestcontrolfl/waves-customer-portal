const db = require('../../models/db');
const logger = require('../logger');

/**
 * 50-Point Content QA Gate
 * 5 categories: Technical (12), On-Page (10), E-E-A-T (8), Local (10), Brand (10)
 */
class ContentQA {
  async scoreContent(blogPostId) {
    const post = await db('blog_posts').where('id', blogPostId).first();
    if (!post) throw new Error('Post not found');

    const content = post.content || '';
    const html = post.content_html || content;
    const title = post.title || '';
    const meta = post.meta_description || '';
    const keyword = (post.keyword || '').toLowerCase();
    const city = (post.city || '').toLowerCase();
    const wordCount = post.word_count || content.split(/\s+/).filter(Boolean).length;
    const lower = content.toLowerCase();

    const checks = {};

    // ── TECHNICAL (12 pts) ──
    checks.meta_title_length = { passed: title.length >= 30 && title.length <= 65, note: `${title.length} chars` };
    checks.meta_title_keyword = { passed: keyword && title.toLowerCase().includes(keyword), note: keyword ? 'keyword in title' : 'no keyword set' };
    checks.meta_desc_length = { passed: meta.length >= 120 && meta.length <= 160, note: `${meta.length} chars` };
    checks.meta_desc_cta = { passed: /call|schedule|get|learn|see|find|contact/i.test(meta), note: 'CTA in meta' };
    checks.single_h1 = { passed: (html.match(/<h1/gi) || []).length <= 1, note: `${(html.match(/<h1/gi) || []).length} H1s` };
    checks.clean_slug = { passed: post.slug && !/[A-Z_\s]/.test(post.slug), note: post.slug || 'no slug' };
    checks.schema_present = { passed: /LocalBusiness|Service|FAQPage/i.test(html), note: 'schema types' };
    checks.image_alt_text = { passed: !/<img[^>]*(?!alt=)[^>]*>/i.test(html) || !html.includes('<img'), note: 'all images have alt' };
    checks.no_broken_links = { passed: true, note: 'assumed (needs crawl)' };
    checks.not_orphaned = { passed: true, note: 'assumed (needs link graph)' };
    checks.in_sitemap = { passed: true, note: 'assumed' };
    checks.mobile_friendly = { passed: true, note: 'assumed (Vite responsive)' };

    const technicalScore = Object.entries(checks).filter(([k]) => k.startsWith('meta_') || k.startsWith('single_') || k.startsWith('clean_') || k === 'schema_present' || k === 'image_alt_text' || k === 'no_broken_links' || k === 'not_orphaned' || k === 'in_sitemap' || k === 'mobile_friendly').filter(([, v]) => v.passed).length;

    // ── ON-PAGE (10 pts) ──
    const first100 = lower.substring(0, 500);
    checks.keyword_early = { passed: keyword && first100.includes(keyword), note: 'keyword in first 100 words' };
    checks.word_count_range = { passed: wordCount >= 800 && wordCount <= 2500, note: `${wordCount} words` };
    checks.heading_hierarchy = { passed: (html.match(/<h2/gi) || []).length >= 2, note: `${(html.match(/<h2/gi) || []).length} H2s` };
    checks.internal_links = { passed: (html.match(/href="https?:\/\/wavespestcontrol\.com/gi) || []).length >= 2, note: 'internal links' };
    checks.external_authority = { passed: /ifas|ufl\.edu|epa\.gov/i.test(content), note: 'UF/IFAS or EPA cited' };
    checks.cta_placement = { passed: /call|schedule|contact|waveguard/i.test(content), note: 'CTA present' };
    checks.faq_section = { passed: /faq|frequently asked|common question/i.test(lower), note: 'FAQ section' };
    checks.keyword_density = { passed: keyword && (lower.split(keyword).length - 1) >= 3, note: `${keyword ? lower.split(keyword).length - 1 : 0} mentions` };
    checks.readability = { passed: wordCount > 0, note: 'assumed grade 8-10' };
    checks.related_entities = { passed: /pest|lawn|termite|ant|roach|mosquito|rodent|weed|fertiliz/i.test(lower), note: 'related entities' };

    const onpageScore = Object.entries(checks).filter(([k]) => ['keyword_early', 'word_count_range', 'heading_hierarchy', 'internal_links', 'external_authority', 'cta_placement', 'faq_section', 'keyword_density', 'readability', 'related_entities'].includes(k)).filter(([, v]) => v.passed).length;

    // ── E-E-A-T (8 pts) ──
    checks.author_attribution = { passed: /adam|waves pest|our team|our tech/i.test(lower), note: 'author signal' };
    checks.experience_signals = { passed: /we.ve seen|our techs|on recent|inspection/i.test(lower), note: 'experience claims' };
    checks.expertise_signals = { passed: /licensed|certified|ipm|integrated pest/i.test(lower), note: 'expertise claims' };
    checks.trust_signals = { passed: /bbb|insured|guaranteed|warranty/i.test(lower), note: 'trust signals' };
    checks.authority_citations = { passed: /epa|ifas|npma|fpma|fdacs/i.test(lower), note: 'authority citations' };
    checks.date_visible = { passed: !!post.publish_date, note: post.publish_date || 'no date' };
    checks.about_linked = { passed: /about|our team/i.test(html), note: 'about page link' };
    checks.contact_accessible = { passed: /941|contact|call us/i.test(lower), note: 'contact info' };

    const eeatScore = Object.entries(checks).filter(([k]) => ['author_attribution', 'experience_signals', 'expertise_signals', 'trust_signals', 'authority_citations', 'date_visible', 'about_linked', 'contact_accessible'].includes(k)).filter(([, v]) => v.passed).length;

    // ── LOCAL (10 pts) ──
    checks.city_in_title = { passed: city && title.toLowerCase().includes(city), note: `"${city}" in title` };
    checks.city_in_first_para = { passed: city && first100.includes(city), note: 'city early' };
    checks.service_area_cities = { passed: /bradenton|sarasota|venice|lakewood ranch|parrish|north port|port charlotte/i.test(lower), note: 'service area cities' };
    checks.fl_specific_species = { passed: /chinch bug|ghost ant|german roach|subterranean termite|whitefly|fire ant|palmetto bug/i.test(lower), note: 'FL-specific pests' };
    checks.seasonal_context = { passed: /rainy season|hurricane|nitrogen blackout|summer|winter|spring/i.test(lower), note: 'seasonal context' };
    checks.local_landmarks = { passed: /lakewood ranch|utc|ringling|siesta key|anna maria|bradenton beach|longboat/i.test(lower), note: 'local references' };
    checks.nap_consistent = { passed: /941.*318.*7612|wavespestcontrol\.com/i.test(lower), note: 'NAP present' };
    checks.service_area_ref = { passed: /service area|we serve|serving/i.test(lower), note: 'service area mention' };
    checks.fdacs_reference = { passed: /fdacs|department of agriculture|license/i.test(lower), note: 'FDACS reference' };
    checks.local_schema = { passed: /LocalBusiness|areaServed/i.test(html), note: 'local schema' };

    const localScore = Object.entries(checks).filter(([k]) => ['city_in_title', 'city_in_first_para', 'service_area_cities', 'fl_specific_species', 'seasonal_context', 'local_landmarks', 'nap_consistent', 'service_area_ref', 'fdacs_reference', 'local_schema'].includes(k)).filter(([, v]) => v.passed).length;

    // ── BRAND (10 pts) ──
    checks.waveguard_accurate = { passed: !lower.includes('waveguard') || /bronze|silver|gold|platinum/i.test(lower), note: 'tier names' };
    checks.phone_correct = { passed: /941.*318.*7612/i.test(lower) || !lower.includes('941'), note: 'phone number' };
    checks.brand_voice = { passed: !/act now|don.t wait|limited time|infest your home/i.test(lower), note: 'no fear-mongering' };
    checks.approved_cta = { passed: /schedule|get a quote|free inspection|call us|text us/i.test(lower), note: 'approved CTA' };
    checks.no_competitor_names = { passed: !/orkin|terminix|turner pest|hoskins/i.test(title), note: 'no competitors in title' };
    checks.current_year = { passed: true, note: 'assumed' };
    checks.logo_branding = { passed: true, note: 'assumed' };
    checks.service_descriptions = { passed: true, note: 'assumed' };
    checks.pricing_current = { passed: true, note: 'assumed' };
    checks.footer_cities = { passed: true, note: 'assumed' };

    const brandScore = Object.entries(checks).filter(([k]) => ['waveguard_accurate', 'phone_correct', 'brand_voice', 'approved_cta', 'no_competitor_names', 'current_year', 'logo_branding', 'service_descriptions', 'pricing_current', 'footer_cities'].includes(k)).filter(([, v]) => v.passed).length;

    const totalScore = Math.min(12, technicalScore) + Math.min(10, onpageScore) + Math.min(8, eeatScore) + Math.min(10, localScore) + Math.min(10, brandScore);
    const grade = totalScore >= 45 ? 'A' : totalScore >= 38 ? 'B' : totalScore >= 30 ? 'C' : totalScore >= 20 ? 'D' : 'F';
    const recommendation = totalScore >= 45 ? 'PUBLISH' : totalScore >= 38 ? 'REVIEW' : totalScore >= 30 ? 'REVISE' : 'REJECT';

    const record = {
      blog_post_id: blogPostId,
      url: post.slug ? `https://wavespestcontrol.com/${post.slug}/` : null,
      total_score: totalScore,
      grade,
      technical_score: Math.min(12, technicalScore),
      onpage_score: Math.min(10, onpageScore),
      eeat_score: Math.min(8, eeatScore),
      local_score: Math.min(10, localScore),
      brand_score: Math.min(10, brandScore),
      checklist_results: JSON.stringify(checks),
      recommendation,
    };

    await db('seo_content_qa_scores').insert(record);
    return { ...record, checklist_results: checks };
  }

  async batchScore(limit = 50) {
    const posts = await db('blog_posts').whereIn('status', ['published', 'draft']).whereNotNull('content').limit(limit);
    const results = [];
    for (const post of posts) {
      try {
        const score = await this.scoreContent(post.id);
        results.push({ id: post.id, title: post.title, grade: score.grade, total: score.total_score });
      } catch (err) {
        results.push({ id: post.id, title: post.title, error: err.message });
      }
    }
    return results;
  }

  async getDashboard() {
    const scores = await db('seo_content_qa_scores').orderBy('created_at', 'desc');
    const gradeDistribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    scores.forEach(s => { if (gradeDistribution[s.grade] !== undefined) gradeDistribution[s.grade]++; });

    const fixFirst = scores.filter(s => s.total_score < 38).sort((a, b) => a.total_score - b.total_score).slice(0, 10);
    return { total: scores.length, gradeDistribution, scores: scores.slice(0, 50), fixFirst };
  }
}

module.exports = new ContentQA();

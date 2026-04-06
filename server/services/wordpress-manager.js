const db = require('../models/db');

class WordPressManager {
  /**
   * Build Basic auth header for a WordPress site using Application Password.
   */
  getAuth(site) {
    if (!site.wp_username || !site.wp_app_password) return null;
    const token = Buffer.from(`${site.wp_username}:${site.wp_app_password}`).toString('base64');
    return `Basic ${token}`;
  }

  /**
   * Helper: make an authenticated fetch to a WordPress REST API endpoint.
   */
  async wpFetch(site, path, options = {}) {
    const baseUrl = `https://${site.domain}/wp-json`;
    const url = `${baseUrl}${path}`;
    const auth = this.getAuth(site);
    if (!auth) throw new Error(`No credentials configured for ${site.domain}`);

    const headers = {
      Authorization: auth,
      'Content-Type': 'application/json',
      'User-Agent': 'WavesPortal/1.0',
      ...options.headers,
    };

    const res = await fetch(url, { ...options, headers, signal: AbortSignal.timeout(60000) });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`WP API ${res.status} on ${site.domain}${path}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  // ── Test Connection ──────────────────────────────────────────────────

  async testConnection(siteId) {
    const site = await db('wordpress_sites').where({ id: siteId }).first();
    if (!site) return { connected: false, error: 'Site not found' };
    if (!site.wp_username || !site.wp_app_password) {
      return { connected: false, error: 'No credentials configured' };
    }

    try {
      const user = await this.wpFetch(site, '/wp/v2/users/me?context=edit');
      await db('wordpress_sites').where({ id: siteId }).update({
        status: 'active',
        last_error: null,
        last_synced_at: new Date(),
      });
      return { connected: true, user: { id: user.id, name: user.name, slug: user.slug, roles: user.roles } };
    } catch (err) {
      await db('wordpress_sites').where({ id: siteId }).update({
        status: 'error',
        last_error: err.message,
      });
      return { connected: false, error: err.message };
    }
  }

  // ── Scan Forms ───────────────────────────────────────────────────────

  /**
   * Scan a WordPress site for Elementor forms containing webhook URLs.
   *
   * Strategy:
   *  1. Fetch all pages (and posts) with context=edit so we get raw content.
   *  2. For each, check if the rendered or raw content contains Elementor
   *     form data with webhook references.
   *  3. Also attempt to read _elementor_data from the REST meta (requires
   *     Elementor to register the meta key for REST — it does in recent versions).
   *  4. Fallback: search raw `content.raw` for webhook/zapier URLs.
   */
  async scanForms(siteId) {
    const site = await db('wordpress_sites').where({ id: siteId }).first();
    if (!site) throw new Error('Site not found');

    const results = { siteId, domain: site.domain, forms: [], errors: [] };

    // Direct HTML scan — check common form page URLs one at a time
    // No batch API calls (crashes Railway with SIGTERM on large sites)
    console.log(`[wp-mgr] Scanning ${site.domain} — checking common form pages directly`);
    {

      const commonPaths = ['/', '/pest-control-quote/', '/contact/', '/free-quote/', '/get-a-quote/', '/quote/', '/free-estimate/', '/lawn-care-quote/'];
      const pagesWithForms = [];

      for (const path of commonPaths) {
        try {
          const pageUrl = `https://${site.domain}${path}`;
          console.log(`[wp-mgr] Fetching ${pageUrl}`);
          const pageRes = await fetch(pageUrl, { signal: AbortSignal.timeout(15000) });
          if (!pageRes.ok) { console.log(`[wp-mgr]   ${pageRes.status}`); continue; }
          const html = await pageRes.text();
          console.log(`[wp-mgr]   HTML: ${html.length} chars, has form: ${html.includes('elementor-form')}`);

          if (html.includes('elementor-form') || html.includes('elementor-widget-form')) {
            pagesWithForms.push({ path, url: pageUrl });

            // Search for webhook URLs in full page source
            const zapierMatches = html.match(/https?:\/\/hooks\.zapier\.com\/hooks\/catch\/[^\s"'<>\\]+/g) || [];
            const portalMatches = html.match(/https?:\/\/[^\s"'<>\\]*webhooks\/lead/g) || [];

            console.log(`[wp-mgr]   Zapier URLs: ${zapierMatches.length}, Portal URLs: ${portalMatches.length}`);

            for (const url of [...new Set(zapierMatches)]) {
              results.forms.push({ postId: null, postTitle: path, postType: 'page', postUrl: pageUrl, webhookUrl: url.replace(/[\\]+$/, ''), formId: null, source: 'html_scan' });
            }
            for (const url of [...new Set(portalMatches)]) {
              results.forms.push({ postId: null, postTitle: path, postType: 'page', postUrl: pageUrl, webhookUrl: url.replace(/[\\]+$/, ''), formId: null, source: 'html_scan' });
            }

            if (zapierMatches.length === 0 && portalMatches.length === 0) {
              results.forms.push({ postId: null, postTitle: `${path} (form found, webhook in Elementor DB)`, postType: 'page', postUrl: pageUrl, webhookUrl: 'stored_in_elementor_data', formId: null, source: 'needs_db_access' });
            }
          }
        } catch (e) { console.log(`[wp-mgr]   Error: ${e.message}`); }
      }

      console.log(`[wp-mgr] Scan complete for ${site.domain}: ${results.forms.length} webhooks found on ${pagesWithForms.length} pages`);
    }

    // Update site record (minimal DB write)
    try {
      const webhookUrls = results.forms.map((f) => f.webhookUrl);
      const hasZapier = webhookUrls.some((u) => u.includes('zapier'));
      const hasPortal = webhookUrls.some((u) => u.includes('webhook') && !u.includes('zapier'));
      const hasDbOnly = webhookUrls.some((u) => u.includes('stored_in_elementor'));
      let webhook_status = 'scanned_no_webhooks';
      if (hasZapier) webhook_status = 'zapier';
      else if (hasPortal) webhook_status = 'portal';
      else if (hasDbOnly) webhook_status = 'needs_plugin';
      if (hasZapier && hasPortal) webhook_status = 'mixed';

      await db('wordpress_sites').where({ id: siteId }).update({
        forms_count: results.forms.length,
        webhook_status,
        last_synced_at: new Date(),
        last_error: null,
      });
    } catch (dbErr) {
      console.error(`[wp-mgr] DB update failed: ${dbErr.message}`);
    }

    return results;
  }

  /**
   * Fetch all items of a post type, paginating through all results.
   * Uses context=edit so we get raw content + meta.
   */
  async fetchAllPostType(site, postType) {
    const items = [];
    let page = 1;
    const perPage = 50;

    while (true) {
      try {
        // Try context=edit first (includes meta/_elementor_data)
        let batch;
        try {
          batch = await this.wpFetch(
            site,
            `/wp/v2/${postType}?per_page=${perPage}&page=${page}&status=publish,draft&context=edit`
          );
        } catch (editErr) {
          // Fallback to view context if edit not allowed
          console.warn(`[wp-mgr] context=edit failed for ${site.domain}/${postType} page ${page}, trying view: ${editErr.message}`);
          batch = await this.wpFetch(
            site,
            `/wp/v2/${postType}?per_page=${perPage}&page=${page}&status=publish,draft`
          );
        }
        if (!Array.isArray(batch) || batch.length === 0) break;
        items.push(...batch);
        if (batch.length < perPage) break;
        page++;
      } catch (err) {
        // 400 = bad page range or past last page
        if (err.message.includes('400') || err.message.includes('rest_post_invalid_page_number')) break;
        console.error(`[wp-mgr] fetchAllPostType ${site.domain}/${postType} page ${page}: ${err.message}`);
        break; // Don't throw — return what we have
      }
    }
    return items;
  }

  /**
   * Extract webhook URLs from a page/post item.
   * Checks:
   *  1. meta._elementor_data (JSON string with form widget configs)
   *  2. content.raw / content.rendered (fallback search)
   */
  extractWebhooksFromItem(item) {
    const found = [];
    const webhookPattern = /https?:\/\/[^\s"'\\]+(?:hooks\.zapier\.com|webhook|hook)[^\s"'\\]*/gi;

    // 1. Try _elementor_data from meta
    const elementorData = item.meta?._elementor_data;
    if (elementorData) {
      const dataStr = typeof elementorData === 'string' ? elementorData : JSON.stringify(elementorData);
      const parsed = this.parseElementorData(dataStr);
      found.push(...parsed);
    }

    // 2. Search raw content for webhook URLs
    const rawContent = item.content?.raw || item.content?.rendered || '';
    const contentMatches = rawContent.match(webhookPattern) || [];
    for (const url of contentMatches) {
      const cleaned = url.replace(/["'>,;\\}\]]+$/, '');
      if (!found.some((f) => f.url === cleaned)) {
        found.push({ url: cleaned, formId: null, source: 'content' });
      }
    }

    return found;
  }

  /**
   * Parse Elementor JSON data and extract webhook URLs from form widgets.
   * Elementor data is a deeply nested JSON array of widget objects.
   */
  parseElementorData(dataStr) {
    const results = [];
    try {
      const data = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;
      this.walkElementorTree(data, results);
    } catch {
      // If JSON parse fails, do a regex search on the raw string
      const urlPattern = /https?:\/\/[^"'\\]+(?:hooks\.zapier\.com|webhook|hook)[^"'\\]*/gi;
      const matches = dataStr.match(urlPattern) || [];
      for (const url of matches) {
        const cleaned = url.replace(/\\+/g, '');
        results.push({ url: cleaned, formId: null, source: 'elementor_raw' });
      }
    }
    return results;
  }

  /**
   * Recursively walk the Elementor widget tree looking for form widgets
   * with webhook actions or webhook URLs in their settings.
   */
  walkElementorTree(node, results) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) this.walkElementorTree(child, results);
      return;
    }
    if (typeof node !== 'object') return;

    // Check if this is a form widget with webhook settings
    const settings = node.settings || {};
    const widgetType = node.widgetType || node.elType || '';

    // Elementor Pro forms: submit_actions may include 'webhook'
    // and webhook_url holds the URL
    if (settings.webhook_url) {
      results.push({
        url: settings.webhook_url,
        formId: settings.form_id || node.id || null,
        source: 'elementor_form',
      });
    }

    // Some setups use 'webhooks' (plural) or custom action fields
    if (settings.webhooks_url) {
      results.push({
        url: settings.webhooks_url,
        formId: settings.form_id || node.id || null,
        source: 'elementor_form',
      });
    }

    // Recurse into children (elements array)
    if (node.elements) this.walkElementorTree(node.elements, results);
  }

  // ── Swap Webhooks ────────────────────────────────────────────────────

  /**
   * Swap webhook URLs on a single site.
   * For each page/post containing oldUrl in _elementor_data or content,
   * replace with newUrl and PUT back.
   */
  async swapWebhooks(siteId, oldUrl, newUrl) {
    const site = await db('wordpress_sites').where({ id: siteId }).first();
    if (!site) throw new Error('Site not found');

    const result = { siteId, domain: site.domain, formsUpdated: 0, pagesModified: 0, errors: [] };

    const [pages, posts] = await Promise.all([
      this.fetchAllPostType(site, 'pages'),
      this.fetchAllPostType(site, 'posts'),
    ]);

    const allItems = [...pages, ...posts];

    for (const item of allItems) {
      try {
        const updated = await this.swapWebhookInItem(site, item, oldUrl, newUrl);
        if (updated) {
          result.pagesModified++;
          result.formsUpdated += updated.count;
        }
      } catch (err) {
        result.errors.push({ postId: item.id, title: item.title?.rendered, error: err.message });
      }
    }

    // Update site status
    const statusUpdate = {
      last_synced_at: new Date(),
      last_error: result.errors.length > 0 ? result.errors.map((e) => e.error).join('; ') : null,
    };
    if (result.formsUpdated > 0 && result.errors.length === 0) {
      statusUpdate.webhook_status = 'portal';
    } else if (result.formsUpdated > 0 && result.errors.length > 0) {
      statusUpdate.webhook_status = 'mixed';
    }
    await db('wordpress_sites').where({ id: siteId }).update(statusUpdate);

    return result;
  }

  /**
   * Replace oldUrl with newUrl in a single page/post's Elementor data and content.
   * Returns { count } if changes were made, null if no changes.
   */
  async swapWebhookInItem(site, item, oldUrl, newUrl) {
    let changed = false;
    let count = 0;
    const updatePayload = {};
    const postType = item.type === 'post' ? 'posts' : 'pages';

    // 1. Check _elementor_data in meta
    const elementorData = item.meta?._elementor_data;
    if (elementorData) {
      const dataStr = typeof elementorData === 'string' ? elementorData : JSON.stringify(elementorData);
      if (dataStr.includes(oldUrl)) {
        // Replace all occurrences in the JSON string
        const updatedStr = dataStr.split(oldUrl).join(newUrl);
        const occurrences = (dataStr.match(new RegExp(this.escapeRegex(oldUrl), 'g')) || []).length;
        count += occurrences;

        // Ensure the updated JSON is still valid
        try {
          JSON.parse(updatedStr);
        } catch {
          throw new Error(`Elementor data JSON would be invalid after replacement on post ${item.id}`);
        }

        updatePayload.meta = { _elementor_data: updatedStr };
        changed = true;
      }
    }

    // 2. Check raw content
    const rawContent = item.content?.raw || '';
    if (rawContent.includes(oldUrl)) {
      const updatedContent = rawContent.split(oldUrl).join(newUrl);
      const occurrences = (rawContent.match(new RegExp(this.escapeRegex(oldUrl), 'g')) || []).length;
      count += occurrences;
      updatePayload.content = updatedContent;
      changed = true;
    }

    if (!changed) return null;

    // PUT updated data back to WordPress
    await this.wpFetch(site, `/wp/v2/${postType}/${item.id}`, {
      method: 'POST', // WP REST API uses POST for updates
      body: JSON.stringify(updatePayload),
    });

    return { count };
  }

  /**
   * Swap webhooks across ALL configured sites with credentials.
   */
  async swapAll(oldUrl, newUrl) {
    const sites = await db('wordpress_sites')
      .whereNotNull('wp_username')
      .whereNotNull('wp_app_password')
      .where('status', '!=', 'inactive');

    const results = { total: sites.length, succeeded: 0, failed: 0, sites: [] };

    for (const site of sites) {
      try {
        const siteResult = await this.swapWebhooks(site.id, oldUrl, newUrl);
        results.sites.push(siteResult);
        if (siteResult.errors.length === 0) results.succeeded++;
        else results.failed++;
      } catch (err) {
        results.failed++;
        results.sites.push({
          siteId: site.id,
          domain: site.domain,
          formsUpdated: 0,
          pagesModified: 0,
          errors: [{ error: err.message }],
        });
      }
    }

    return results;
  }

  // ── Get All Sites ────────────────────────────────────────────────────

  async getAllSites() {
    return db('wordpress_sites').orderBy('site_type').orderBy('area');
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

module.exports = new WordPressManager();

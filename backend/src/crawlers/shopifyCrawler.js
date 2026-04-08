const axios = require('axios');
const cheerio = require('cheerio');
const normalizeUrl = require('../utils/url');
const {
  extractStructuredDataForPage
} = require('../extractors/structuredDataExtractor');

class ShopifyCrawler {
  constructor(baseUrl) {
    this.baseUrl = normalizeUrl(baseUrl);
    this.visited = new Set();
    this.results = [];
    this.resultsByUrl = new Map();
    this.urlAliases = new Map();
    this.canonicalInspectionCache = new Map();
    this.robotsRulesCache = new Map();
  }

  async fetchPageResponse(url) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (SEO Audit Bot)'
        },
        timeout: 10000,
        maxRedirects: 5,
        validateStatus: () => true
      });

      return response;
    } catch (error) {
      console.log(`Error fetching ${url}`);
      return null;
    }
  }

  async fetchPage(url) {
    const response = await this.fetchPageResponse(url);

    if (!response || response.status >= 400 || typeof response.data !== 'string') {
      return null;
    }

    return response.data;
  }

  detectShopify(html) {
    return (
      html.includes('cdn.shopify.com') ||
      html.includes('Shopify.theme') ||
      html.includes('/products/') ||
      html.includes('/collections/')
    );
  }

  detectPageType(url) {
    if (url.includes('/products/')) return 'product';
    if (url.includes('/collections/')) return 'collection';
    if (url.includes('/blogs/')) return 'blog';
    return 'other';
  }

  normalizeText(text) {
    return text.replace(/\s+/g, ' ').trim();
  }

  resolveUrl(url) {
    if (!url) {
      return '';
    }

    if (url.startsWith('http://') || url.startsWith('https://')) {
      return normalizeUrl(url);
    }

    if (url.startsWith('/')) {
      return normalizeUrl(`${this.baseUrl}${url}`);
    }

    return normalizeUrl(`${this.baseUrl}/${url.replace(/^\.\//, '')}`);
  }

  registerDiscoveredUrl(url) {
    const info = normalizeUrl.getShopifyProductUrlInfo(url);

    if (!info.isCollectionProductUrl) {
      return;
    }

    if (!this.urlAliases.has(info.baseProductUrl)) {
      this.urlAliases.set(info.baseProductUrl, new Set());
    }

    this.urlAliases.get(info.baseProductUrl).add(info.collectionProductUrl);

    const existingPage = this.resultsByUrl.get(info.baseProductUrl);
    if (existingPage) {
      existingPage.collectionProductUrls = Array.from(
        this.urlAliases.get(info.baseProductUrl)
      );
    }
  }

  extractRobotsDirectives($) {
    const robotsContent = [
      $('meta[name="robots"]').attr('content') || '',
      $('meta[name="googlebot"]').attr('content') || ''
    ]
      .filter(Boolean)
      .join(',');

    const normalized = robotsContent
      .toLowerCase()
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);

    return {
      robotsContent,
      robotsDirectives: normalized,
      isNoindex: normalized.includes('noindex'),
      isNofollow: normalized.includes('nofollow')
    };
  }

  extractHeaderRobotsDirectives(headers = {}) {
    const headerValue = headers['x-robots-tag'] || headers['X-Robots-Tag'] || '';
    const directives = String(headerValue)
      .toLowerCase()
      .split(',')
      .map(value => value.trim())
      .filter(Boolean);

    return {
      headerRobotsContent: String(headerValue || ''),
      headerRobotsDirectives: directives,
      headerIsNoindex: directives.includes('noindex') || directives.includes('none')
    };
  }

  extractCanonicalData($) {
    const canonicalTags = $('link[rel="canonical"]')
      .map((_, el) => $(el).attr('href') || '')
      .get()
      .filter(Boolean);

    return {
      canonicalTagCount: canonicalTags.length,
      canonicalTagValues: canonicalTags,
      canonical: this.resolveUrl(canonicalTags[0] || '')
    };
  }

  async fetchRobotsRules(origin) {
    if (this.robotsRulesCache.has(origin)) {
      return this.robotsRulesCache.get(origin);
    }

    const robotsUrl = `${origin.replace(/\/$/, '')}/robots.txt`;
    const response = await this.fetchPageResponse(robotsUrl);
    const rules = [];

    if (response && response.status < 400 && typeof response.data === 'string') {
      let applies = false;

      response.data.split(/\r?\n/).forEach(line => {
        const cleaned = line.split('#')[0].trim();

        if (!cleaned) {
          return;
        }

        const separatorIndex = cleaned.indexOf(':');
        if (separatorIndex === -1) {
          return;
        }

        const directive = cleaned.slice(0, separatorIndex).trim().toLowerCase();
        const value = cleaned.slice(separatorIndex + 1).trim();

        if (directive === 'user-agent') {
          const agent = value.toLowerCase();
          applies = agent === '*' || agent === 'mozilla/5.0 (seo audit bot)'.toLowerCase();
          return;
        }

        if (directive === 'disallow' && applies && value) {
          rules.push(value);
        }
      });
    }

    this.robotsRulesCache.set(origin, rules);
    return rules;
  }

  async isBlockedByRobots(url) {
    try {
      const parsedUrl = new URL(url);
      const rules = await this.fetchRobotsRules(parsedUrl.origin);

      return rules.some(rule => {
        if (rule === '/') {
          return true;
        }

        return parsedUrl.pathname.startsWith(rule);
      });
    } catch (error) {
      return false;
    }
  }

  async inspectCanonicalTarget(url) {
    if (!url) {
      return null;
    }

    if (this.canonicalInspectionCache.has(url)) {
      return this.canonicalInspectionCache.get(url);
    }

    const response = await this.fetchPageResponse(url);
    if (!response) {
      return null;
    }

    const html = typeof response.data === 'string' ? response.data : '';
    const $ = html ? cheerio.load(html) : null;
    const robotsData = $ ? this.extractRobotsDirectives($) : {
      robotsContent: '',
      robotsDirectives: [],
      isNoindex: false,
      isNofollow: false
    };
    const headerRobotsData = this.extractHeaderRobotsDirectives(response.headers || {});
    const canonicalData = $ ? this.extractCanonicalData($) : {
      canonicalTagCount: 0,
      canonicalTagValues: [],
      canonical: ''
    };
    const isBlockedByRobots = await this.isBlockedByRobots(url);

    const inspection = {
      url,
      status: response.status,
      canonical: canonicalData.canonical,
      canonicalTagCount: canonicalData.canonicalTagCount,
      robotsContent: robotsData.robotsContent,
      robotsDirectives: robotsData.robotsDirectives,
      isNoindex: robotsData.isNoindex || headerRobotsData.headerIsNoindex,
      isBlockedByRobots,
      headerRobotsContent: headerRobotsData.headerRobotsContent
    };

    this.canonicalInspectionCache.set(url, inspection);
    return inspection;
  }

  extractBodyText($) {
    const selectorsToRemove = [
      'script',
      'style',
      'noscript',
      'svg',
      'iframe',
      'header',
      'footer',
      'nav'
    ];

    selectorsToRemove.forEach(selector => {
      $(selector).remove();
    });

    return this.normalizeText($('body').text());
  }

  createContentFingerprint(text) {
    const normalized = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalized) {
      return '';
    }

    return normalized
      .split(' ')
      .filter(word => word.length > 2)
      .slice(0, 100)
      .join(' ');
  }

  async extractSEO($, html, url, pageType, headers = {}) {
    const bodyText = this.extractBodyText($);
    const robotsData = this.extractRobotsDirectives($);
    const headerRobotsData = this.extractHeaderRobotsDirectives(headers);
    const canonicalData = this.extractCanonicalData($);
    const structuredData = await extractStructuredDataForPage({
      url,
      html,
      pageType
    });
    const canonicalInspection =
      canonicalData.canonical && canonicalData.canonical !== url
        ? await this.inspectCanonicalTarget(canonicalData.canonical)
        : null;

    return {
      title: $('title').text().trim(),
      metaDescription: $('meta[name="description"]').attr('content') || '',
      h1: $('h1').first().text().trim(),
      canonical: canonicalData.canonical,
      canonicalTagCount: canonicalData.canonicalTagCount,
      canonicalTagValues: canonicalData.canonicalTagValues,
      imagesWithoutAlt: $('img').filter((i, el) => !$(el).attr('alt')).length,
      totalImages: $('img').length,
      bodyText,
      wordCount: bodyText ? bodyText.split(' ').length : 0,
      contentFingerprint: this.createContentFingerprint(bodyText),
      ...robotsData,
      ...headerRobotsData,
      isNoindex: robotsData.isNoindex || headerRobotsData.headerIsNoindex,
      canonicalInspection,
      structuredData
    };
  }

  extractLinks($) {
    const links = [];

    $('a').each((i, el) => {
      let href = $(el).attr('href');

      if (!href) {
        return;
      }

      if (href.startsWith('/')) {
        href = this.baseUrl + href;
      }

      if (href.startsWith(this.baseUrl)) {
        links.push({
          rawUrl: href,
          normalizedUrl: normalizeUrl(href)
        });
      }
    });

    return links;
  }

  async crawl(url, depth = 0, maxDepth = 2, discoveredUrl = url) {
    const normalizedUrl = normalizeUrl(url);

    this.registerDiscoveredUrl(discoveredUrl);

    if (this.visited.has(normalizedUrl) || depth > maxDepth) {
      return;
    }

    console.log(`Crawling: ${normalizedUrl}`);

    this.visited.add(normalizedUrl);

    const response = await this.fetchPageResponse(normalizedUrl);
    if (!response || response.status >= 400 || typeof response.data !== 'string') {
      console.log(`Error fetching ${normalizedUrl}`);
      return;
    }
    const html = response.data;

    const $ = cheerio.load(html);
    const isShopify = this.detectShopify(html);
    const pageType = this.detectPageType(normalizedUrl);
    const seoData = await this.extractSEO(
      $,
      html,
      normalizedUrl,
      pageType,
      response.headers || {}
    );

    const pageResult = {
      url: normalizedUrl,
      discoveredUrl,
      pageType,
      isShopify,
      collectionProductUrls: Array.from(this.urlAliases.get(normalizedUrl) || []),
      ...seoData
    };

    this.results.push(pageResult);
    this.resultsByUrl.set(normalizedUrl, pageResult);

    const links = this.extractLinks($);

    for (const link of links) {
      this.registerDiscoveredUrl(link.rawUrl);
      await this.crawl(link.normalizedUrl, depth + 1, maxDepth, link.rawUrl);
    }
  }

  async start() {
    await this.crawl(this.baseUrl);
    return this.results;
  }
}

module.exports = ShopifyCrawler;

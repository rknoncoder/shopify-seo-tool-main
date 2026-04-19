const axios = require('axios');
const cheerio = require('cheerio');
const normalizeUrl = require('../utils/url');
const { detectShopifyPageType } = require('../utils/pageTypeDetector');
const { sitemapParser } = require('../crawler/sitemapParser');
const {
  extractStructuredDataForPage
} = require('../extractors/structuredDataExtractor');

const MAX_CRAWL_PAGES = 200;
const MAX_COLLECTION_URLS = 30;
const MAX_PRODUCT_URLS = 150;
const MIN_PRODUCT_URLS = 50;
const MIN_PRODUCT_SHARE = 0.7;

class ShopifyCrawler {
  constructor(baseUrl) {
    this.baseUrl = normalizeUrl(baseUrl);
    this.origin = new URL(this.baseUrl).origin;
    this.baseHostname = new URL(this.baseUrl).hostname.replace(/^www\./i, '').toLowerCase();
    this.visited = new Set();
    this.results = [];
    this.resultsByUrl = new Map();
    this.collectionProductDuplicateMap = new Map();
    this.canonicalInspectionCache = new Map();
    this.robotsRulesCache = new Map();
    this.crawlSummary = {
      sitemapUrl: '',
      totalUrlsInSitemap: 0,
      crawledUrls: 0
    };
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

  detectPageType(url, $, html = '') {
    return detectShopifyPageType({
      url,
      html,
      $,
      fallback: 'webpage'
    });
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

  getRobotsUrl() {
    return `${this.origin}/robots.txt`;
  }

  getDefaultSitemapUrl() {
    return `${this.origin}/sitemap.xml`;
  }

  async fetchSitemap(url = this.getDefaultSitemapUrl()) {
    const response = await this.fetchPageResponse(url);

    if (!response || response.status >= 400 || typeof response.data !== 'string') {
      return null;
    }

    return {
      url,
      xml: response.data
    };
  }

  async discoverSitemapUrl() {
    const defaultSitemap = await this.fetchSitemap(this.getDefaultSitemapUrl());
    if (defaultSitemap) {
      return defaultSitemap;
    }

    const robotsResponse = await this.fetchPageResponse(this.getRobotsUrl());
    if (!robotsResponse || robotsResponse.status >= 400 || typeof robotsResponse.data !== 'string') {
      return null;
    }

    const sitemapLine = robotsResponse.data
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => /^sitemap:/i.test(line));

    if (!sitemapLine) {
      return null;
    }

    const sitemapUrl = sitemapLine.split(':').slice(1).join(':').trim();
    if (!sitemapUrl) {
      return null;
    }

    return this.fetchSitemap(sitemapUrl);
  }

  async collectSitemapUrls() {
    const discovered = await this.discoverSitemapUrl();

    if (!discovered) {
      console.log('No sitemap found');
      return {
        urls: [],
        total: 0,
        sitemaps: []
      };
    }

    this.crawlSummary.sitemapUrl = discovered.url;
    const parsedSitemap = await sitemapParser(discovered.url);

    if (parsedSitemap.sitemaps.length > 0) {
      console.log('\nDiscovered sitemaps:');
      parsedSitemap.sitemaps.forEach((sitemap, index) => {
        console.log(
          `[${index + 1}] ${sitemap.url} | type: ${sitemap.type} | urls: ${sitemap.urlCount}`
        );
      });
    }

    this.crawlSummary.totalUrlsInSitemap = parsedSitemap.total;

    return parsedSitemap;
  }

  isAllowedShopifyUrl(url) {
    if (!url) {
      return false;
    }

    let parsedUrl;

    try {
      parsedUrl = new URL(url);
    } catch (error) {
      return false;
    }

    const normalizedHostname = parsedUrl.hostname
      .replace(/^www\./i, '')
      .toLowerCase();

    if (normalizedHostname !== this.baseHostname) {
      return false;
    }

    const pathname = (parsedUrl.pathname || '/').split('?')[0];
    const lowerPath = pathname.toLowerCase();

    if (
      lowerPath.startsWith('/cart') ||
      lowerPath.startsWith('/checkout') ||
      lowerPath.startsWith('/account')
    ) {
      return false;
    }

    if (lowerPath.endsWith('.xml')) {
      return false;
    }

    return (
      lowerPath.includes('/products/') ||
      lowerPath.includes('/collections/') ||
      lowerPath.includes('/blogs/') ||
      lowerPath.includes('/pages/') ||
      pathname === '/'
    );
  }

  filterShopifyUrls(urls = []) {
    console.log(`Total URLs before filter: ${urls.length}`);
    console.log('Sample URLs:', urls.slice(0, 10));

    const filtered = [];
    const seen = new Set();

    urls.forEach(url => {
      const normalizedCandidate = String(url || '').split('?')[0].trim();

      if (!this.isAllowedShopifyUrl(normalizedCandidate)) {
        return;
      }

      const normalized = normalizeUrl(normalizedCandidate);
      this.registerDiscoveredUrl(normalizedCandidate);

      if (!normalized || seen.has(normalized)) {
        return;
      }

      seen.add(normalized);
      filtered.push(normalized);
    });

    console.log(`Filtered URLs: ${filtered.length}`);
    return filtered;
  }

  normalizeSelectedUrls(urls = []) {
    const normalizedUrls = [];
    const seen = new Set();

    urls.forEach(url => {
      const normalized = normalizeUrl(url);
      if (!normalized || seen.has(normalized)) {
        return;
      }

      seen.add(normalized);
      normalizedUrls.push(normalized);
    });

    return normalizedUrls;
  }

  prioritizeUrls(urls = []) {
    const getPriorityScore = url => {
      const normalizedUrl = String(url || '').toLowerCase();

      if (normalizedUrl.includes('/collections/')) {
        return 3;
      }

      if (normalizedUrl.includes('/products/')) {
        return 2;
      }

      if (normalizedUrl.includes('/blogs/')) {
        return 1;
      }

      if (normalizedUrl.includes('/pages/')) {
        return 0;
      }

      return -1;
    };

    const prioritized = [...urls].sort((left, right) => {
      const priorityDifference = getPriorityScore(right) - getPriorityScore(left);
      if (priorityDifference !== 0) {
        return priorityDifference;
      }

      return left.localeCompare(right);
    });

    console.log(`URLs after prioritization: ${prioritized.length}`);
    console.log('Top 10 prioritized URLs:', prioritized.slice(0, 10));

    return prioritized;
  }

  buildOptimizedCrawlList(urls = []) {
    const grouped = {
      collections: [],
      products: [],
      blogs: [],
      pages: [],
      other: []
    };
    const seen = new Set();

    urls.forEach(url => {
      const normalized = normalizeUrl(url);
      const lowerUrl = String(normalized || '').toLowerCase();

      if (!normalized || seen.has(normalized)) {
        return;
      }

      seen.add(normalized);

      if (lowerUrl.includes('/collections/')) {
        grouped.collections.push(normalized);
        return;
      }

      if (lowerUrl.includes('/products/')) {
        grouped.products.push(normalized);
        return;
      }

      if (lowerUrl.includes('/blogs/')) {
        grouped.blogs.push(normalized);
        return;
      }

      if (lowerUrl.includes('/pages/')) {
        grouped.pages.push(normalized);
        return;
      }

      grouped.other.push(normalized);
    });

    const productTarget = Math.max(
      MIN_PRODUCT_URLS,
      Math.min(MAX_PRODUCT_URLS, Math.ceil(MAX_CRAWL_PAGES * MIN_PRODUCT_SHARE))
    );
    const selectedProducts = grouped.products.slice(
      0,
      Math.min(MAX_PRODUCT_URLS, Math.max(productTarget, MIN_PRODUCT_URLS))
    );

    const remainingAfterProducts = Math.max(
      MAX_CRAWL_PAGES - selectedProducts.length,
      0
    );
    const selectedCollections = grouped.collections.slice(
      0,
      Math.min(MAX_COLLECTION_URLS, remainingAfterProducts)
    );

    const remainingSlots =
      MAX_CRAWL_PAGES - (selectedCollections.length + selectedProducts.length);
    const otherUrls = [...grouped.blogs, ...grouped.pages, ...grouped.other];
    const selectedRemaining = otherUrls.slice(0, Math.max(remainingSlots, 0));

    const optimized = [];
    const optimizedSeen = new Set();

    [...selectedCollections, ...selectedProducts, ...selectedRemaining].forEach(url => {
      if (!optimizedSeen.has(url) && optimized.length < MAX_CRAWL_PAGES) {
        optimizedSeen.add(url);
        optimized.push(url);
      }
    });

    console.log(`Collections selected: ${selectedCollections.length}`);
    console.log(`Products selected: ${selectedProducts.length}`);
    console.log(`Other pages selected: ${selectedRemaining.length}`);
    console.log('Optimized crawl mix:', {
      collections: selectedCollections.length,
      products: selectedProducts.length,
      blogsAndPages: selectedRemaining.length,
      total: optimized.length,
      productShare:
        optimized.length > 0
          ? `${Math.round((selectedProducts.length / optimized.length) * 100)}%`
          : '0%'
    });

    return optimized;
  }

  getProductIdentityKey(url) {
    try {
      const parsedUrl = new URL(url);
      const productMatch = parsedUrl.pathname.match(/\/products\/([^/?#]+)/i);

      if (!productMatch) {
        return '';
      }

      return `/products/${productMatch[1].toLowerCase()}`;
    } catch (error) {
      return '';
    }
  }

  registerDiscoveredUrl(url) {
    const info = normalizeUrl.getShopifyProductUrlInfo(url);

    if (!info.isCollectionProductUrl) {
      return;
    }

    const productKey = this.getProductIdentityKey(info.baseProductUrl);

    if (!productKey) {
      return;
    }

    if (!this.collectionProductDuplicateMap.has(productKey)) {
      this.collectionProductDuplicateMap.set(productKey, new Set());
    }

    this.collectionProductDuplicateMap
      .get(productKey)
      .add(info.collectionProductUrl);
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

  extractInternalLinks($) {
    const links = [];

    $('a[href]').each((_, element) => {
      const href = String($(element).attr('href') || '').trim();
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
        return;
      }

      let resolvedUrl = '';

      try {
        resolvedUrl = new URL(href, this.baseUrl).toString();
      } catch (error) {
        return;
      }

      const normalizedHostname = new URL(resolvedUrl).hostname
        .replace(/^www\./i, '')
        .toLowerCase();

      if (normalizedHostname !== this.baseHostname) {
        return;
      }

      links.push({
        rawHref: href,
        resolvedUrl
      });
    });

    const uniqueLinks = [];
    const seen = new Set();

    links.forEach(link => {
      if (seen.has(link.resolvedUrl)) {
        return;
      }

      seen.add(link.resolvedUrl);
      uniqueLinks.push(link);
    });

    return uniqueLinks;
  }

  async extractInternalLinksWithPuppeteer(url) {
    let puppeteer;

    try {
      puppeteer = require('puppeteer');
    } catch (error) {
      return [];
    }

    let browser;

    try {
      browser = await puppeteer.launch({
        headless: true
      });

      const page = await browser.newPage();
      await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });

      const hrefs = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'))
          .map(node => node.getAttribute('href') || '')
          .filter(Boolean)
      );

      const uniqueLinks = [];
      const seen = new Set();

      hrefs.forEach(href => {
        const trimmedHref = String(href || '').trim();

        if (
          !trimmedHref ||
          trimmedHref.startsWith('#') ||
          trimmedHref.startsWith('mailto:') ||
          trimmedHref.startsWith('tel:')
        ) {
          return;
        }

        let resolvedUrl = '';

        try {
          resolvedUrl = new URL(trimmedHref, this.baseUrl).toString();
        } catch (error) {
          return;
        }

        const normalizedHostname = new URL(resolvedUrl).hostname
          .replace(/^www\./i, '')
          .toLowerCase();

        if (normalizedHostname !== this.baseHostname || seen.has(resolvedUrl)) {
          return;
        }

        seen.add(resolvedUrl);
        uniqueLinks.push({
          rawHref: trimmedHref,
          resolvedUrl
        });
      });

      return uniqueLinks;
    } catch (error) {
      console.log(`[collection-duplicates] Puppeteer link extraction failed for ${url}: ${error.message}`);
      return [];
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  collectCollectionProductAliasesFromLinks(links = []) {
    const discoveredAliases = [];

    links.forEach(link => {
      const resolvedUrl = String(link?.resolvedUrl || '').trim();
      const rawHref = String(link?.rawHref || '').trim();
      const lowerMatchSource = `${rawHref} ${resolvedUrl}`.toLowerCase();

      if (
        !lowerMatchSource.includes('/collections/') ||
        !lowerMatchSource.includes('/products/')
      ) {
        return;
      }

      const linkInfo = normalizeUrl.getShopifyProductUrlInfo(resolvedUrl);

      if (!linkInfo.isCollectionProductUrl) {
        return;
      }

      this.registerDiscoveredUrl(resolvedUrl);
      discoveredAliases.push(linkInfo.collectionProductUrl || resolvedUrl);
    });

    return Array.from(new Set(discoveredAliases));
  }

  async collectCollectionProductAliases(pageUrl, pageType, internalLinks) {
    if (pageType !== 'collection') {
      return [];
    }

    const rawAliases = this.collectCollectionProductAliasesFromLinks(internalLinks);

    if (rawAliases.length > 0) {
      return rawAliases;
    }

    const renderedLinks = await this.extractInternalLinksWithPuppeteer(pageUrl);
    return this.collectCollectionProductAliasesFromLinks(renderedLinks);
  }

  buildDuplicateMap() {
    const duplicateMap = {};

    Array.from(this.collectionProductDuplicateMap.entries()).forEach(
      ([productKey, duplicateUrls]) => {
        if (!duplicateMap[productKey]) {
          duplicateMap[productKey] = [];
        }

        Array.from(duplicateUrls).forEach(collectionProductUrl => {
          duplicateMap[productKey].push(collectionProductUrl);
        });

        duplicateMap[productKey] = [...new Set(duplicateMap[productKey])];
        console.log(productKey, duplicateMap[productKey].length);
      }
    );

    return duplicateMap;
  }

  attachCollectionProductDuplicates() {
    const duplicateMap = this.buildDuplicateMap();

    this.results.forEach(page => {
      if (page.pageType !== 'product') {
        return;
      }

      const productKey = this.getProductIdentityKey(page.url);
      const duplicateUrls = duplicateMap[productKey] || [];
      page.collectionProductUrls = duplicateUrls;
      page.collectionProductDuplicateUrls = duplicateUrls;
    });

    console.log(`Duplicate map size: ${Object.keys(duplicateMap).length}`);
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

  async crawlPage(url, discoveredUrl = url) {
    const normalizedUrl = normalizeUrl(url);

    this.registerDiscoveredUrl(discoveredUrl);

    if (this.visited.has(normalizedUrl)) {
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
    const pageType = this.detectPageType(normalizedUrl, $, html);
    const internalLinks = this.extractInternalLinks($);
    const discoveredCollectionProductAliases = await this.collectCollectionProductAliases(
      normalizedUrl,
      pageType,
      internalLinks
    );

    if (pageType === 'collection') {
      console.log(
        `[collection-duplicates] ${normalizedUrl} found ${discoveredCollectionProductAliases.length} collection-product link(s)`
      );
    }

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
      collectionProductUrls: [],
      collectionProductDuplicateUrls: [],
      ...seoData
    };

    this.results.push(pageResult);
    this.resultsByUrl.set(normalizedUrl, pageResult);
  }

  async crawlUrls(urls = [], limit = MAX_CRAWL_PAGES) {
    const crawlQueue = this.normalizeSelectedUrls(urls).slice(0, limit);

    console.log(`Starting crawl with ${crawlQueue.length} URLs`);

    for (const url of crawlQueue) {
      await this.crawlPage(url, url);
    }

    this.attachCollectionProductDuplicates();
    this.crawlSummary.crawledUrls = this.results.length;
    return this.results;
  }

  async buildInitialUrls() {
    const sitemapResult = await this.collectSitemapUrls();
    const filteredUrls = this.filterShopifyUrls(sitemapResult.urls || []);
    const prioritizedUrls = this.prioritizeUrls(filteredUrls);
    const selectedUrls = this.buildOptimizedCrawlList(prioritizedUrls);

    console.log('\nSitemap crawl summary:');
    console.log(`Total sitemaps found: ${(sitemapResult.sitemaps || []).length}`);
    console.log(`Total URLs found: ${sitemapResult.total || 0}`);
    console.log(`Final URLs selected: ${selectedUrls.length}`);

    return {
      sitemapResult,
      selectedUrls
    };
  }

  async start(initialUrls = []) {
    const normalizedInitialUrls = this.normalizeSelectedUrls(initialUrls);
    let sitemapResult = {
      total: 0,
      sitemaps: []
    };
    let selectedUrls = normalizedInitialUrls;

    if (selectedUrls.length === 0) {
      const initialSelection = await this.buildInitialUrls();
      sitemapResult = initialSelection.sitemapResult;
      selectedUrls = initialSelection.selectedUrls;
    } else {
      this.crawlSummary.totalUrlsInSitemap = normalizedInitialUrls.length;
    }

    if (selectedUrls.length > 0) {
      await this.crawlUrls(selectedUrls, MAX_CRAWL_PAGES);
    } else {
      console.log('Falling back to start URL crawling');
      await this.crawlUrls([this.baseUrl], 1);
    }

    return {
      summary: {
        total_urls_in_sitemap: this.crawlSummary.totalUrlsInSitemap,
        crawled_urls: this.crawlSummary.crawledUrls
      },
      selectedUrls,
      sitemapResult,
      pages: this.results
    };
  }
}

module.exports = ShopifyCrawler;

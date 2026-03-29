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
  }

  async fetchPage(url) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (SEO Audit Bot)'
        },
        timeout: 10000
      });

      return response.data;
    } catch (error) {
      console.log(`Error fetching ${url}`);
      return null;
    }
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

  async extractSEO($, html, url, pageType) {
    const bodyText = this.extractBodyText($);
    const robotsData = this.extractRobotsDirectives($);
    const structuredData = await extractStructuredDataForPage({
      url,
      html,
      pageType
    });

    return {
      title: $('title').text().trim(),
      metaDescription: $('meta[name="description"]').attr('content') || '',
      h1: $('h1').first().text().trim(),
      canonical: this.resolveUrl($('link[rel="canonical"]').attr('href') || ''),
      imagesWithoutAlt: $('img').filter((i, el) => !$(el).attr('alt')).length,
      totalImages: $('img').length,
      bodyText,
      wordCount: bodyText ? bodyText.split(' ').length : 0,
      contentFingerprint: this.createContentFingerprint(bodyText),
      ...robotsData,
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

    const html = await this.fetchPage(normalizedUrl);
    if (!html) {
      return;
    }

    const $ = cheerio.load(html);
    const isShopify = this.detectShopify(html);
    const pageType = this.detectPageType(normalizedUrl);
    const seoData = await this.extractSEO($, html, normalizedUrl, pageType);

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

const cheerio = require('cheerio');
const {
  extractMicrodataItems,
  buildSchemaAudit,
  normalizePrice,
  normalizeAvailability
} = require('../audits/schemaAudit');
const { detectShopifyPageType } = require('../utils/pageTypeDetector');

const REQUIRED_SCHEMAS_BY_PAGE_TYPE = {
  homepage: ['Organization', 'WebSite'],
  product: ['Product'],
  collection: ['CollectionPage', 'BreadcrumbList'],
  blog: ['Article'],
  page: ['WebPage'],
  search: ['SearchResultsPage'],
  webpage: ['WebPage']
};

const SCHEMA_ALIASES = {
  product: 'Product',
  productgroup: 'ProductGroup',
  breadcrumblist: 'BreadcrumbList',
  itemlist: 'ItemList',
  faqpage: 'FAQPage',
  article: 'Article',
  blogposting: 'BlogPosting',
  organization: 'Organization',
  website: 'WebSite',
  webpage: 'WebPage',
  collectionpage: 'CollectionPage',
  searchresultspage: 'SearchResultsPage',
  contactpoint: 'ContactPoint',
  searchaction: 'SearchAction',
  aggregaterating: 'AggregateRating',
  aggregateoffer: 'AggregateOffer',
  offer: 'Offer',
  review: 'Review',
  rating: 'Rating',
  person: 'Person',
  imageobject: 'ImageObject',
  listitem: 'ListItem',
  postaladdress: 'PostalAddress'
};


function extractVisiblePrice($) {
  const selectors = [
    '[itemprop="price"]',
    '[data-product-price]',
    '[data-testid*="price" i]',
    '.price-item--regular',
    '.price-item',
    '.product__price',
    '.price',
    '.money'
  ];

  for (const selector of selectors) {
    const values = $(selector)
      .map((_, element) => normalizePrice($(element).attr('content') || $(element).text()))
      .get()
      .filter(Boolean);

    if (values.length > 0) {
      return values[0];
    }
  }

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const fallbackMatch = bodyText.match(/(?:Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
  return fallbackMatch ? normalizePrice(fallbackMatch[1]) : '';
}

function extractVisibleAvailability($) {
  const selectors = [
    '[itemprop="availability"]',
    '[data-product-availability]',
    '[data-availability]',
    '[data-stock]',
    '.product__inventory',
    '.inventory',
    '.stock',
    '.availability',
    '.sold-out',
    '.product-form__submit',
    'button[name="add"]',
    'button[type="submit"]'
  ];

  for (const selector of selectors) {
    const values = $(selector)
      .map((_, element) => {
        const node = $(element);
        const text = [
          node.attr('content'),
          node.attr('data-product-availability'),
          node.attr('data-availability'),
          node.attr('data-stock'),
          node.attr('aria-label'),
          node.attr('value'),
          node.text(),
          node.attr('disabled') !== undefined ? 'sold out' : ''
        ]
          .filter(Boolean)
          .join(' ');

        return normalizeAvailability(text);
      })
      .get()
      .filter(Boolean);

    if (values.length > 0) {
      return values[0];
    }
  }

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  return normalizeAvailability(bodyText.match(/sold out|out of stock|pre-?order|back-?order/i)?.[0] || '');
}

function toBreadcrumbLabel(segment) {
  return decodeURIComponent(String(segment || ''))
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function resolveBreadcrumbUrl(pageUrl, href) {
  const rawHref = String(href || '').trim();

  if (!rawHref || !pageUrl) {
    return '';
  }

  try {
    return new URL(rawHref, pageUrl).href;
  } catch (error) {
    return '';
  }
}

function buildBreadcrumbListFromLinks(links = []) {
  const normalizedLinks = [...links];
  const firstLabel = String(normalizedLinks[0]?.name || '').trim().toLowerCase();

  if (normalizedLinks.length > 0 && firstLabel !== 'home') {
    let homeUrl = '';

    try {
      homeUrl = new URL(normalizedLinks[0].item || normalizedLinks[0].href).origin + '/';
    } catch (error) {
      homeUrl = '';
    }

    normalizedLinks.unshift({
      name: 'Home',
      href: '/',
      item: homeUrl
    });
  }

  const itemListElement = normalizedLinks
    .map((link, index) => {
      const name = String(link?.name || '').replace(/\s+/g, ' ').trim();

      if (!name) {
        return null;
      }

      const item = {
        '@type': 'ListItem',
        position: index + 1,
        name
      };

      if (link.item) {
        item.item = link.item;
      }

      return item;
    })
    .filter(Boolean);

  if (itemListElement.length === 0) {
    return '';
  }

  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement
  }, null, 2);
}

function buildBreadcrumbListSample(pageUrl, breadcrumbLinks = []) {
  const sampleFromLinks = buildBreadcrumbListFromLinks(breadcrumbLinks);

  if (sampleFromLinks) {
    return sampleFromLinks;
  }

  try {
    const parsedUrl = new URL(pageUrl);
    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    const itemListElement = [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Home',
        item: parsedUrl.origin + '/'
      }
    ];

    let cumulativePath = '';
    segments.forEach((segment, index) => {
      cumulativePath += '/' + segment;
      itemListElement.push({
        '@type': 'ListItem',
        position: index + 2,
        name: toBreadcrumbLabel(segment),
        item: parsedUrl.origin + cumulativePath
      });
    });

    return JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement
    }, null, 2);
  } catch (error) {
    return '';
  }
}

function hasBreadcrumbTrailText(text) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return false;
  }

  return /(home\s*(>|\/|›|»|→).+\s*(>|\/|›|»|→).+)/i.test(normalized);
}

function extractBreadcrumbLinksFromElement($, element, pageUrl = '') {
  return $(element)
    .find('a')
    .map((_, link) => {
      const name = $(link).text().replace(/\s+/g, ' ').trim();
      const rawHref = $(link).attr('href') || '';

      if (!name) {
        return null;
      }

      return {
        name,
        href: rawHref,
        item: resolveBreadcrumbUrl(pageUrl, rawHref)
      };
    })
    .get()
    .filter(Boolean);
}

function extractBreadcrumbTrailFromCheerio($, pageUrl = '') {
  const explicitMatches = [
    'nav[aria-label="Breadcrumb" i]',
    'nav[aria-label*="breadcrumb" i]',
    'nav[aria-label*="breadcrumbs" i]',
    '.breadcrumb',
    '.breadcrumbs',
    '.b-crumbs',
    '[class*="breadcrumb" i]',
    '[class*="breadcrumbs" i]',
    '[class*="b-crumbs" i]',
    '[data-testid*="breadcrumb" i]'
  ];
  const explicitElements = $(explicitMatches.join(',')).toArray();

  for (const element of explicitElements) {
    const links = extractBreadcrumbLinksFromElement($, element, pageUrl);

    if (links.length > 0) {
      return {
        present: true,
        links
      };
    }
  }

  if (explicitElements.length > 0) {
    return {
      present: true,
      links: []
    };
  }

  let trail = {
    present: false,
    links: []
  };

  $('nav, ol, ul, div').each((_, el) => {
    const links = $(el).find('a');
    const text = $(el).text();

    if (links.length >= 2 && hasBreadcrumbTrailText(text)) {
      trail = {
        present: true,
        links: extractBreadcrumbLinksFromElement($, el, pageUrl)
      };
      return false;
    }

    return undefined;
  });

  return trail;
}

function detectBreadcrumbUiFromCheerio($) {
  return extractBreadcrumbTrailFromCheerio($).present;
}

function resolveSchemaPageType(url, pageType, html = '', $ = null) {
  return detectShopifyPageType({
    url,
    html,
    $,
    fallback: pageType
  });
}

function normalizeSchemaType(type) {
  const rawValue = String(type || '').trim();
  const normalized = rawValue.toLowerCase();

  if (SCHEMA_ALIASES[normalized]) {
    return SCHEMA_ALIASES[normalized];
  }

  return rawValue;
}

function collectSchemaTypes(value, detected = new Set(), seen = new WeakSet()) {
  if (!value) {
    return detected;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectSchemaTypes(item, detected, seen));
    return detected;
  }

  if (typeof value !== 'object') {
    return detected;
  }

  if (seen.has(value)) {
    return detected;
  }

  seen.add(value);

  const typeValue = value['@type'];
  if (Array.isArray(typeValue)) {
    typeValue.forEach(type => detected.add(normalizeSchemaType(type)));
  } else if (typeValue) {
    detected.add(normalizeSchemaType(typeValue));
  }

  if (Array.isArray(value['@graph'])) {
    value['@graph'].forEach(item => {
      collectSchemaTypes(item, detected, seen);
    });
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === '@context' || key === '@graph') {
      return;
    }

    collectSchemaTypes(child, detected, seen);
  });

  return detected;
}

function countSchemaObjects(value, seen = new WeakSet()) {
  if (!value) {
    return 0;
  }

  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countSchemaObjects(item, seen), 0);
  }

  if (typeof value !== 'object') {
    return 0;
  }

  if (seen.has(value)) {
    return 0;
  }

  seen.add(value);

  let count = value['@type'] ? 1 : 0;

  if (Array.isArray(value['@graph'])) {
    count += value['@graph'].reduce(
      (total, item) => total + countSchemaObjects(item, seen),
      0
    );
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === '@context' || key === '@graph') {
      return;
    }

    count += countSchemaObjects(child, seen);
  });

  return count;
}

function parseJsonLdScripts(scriptContents = []) {
  const detected = new Set();
  const errors = [];
  const parsedDocuments = [];
  let parsedScriptCount = 0;
  let schemaObjectCount = 0;

  scriptContents.forEach(content => {
    const rawContent = String(content || '').trim();

    if (!rawContent) {
      return;
    }

    try {
      const parsed = JSON.parse(rawContent);
      parsedScriptCount += 1;
      parsedDocuments.push(parsed);
      collectSchemaTypes(parsed, detected);
      schemaObjectCount += countSchemaObjects(parsed);
    } catch (error) {
      errors.push({
        message: error.message,
        snippet: rawContent.slice(0, 200)
      });
    }
  });

  return {
    scriptCount: scriptContents.length,
    parsedScriptCount,
    schemaObjectCount,
    detectedSchemas: Array.from(detected).sort(),
    parsedDocuments,
    errors
  };
}

function buildMissingSchemas(pageType, detectedSchemas) {
  const required = REQUIRED_SCHEMAS_BY_PAGE_TYPE[pageType] || [];
  const detected = new Set(detectedSchemas);

  return required.filter(schema => {
    if (schema === 'Product') {
      return !detected.has('Product') && !detected.has('ProductGroup');
    }

    if (schema === 'Article') {
      return !detected.has('Article') && !detected.has('BlogPosting');
    }

    return !detected.has(schema);
  });
}

function buildBreadcrumbSchemaIssue(detectedSchemas, breadcrumbUiPresent) {
  if (!breadcrumbUiPresent || detectedSchemas.includes('BreadcrumbList')) {
    return null;
  }

  return {
    type: 'breadcrumb-missing-schema',
    severity: 'high',
    message:
      'Visual breadcrumbs detected but Structured Data is missing. Search engines cannot generate breadcrumb snippets for this page.'
  };
}

function buildStructuredDataResult(
  pageType,
  parseResult,
  source,
  pageUrl,
  breadcrumbTrail = { present: false, links: [] },
  microdataItems = [],
  visiblePrice = '',
  visibleAvailability = ''
) {
  const normalizedBreadcrumbTrail =
    typeof breadcrumbTrail === 'boolean'
      ? { present: breadcrumbTrail, links: [] }
      : breadcrumbTrail || { present: false, links: [] };
  const breadcrumbUiPresent = Boolean(normalizedBreadcrumbTrail.present);
  const microdataTypes = microdataItems
    .flatMap(item => item.types || [])
    .filter((type, index, all) => type && all.indexOf(type) === index)
    .sort();
  const combinedDetectedSchemas = Array.from(
    new Set([...(parseResult.detectedSchemas || []), ...microdataTypes])
  ).sort();
  const missingSchemas = buildMissingSchemas(pageType, combinedDetectedSchemas);
  const issues = [];
  const recommendations = [];
  const breadcrumbIssue = buildBreadcrumbSchemaIssue(
    combinedDetectedSchemas,
    breadcrumbUiPresent
  );
  const generatedSchemaSample = breadcrumbIssue
    ? buildBreadcrumbListSample(pageUrl, normalizedBreadcrumbTrail.links || [])
    : '';

  if (breadcrumbIssue) {
    issues.push(breadcrumbIssue);

    if (!missingSchemas.includes('BreadcrumbList')) {
      missingSchemas.push('BreadcrumbList');
    }

    recommendations.push(
      'Add BreadcrumbList schema to match visible breadcrumb navigation and help search engines understand page hierarchy.'
    );
  }

  let confidence = 'low';
  if (parseResult.scriptCount > 0) {
    confidence = parseResult.parsedScriptCount > 0 ? 'high' : 'medium';
  }

  const schemaAudit = buildSchemaAudit({
    pageType,
    source,
    pageUrl,
    jsonLdDocuments: parseResult.parsedDocuments,
    microdataItems,
    breadcrumbUiPresent,
    breadcrumbLinks: normalizedBreadcrumbTrail.links || [],
    jsonLdErrorCount: parseResult.errors.length,
    visiblePrice,
    visibleAvailability
  });

  (schemaAudit.consistencyWarnings || []).forEach(warning => {
    issues.push({
      type: warning.type || 'schema-ui-consistency',
      severity: warning.priority === 'high' ? 'high' : 'warning',
      message: warning.issue,
      recommendation: warning.howToFix,
      details: {
        schemaPrice: schemaAudit.schemaPrice || '',
        visiblePrice: schemaAudit.visiblePrice || '',
        priceMatchStatus: schemaAudit.priceMatchStatus || '',
        schemaAvailability: schemaAudit.schemaAvailability || '',
        visibleAvailability: schemaAudit.visibleAvailability || '',
        availabilityMatchStatus: schemaAudit.availabilityMatchStatus || ''
      }
    });
  });

  const generatedSchemaSamples = {
    ...(schemaAudit.generatedSchemaSamples || {})
  };
  if (generatedSchemaSample && !generatedSchemaSamples.breadcrumbList) {
    generatedSchemaSamples.breadcrumbList = generatedSchemaSample;
  }

  return {
    detectedSchemas: combinedDetectedSchemas,
    missingSchemas,
    confidence,
    source,
    breadcrumbUiPresent,
    breadcrumbLinks: normalizedBreadcrumbTrail.links || [],
    issues,
    recommendations,
    scriptCount: parseResult.scriptCount,
    parsedScriptCount: parseResult.parsedScriptCount,
    schemaObjectCount: parseResult.schemaObjectCount,
    jsonLdErrors: parseResult.errors,
    hasStructuredData:
      parseResult.scriptCount > 0 || microdataItems.length > 0,
    schemaTypes: combinedDetectedSchemas,
    microdataTypes,
    microdataItemCount: microdataItems.length,
    schemaAudit,
    generatedSchemaSample,
    generatedSchemaSamples,
    detectedSchemaTypes: schemaAudit.detectedSchemaTypes || combinedDetectedSchemas,
    expectedSchemaTypes: schemaAudit.expectedSchemaTypes || [],
    missingRequiredSchema: schemaAudit.missingRequiredSchema || [],
    missingRecommendedSchema: schemaAudit.missingRecommendedSchema || [],
    unexpectedSchemaTypes: schemaAudit.unexpectedSchemaTypes || [],
    schemaConflicts: schemaAudit.schemaConflicts || [],
    richResultSummary: schemaAudit.richResultSummary || {},
    schemaRecommendations: schemaAudit.schemaRecommendations || [],
    schemaScoreBreakdown: schemaAudit.schemaScoreBreakdown || {},
    schemaPrice: schemaAudit.schemaPrice || '',
    priceMatchStatus: schemaAudit.priceMatchStatus || '',
    schemaAvailability: schemaAudit.schemaAvailability || '',
    visibleAvailability: schemaAudit.visibleAvailability || '',
    availabilityMatchStatus: schemaAudit.availabilityMatchStatus || '',
    consistencyWarnings: schemaAudit.consistencyWarnings || [],
    visiblePrice: normalizePrice(visiblePrice) || '',
    totalDetectedItems:
      parseResult.schemaObjectCount + microdataItems.length > 0
        ? parseResult.schemaObjectCount + microdataItems.length
        : combinedDetectedSchemas.length > 0
          ? combinedDetectedSchemas.length
          : 0
  };
}

function extractStructuredDataFromHtml(html, pageType, pageUrl = '') {
  const $ = cheerio.load(html);
  const effectivePageType = resolveSchemaPageType(pageUrl, pageType, html, $);
  const scripts = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).html() || '')
    .get();
  const parseResult = parseJsonLdScripts(scripts);
  const breadcrumbTrail = extractBreadcrumbTrailFromCheerio($, pageUrl);
  const microdataItems = extractMicrodataItems($);
  const visiblePrice = extractVisiblePrice($);
  const visibleAvailability = extractVisibleAvailability($);

  return buildStructuredDataResult(
    effectivePageType,
    parseResult,
    'raw-html',
    pageUrl,
    breadcrumbTrail,
    microdataItems,
    visiblePrice,
    visibleAvailability
  );
}

async function extractStructuredDataWithPuppeteer(url, pageType) {
  let puppeteer;

  try {
    puppeteer = require('puppeteer');
  } catch (error) {
    return {
      error: 'Puppeteer not installed'
    };
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

    const renderedData = await page.evaluate(() => {
      const scriptContents = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]')
      ).map(node => node.textContent || '');

      const selectorMatches = document.querySelectorAll(
        'nav[aria-label*="breadcrumb" i], nav[aria-label*="breadcrumbs" i], [class*="breadcrumb" i], [class*="breadcrumbs" i], [data-testid*="breadcrumb" i]'
      ).length;

      const containers = Array.from(document.querySelectorAll('nav, ol, ul, div'));
      const breadcrumbTrail = containers.some(node => {
        const links = node.querySelectorAll('a').length;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();

        return links >= 3 && /home\s*(>|\/|›|»|→).+\s*(>|\/|›|»|→).+/i.test(text);
      });

      const priceSelectors = [
        '[itemprop="price"]',
        '[data-product-price]',
        '[data-testid*="price" i]',
        '.price-item--regular',
        '.price-item',
        '.product__price',
        '.price',
        '.money'
      ];

      let visiblePrice = '';
      for (const selector of priceSelectors) {
        const match = Array.from(document.querySelectorAll(selector))
          .map(node => (node.getAttribute('content') || node.textContent || '').replace(/\s+/g, ' ').trim())
          .find(Boolean);

        if (match) {
          visiblePrice = match;
          break;
        }
      }

      if (!visiblePrice) {
        const bodyText = (document.body?.textContent || '').replace(/\s+/g, ' ').trim();
        const fallbackMatch = bodyText.match(/(?:Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
        visiblePrice = fallbackMatch ? fallbackMatch[1] : '';
      }

      return {
        scriptContents,
        visiblePrice,
        breadcrumbUiPresent: selectorMatches > 0 || breadcrumbTrail
      };
    });

    const parseResult = parseJsonLdScripts(renderedData.scriptContents);
    const renderedHtml = await page.content();
    const rendered$ = cheerio.load(renderedHtml);
    const renderedMicrodataItems = extractMicrodataItems(rendered$);
    const breadcrumbTrail = extractBreadcrumbTrailFromCheerio(rendered$, url);
    const visibleAvailability = extractVisibleAvailability(rendered$);

    return buildStructuredDataResult(
      pageType,
      parseResult,
      'puppeteer',
      url,
      breadcrumbTrail,
      renderedMicrodataItems,
      normalizePrice(renderedData.visiblePrice) || '',
      visibleAvailability
    );
  } catch (error) {
    return {
      error: error.message
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function extractStructuredDataForPage({ url, html, pageType }) {
  const effectivePageType = resolveSchemaPageType(url, pageType, html, cheerio.load(html));
  const rawResult = extractStructuredDataFromHtml(html, effectivePageType, url);

  console.log(
    `[structured-data:raw] ${url} pageType=${effectivePageType} scripts=${rawResult.scriptCount} parsed=${rawResult.parsedScriptCount} types=${rawResult.detectedSchemas.join(', ') || 'none'}`
  );

  if (
    rawResult.detectedSchemas.length > 0 ||
    rawResult.microdataItemCount > 0 ||
    rawResult.hasStructuredData
  ) {
    return rawResult;
  }

  const renderedResult = await extractStructuredDataWithPuppeteer(
    url,
    effectivePageType
  );

  if (!renderedResult.error) {
    console.log(
      `[structured-data:puppeteer] ${url} pageType=${effectivePageType} scripts=${renderedResult.scriptCount} parsed=${renderedResult.parsedScriptCount} types=${renderedResult.detectedSchemas.join(', ') || 'none'}`
    );

    return renderedResult;
  }

  console.log(
    `[structured-data:fallback] ${url} using raw HTML result because Puppeteer failed: ${renderedResult.error}`
  );

  return {
    ...rawResult,
    fallbackReason: renderedResult.error
  };
}

module.exports = {
  normalizeSchemaType,
  parseJsonLdScripts,
  resolveSchemaPageType,
  detectBreadcrumbUiFromCheerio,
  extractBreadcrumbTrailFromCheerio,
  extractStructuredDataFromHtml,
  extractStructuredDataWithPuppeteer,
  extractStructuredDataForPage,
  buildBreadcrumbListSample
};

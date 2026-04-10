const cheerio = require('cheerio');
const {
  extractMicrodataItems,
  buildSchemaAudit,
  normalizePrice
} = require('../audits/schemaAudit');

const REQUIRED_SCHEMAS_BY_PAGE_TYPE = {
  homepage: ['Organization', 'WebSite'],
  product: ['Product'],
  collection: ['BreadcrumbList', 'ItemList'],
  blog: ['Article'],
  other: []
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

function hasBreadcrumbTrailText(text) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return false;
  }

  return /(home\s*(>|\/|›|»|→).+\s*(>|\/|›|»|→).+)/i.test(normalized);
}

function detectBreadcrumbUiFromCheerio($) {
  const explicitMatches = [
    'nav[aria-label*="breadcrumb" i]',
    'nav[aria-label*="breadcrumbs" i]',
    '[class*="breadcrumb" i]',
    '[class*="breadcrumbs" i]',
    '[data-testid*="breadcrumb" i]'
  ];

  if ($(explicitMatches.join(',')).length > 0) {
    return true;
  }

  let hasTrail = false;

  $('nav, ol, ul, div').each((_, el) => {
    const links = $(el).find('a');
    const text = $(el).text();

    if (links.length >= 3 && hasBreadcrumbTrailText(text)) {
      hasTrail = true;
      return false;
    }

    return undefined;
  });

  return hasTrail;
}

function resolveSchemaPageType(url, pageType) {
  try {
    const parsedUrl = new URL(url);
    const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '') || '/';

    if (normalizedPath === '/') {
      return 'homepage';
    }
  } catch (error) {
    return pageType || 'other';
  }

  return pageType || 'other';
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
    message: 'Breadcrumb UI found but schema missing'
  };
}

function buildStructuredDataResult(
  pageType,
  parseResult,
  source,
  breadcrumbUiPresent = false,
  microdataItems = [],
  visiblePrice = ''
) {
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
    jsonLdDocuments: parseResult.parsedDocuments,
    microdataItems,
    visiblePrice
  });

  return {
    detectedSchemas: combinedDetectedSchemas,
    missingSchemas,
    confidence,
    source,
    breadcrumbUiPresent,
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
    visiblePrice: normalizePrice(visiblePrice) || '',
    totalDetectedItems:
      parseResult.schemaObjectCount + microdataItems.length > 0
        ? parseResult.schemaObjectCount + microdataItems.length
        : combinedDetectedSchemas.length > 0
          ? combinedDetectedSchemas.length
          : 0
  };
}

function extractStructuredDataFromHtml(html, pageType) {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).html() || '')
    .get();
  const parseResult = parseJsonLdScripts(scripts);
  const breadcrumbUiPresent = detectBreadcrumbUiFromCheerio($);
  const microdataItems = extractMicrodataItems($);
  const visiblePrice = extractVisiblePrice($);

  return buildStructuredDataResult(
    pageType,
    parseResult,
    'raw-html',
    breadcrumbUiPresent,
    microdataItems,
    visiblePrice
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
    const renderedMicrodataItems = extractMicrodataItems(cheerio.load(renderedHtml));

    return buildStructuredDataResult(
      pageType,
      parseResult,
      'puppeteer',
      renderedData.breadcrumbUiPresent,
      renderedMicrodataItems,
      normalizePrice(renderedData.visiblePrice) || ''
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
  const effectivePageType = resolveSchemaPageType(url, pageType);
  const rawResult = extractStructuredDataFromHtml(html, effectivePageType);

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
  extractStructuredDataFromHtml,
  extractStructuredDataWithPuppeteer,
  extractStructuredDataForPage
};

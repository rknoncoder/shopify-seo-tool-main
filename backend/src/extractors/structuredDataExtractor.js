const cheerio = require('cheerio');

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

function hasBreadcrumbTrailText(text) {
  const normalized = String(text || '')
    .replace(/s+/g, ' ')
    .trim();

  if (!normalized) {
    return false;
  }

  return /homes*[>/].+[>/].+/i.test(normalized);
}

function normalizeBreadcrumbLabel(value) {
  return String(value || '')
    .replace(/s+/g, ' ')
    .replace(/s*[>/]s*/g, ' ')
    .trim();
}

function normalizeBreadcrumbPath(path = []) {
  return path
    .map(normalizeBreadcrumbLabel)
    .filter(Boolean)
    .filter((label, index, all) => index === 0 || label !== all[index - 1]);
}

function extractPathFromElement($, element) {
  const container = $(element);
  let segments = container
    .find('li')
    .map((_, item) => {
      const label = $(item).find('a, span, [aria-current]').first().text() || $(item).text();
      return normalizeBreadcrumbLabel(label);
    })
    .get()
    .filter(Boolean);

  if (segments.length < 2) {
    segments = container
      .find('a, span, [aria-current]')
      .map((_, item) => normalizeBreadcrumbLabel($(item).text()))
      .get()
      .filter(Boolean);
  }

  if (segments.length < 2) {
    const text = normalizeBreadcrumbLabel(container.text());
    if (hasBreadcrumbTrailText(text)) {
      segments = text
        .split(/[>/]/)
        .map(normalizeBreadcrumbLabel)
        .filter(Boolean);
    }
  }

  return normalizeBreadcrumbPath(segments);
}

function extractBreadcrumbUIPath($) {
  const candidates = [];
  const selectors = [
    'nav[aria-label*="breadcrumb" i]',
    'nav[aria-label*="breadcrumbs" i]',
    '[class*="breadcrumb" i]',
    '[class*="breadcrumbs" i]',
    '[data-testid*="breadcrumb" i]',
    'ol'
  ];

  $(selectors.join(',')).each((_, element) => {
    const path = extractPathFromElement($, element);
    const text = normalizeBreadcrumbLabel($(element).text());
    const className = $(element).attr('class') || '';
    const hasListItems = $(element).find('li').length >= 2;
    const looksLikeBreadcrumb =
      path.length >= 2 &&
      (
        /breadcrumb/i.test(className) ||
        hasBreadcrumbTrailText(text) ||
        hasListItems ||
        path.length <= 6
      );

    if (looksLikeBreadcrumb) {
      candidates.push(path);
    }
  });

  return candidates.sort((left, right) => right.length - left.length)[0] || [];
}

function detectBreadcrumbUI($) {
  return extractBreadcrumbUIPath($).length > 0;
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

function hasSchemaType(value, expectedType) {
  const normalizedExpected = normalizeSchemaType(expectedType);
  const typeValue = value?.['@type'];

  if (Array.isArray(typeValue)) {
    return typeValue.some(type => normalizeSchemaType(type) === normalizedExpected);
  }

  return normalizeSchemaType(typeValue) === normalizedExpected;
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
    value['@graph'].forEach(item => collectSchemaTypes(item, detected, seen));
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === '@context' || key === '@graph') {
      return;
    }

    collectSchemaTypes(child, detected, seen);
  });

  return detected;
}

function collectBreadcrumbLists(value, found = [], seen = new WeakSet()) {
  if (!value) {
    return found;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectBreadcrumbLists(item, found, seen));
    return found;
  }

  if (typeof value !== 'object') {
    return found;
  }

  if (seen.has(value)) {
    return found;
  }

  seen.add(value);

  if (hasSchemaType(value, 'BreadcrumbList')) {
    found.push(value);
  }

  if (Array.isArray(value['@graph'])) {
    value['@graph'].forEach(item => collectBreadcrumbLists(item, found, seen));
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === '@context' || key === '@graph') {
      return;
    }

    collectBreadcrumbLists(child, found, seen);
  });

  return found;
}

function extractNameFromBreadcrumbItem(item) {
  if (!item) {
    return '';
  }

  if (typeof item === 'string') {
    return normalizeBreadcrumbLabel(item);
  }

  if (typeof item === 'object') {
    if (item.name) {
      return normalizeBreadcrumbLabel(item.name);
    }

    if (item.item && typeof item.item === 'object' && item.item.name) {
      return normalizeBreadcrumbLabel(item.item.name);
    }

    if (item.item && typeof item.item === 'string') {
      try {
        const parsedUrl = new URL(item.item);
        const segments = parsedUrl.pathname.split('/').filter(Boolean);
        return normalizeBreadcrumbLabel(segments[segments.length - 1] || parsedUrl.hostname);
      } catch (error) {
        return normalizeBreadcrumbLabel(item.item);
      }
    }
  }

  return '';
}

function extractBreadcrumbSchemaPath(parsedDocuments = []) {
  const candidates = [];

  parsedDocuments.forEach(document => {
    const lists = collectBreadcrumbLists(document);

    lists.forEach(list => {
      const elements = Array.isArray(list.itemListElement)
        ? [...list.itemListElement].sort((left, right) => {
            const leftPosition = Number(left?.position || 0);
            const rightPosition = Number(right?.position || 0);
            return leftPosition - rightPosition;
          })
        : [];

      const path = normalizeBreadcrumbPath(
        elements.map(extractNameFromBreadcrumbItem).filter(Boolean)
      );

      if (path.length > 0) {
        candidates.push(path);
      }
    });
  });

  return candidates.sort((left, right) => right.length - left.length)[0] || [];
}

function detectBreadcrumbSchema(parsedDocuments = []) {
  return extractBreadcrumbSchemaPath(parsedDocuments).length > 0;
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

function generateBreadcrumbIssues(data, options = {}) {
  const issues = [];
  const { requireBreadcrumb = false } = options;
  const uiPath = normalizeBreadcrumbPath(data.ui_path || []);
  const schemaPath = normalizeBreadcrumbPath(data.schema_path || []);
  const uiPresent = Boolean(data.ui_present);
  const schemaPresent = Boolean(data.schema_present);

  if (!uiPresent && !schemaPresent && !requireBreadcrumb) {
    return issues;
  }

  if (uiPresent && !schemaPresent) {
    issues.push({
      type: 'breadcrumb_schema_missing',
      severity: 'high',
      message: 'Breadcrumb UI found but schema missing',
      details: {
        ui_present: true,
        schema_present: false,
        ui_path: uiPath,
        schema_path: schemaPath
      }
    });

    return issues;
  }

  if (!uiPresent && schemaPresent) {
    issues.push({
      type: 'breadcrumb_ui_missing',
      severity: 'low',
      message: 'Breadcrumb schema exists but breadcrumb UI is missing',
      details: {
        ui_present: false,
        schema_present: true,
        ui_path: uiPath,
        schema_path: schemaPath
      }
    });

    return issues;
  }

  if (!uiPresent && !schemaPresent) {
    issues.push({
      type: 'breadcrumb_missing',
      severity: 'medium',
      message: 'Both breadcrumb UI and schema are missing',
      details: {
        ui_present: false,
        schema_present: false,
        ui_path: uiPath,
        schema_path: schemaPath
      }
    });

    return issues;
  }

  const normalizedUi = uiPath.map(label => label.toLowerCase());
  const normalizedSchema = schemaPath.map(label => label.toLowerCase());

  if (
    normalizedUi.length > 0 &&
    normalizedSchema.length > 0 &&
    JSON.stringify(normalizedUi) !== JSON.stringify(normalizedSchema)
  ) {
    issues.push({
      type: 'breadcrumb_mismatch',
      severity: 'medium',
      message: 'Breadcrumb UI and schema paths do not match',
      details: {
        ui_present: true,
        schema_present: true,
        ui_path: uiPath,
        schema_path: schemaPath
      }
    });
  }

  return issues;
}

function buildStructuredDataResult(
  pageType,
  parseResult,
  source,
  breadcrumbData = {
    ui_present: false,
    schema_present: false,
    ui_path: [],
    schema_path: []
  }
) {
  const missingSchemas = buildMissingSchemas(pageType, parseResult.detectedSchemas);
  const requireBreadcrumb = ['product', 'collection'].includes(pageType);
  const breadcrumb = {
    ui_present: Boolean(breadcrumbData.ui_present),
    schema_present: Boolean(breadcrumbData.schema_present),
    ui_path: normalizeBreadcrumbPath(breadcrumbData.ui_path || []),
    schema_path: normalizeBreadcrumbPath(breadcrumbData.schema_path || [])
  };
  const issues = generateBreadcrumbIssues(breadcrumb, { requireBreadcrumb });
  const recommendations = [];

  if (!breadcrumb.schema_present && !missingSchemas.includes('BreadcrumbList')) {
    missingSchemas.push('BreadcrumbList');
  }

  if (issues.some(issue => issue.type === 'breadcrumb_schema_missing')) {
    recommendations.push(
      'Add BreadcrumbList schema to match visible breadcrumb navigation and help search engines understand page hierarchy.'
    );
  }

  if (issues.some(issue => issue.type === 'breadcrumb_mismatch')) {
    recommendations.push(
      'Align breadcrumb schema names with the visible breadcrumb UI so search engines and users see the same hierarchy.'
    );
  }

  let confidence = 'low';
  if (parseResult.scriptCount > 0) {
    confidence = parseResult.parsedScriptCount > 0 ? 'high' : 'medium';
  }

  return {
    detectedSchemas: parseResult.detectedSchemas,
    missingSchemas,
    confidence,
    source,
    breadcrumb,
    issues,
    recommendations,
    scriptCount: parseResult.scriptCount,
    parsedScriptCount: parseResult.parsedScriptCount,
    schemaObjectCount: parseResult.schemaObjectCount,
    jsonLdErrors: parseResult.errors,
    hasStructuredData: parseResult.scriptCount > 0,
    schemaTypes: parseResult.detectedSchemas,
    totalDetectedItems:
      parseResult.schemaObjectCount > 0
        ? parseResult.schemaObjectCount
        : parseResult.detectedSchemas.length > 0
          ? parseResult.detectedSchemas.length
          : 0
  };
}

function extractStructuredDataFromHtml(html, pageType) {
  const $ = cheerio.load(html);
  const scripts = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).html() || '')
    .get();
  const parseResult = parseJsonLdScripts(scripts);
  const breadcrumb = {
    ui_present: detectBreadcrumbUI($),
    schema_present: detectBreadcrumbSchema(parseResult.parsedDocuments),
    ui_path: extractBreadcrumbUIPath($),
    schema_path: extractBreadcrumbSchemaPath(parseResult.parsedDocuments)
  };

  return buildStructuredDataResult(
    pageType,
    parseResult,
    'raw-html',
    breadcrumb
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
      const normalizeLabel = value =>
        String(value || '')
          .replace(/s+/g, ' ')
          .replace(/s*[>/]s*/g, ' ')
          .trim();

      const normalizePath = path =>
        path
          .map(normalizeLabel)
          .filter(Boolean)
          .filter((label, index, all) => index === 0 || label !== all[index - 1]);

      const hasTrailText = text => /homes*[>/].+[>/].+/i.test(text);

      const extractPathFromElement = element => {
        let segments = Array.from(element.querySelectorAll('li')).map(item => {
          const target = item.querySelector('a, span, [aria-current]') || item;
          return normalizeLabel(target.textContent || '');
        }).filter(Boolean);

        if (segments.length < 2) {
          segments = Array.from(element.querySelectorAll('a, span, [aria-current]'))
            .map(item => normalizeLabel(item.textContent || ''))
            .filter(Boolean);
        }

        if (segments.length < 2) {
          const text = normalizeLabel(element.textContent || '');
          if (hasTrailText(text)) {
            segments = text
              .split(/[>/]/)
              .map(normalizeLabel)
              .filter(Boolean);
          }
        }

        return normalizePath(segments);
      };

      const selectors = [
        'nav[aria-label*="breadcrumb" i]',
        'nav[aria-label*="breadcrumbs" i]',
        '[class*="breadcrumb" i]',
        '[class*="breadcrumbs" i]',
        '[data-testid*="breadcrumb" i]',
        'ol'
      ];

      const uiCandidates = Array.from(document.querySelectorAll(selectors.join(',')))
        .map(extractPathFromElement)
        .filter(path => path.length >= 2)
        .sort((left, right) => right.length - left.length);

      return {
        scriptContents: Array.from(
          document.querySelectorAll('script[type="application/ld+json"]')
        ).map(node => node.textContent || ''),
        breadcrumb: {
          ui_present: uiCandidates.length > 0,
          ui_path: uiCandidates[0] || []
        }
      };
    });

    const parseResult = parseJsonLdScripts(renderedData.scriptContents);
    const breadcrumb = {
      ui_present: renderedData.breadcrumb.ui_present,
      ui_path: renderedData.breadcrumb.ui_path,
      schema_present: detectBreadcrumbSchema(parseResult.parsedDocuments),
      schema_path: extractBreadcrumbSchemaPath(parseResult.parsedDocuments)
    };

    return buildStructuredDataResult(
      pageType,
      parseResult,
      'puppeteer',
      breadcrumb
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

  if (rawResult.detectedSchemas.length > 0) {
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
  detectBreadcrumbUI,
  detectBreadcrumbSchema,
  extractBreadcrumbUIPath,
  extractBreadcrumbSchemaPath,
  generateBreadcrumbIssues,
  extractStructuredDataFromHtml,
  extractStructuredDataWithPuppeteer,
  extractStructuredDataForPage
};

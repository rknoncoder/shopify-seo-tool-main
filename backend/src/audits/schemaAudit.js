function normalizeSchemaType(type) {
  return String(type || '')
    .trim()
    .replace(/^https?:\/\/schema\.org\//i, '')
    .replace(/^schema:/i, '');
}

function getNormalizedTypeList(value) {
  const rawTypes = Array.isArray(value?.['@type'])
    ? value['@type']
    : value?.['@type']
      ? [value['@type']]
      : [];

  return rawTypes.map(normalizeSchemaType).filter(Boolean);
}

function collectEntitiesByTypes(
  value,
  targetTypes,
  entities = [],
  seen = new WeakSet()
) {
  if (!value) {
    return entities;
  }

  if (Array.isArray(value)) {
    value.forEach(item =>
      collectEntitiesByTypes(item, targetTypes, entities, seen)
    );
    return entities;
  }

  if (typeof value !== 'object') {
    return entities;
  }

  if (seen.has(value)) {
    return entities;
  }

  seen.add(value);

  const types = getNormalizedTypeList(value);
  if (types.some(type => targetTypes.has(type))) {
    entities.push({
      source: 'json-ld',
      types,
      entity: value
    });
  }

  if (Array.isArray(value['@graph'])) {
    value['@graph'].forEach(item =>
      collectEntitiesByTypes(item, targetTypes, entities, seen)
    );
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === '@context' || key === '@graph') {
      return;
    }

    collectEntitiesByTypes(child, targetTypes, entities, seen);
  });

  return entities;
}

function collectAllSchemaTypes(value, detected = new Set(), seen = new WeakSet()) {
  if (!value) {
    return detected;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectAllSchemaTypes(item, detected, seen));
    return detected;
  }

  if (typeof value !== 'object') {
    return detected;
  }

  if (seen.has(value)) {
    return detected;
  }

  seen.add(value);

  getNormalizedTypeList(value).forEach(type => detected.add(type));

  if (Array.isArray(value['@graph'])) {
    value['@graph'].forEach(item => collectAllSchemaTypes(item, detected, seen));
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === '@context' || key === '@graph') {
      return;
    }

    collectAllSchemaTypes(child, detected, seen);
  });

  return detected;
}

function normalizeMicrodataType(itemType) {
  return normalizeSchemaType(String(itemType || '').split(/\s+/)[0]);
}

function readMicrodataValue($, element) {
  const node = $(element);

  return (
    node.attr('content') ||
    node.attr('href') ||
    node.attr('src') ||
    node.attr('datetime') ||
    node.attr('value') ||
    node.text() ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMicrodataProperties($, root) {
  const properties = {};

  $(root).find('[itemprop]').each((_, element) => {
    const ownerScope = $(element).closest('[itemscope]').get(0);
    if (ownerScope && ownerScope !== root) {
      return;
    }

    const key = String($(element).attr('itemprop') || '').trim();
    if (!key) {
      return;
    }

    const value = readMicrodataValue($, element);
    if (!value) {
      return;
    }

    if (!properties[key]) {
      properties[key] = [];
    }

    properties[key].push(value);
  });

  return properties;
}

function extractMicrodataItems($) {
  const items = [];

  $('[itemscope][itemtype]').each((_, element) => {
    const itemType = normalizeMicrodataType($(element).attr('itemtype'));
    if (!itemType) {
      return;
    }

    items.push({
      source: 'microdata',
      types: [itemType],
      properties: extractMicrodataProperties($, element)
    });
  });

  return items;
}

function readJsonLdField(entity, key) {
  const value = entity?.[key];

  if (Array.isArray(value)) {
    return value.find(Boolean);
  }

  return value;
}

function readOfferField(entity, key) {
  const offers = readJsonLdField(entity, 'offers');

  if (Array.isArray(offers)) {
    return offers.map(offer => offer?.[key]).find(Boolean);
  }

  return offers?.[key];
}

function hasImageValue(value) {
  if (!value) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some(hasImageValue);
  }

  if (typeof value === 'string') {
    return Boolean(value.trim());
  }

  if (typeof value === 'object') {
    return Boolean(value.url || value.contentUrl || value.image);
  }

  return false;
}

function hasProductEligibilityFields(candidate) {
  if (candidate.source === 'microdata') {
    const props = candidate.properties || {};
    return {
      name: Boolean(props.name?.[0]),
      image: Boolean(props.image?.[0]),
      price: Boolean(props.price?.[0]),
      availability: Boolean(props.availability?.[0])
    };
  }

  const entity = candidate.entity || {};

  return {
    name: Boolean(readJsonLdField(entity, 'name')),
    image: hasImageValue(readJsonLdField(entity, 'image')),
    price: Boolean(
      readJsonLdField(entity, 'price') || readOfferField(entity, 'price')
    ),
    availability: Boolean(
      readJsonLdField(entity, 'availability') ||
        readOfferField(entity, 'availability')
    )
  };
}

function getOptionalProductFieldMap(candidate) {
  if (!candidate) {
    return {};
  }

  if (candidate.source === 'microdata') {
    const props = candidate.properties || {};
    return {
      gtin13: Boolean(props.gtin13?.[0]),
      color: Boolean(props.color?.[0]),
      material: Boolean(props.material?.[0])
    };
  }

  const entity = candidate.entity || {};

  return {
    gtin13: Boolean(readJsonLdField(entity, 'gtin13')),
    color: Boolean(readJsonLdField(entity, 'color')),
    material: Boolean(readJsonLdField(entity, 'material'))
  };
}

function getPrimaryProductCandidate(productCandidates = []) {
  return (
    productCandidates.find(candidate => candidate.source === 'json-ld') ||
    productCandidates[0] ||
    null
  );
}

function getDuplicateProductCandidates(productCandidates = [], primaryCandidate) {
  return productCandidates.filter(candidate => candidate !== primaryCandidate);
}

function normalizePrice(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).replace(/,/g, '').trim();
  const match = text.match(/\d+(?:\.\d{1,2})?/);

  if (!match) {
    return null;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : null;
}

function normalizeAvailability(value) {
  const text = String(value || '')
    .replace(/^https?:\/\/schema\.org\//i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!text) {
    return '';
  }

  if (/(out of stock|sold out|unavailable|discontinued)/i.test(text)) {
    return 'out_of_stock';
  }

  if (/(pre order|preorder|pre sale|presale)/i.test(text)) {
    return 'preorder';
  }

  if (/(back order|backorder)/i.test(text)) {
    return 'backorder';
  }

  if (/(in stock|instock|available|add to cart|buy now)/i.test(text)) {
    return 'in_stock';
  }

  return '';
}

function uniqueValues(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function getOfferValues(entity, key) {
  const offers = entity?.offers;

  if (Array.isArray(offers)) {
    return offers.map(offer => offer?.[key]).filter(Boolean);
  }

  return offers?.[key] ? [offers[key]] : [];
}

function getSchemaPrice(candidate) {
  if (!candidate) {
    return null;
  }

  if (candidate.source === 'microdata') {
    return normalizePrice(candidate.properties?.price?.[0]);
  }

  const entity = candidate.entity || {};
  return normalizePrice(
    readJsonLdField(entity, 'price') || readOfferField(entity, 'price')
  );
}

function getSchemaPrices(candidate) {
  if (!candidate) {
    return [];
  }

  if (candidate.source === 'microdata') {
    return uniqueValues((candidate.properties?.price || []).map(normalizePrice));
  }

  const entity = candidate.entity || {};
  return uniqueValues([
    normalizePrice(readJsonLdField(entity, 'price')),
    ...getOfferValues(entity, 'price').map(normalizePrice),
    ...getOfferValues(entity, 'lowPrice').map(normalizePrice),
    ...getOfferValues(entity, 'highPrice').map(normalizePrice)
  ]);
}

function getSchemaAvailability(candidate) {
  if (!candidate) {
    return '';
  }

  if (candidate.source === 'microdata') {
    return normalizeAvailability(candidate.properties?.availability?.[0]);
  }

  const entity = candidate.entity || {};
  return normalizeAvailability(
    readJsonLdField(entity, 'availability') ||
      readOfferField(entity, 'availability')
  );
}

function getSchemaAvailabilities(candidate) {
  if (!candidate) {
    return [];
  }

  if (candidate.source === 'microdata') {
    return uniqueValues(
      (candidate.properties?.availability || []).map(normalizeAvailability)
    );
  }

  const entity = candidate.entity || {};
  return uniqueValues([
    normalizeAvailability(readJsonLdField(entity, 'availability')),
    ...getOfferValues(entity, 'availability').map(normalizeAvailability)
  ]);
}

function getAllSchemaPrices(productCandidates = []) {
  return uniqueValues(productCandidates.flatMap(getSchemaPrices));
}

function getAllSchemaAvailabilities(productCandidates = []) {
  return uniqueValues(productCandidates.flatMap(getSchemaAvailabilities));
}

function normalizeEntityId(value) {
  return String(value || '').trim();
}

function getEntityId(entity) {
  return normalizeEntityId(entity?.['@id']);
}

function collectLinkedEntityIds(value, found = new Set()) {
  if (!value) {
    return found;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectLinkedEntityIds(item, found));
    return found;
  }

  if (typeof value === 'string') {
    const normalized = normalizeEntityId(value);
    if (normalized.startsWith('#') || normalized.startsWith('http')) {
      found.add(normalized);
    }
    return found;
  }

  if (typeof value === 'object') {
    const entityId = getEntityId(value);
    if (entityId) {
      found.add(entityId);
    }

    if (value.item) {
      collectLinkedEntityIds(value.item, found);
    }
  }

  return found;
}

function hasSchemaTypeInJsonLd(jsonLdDocuments = [], schemaType) {
  const targetTypes = new Set([schemaType]);

  return jsonLdDocuments.some(
    document => collectEntitiesByTypes(document, targetTypes).length > 0
  );
}

function hasSchemaTypeInMicrodata(microdataItems = [], schemaType) {
  return microdataItems.some(item =>
    (item.types || []).some(type => type === schemaType)
  );
}

const PAGE_SCHEMA_RULES = {
  homepage: {
    required: [
      { label: 'Organization', anyOf: ['Organization'] },
      { label: 'WebSite', anyOf: ['WebSite'] }
    ],
    recommended: []
  },
  collection: {
    required: [
      { label: 'CollectionPage or WebPage', anyOf: ['CollectionPage', 'WebPage'] }
    ],
    recommended: [
      { label: 'BreadcrumbList', anyOf: ['BreadcrumbList'] },
      { label: 'ItemList', anyOf: ['ItemList'], optional: true }
    ]
  },
  product: {
    required: [
      { label: 'Product or ProductGroup', anyOf: ['Product', 'ProductGroup'] },
      { label: 'Offer or AggregateOffer', anyOf: ['Offer', 'AggregateOffer'] }
    ],
    recommended: [{ label: 'BreadcrumbList', anyOf: ['BreadcrumbList'] }]
  },
  blog: {
    required: [
      { label: 'Article or BlogPosting', anyOf: ['Article', 'BlogPosting'] }
    ],
    recommended: [{ label: 'BreadcrumbList', anyOf: ['BreadcrumbList'] }]
  },
  page: {
    required: [{ label: 'WebPage', anyOf: ['WebPage'] }],
    recommended: []
  },
  search: {
    required: [{ label: 'SearchResultsPage or WebPage', anyOf: ['SearchResultsPage', 'WebPage'] }],
    recommended: []
  },
  webpage: {
    required: [{ label: 'WebPage', anyOf: ['WebPage'] }],
    recommended: []
  }
};

function getSchemaRules(pageType) {
  return PAGE_SCHEMA_RULES[pageType] || PAGE_SCHEMA_RULES.webpage;
}

function hasAnySchemaType(detectedTypes, expectedTypes) {
  const typeSet = new Set(detectedTypes || []);
  return expectedTypes.some(type => typeSet.has(type));
}

function listExpectedSchemaTypes(pageType) {
  const rules = getSchemaRules(pageType);
  return [
    ...rules.required.map(rule => rule.label),
    ...rules.recommended.map(rule =>
      rule.optional ? `${rule.label} (optional)` : rule.label
    )
  ];
}

function getMissingSchemaGroups(pageType, detectedTypes, breadcrumbUiPresent) {
  const rules = getSchemaRules(pageType);
  const missingRequired = rules.required
    .filter(rule => !hasAnySchemaType(detectedTypes, rule.anyOf))
    .map(rule => rule.label);
  const missingRecommended = rules.recommended
    .filter(rule => !hasAnySchemaType(detectedTypes, rule.anyOf))
    .filter(rule => {
      if (rule.label === 'BreadcrumbList') {
        return pageType !== 'homepage' && breadcrumbUiPresent;
      }

      return true;
    })
    .map(rule => rule.label);

  return {
    missingRequired,
    missingRecommended
  };
}

function getUnexpectedSchemaTypes(pageType, detectedTypes) {
  const typeSet = new Set(detectedTypes || []);
  const unexpected = [];

  if (pageType !== 'product' && (typeSet.has('Product') || typeSet.has('ProductGroup'))) {
    unexpected.push({
      type: 'Product/ProductGroup',
      priority: pageType === 'collection' ? 'medium' : 'high',
      reason: 'Product schema should usually be limited to canonical product detail pages.'
    });
  }

  if (pageType !== 'blog' && (typeSet.has('Article') || typeSet.has('BlogPosting'))) {
    unexpected.push({
      type: 'Article/BlogPosting',
      priority: 'medium',
      reason: 'Article schema should only describe article or blog content.'
    });
  }

  if (pageType !== 'collection' && typeSet.has('CollectionPage')) {
    unexpected.push({
      type: 'CollectionPage',
      priority: 'medium',
      reason: 'CollectionPage schema should describe Shopify collection pages.'
    });
  }

  if (pageType !== 'homepage' && typeSet.has('WebSite')) {
    unexpected.push({
      type: 'WebSite',
      priority: 'low',
      reason: 'WebSite schema is usually strongest as a homepage/site entity.'
    });
  }

  return unexpected;
}

function getSchemaConflicts(pageType, detectedTypes, productCandidates) {
  const typeSet = new Set(detectedTypes || []);
  const conflicts = [];
  const productTypeCount = productCandidates.filter(
    candidate => candidate.source === 'json-ld'
  ).length;

  if (
    (typeSet.has('Product') || typeSet.has('ProductGroup')) &&
    (typeSet.has('Article') || typeSet.has('BlogPosting'))
  ) {
    conflicts.push({
      priority: 'high',
      issue: 'Product and Article schema are both present',
      whyItMatters:
        'Mixed primary entities make it harder for search engines to understand the page intent.',
      howToFix:
        'Keep one primary schema type that matches the Shopify page template.'
    });
  }

  if (pageType === 'collection' && (typeSet.has('Product') || typeSet.has('ProductGroup'))) {
    conflicts.push({
      priority: 'medium',
      issue: 'Collection page contains product-detail schema',
      whyItMatters:
        'Collection pages should describe the collection, not compete with product detail pages.',
      howToFix:
        'Use CollectionPage plus optional ItemList, and reserve Product schema for /products/ URLs.'
    });
  }

  if (productTypeCount > 1) {
    conflicts.push({
      priority: 'medium',
      issue: 'Multiple JSON-LD Product entities detected',
      whyItMatters:
        'Duplicate Product entities from theme and app injections can create inconsistent rich result data.',
      howToFix:
        'Choose one canonical Product/ProductGroup implementation and remove duplicate app or theme output.'
    });
  }

  return conflicts;
}

function getOrigin(pageUrl) {
  try {
    return new URL(pageUrl).origin;
  } catch (error) {
    return '';
  }
}

function getPageEntityId(pageUrl, suffix) {
  const cleanUrl = String(pageUrl || '').split('#')[0];
  return cleanUrl ? `${cleanUrl}#${suffix}` : `#${suffix}`;
}

function stringifySample(value) {
  return JSON.stringify(value, null, 2);
}

function buildOrganizationSample(pageUrl) {
  const origin = getOrigin(pageUrl);

  if (!origin) {
    return '';
  }

  return stringifySample({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${origin}/#organization`,
    name: 'Store name',
    url: `${origin}/`,
    logo: `${origin}/path-to-logo.png`
  });
}

function buildWebSiteSample(pageUrl) {
  const origin = getOrigin(pageUrl);

  if (!origin) {
    return '';
  }

  return stringifySample({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${origin}/#website`,
    url: `${origin}/`,
    name: 'Store name',
    publisher: {
      '@id': `${origin}/#organization`
    }
  });
}

function buildBreadcrumbSampleFromLinks(pageUrl, breadcrumbLinks = []) {
  const links = (breadcrumbLinks || []).filter(link => link?.name);

  if (links.length === 0) {
    return '';
  }

  const normalizedLinks = [...links];
  const firstLabel = String(normalizedLinks[0]?.name || '').trim().toLowerCase();
  const origin = getOrigin(pageUrl);

  if (firstLabel !== 'home') {
    normalizedLinks.unshift({
      name: 'Home',
      href: '/',
      item: origin ? `${origin}/` : '/'
    });
  }

  return stringifySample({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    '@id': getPageEntityId(pageUrl, 'breadcrumb'),
    itemListElement: normalizedLinks.map((link, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: link.name,
      item: link.item || link.href || pageUrl
    }))
  });
}

function buildCollectionPageSample(pageUrl) {
  const origin = getOrigin(pageUrl);

  return stringifySample({
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': getPageEntityId(pageUrl, 'webpage'),
    url: pageUrl,
    name: 'Collection name',
    isPartOf: origin ? { '@id': `${origin}/#website` } : undefined,
    publisher: origin ? { '@id': `${origin}/#organization` } : undefined,
    breadcrumb: {
      '@id': getPageEntityId(pageUrl, 'breadcrumb')
    }
  });
}

function buildItemListSample(pageUrl) {
  return stringifySample({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    '@id': getPageEntityId(pageUrl, 'itemlist'),
    name: 'Collection products',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        url: `${getOrigin(pageUrl) || 'https://example.com'}/products/product-handle`
      }
    ]
  });
}

function buildProductSample(pageUrl) {
  const origin = getOrigin(pageUrl);

  return stringifySample({
    '@context': 'https://schema.org',
    '@type': 'Product',
    '@id': getPageEntityId(pageUrl, 'product'),
    name: 'Product name',
    url: pageUrl,
    brand: origin ? { '@id': `${origin}/#organization` } : undefined,
    offers: {
      '@type': 'Offer',
      url: pageUrl,
      priceCurrency: 'INR',
      price: '0.00',
      availability: 'https://schema.org/InStock'
    }
  });
}

function buildGeneratedSchemaSamples({
  pageType,
  pageUrl,
  breadcrumbLinks,
  missingRequired,
  missingRecommended
}) {
  const samples = {};
  const missing = new Set([...missingRequired, ...missingRecommended]);

  if (pageType === 'homepage') {
    if (missing.has('Organization')) samples.organization = buildOrganizationSample(pageUrl);
    if (missing.has('WebSite')) samples.webSite = buildWebSiteSample(pageUrl);
  }

  if (['collection', 'product', 'blog'].includes(pageType)) {
    const breadcrumbSample = buildBreadcrumbSampleFromLinks(pageUrl, breadcrumbLinks);
    if (breadcrumbSample) {
      samples.breadcrumbList = breadcrumbSample;
    }
  }

  if (pageType === 'collection') {
    samples.collectionPage = buildCollectionPageSample(pageUrl);
    samples.itemList = buildItemListSample(pageUrl);
  }

  if (pageType === 'product' && missing.has('Product or ProductGroup')) {
    samples.product = buildProductSample(pageUrl);
  }

  return samples;
}

function createSchemaRecommendation({
  priority,
  issue,
  whyItMatters,
  howToFix,
  sampleJsonLd = ''
}) {
  return {
    priority,
    issue,
    whyItMatters,
    howToFix,
    sampleJsonLd
  };
}

function buildRichResultSummary({
  pageType,
  productCandidates,
  detectedTypes,
  missingRequired,
  missingRecommended
}) {
  const typeSet = new Set(detectedTypes || []);

  if (pageType === 'product') {
    if (productCandidates.length === 0) {
      return {
        status: 'Not eligible',
        notes:
          'Product rich results require Product/ProductGroup markup with Offer pricing and availability.'
      };
    }

    const eligibility = productCandidates
      .map(hasProductEligibilityFields)
      .find(check => ['name', 'image', 'price', 'availability'].every(field => check[field]));

    return {
      status: eligibility ? 'Eligible' : 'Needs improvement',
      notes: eligibility
        ? 'Product markup has the core fields needed for rich result eligibility.'
        : 'Product markup exists but is missing one or more core rich result fields.'
    };
  }

  if (pageType === 'collection') {
    return {
      status: typeSet.has('BreadcrumbList') ? 'Breadcrumb eligible' : 'Needs BreadcrumbList',
      notes: typeSet.has('ItemList')
        ? 'Collection has breadcrumb markup and an ItemList enhancement.'
        : 'Collection rich result opportunities are mostly breadcrumb snippets; ItemList is optional context.'
    };
  }

  if (pageType === 'blog') {
    return {
      status:
        typeSet.has('Article') || typeSet.has('BlogPosting')
          ? 'Article markup present'
          : 'Needs Article markup',
      notes: missingRecommended.includes('BreadcrumbList')
        ? 'Add BreadcrumbList to improve breadcrumb snippet eligibility.'
        : 'Article schema is the primary rich result signal for blog pages.'
    };
  }

  if (pageType === 'homepage') {
    return {
      status: missingRequired.length === 0 ? 'Site entity complete' : 'Needs site entity schema',
      notes: 'Organization and WebSite schema help search engines understand the store entity.'
    };
  }

  return {
    status: 'Informational',
    notes: 'No specialized rich result eligibility checks are required for this page type.'
  };
}

function getMatchStatus({ primaryValue, allValues, visibleValue }) {
  if (!primaryValue && allValues.length === 0) {
    return 'schema_missing';
  }

  if (!visibleValue) {
    return 'ui_missing';
  }

  if (primaryValue === visibleValue) {
    return 'match';
  }

  if (allValues.length > 1 && allValues.includes(visibleValue)) {
    return 'variant_match';
  }

  return 'mismatch';
}

function buildSchemaUiConsistency({
  pageType,
  productCandidates,
  visiblePrice,
  visibleAvailability
}) {
  if (pageType !== 'product') {
    return {
      schemaPrice: '',
      visiblePrice: normalizePrice(visiblePrice) || '',
      priceMatchStatus: 'not_applicable',
      schemaAvailability: '',
      visibleAvailability: normalizeAvailability(visibleAvailability) || '',
      availabilityMatchStatus: 'not_applicable',
      consistencyWarnings: []
    };
  }

  const primaryCandidate = getPrimaryProductCandidate(productCandidates);
  const schemaPrice = getSchemaPrice(primaryCandidate) || '';
  const allSchemaPrices = getAllSchemaPrices(productCandidates);
  const normalizedVisiblePrice = normalizePrice(visiblePrice) || '';
  const schemaAvailability = getSchemaAvailability(primaryCandidate) || '';
  const allSchemaAvailabilities = getAllSchemaAvailabilities(productCandidates);
  const normalizedVisibleAvailability =
    normalizeAvailability(visibleAvailability) || '';
  const priceMatchStatus = getMatchStatus({
    primaryValue: schemaPrice,
    allValues: allSchemaPrices,
    visibleValue: normalizedVisiblePrice
  });
  const availabilityMatchStatus = getMatchStatus({
    primaryValue: schemaAvailability,
    allValues: allSchemaAvailabilities,
    visibleValue: normalizedVisibleAvailability
  });
  const consistencyWarnings = [];

  if (priceMatchStatus === 'mismatch') {
    const variantSensitive = allSchemaPrices.length > 1;
    consistencyWarnings.push({
      priority: variantSensitive ? 'medium' : 'high',
      type: 'price_mismatch',
      issue: variantSensitive
        ? 'Visible price does not match any detected schema variant price'
        : 'Schema price does not match visible product price',
      whyItMatters:
        'Google Merchant Center and product rich results rely on price parity between structured data and the visible product UI.',
      howToFix:
        'Sync the primary Product/Offer price with the selected visible variant price, or expose all variant offers accurately in ProductGroup/Offer markup.'
    });
  }

  if (priceMatchStatus === 'schema_missing') {
    consistencyWarnings.push({
      priority: 'high',
      type: 'price_schema_missing',
      issue: 'Schema price is missing',
      whyItMatters:
        'Product rich result eligibility requires a valid Offer price.',
      howToFix: 'Add offers.price to the primary Product JSON-LD.'
    });
  }

  if (priceMatchStatus === 'ui_missing') {
    consistencyWarnings.push({
      priority: 'medium',
      type: 'price_ui_missing',
      issue: 'Visible product price could not be confidently detected',
      whyItMatters:
        'Automated price parity checks need a clear primary price in the UI.',
      howToFix:
        'Expose the selected variant price in a stable price element or data attribute.'
    });
  }

  if (availabilityMatchStatus === 'mismatch') {
    const variantSensitive = allSchemaAvailabilities.length > 1;
    consistencyWarnings.push({
      priority: variantSensitive ? 'medium' : 'high',
      type: 'availability_mismatch',
      issue: variantSensitive
        ? 'Visible stock state does not match any detected schema variant availability'
        : 'Schema availability does not match visible stock state',
      whyItMatters:
        'Availability mismatches can create misleading rich results and Merchant Center disapproval risk.',
      howToFix:
        'Sync offers.availability with the selected visible variant state, or model variant availability consistently.'
    });
  }

  if (availabilityMatchStatus === 'schema_missing') {
    consistencyWarnings.push({
      priority: 'high',
      type: 'availability_schema_missing',
      issue: 'Schema availability is missing',
      whyItMatters:
        'Product rich result eligibility expects Offer availability.',
      howToFix:
        'Add offers.availability with a schema.org URL such as https://schema.org/InStock.'
    });
  }

  if (availabilityMatchStatus === 'ui_missing') {
    consistencyWarnings.push({
      priority: 'medium',
      type: 'availability_ui_missing',
      issue: 'Visible stock state could not be confidently detected',
      whyItMatters:
        'Availability parity checks need a visible in-stock, out-of-stock, preorder, or backorder state.',
      howToFix:
        'Expose stock state in visible product text, inventory messaging, or add-to-cart button state.'
    });
  }

  return {
    schemaPrice,
    visiblePrice: normalizedVisiblePrice,
    priceMatchStatus,
    schemaAvailability,
    visibleAvailability: normalizedVisibleAvailability,
    availabilityMatchStatus,
    consistencyWarnings
  };
}

function buildSchemaScoreBreakdown({
  missingRequired,
  missingRecommended,
  unexpectedSchemaTypes,
  schemaConflicts,
  consistencyWarnings,
  jsonLdErrorCount,
  implementationType
}) {
  const deductions = [];

  if (jsonLdErrorCount > 0) {
    deductions.push({
      category: 'JSON-LD validity',
      points: jsonLdErrorCount * 20,
      reason: `${jsonLdErrorCount} JSON-LD block(s) failed to parse.`
    });
  }

  missingRequired.forEach(schema => {
    deductions.push({
      category: 'Required schema',
      points: 18,
      reason: `${schema} is missing.`
    });
  });

  missingRecommended.forEach(schema => {
    deductions.push({
      category: 'Recommended schema',
      points: schema === 'ItemList' ? 5 : 10,
      reason: `${schema} is recommended for this page type.`
    });
  });

  unexpectedSchemaTypes.forEach(item => {
    deductions.push({
      category: 'Unexpected schema',
      points: item.priority === 'high' ? 12 : item.priority === 'medium' ? 8 : 4,
      reason: `${item.type}: ${item.reason}`
    });
  });

  schemaConflicts.forEach(conflict => {
    deductions.push({
      category: 'Schema conflict',
      points: conflict.priority === 'high' ? 15 : 10,
      reason: conflict.issue
    });
  });

  (consistencyWarnings || []).forEach(warning => {
    deductions.push({
      category: 'Schema/UI consistency',
      points: warning.priority === 'high' ? 15 : 8,
      reason: warning.issue
    });
  });

  if (implementationType === 'App-level') {
    deductions.push({
      category: 'Implementation source',
      points: 5,
      reason: 'Schema appears to be injected after load.'
    });
  }

  const totalDeduction = deductions.reduce(
    (total, item) => total + item.points,
    0
  );

  return {
    score: Math.max(0, 100 - totalDeduction),
    deductions
  };
}

function buildSchemaRecommendations({
  pageType,
  pageUrl,
  missingRequired,
  missingRecommended,
  unexpectedSchemaTypes,
  schemaConflicts,
  consistencyWarnings,
  generatedSchemaSamples,
  implementationType,
  entityStitchingRows
}) {
  const recommendations = [];

  missingRequired.forEach(schema => {
    const isBreadcrumb = schema === 'BreadcrumbList';
    recommendations.push(createSchemaRecommendation({
      priority: isBreadcrumb ? 'high' : 'high',
      issue: `Missing required schema: ${schema}`,
      whyItMatters: isBreadcrumb
        ? 'Search engines cannot generate breadcrumb snippets without BreadcrumbList structured data.'
        : 'Required schema helps search engines classify the primary Shopify page entity.',
      howToFix: `Add ${schema} JSON-LD that matches the visible page content.`,
      sampleJsonLd:
        schema === 'Organization'
          ? generatedSchemaSamples.organization
          : schema === 'WebSite'
            ? generatedSchemaSamples.webSite
            : schema.includes('CollectionPage')
              ? generatedSchemaSamples.collectionPage
              : schema.includes('Product')
                ? generatedSchemaSamples.product
                : isBreadcrumb
                  ? generatedSchemaSamples.breadcrumbList
                  : ''
    }));
  });

  missingRecommended.forEach(schema => {
    recommendations.push(createSchemaRecommendation({
      priority: schema === 'BreadcrumbList' ? 'high' : 'low',
      issue: `Missing recommended schema: ${schema}`,
      whyItMatters:
        schema === 'ItemList'
          ? 'ItemList can clarify that a collection page is a list of products without adding Product schema to the collection.'
          : 'Recommended schema improves context and can support richer search presentation.',
      howToFix:
        schema === 'ItemList'
          ? 'Add an ItemList with product URLs and list positions for visible collection products.'
          : `Add ${schema} JSON-LD that mirrors the visible UI.`,
      sampleJsonLd:
        schema === 'ItemList'
          ? generatedSchemaSamples.itemList
          : schema === 'BreadcrumbList'
            ? generatedSchemaSamples.breadcrumbList
            : ''
    }));
  });

  unexpectedSchemaTypes.forEach(item => {
    recommendations.push(createSchemaRecommendation({
      priority: item.priority,
      issue: `Unexpected schema detected: ${item.type}`,
      whyItMatters: item.reason,
      howToFix:
        pageType === 'collection' && item.type === 'Product/ProductGroup'
          ? 'Remove product-detail schema from the collection template and use CollectionPage plus optional ItemList.'
          : 'Move this schema to the template that matches its entity type.'
    }));
  });

  schemaConflicts.forEach(conflict => {
    recommendations.push(createSchemaRecommendation(conflict));
  });

  (consistencyWarnings || []).forEach(warning => {
    recommendations.push(createSchemaRecommendation({
      priority: warning.priority,
      issue: warning.issue,
      whyItMatters: warning.whyItMatters,
      howToFix: warning.howToFix
    }));
  });

  entityStitchingRows
    .filter(row => row.status === 'Warning' || row.status === 'Error')
    .forEach(row => {
      recommendations.push(createSchemaRecommendation({
        priority: 'medium',
        issue: row.type,
        whyItMatters:
          'Stable @id links help search engines connect Product, WebSite, Breadcrumb, and Organization entities.',
        howToFix: row.recommendation
      }));
    });

  if (implementationType === 'App-level') {
    recommendations.push(createSchemaRecommendation({
      priority: 'low',
      issue: 'Schema appears to be app-injected',
      whyItMatters:
        'Theme-level JSON-LD in the initial HTML is usually more reliable for crawlers.',
      howToFix:
        'Verify app-injected schema renders consistently, or move core schema into the Shopify theme where possible.'
    }));
  }

  if (pageType === 'homepage' && !missingRequired.includes('Organization')) {
    recommendations.push(createSchemaRecommendation({
      priority: 'low',
      issue: 'Use a stable Organization @id',
      whyItMatters:
        'A consistent Organization @id lets product, website, and breadcrumb entities reference the same store entity.',
      howToFix: `Use ${getOrigin(pageUrl)}/#organization as the Organization @id and reference it from related entities.`
    }));
  }

  return recommendations;
}

function buildGoogleEligibilityRow(pageType, productCandidates) {
  if (pageType !== 'product') {
    return {
      type: 'Google Eligibility',
      status: 'Pass',
      recommendation:
        'Product rich-result eligibility is not required on this page type.'
    };
  }

  if (productCandidates.length === 0) {
    return {
      type: 'Google Eligibility',
      status: 'Error',
      recommendation:
        'Add Product or ProductGroup schema with name, image, price, and availability.'
    };
  }

  const fieldChecks = productCandidates.map(hasProductEligibilityFields);
  const passingCandidate = fieldChecks.find(check =>
    ['name', 'image', 'price', 'availability'].every(field => check[field])
  );

  if (passingCandidate) {
    return {
      type: 'Google Eligibility',
      status: 'Pass',
      recommendation:
        'Keep the Product markup complete with name, image, price, and availability.'
    };
  }

  const missingFields = ['name', 'image', 'price', 'availability'].filter(
    field => !fieldChecks.some(check => check[field])
  );

  return {
    type: 'Google Eligibility',
    status: 'Warning',
    recommendation:
      `Add the missing Product fields required for Google eligibility: ${missingFields.join(', ')}.`
  };
}

function buildMerchantCenterSyncRow(pageType, consistencyResult) {
  if (pageType !== 'product') {
    return {
      type: 'Price/Availability Match',
      status: 'Pass',
      recommendation:
        'Merchant Center price matching is only required on product pages.'
    };
  }

  const blockingWarnings = (consistencyResult.consistencyWarnings || []).filter(
    warning => warning.priority === 'high'
  );
  const cautionWarnings = (consistencyResult.consistencyWarnings || []).filter(
    warning => warning.priority !== 'high'
  );

  if (blockingWarnings.length > 0) {
    return {
      type: 'Price/Availability Match',
      status: 'Error',
      warnings: blockingWarnings.map(warning => warning.issue).join(' | '),
      recommendation:
        blockingWarnings.map(warning => warning.howToFix).join(' | ')
    };
  }

  if (cautionWarnings.length > 0) {
    return {
      type: 'Price/Availability Match',
      status: 'Warning',
      warnings: cautionWarnings.map(warning => warning.issue).join(' | '),
      recommendation:
        cautionWarnings.map(warning => warning.howToFix).join(' | ')
    };
  }

  return {
    type: 'Price/Availability Match',
    status: 'Pass',
    recommendation:
      'Visible product price and availability are aligned with Product schema, or match a detected variant offer.'
  };
}

function buildRichResultWarningsRow(pageType, productCandidates) {
  if (pageType !== 'product') {
    return {
      type: 'Rich Result Warnings',
      status: 'Pass',
      warnings: '',
      recommendation:
        'Optional rich-result enhancement fields are not required on this page type.'
    };
  }

  if (productCandidates.length === 0) {
    return {
      type: 'Rich Result Warnings',
      status: 'Warning',
      warnings: 'gtin13, color, material',
      recommendation:
        'Add Product schema first, then include optional fields like gtin13, color, and material to improve filtered search visibility.'
    };
  }

  const primaryCandidate = getPrimaryProductCandidate(productCandidates);
  const primaryFieldMap = getOptionalProductFieldMap(primaryCandidate);
  const missingFields = ['gtin13', 'color', 'material'].filter(
    field => !primaryFieldMap[field]
  );

  if (missingFields.length === 0) {
    return {
      type: 'Rich Result Warnings',
      status: 'Pass',
      warnings: '',
      recommendation:
        'Optional product enhancement fields such as gtin13, color, and material are present.'
    };
  }

  const duplicateFieldMaps = getDuplicateProductCandidates(
    productCandidates,
    primaryCandidate
  ).map(getOptionalProductFieldMap);
  const fieldsFoundInDuplicate = missingFields.filter(field =>
    duplicateFieldMaps.some(map => map[field])
  );
  const fieldsMissingEverywhere = missingFields.filter(
    field => !fieldsFoundInDuplicate.includes(field)
  );

  if (fieldsFoundInDuplicate.length > 0) {
    const missingEverywhereMessage =
      fieldsMissingEverywhere.length > 0
        ? ` Still missing from all Product scripts: ${fieldsMissingEverywhere.join(', ')}.`
        : '';

    return {
      type: 'Rich Result Warnings',
      status: 'Warning',
      warnings: missingFields.join(', '),
      recommendation:
        `Fields found in duplicate script, but missing from primary script: ${fieldsFoundInDuplicate.join(', ')}. Move these fields into the primary Product JSON-LD and remove conflicting duplicate Product markup.${missingEverywhereMessage}`
    };
  }

  return {
    type: 'Rich Result Warnings',
    status: 'Warning',
    warnings: missingFields.join(', '),
    recommendation:
      `Add optional Product fields like ${missingFields.join(', ')} to improve merchandising signals and filtered search visibility in Google.`
  };
}

function buildOrganizationConnectionRow(
  pageType,
  pageUrl,
  jsonLdDocuments,
  productCandidates
) {
  if (pageType !== 'product') {
    return {
      type: 'Organization Connection',
      status: 'Pass',
      recommendation:
        'Entity stitching between Product and Organization is only required on product pages.'
    };
  }

  const expectedOrganizationId = `${getOrigin(pageUrl)}/#organization`;
  const organizationEntities = jsonLdDocuments.flatMap(document =>
    collectEntitiesByTypes(document, new Set(['Organization']))
  );
  const organizationIds = organizationEntities
    .map(candidate => getEntityId(candidate.entity))
    .filter(Boolean);

  const linkedIds = new Set();
  productCandidates
    .filter(candidate => candidate.source === 'json-ld')
    .forEach(candidate => {
      const entity = candidate.entity || {};
      collectLinkedEntityIds(entity.brand, linkedIds);
      collectLinkedEntityIds(entity.manufacturer, linkedIds);
    });

  if (linkedIds.size === 0) {
    return {
      type: 'Organization Connection',
      status: 'Warning',
      recommendation:
        'Link the Product brand or manufacturer to your Organization schema using the same @id to strengthen entity stitching.'
    };
  }

  const matchedId =
    organizationIds.find(id => linkedIds.has(id)) ||
    Array.from(linkedIds).find(id => id === expectedOrganizationId);

  if (!matchedId) {
    return {
      type: 'Organization Connection',
      status: 'Warning',
      recommendation:
        `Product brand or manufacturer should reference the stable Organization @id ${expectedOrganizationId}.`
    };
  }

  return {
    type: 'Organization Connection',
    status: 'Pass',
    recommendation:
      `Product brand or manufacturer is stitched to the Organization schema through @id ${matchedId}.`
  };
}

function buildEntityIdRow(pageType, pageUrl, jsonLdDocuments) {
  const pageEntityTypes = new Set([
    'Product',
    'ProductGroup',
    'CollectionPage',
    'WebPage',
    'Article',
    'BlogPosting',
    'WebSite',
    'Organization'
  ]);
  const entities = jsonLdDocuments.flatMap(document =>
    collectEntitiesByTypes(document, pageEntityTypes)
  );
  const primaryEntities = entities.filter(candidate =>
    (candidate.types || []).some(type => {
      if (pageType === 'product') return type === 'Product' || type === 'ProductGroup';
      if (pageType === 'collection') return type === 'CollectionPage' || type === 'WebPage';
      if (pageType === 'blog') return type === 'Article' || type === 'BlogPosting';
      if (pageType === 'homepage') return type === 'Organization' || type === 'WebSite';
      return type === 'WebPage';
    })
  );
  const missingIds = primaryEntities
    .filter(candidate => !getEntityId(candidate.entity))
    .flatMap(candidate => candidate.types || []);

  if (missingIds.length === 0) {
    return {
      type: 'Entity @id Stitching',
      status: 'Pass',
      recommendation:
        'Primary schema entities use @id values that can be referenced across the site.'
    };
  }

  return {
    type: 'Entity @id Stitching',
    status: 'Warning',
    warnings: Array.from(new Set(missingIds)).join(', '),
    recommendation:
      'Add stable @id values such as #organization, #website, #webpage, #product, and #breadcrumb so entities can connect cleanly.'
  };
}

function getVariantIdentity(entity) {
  if (!entity || typeof entity !== 'object') {
    return '';
  }

  return String(
    entity['@id'] || entity.sku || entity.url || entity.name || ''
  ).trim();
}

function getHasVariantIdentities(productGroupEntity) {
  const hasVariant = productGroupEntity?.hasVariant;
  const values = Array.isArray(hasVariant)
    ? hasVariant
    : hasVariant
      ? [hasVariant]
      : [];

  return values
    .map(value => {
      if (!value) {
        return '';
      }

      if (typeof value === 'string') {
        return String(value).trim();
      }

      if (typeof value === 'object') {
        return getVariantIdentity(value);
      }

      return '';
    })
    .filter(Boolean);
}

function buildPrimaryProductStructureRow(jsonLdDocuments) {
  const productGroups = jsonLdDocuments.flatMap(document =>
    collectEntitiesByTypes(document, new Set(['ProductGroup']))
  );
  const products = jsonLdDocuments.flatMap(document =>
    collectEntitiesByTypes(document, new Set(['Product']))
  );

  if (productGroups.length === 0 || products.length <= 1) {
    return {
      type: 'Primary Product Structure',
      status: 'Pass',
      recommendation:
        'No multi-variant ProductGroup structure needs hasVariant validation on this page.'
    };
  }

  const primaryGroup = productGroups[0].entity || {};
  const primaryIdentifier = getVariantIdentity(primaryGroup) || 'ProductGroup';
  const variantIds = products
    .map(candidate => getVariantIdentity(candidate.entity))
    .filter(Boolean);
  const hasVariantIds = getHasVariantIdentities(primaryGroup);

  if (hasVariantIds.length === 0) {
    return {
      type: 'Primary Product Structure',
      status: 'Warning',
      recommendation:
        'Primary ProductGroup ' + primaryIdentifier + ' does not declare hasVariant entries for the detected Product variants. Add hasVariant references to stitch the primary product to each variant.'
    };
  }

  const missingVariantIds = variantIds.filter(id => !hasVariantIds.includes(id));

  if (missingVariantIds.length > 0) {
    return {
      type: 'Primary Product Structure',
      status: 'Warning',
      warnings: missingVariantIds.join(', '),
      recommendation:
        'Primary ProductGroup ' + primaryIdentifier + ' is missing hasVariant links for: ' + missingVariantIds.join(', ') + '.',
    };
  }

  return {
    type: 'Primary Product Structure',
    status: 'Pass',
    recommendation:
      'Primary ProductGroup ' + primaryIdentifier + ' correctly contains the detected Product variants via hasVariant.'
  };
}

function buildShopifyConflictRow(productCandidates) {
  const uniqueTypes = new Set(
    productCandidates.flatMap(candidate => candidate.types || [])
  );
  const jsonLdProductCount = productCandidates.filter(
    candidate => candidate.source === 'json-ld'
  ).length;

  if (uniqueTypes.size > 1 || jsonLdProductCount > 1) {
    return {
      type: 'Shopify Conflict',
      status: 'Warning',
      recommendation:
        'Consolidate Product/ProductGroup markup so one primary product entity represents the page.'
    };
  }

  return {
    type: 'Shopify Conflict',
    status: 'Pass',
    recommendation:
      'Only one primary Product entity was detected, so no Shopify schema conflict was found.'
  };
}

function buildBreadcrumbFormatRow(
  jsonLdDocuments,
  microdataItems,
  breadcrumbUiPresent
) {
  const hasJsonLdBreadcrumb = hasSchemaTypeInJsonLd(
    jsonLdDocuments,
    'BreadcrumbList'
  );
  const hasMicrodataBreadcrumb = hasSchemaTypeInMicrodata(
    microdataItems,
    'BreadcrumbList'
  );

  if (hasJsonLdBreadcrumb) {
    return {
      type: 'Breadcrumb Format',
      status: 'Pass',
      recommendation:
        'BreadcrumbList is implemented in JSON-LD, which is the preferred schema format.'
    };
  }

  if (hasMicrodataBreadcrumb) {
    return {
      type: 'Breadcrumb Format',
      status: 'Pass',
      recommendation:
        'BreadcrumbList markup is present and valid through Microdata.',
      suggestion:
        'JSON-LD is the preferred BreadcrumbList format for 2026 SEO standards. Consider migrating this breadcrumb markup from Microdata to JSON-LD.'
    };
  }

  if (breadcrumbUiPresent) {
    return {
      type: 'Breadcrumb Format',
      status: 'Warning',
      recommendation:
        'Add BreadcrumbList schema, ideally in JSON-LD, to clarify page hierarchy for search engines.'
    };
  }

  return {
    type: 'Breadcrumb Format',
    status: 'Pass',
    recommendation:
      'No visual breadcrumb trail was detected, so BreadcrumbList markup is not required for this page.'
  };
}

function buildSchemaScopeRow(pageType, detectedTypes) {
  const typeSet = new Set(detectedTypes || []);
  const warnings = [];

  if (pageType === 'homepage') {
    if (!typeSet.has('Organization')) {
      warnings.push('missing Organization on homepage');
    }

    if (!typeSet.has('WebSite')) {
      warnings.push('missing WebSite on homepage');
    }

    if (typeSet.has('Product')) {
      warnings.push('Product should not be global on homepage');
    }

    if (typeSet.has('Article') || typeSet.has('BlogPosting')) {
      warnings.push('Article should not be global on homepage');
    }
  } else {
    if (typeSet.has('Product') && pageType !== 'product') {
      warnings.push('Product schema is on a non-product page');
    }

    if ((typeSet.has('Article') || typeSet.has('BlogPosting')) && pageType !== 'blog') {
      warnings.push('Article schema is on a non-blog page');
    }
  }

  if (warnings.length === 0) {
    return {
      type: 'Schema Scope',
      status: 'Pass',
      warnings: '',
      recommendation:
        'Global schemas are limited to the homepage and local schemas appear on the correct page types.'
    };
  }

  return {
    type: 'Schema Scope',
    status: 'Warning',
    warnings: warnings.join(', '),
    recommendation:
      'Keep primary Product, Collection, and Article schemas aligned to their matching Shopify templates.',
  };
}

function buildImplementationRow({ implementationType, pageType, hasSchema }) {
  if (implementationType === 'Theme-level') {
    return {
      type: 'Implementation Type',
      status: 'Pass',
      value: implementationType,
      recommendation:
        'Schema is present in the raw HTML, which is typically the most stable Shopify implementation.'
    };
  }

  if (implementationType === 'App-level') {
    return {
      type: 'Implementation Type',
      status: 'Warning',
      value: implementationType,
      recommendation:
        'Schema appears to be injected after load. Verify that apps render consistently for crawlers and search engines.'
    };
  }

  return {
    type: 'Implementation Type',
    status: pageType === 'product' || hasSchema ? 'Warning' : 'Pass',
    value: implementationType,
    recommendation:
      pageType === 'product'
        ? 'No schema implementation was detected. Add theme-level Product markup or validate the app injection path.'
        : 'No schema implementation was detected on this page.'
  };
}

function buildSchemaAudit({
  pageType,
  source,
  pageUrl = '',
  jsonLdDocuments = [],
  microdataItems = [],
  breadcrumbUiPresent = false,
  breadcrumbLinks = [],
  jsonLdErrorCount = 0,
  visiblePrice = '',
  visibleAvailability = ''
}) {
  const targetTypes = new Set(['Product', 'ProductGroup']);
  const jsonLdProductCandidates = jsonLdDocuments.flatMap(document =>
    collectEntitiesByTypes(document, targetTypes)
  );
  const microdataProductCandidates = microdataItems.filter(item =>
    (item.types || []).some(type => targetTypes.has(type))
  );
  const productCandidates = [
    ...jsonLdProductCandidates,
    ...microdataProductCandidates
  ];
  const allDetectedTypes = Array.from(new Set([
    ...jsonLdDocuments.flatMap(document => Array.from(collectAllSchemaTypes(document))),
    ...microdataItems.flatMap(item => item.types || [])
  ])).sort();
  const hasSchema =
    jsonLdDocuments.length > 0 ||
    (Array.isArray(microdataItems) && microdataItems.length > 0);
  const implementationType = hasSchema
    ? source === 'puppeteer'
      ? 'App-level'
      : 'Theme-level'
    : 'Not detected';
  const { missingRequired, missingRecommended } = getMissingSchemaGroups(
    pageType,
    allDetectedTypes,
    breadcrumbUiPresent
  );
  const unexpectedSchemaTypes = getUnexpectedSchemaTypes(
    pageType,
    allDetectedTypes
  );
  const schemaConflicts = getSchemaConflicts(
    pageType,
    allDetectedTypes,
    productCandidates
  );
  const consistencyResult = buildSchemaUiConsistency({
    pageType,
    productCandidates,
    visiblePrice,
    visibleAvailability
  });
  const generatedSchemaSamples = buildGeneratedSchemaSamples({
    pageType,
    pageUrl,
    breadcrumbLinks,
    missingRequired,
    missingRecommended
  });
  const entityRows = [
    buildOrganizationConnectionRow(
      pageType,
      pageUrl,
      jsonLdDocuments,
      productCandidates
    ),
    buildEntityIdRow(pageType, pageUrl, jsonLdDocuments)
  ];
  const richResultSummary = buildRichResultSummary({
    pageType,
    productCandidates,
    detectedTypes: allDetectedTypes,
    missingRequired,
    missingRecommended
  });
  const schemaScoreBreakdown = buildSchemaScoreBreakdown({
    missingRequired,
    missingRecommended,
    unexpectedSchemaTypes,
    schemaConflicts,
    consistencyWarnings: consistencyResult.consistencyWarnings,
    jsonLdErrorCount,
    implementationType
  });
  const rows = [
    buildGoogleEligibilityRow(pageType, productCandidates),
    buildRichResultWarningsRow(pageType, productCandidates),
    buildMerchantCenterSyncRow(pageType, consistencyResult),
    ...entityRows,
    buildBreadcrumbFormatRow(
      jsonLdDocuments,
      microdataItems,
      breadcrumbUiPresent
    ),
    buildSchemaScopeRow(pageType, allDetectedTypes),
    buildPrimaryProductStructureRow(jsonLdDocuments),
    buildShopifyConflictRow(productCandidates),
    buildImplementationRow({ implementationType, pageType, hasSchema })
  ];
  const schemaRecommendations = buildSchemaRecommendations({
    pageType,
    pageUrl,
    missingRequired,
    missingRecommended,
    unexpectedSchemaTypes,
    schemaConflicts,
    consistencyWarnings: consistencyResult.consistencyWarnings,
    generatedSchemaSamples,
    implementationType,
    entityStitchingRows: entityRows
  });

  return {
    implementationType,
    visiblePrice: normalizePrice(visiblePrice),
    detectedSchemaTypes: allDetectedTypes,
    expectedSchemaTypes: listExpectedSchemaTypes(pageType),
    missingRequiredSchema: missingRequired,
    missingRecommendedSchema: missingRecommended,
    unexpectedSchemaTypes,
    schemaConflicts,
    richResultSummary,
    schemaRecommendations,
    generatedSchemaSamples,
    schemaScoreBreakdown,
    ...consistencyResult,
    rows
  };
}

module.exports = {
  extractMicrodataItems,
  buildSchemaAudit,
  normalizePrice,
  normalizeAvailability
};

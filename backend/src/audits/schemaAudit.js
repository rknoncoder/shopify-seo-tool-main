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

function buildMerchantCenterSyncRow(pageType, productCandidates, visiblePrice) {
  if (pageType !== 'product') {
    return {
      type: 'Price/Availability Match',
      status: 'Pass',
      recommendation:
        'Merchant Center price matching is only required on product pages.'
    };
  }

  const schemaPrice = productCandidates.map(getSchemaPrice).find(Boolean);
  const normalizedVisiblePrice = normalizePrice(visiblePrice);

  if (!schemaPrice) {
    return {
      type: 'Price/Availability Match',
      status: 'Error',
      recommendation:
        'Add a valid Product price in schema markup so Merchant Center can verify the offer.'
    };
  }

  if (!normalizedVisiblePrice) {
    return {
      type: 'Price/Availability Match',
      status: 'Warning',
      recommendation:
        'Expose a clear visible product price in the page content so Merchant Center can verify it against schema.'
    };
  }

  if (schemaPrice !== normalizedVisiblePrice) {
    return {
      type: 'Price/Availability Match',
      status: 'Error',
      recommendation:
        `Schema price (${schemaPrice}) does not match the visible page price (${normalizedVisiblePrice}). Sync them to avoid Google Merchant Center disapproval or suspension risk.`
    };
  }

  return {
    type: 'Price/Availability Match',
    status: 'Pass',
    recommendation:
      'Visible price matches the Product schema price, which is aligned for Merchant Center checks.'
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

  const fieldMaps = productCandidates.map(getOptionalProductFieldMap);
  const missingFields = ['gtin13', 'color', 'material'].filter(
    field => !fieldMaps.some(map => map[field])
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

  const organizationEntities = jsonLdDocuments.flatMap(document =>
    collectEntitiesByTypes(document, new Set(['Organization']))
  );
  const organizationIds = organizationEntities
    .map(candidate => getEntityId(candidate.entity))
    .filter(Boolean);

  if (organizationIds.length === 0) {
    return {
      type: 'Organization Connection',
      status: 'Warning',
      recommendation:
        'Add an Organization schema with a stable @id so product entities can stitch back to the site entity.'
    };
  }

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

  const matchedId = organizationIds.find(id => linkedIds.has(id));
  if (!matchedId) {
    return {
      type: 'Organization Connection',
      status: 'Warning',
      recommendation:
        'Product brand or manufacturer uses a different @id than the Organization schema. Reuse the Organization @id inside brand or manufacturer to stitch the entities together.'
    };
  }

  return {
    type: 'Organization Connection',
    status: 'Pass',
    recommendation:
      `Product brand or manufacturer is stitched to the Organization schema through @id ${matchedId}.`
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
    if (typeSet.has('Organization')) {
      warnings.push('Organization should be homepage-only');
    }

    if (typeSet.has('WebSite')) {
      warnings.push('WebSite should be homepage-only');
    }

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
      'Keep Organization and WebSite on the homepage only, and limit Product or Article schemas to their matching product and blog pages.',
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
  jsonLdDocuments = [],
  microdataItems = [],
  visiblePrice = ''
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

  return {
    implementationType,
    visiblePrice: normalizePrice(visiblePrice),
    rows: [
      buildGoogleEligibilityRow(pageType, productCandidates),
      buildRichResultWarningsRow(pageType, productCandidates),
      buildMerchantCenterSyncRow(pageType, productCandidates, visiblePrice),
      buildOrganizationConnectionRow(
        pageType,
        jsonLdDocuments,
        productCandidates
      ),
      buildSchemaScopeRow(pageType, allDetectedTypes),
      buildPrimaryProductStructureRow(jsonLdDocuments),
      buildShopifyConflictRow(productCandidates),
      buildImplementationRow({ implementationType, pageType, hasSchema })
    ]
  };
}

module.exports = {
  extractMicrodataItems,
  buildSchemaAudit,
  normalizePrice
};

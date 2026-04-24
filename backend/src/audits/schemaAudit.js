const {
  getMissingSchemaGroups,
  listExpectedSchemaTypes
} = require('../utils/schemaRules');

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

function collectJsonLdEntities(value, entities = [], seen = new WeakSet()) {
  if (!value) {
    return entities;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectJsonLdEntities(item, entities, seen));
    return entities;
  }

  if (typeof value !== 'object') {
    return entities;
  }

  if (seen.has(value)) {
    return entities;
  }

  seen.add(value);

  if (value['@id']) {
    entities.push(value);
  }

  if (Array.isArray(value['@graph'])) {
    value['@graph'].forEach(item => collectJsonLdEntities(item, entities, seen));
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === '@context' || key === '@graph') {
      return;
    }

    collectJsonLdEntities(child, entities, seen);
  });

  return entities;
}

function createJsonLdEntityIndex(jsonLdDocuments = []) {
  const index = new Map();

  jsonLdDocuments
    .flatMap(document => collectJsonLdEntities(document))
    .forEach(entity => {
      const id = normalizeEntityId(entity['@id']);
      const existing = index.get(id);
      if (
        id &&
        (!existing ||
          (isReferenceOnlyObject(existing) && !isReferenceOnlyObject(entity)))
      ) {
        index.set(id, entity);
      }
    });

  return index;
}

function isReferenceOnlyObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === '@id';
}

function resolveJsonLdReference(value, graphIndex, seen = new Set()) {
  if (!graphIndex || graphIndex.size === 0 || !value) {
    return value;
  }

  const id =
    typeof value === 'string'
      ? normalizeEntityId(value)
      : typeof value === 'object'
        ? normalizeEntityId(value['@id'])
        : '';

  if (!id || seen.has(id) || !graphIndex.has(id)) {
    return value;
  }

  seen.add(id);
  const referenced = graphIndex.get(id);

  if (isReferenceOnlyObject(value) || typeof value === 'string') {
    return referenced;
  }

  return {
    ...referenced,
    ...value
  };
}

function resolveJsonLdValue(value, graphIndex, seen = new Set()) {
  if (Array.isArray(value)) {
    return value.map(item => resolveJsonLdValue(item, graphIndex, seen));
  }

  if (!value || typeof value !== 'object') {
    return resolveJsonLdReference(value, graphIndex, seen);
  }

  const resolved = resolveJsonLdReference(value, graphIndex, seen);
  return resolved;
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

function normalizePropertyValues(value) {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value.filter(Boolean) : [value].filter(Boolean);
}

function readCandidateField(candidate, key) {
  if (!candidate) {
    return '';
  }

  if (candidate.source === 'microdata') {
    return normalizePropertyValues(candidate.properties?.[key])[0] || '';
  }

  return readJsonLdField(candidate.entity || {}, key, candidate.graphIndex || null) || '';
}

function readCandidateFields(candidate, keys = []) {
  return keys.flatMap(key => normalizePropertyValues(readCandidateField(candidate, key)));
}

function collectMicrodataPropertyValues(item, keys = [], found = []) {
  if (!item || typeof item !== 'object') {
    return found;
  }

  const properties = item.properties || {};
  keys.forEach(key => {
    normalizePropertyValues(properties[key]).forEach(value => {
      if (value && typeof value === 'object' && value.properties) {
        collectMicrodataPropertyValues(value, keys, found);
      } else if (value !== undefined && value !== null) {
        found.push(value);
      }
    });
  });

  Object.values(properties).flat().forEach(value => {
    if (value && typeof value === 'object' && value.properties) {
      collectMicrodataPropertyValues(value, keys, found);
    }
  });

  return found;
}

function extractMicrodataProperties($, root) {
  const properties = {};

  $(root).children().find('[itemprop]').add($(root).children('[itemprop]')).each((_, element) => {
    const ownerScope = $(element).closest('[itemscope]').get(0);
    const isNestedScope = element !== root && $(element).is('[itemscope]');

    if (ownerScope && ownerScope !== root && !isNestedScope) {
      return;
    }

    const key = String($(element).attr('itemprop') || '').trim();
    if (!key) {
      return;
    }

    const value = isNestedScope
      ? extractMicrodataItem($, element)
      : readMicrodataValue($, element);
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

function extractMicrodataItem($, element) {
  const itemType = normalizeMicrodataType($(element).attr('itemtype'));
  if (!itemType) {
    return null;
  }

  const properties = extractMicrodataProperties($, element);
  const nestedTypes = Object.values(properties)
    .flat()
    .filter(value => value && typeof value === 'object' && value.types)
    .flatMap(value => value.types || []);

  return {
    source: 'microdata',
    types: Array.from(new Set([itemType, ...nestedTypes])),
    primaryType: itemType,
    properties
  };
}

function extractMicrodataItems($) {
  const items = [];

  $('[itemscope][itemtype]').each((_, element) => {
    if ($(element).parents('[itemscope]').length > 0) {
      return;
    }

    const item = extractMicrodataItem($, element);
    if (item) {
      items.push(item);
    }
  });

  return items;
}

function readJsonLdField(entity, key, graphIndex = null) {
  const value = resolveJsonLdValue(entity?.[key], graphIndex);

  if (Array.isArray(value)) {
    return value.find(Boolean);
  }

  return value;
}

function getResolvedOfferEntities(entity, graphIndex = null) {
  const offers = readJsonLdField(entity, 'offers', graphIndex);

  if (Array.isArray(offers)) {
    return offers
      .map(offer => resolveJsonLdValue(offer, graphIndex))
      .filter(Boolean);
  }

  return offers ? [resolveJsonLdValue(offers, graphIndex)] : [];
}

function readOfferField(entity, key, graphIndex = null) {
  return getResolvedOfferEntities(entity, graphIndex)
    .map(offer => readJsonLdField(offer, key, graphIndex))
    .find(Boolean);
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
      price: collectMicrodataPropertyValues(candidate, ['price', 'lowPrice']).length > 0,
      availability: collectMicrodataPropertyValues(candidate, ['availability']).length > 0
    };
  }

  const entity = candidate.entity || {};
  const graphIndex = candidate.graphIndex || null;

  return {
    name: Boolean(readJsonLdField(entity, 'name', graphIndex)),
    image: hasImageValue(readJsonLdField(entity, 'image', graphIndex)),
    price: Boolean(
      readJsonLdField(entity, 'price', graphIndex) ||
        readOfferField(entity, 'price', graphIndex) ||
        getVariantCandidates(candidate).some(variant => getSchemaPrice(variant))
    ),
    availability: Boolean(
      readJsonLdField(entity, 'availability', graphIndex) ||
        readOfferField(entity, 'availability', graphIndex) ||
        getVariantCandidates(candidate).some(variant => getSchemaAvailability(variant))
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
  const graphIndex = candidate.graphIndex || null;

  return {
    gtin13: Boolean(readJsonLdField(entity, 'gtin13', graphIndex)),
    color: Boolean(readJsonLdField(entity, 'color', graphIndex)),
    material: Boolean(readJsonLdField(entity, 'material', graphIndex))
  };
}

function stringifySchemaValue(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }

  if (Array.isArray(value)) {
    return value.map(stringifySchemaValue).find(Boolean) || '';
  }

  if (typeof value === 'object') {
    return stringifySchemaValue(
      value.name ||
        value.url ||
        value.contentUrl ||
        value['@id'] ||
        value.sku ||
        value.value
    );
  }

  return '';
}

function getCandidateFieldValues(candidate, keys = []) {
  if (!candidate) {
    return [];
  }

  if (candidate.source === 'microdata') {
    return uniqueValues(
      keys
        .flatMap(key => collectMicrodataPropertyValues(candidate, [key]))
        .map(stringifySchemaValue)
    );
  }

  const entity = candidate.entity || {};
  const graphIndex = candidate.graphIndex || null;
  return uniqueValues(
    keys
      .flatMap(key => normalizePropertyValues(readJsonLdField(entity, key, graphIndex)))
      .map(value => stringifySchemaValue(resolveJsonLdValue(value, graphIndex)))
  );
}

function getProductImageValues(candidate) {
  if (candidate?.source === 'microdata') {
    return getCandidateFieldValues(candidate, ['image']);
  }

  const value = readJsonLdField(
    candidate?.entity || {},
    'image',
    candidate?.graphIndex || null
  );
  return uniqueValues(normalizePropertyValues(value).map(stringifySchemaValue));
}

function isValidAbsoluteUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function validateImageUrl(value) {
  const text = String(value || '').trim();
  if (!text) {
    return { valid: false, reason: 'missing' };
  }

  if (!isValidAbsoluteUrl(text)) {
    return { valid: false, reason: 'not_absolute_url' };
  }

  if (!/\.(avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(text)) {
    return { valid: true, reason: 'url_without_image_extension' };
  }

  return { valid: true, reason: '' };
}

function buildProductFieldValidation(pageType, productCandidates = []) {
  if (pageType !== 'product') {
    return {
      status: 'not_applicable',
      required: [],
      recommended: [],
      optional: [],
      warnings: []
    };
  }

  const primaryCandidate =
    productCandidates.find(candidate => {
      const fields = hasProductEligibilityFields(candidate);
      return fields.name && fields.image;
    }) ||
    getPrimaryProductCandidate(productCandidates);
  if (!primaryCandidate) {
    return {
      status: 'error',
      required: [
        { field: 'Product/ProductGroup', status: 'missing', level: 'required' }
      ],
      recommended: [],
      optional: [],
      warnings: ['Product/ProductGroup schema is missing']
    };
  }

  const requiredChecks = [
    {
      field: 'name',
      status: getCandidateFieldValues(primaryCandidate, ['name']).length > 0 ? 'pass' : 'missing',
      level: 'required'
    },
    {
      field: 'image',
      status: getProductImageValues(primaryCandidate).length > 0 ? 'pass' : 'missing',
      level: 'required'
    },
    {
      field: 'offers.price',
      status: getAllSchemaPrices(productCandidates).length > 0 ? 'pass' : 'missing',
      level: 'required'
    },
    {
      field: 'offers.availability',
      status: getAllSchemaAvailabilities(productCandidates).length > 0 ? 'pass' : 'missing',
      level: 'required'
    }
  ];

  const imageValues = getProductImageValues(primaryCandidate);
  const imageIssues = imageValues
    .map(value => ({ value, ...validateImageUrl(value) }))
    .filter(item => !item.valid);

  const recommendedChecks = [
    {
      field: 'sku',
      status: getCandidateFieldValues(primaryCandidate, ['sku']).length > 0 ? 'pass' : 'recommended',
      level: 'recommended'
    },
    {
      field: 'brand',
      status: getCandidateFieldValues(primaryCandidate, ['brand', 'manufacturer']).length > 0 ? 'pass' : 'recommended',
      level: 'recommended'
    },
    {
      field: 'offers.priceCurrency',
      status: productCandidates.some(candidate =>
        getOfferValues(candidate.entity || {}, 'priceCurrency', candidate.graphIndex || null).length > 0 ||
          collectMicrodataPropertyValues(candidate, ['priceCurrency']).length > 0
      )
        ? 'pass'
        : 'recommended',
      level: 'recommended'
    },
    {
      field: 'url',
      status: getCandidateFieldValues(primaryCandidate, ['url']).some(isValidAbsoluteUrl)
        ? 'pass'
        : 'recommended',
      level: 'recommended'
    },
    {
      field: 'image.url',
      status: imageIssues.length === 0 ? 'pass' : 'warning',
      level: 'recommended',
      warnings: imageIssues.map(item => `${item.value}: ${item.reason}`)
    }
  ];

  const identifierFields = ['gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'mpn'];
  const optionalChecks = identifierFields.map(field => {
    const values = getCandidateFieldValues(primaryCandidate, [field]);
    const invalidValues = values.filter(value => {
      if (field.startsWith('gtin')) {
        return !/^\d{8,14}$/.test(String(value).replace(/\D/g, ''));
      }
      return field === 'mpn' && String(value).trim().length < 2;
    });

    return {
      field,
      status:
        values.length === 0
          ? 'not_present'
          : invalidValues.length > 0
            ? 'warning'
            : 'pass',
      level: 'optional',
      warnings: invalidValues
    };
  });

  const warnings = [
    ...requiredChecks
      .filter(item => item.status === 'missing')
      .map(item => `${item.field} is missing`),
    ...recommendedChecks
      .filter(item => item.status === 'recommended')
      .map(item => `${item.field} is recommended`),
    ...recommendedChecks
      .filter(item => item.status === 'warning')
      .map(item => `${item.field} should be checked`),
    ...optionalChecks
      .filter(item => item.status === 'warning')
      .map(item => `${item.field} has an invalid-looking value`)
  ];

  return {
    status:
      requiredChecks.some(item => item.status === 'missing')
        ? 'error'
        : recommendedChecks.some(item => item.status !== 'pass') ||
            optionalChecks.some(item => item.status === 'warning')
          ? 'warning'
          : 'pass',
    required: requiredChecks,
    recommended: recommendedChecks,
    optional: optionalChecks,
    warnings
  };
}

function getPrimaryProductCandidate(productCandidates = []) {
  const jsonLdCandidates = productCandidates.filter(
    candidate => candidate.source === 'json-ld'
  );
  const pricedJsonLdCandidate = jsonLdCandidates.find(candidate =>
    Boolean(getSchemaPrice(candidate))
  );

  if (pricedJsonLdCandidate) {
    return pricedJsonLdCandidate;
  }

  return (
    jsonLdCandidates[0] ||
    productCandidates.find(candidate => Boolean(getSchemaPrice(candidate))) ||
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

function parsePriceNumber(value) {
  const normalized = normalizePrice(value);
  return normalized ? Number(normalized) : null;
}

function parseRawShopifyPriceNumber(value) {
  const match = String(value || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  if (!match) {
    return null;
  }

  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function pricesAreEqual(left, right) {
  if (left === null || right === null) {
    return false;
  }

  return Math.abs(left - right) < 0.01;
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

function getOfferValues(entity, key, graphIndex = null) {
  return getResolvedOfferEntities(entity, graphIndex)
    .flatMap(offer => {
      const value = readJsonLdField(offer, key, graphIndex);
      return Array.isArray(value) ? value : [value];
    })
    .filter(Boolean);
}

function getVariantCandidates(candidate) {
  if (!candidate || candidate.source === 'microdata') {
    return [];
  }

  const entity = candidate.entity || {};
  const graphIndex = candidate.graphIndex || null;
  const variants = readJsonLdField(entity, 'hasVariant', graphIndex);
  const values = Array.isArray(variants) ? variants : variants ? [variants] : [];

  return values
    .map(variant => resolveJsonLdValue(variant, graphIndex))
    .filter(variant => variant && typeof variant === 'object')
    .map(variant => ({
      source: 'json-ld',
      types: getNormalizedTypeList(variant),
      entity: variant,
      graphIndex,
      parentTypes: candidate.types || []
    }));
}

function getProductAndVariantCandidates(productCandidates = []) {
  return [
    ...productCandidates,
    ...productCandidates.flatMap(getVariantCandidates)
  ];
}

function normalizeVariantId(value) {
  const match = String(value || '').match(/\d{5,}/);
  return match ? match[0] : String(value || '').trim();
}

function getCandidateIdentityValues(candidate) {
  if (!candidate || candidate.source === 'microdata') {
    const props = candidate?.properties || {};
    return uniqueValues([
      props.sku?.[0],
      props.productID?.[0],
      props.url?.[0],
      props.name?.[0]
    ]);
  }

  const entity = candidate.entity || {};
  const graphIndex = candidate.graphIndex || null;
  return uniqueValues([
    entity['@id'],
    readJsonLdField(entity, 'sku', graphIndex),
    readJsonLdField(entity, 'productID', graphIndex),
    readJsonLdField(entity, 'variantId', graphIndex),
    readJsonLdField(entity, 'url', graphIndex),
    readJsonLdField(entity, 'name', graphIndex)
  ]);
}

function getSelectedVariantCandidate(productCandidates = [], selectedVariantId = '') {
  const normalizedSelected = normalizeVariantId(selectedVariantId);
  if (!normalizedSelected) {
    return null;
  }

  return getProductAndVariantCandidates(productCandidates).find(candidate =>
    getCandidateIdentityValues(candidate).some(value => {
      const normalizedValue = normalizeVariantId(value);
      return (
        normalizedValue === normalizedSelected ||
        String(value || '').includes(normalizedSelected)
      );
    })
  ) || null;
}

function getSchemaPrice(candidate) {
  if (!candidate) {
    return null;
  }

  if (candidate.source === 'microdata') {
    return normalizePrice(
      collectMicrodataPropertyValues(candidate, ['price', 'lowPrice'])[0]
    );
  }

  const entity = candidate.entity || {};
  const graphIndex = candidate.graphIndex || null;
  return normalizePrice(
    readJsonLdField(entity, 'price', graphIndex) ||
      readOfferField(entity, 'price', graphIndex) ||
      readOfferField(entity, 'lowPrice', graphIndex)
  );
}

function getSchemaPrices(candidate) {
  if (!candidate) {
    return [];
  }

  if (candidate.source === 'microdata') {
    return uniqueValues(
      collectMicrodataPropertyValues(candidate, ['price', 'lowPrice', 'highPrice'])
        .map(normalizePrice)
    );
  }

  const entity = candidate.entity || {};
  const graphIndex = candidate.graphIndex || null;
  return uniqueValues([
    normalizePrice(readJsonLdField(entity, 'price', graphIndex)),
    ...getOfferValues(entity, 'price', graphIndex).map(normalizePrice),
    ...getOfferValues(entity, 'lowPrice', graphIndex).map(normalizePrice),
    ...getOfferValues(entity, 'highPrice', graphIndex).map(normalizePrice),
    ...getVariantCandidates(candidate).flatMap(getSchemaPrices)
  ]);
}

function getSchemaAvailability(candidate) {
  if (!candidate) {
    return '';
  }

  if (candidate.source === 'microdata') {
    return normalizeAvailability(
      collectMicrodataPropertyValues(candidate, ['availability'])[0]
    );
  }

  const entity = candidate.entity || {};
  const graphIndex = candidate.graphIndex || null;
  return normalizeAvailability(
    readJsonLdField(entity, 'availability', graphIndex) ||
      readOfferField(entity, 'availability', graphIndex)
  );
}

function getSchemaAvailabilities(candidate) {
  if (!candidate) {
    return [];
  }

  if (candidate.source === 'microdata') {
    return uniqueValues(
      collectMicrodataPropertyValues(candidate, ['availability'])
        .map(normalizeAvailability)
    );
  }

  const entity = candidate.entity || {};
  const graphIndex = candidate.graphIndex || null;
  return uniqueValues([
    normalizeAvailability(readJsonLdField(entity, 'availability', graphIndex)),
    ...getOfferValues(entity, 'availability', graphIndex).map(normalizeAvailability),
    ...getVariantCandidates(candidate).flatMap(getSchemaAvailabilities)
  ]);
}

function getAllSchemaPrices(productCandidates = []) {
  return uniqueValues(getProductAndVariantCandidates(productCandidates).flatMap(getSchemaPrices));
}

function getAllSchemaAvailabilities(productCandidates = []) {
  return uniqueValues(getProductAndVariantCandidates(productCandidates).flatMap(getSchemaAvailabilities));
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

function normalizeComparableText(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeComparableUrl(value, pageUrl = '') {
  const raw = String(value || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const parsed = new URL(raw, pageUrl || undefined);
    parsed.hash = '';
    parsed.search = '';
    return parsed.href.replace(/\/+$/, '');
  } catch (error) {
    return raw.replace(/\/+$/, '').toLowerCase();
  }
}

function getBreadcrumbItemUrl(item, pageUrl = '') {
  const value = item?.item || item?.url || item?.href || '';
  if (typeof value === 'string') {
    return normalizeComparableUrl(value, pageUrl);
  }

  return normalizeComparableUrl(value?.['@id'] || value?.url || value?.item || '', pageUrl);
}

function collectJsonLdBreadcrumbItems(jsonLdDocuments = [], pageUrl = '') {
  const graphIndex = createJsonLdEntityIndex(jsonLdDocuments);
  return jsonLdDocuments
    .flatMap(document => collectEntitiesByTypes(document, new Set(['BreadcrumbList'])))
    .flatMap(candidate => {
      const entity = candidate.entity || {};
      const itemList = resolveJsonLdValue(entity.itemListElement, graphIndex);
      const items = Array.isArray(itemList) ? itemList : itemList ? [itemList] : [];

      return items
        .map((item, index) => resolveJsonLdValue(item, graphIndex))
        .filter(item => item && typeof item === 'object')
        .map((item, index) => ({
          name: stringifySchemaValue(item.name || item.item?.name),
          position: Number(item.position) || index + 1,
          item: getBreadcrumbItemUrl(item, pageUrl)
        }));
    })
    .sort((left, right) => left.position - right.position);
}

function collectMicrodataBreadcrumbItems(microdataItems = [], pageUrl = '') {
  return microdataItems
    .filter(item => (item.types || []).includes('BreadcrumbList'))
    .flatMap(item => normalizePropertyValues(item.properties?.itemListElement))
    .filter(item => item && typeof item === 'object')
    .map((item, index) => ({
      name: stringifySchemaValue(
        collectMicrodataPropertyValues(item, ['name'])[0] ||
          collectMicrodataPropertyValues(item, ['item'])[0]
      ),
      position:
        Number(collectMicrodataPropertyValues(item, ['position'])[0]) ||
        index + 1,
      item: normalizeComparableUrl(
        stringifySchemaValue(collectMicrodataPropertyValues(item, ['item', 'url'])[0]),
        pageUrl
      )
    }))
    .sort((left, right) => left.position - right.position);
}

function buildBreadcrumbConsistency({
  pageType,
  pageUrl,
  pageTitle = '',
  jsonLdDocuments = [],
  microdataItems = [],
  breadcrumbUiPresent = false,
  breadcrumbLinks = []
}) {
  const schemaItems = [
    ...collectJsonLdBreadcrumbItems(jsonLdDocuments, pageUrl),
    ...collectMicrodataBreadcrumbItems(microdataItems, pageUrl)
  ];
  const visibleItems = (breadcrumbLinks || [])
    .filter(link => link?.name)
    .map((link, index) => ({
      name: String(link.name || '').trim(),
      position: index + 1,
      item: normalizeComparableUrl(link.item || link.href || '', pageUrl)
    }));

  if (!breadcrumbUiPresent && schemaItems.length === 0) {
    return {
      status: 'not_applicable',
      warnings: [],
      visibleItems,
      schemaItems
    };
  }

  if (breadcrumbUiPresent && schemaItems.length === 0) {
    return {
      status: 'missing_schema',
      warnings: ['Visible breadcrumb UI is present but BreadcrumbList schema is missing.'],
      visibleItems,
      schemaItems
    };
  }

  if (!breadcrumbUiPresent || visibleItems.length === 0) {
    return {
      status: 'schema_only',
      warnings: [],
      visibleItems,
      schemaItems
    };
  }

  const warnings = [];
  const comparableLength = Math.min(visibleItems.length, schemaItems.length);

  if (visibleItems.length !== schemaItems.length) {
    warnings.push('Breadcrumb schema item count does not match visible breadcrumb UI.');
  }

  for (let index = 0; index < comparableLength; index += 1) {
    const visible = visibleItems[index];
    const schema = schemaItems[index];

    if (Number(schema.position) !== index + 1) {
      warnings.push(`Breadcrumb schema position ${schema.position || 'missing'} should be ${index + 1}.`);
    }

    if (
      normalizeComparableText(visible.name) &&
      normalizeComparableText(schema.name) &&
      normalizeComparableText(visible.name) !== normalizeComparableText(schema.name)
    ) {
      warnings.push(`Breadcrumb name mismatch at position ${index + 1}: UI "${visible.name}" vs schema "${schema.name}".`);
    }

    if (visible.item && schema.item && visible.item !== schema.item) {
      warnings.push(`Breadcrumb URL mismatch at position ${index + 1}.`);
    }
  }

  const finalVisible = visibleItems[visibleItems.length - 1]?.name || '';
  const finalSchema = schemaItems[schemaItems.length - 1]?.name || '';
  const normalizedTitle = normalizeComparableText(pageTitle);
  const normalizedFinal = normalizeComparableText(finalSchema || finalVisible);

  if (
    ['product', 'collection', 'blog'].includes(pageType) &&
    normalizedTitle &&
    normalizedFinal &&
    !normalizedTitle.includes(normalizedFinal) &&
    !normalizedFinal.includes(normalizedTitle)
  ) {
    warnings.push('Final breadcrumb label does not appear to match the page title or primary heading.');
  }

  return {
    status:
      warnings.length === 0
        ? 'match'
        : warnings.length <= 2
          ? 'partial_match'
          : 'mismatch',
    warnings,
    visibleItems,
    schemaItems
  };
}

function buildBreadcrumbConsistencyRow(breadcrumbConsistency) {
  if (breadcrumbConsistency.status === 'match') {
    return {
      type: 'Breadcrumb Consistency',
      status: 'Pass',
      recommendation:
        'BreadcrumbList schema matches the visible breadcrumb trail.'
    };
  }

  if (breadcrumbConsistency.status === 'missing_schema') {
    return {
      type: 'Breadcrumb Consistency',
      status: 'Warning',
      warnings: breadcrumbConsistency.warnings.join(' | '),
      recommendation:
        'Add BreadcrumbList JSON-LD that mirrors the visible breadcrumb labels, order, and URLs.'
    };
  }

  if (breadcrumbConsistency.status === 'partial_match') {
    return {
      type: 'Breadcrumb Consistency',
      status: 'Warning',
      warnings: breadcrumbConsistency.warnings.join(' | '),
      recommendation:
        'Align breadcrumb schema labels, positions, and URLs with the visible breadcrumb UI.'
    };
  }

  if (breadcrumbConsistency.status === 'mismatch') {
    return {
      type: 'Breadcrumb Consistency',
      status: 'Warning',
      warnings: breadcrumbConsistency.warnings.join(' | '),
      recommendation:
        'Rebuild BreadcrumbList schema from the visible breadcrumb trail to avoid conflicting hierarchy signals.'
    };
  }

  return {
    type: 'Breadcrumb Consistency',
    status: 'Pass',
    recommendation:
      'No breadcrumb UI/schema consistency issue was detected.'
  };
}

function buildReviewRatingVisibility({
  jsonLdDocuments = [],
  microdataItems = [],
  visibleReviewData = {}
}) {
  const hasAggregateRating =
    hasSchemaTypeInJsonLd(jsonLdDocuments, 'AggregateRating') ||
    hasSchemaTypeInMicrodata(microdataItems, 'AggregateRating');
  const hasReview =
    hasSchemaTypeInJsonLd(jsonLdDocuments, 'Review') ||
    hasSchemaTypeInMicrodata(microdataItems, 'Review');
  const lazyEvidence = Boolean(visibleReviewData.lazyReviewHint);
  const ratingEvidence = Boolean(visibleReviewData.hasRatingSignal);
  const reviewEvidence = Boolean(visibleReviewData.hasReviewSignal);

  const ratingVisibilityStatus =
    !hasAggregateRating
      ? 'not_claimed'
      : ratingEvidence
        ? 'visible'
        : lazyEvidence
          ? 'unknown_lazy_loaded'
          : 'schema_only';
  const reviewVisibilityStatus =
    !hasReview
      ? 'not_claimed'
      : reviewEvidence
        ? 'visible'
        : lazyEvidence
          ? 'unknown_lazy_loaded'
          : 'schema_only';
  const warnings = [];

  if (ratingVisibilityStatus === 'schema_only') {
    warnings.push({
      type: 'aggregate_rating_not_visible',
      priority: 'medium',
      issue: 'AggregateRating schema is present but visible rating/review evidence was not found',
      whyItMatters:
        'Rating markup should reflect review information users can verify on the page.',
      howToFix:
        'Show matching rating/review UI near the product content, or remove AggregateRating until reviews are visible.'
    });
  }

  if (reviewVisibilityStatus === 'schema_only') {
    warnings.push({
      type: 'review_not_visible',
      priority: 'medium',
      issue: 'Review schema is present but visible review content was not found',
      whyItMatters:
        'Review schema should represent review content available to users.',
      howToFix:
        'Render review excerpts/content in the page UI, or remove Review markup until reviews are visible.'
    });
  }

  return {
    reviewVisibilityStatus,
    ratingVisibilityStatus,
    warnings,
    evidence: visibleReviewData
  };
}

function buildReviewRatingRows(reviewRatingVisibility) {
  const rows = [];

  rows.push({
    type: 'Rating Visibility',
    status:
      reviewRatingVisibility.ratingVisibilityStatus === 'schema_only'
        ? 'Warning'
        : 'Pass',
    warnings:
      reviewRatingVisibility.warnings
        .filter(warning => warning.type === 'aggregate_rating_not_visible')
        .map(warning => warning.issue)
        .join(' | '),
    recommendation:
      reviewRatingVisibility.ratingVisibilityStatus === 'unknown_lazy_loaded'
        ? 'AggregateRating exists and reviews may be lazy-loaded; verify rendered review widgets before changing schema.'
        : reviewRatingVisibility.ratingVisibilityStatus === 'schema_only'
          ? 'Make rating/review evidence visible on the page or remove AggregateRating schema.'
          : 'No rating visibility issue was detected.'
  });

  rows.push({
    type: 'Review Visibility',
    status:
      reviewRatingVisibility.reviewVisibilityStatus === 'schema_only'
        ? 'Warning'
        : 'Pass',
    warnings:
      reviewRatingVisibility.warnings
        .filter(warning => warning.type === 'review_not_visible')
        .map(warning => warning.issue)
        .join(' | '),
    recommendation:
      reviewRatingVisibility.reviewVisibilityStatus === 'unknown_lazy_loaded'
        ? 'Review schema exists and reviews may be lazy-loaded; verify rendered review widgets before changing schema.'
        : reviewRatingVisibility.reviewVisibilityStatus === 'schema_only'
          ? 'Make review content visible on the page or remove Review schema.'
          : 'No review visibility issue was detected.'
  });

  return rows;
}

function buildProductFieldValidationRow(productFieldValidation) {
  if (productFieldValidation.status === 'not_applicable') {
    return {
      type: 'Product Field Quality',
      status: 'Pass',
      recommendation:
        'Product field quality validation is only required on product pages.'
    };
  }

  if (productFieldValidation.status === 'error') {
    return {
      type: 'Product Field Quality',
      status: 'Error',
      warnings: productFieldValidation.warnings.join(' | '),
      recommendation:
        'Add the required Product fields first: name, image, price, and availability.'
    };
  }

  if (productFieldValidation.status === 'warning') {
    return {
      type: 'Product Field Quality',
      status: 'Warning',
      warnings: productFieldValidation.warnings.join(' | '),
      recommendation:
        'Keep required fields complete, then add recommended identifiers such as sku, brand, priceCurrency, url, and clean image URLs.'
    };
  }

  return {
    type: 'Product Field Quality',
    status: 'Pass',
    recommendation:
      'Product schema includes the core and recommended commerce fields checked by this audit.'
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

function getProductDedupeKey(candidate) {
  const values = getCandidateIdentityValues(candidate);
  const identity = values.find(Boolean);
  if (identity) {
    return normalizeComparableText(identity);
  }

  return normalizeComparableText(
    [
      getCandidateFieldValues(candidate, ['name'])[0],
      getCandidateFieldValues(candidate, ['url'])[0]
    ]
      .filter(Boolean)
      .join('|')
  );
}

function dedupeProductCandidates(productCandidates = []) {
  const seen = new Map();

  productCandidates.forEach(candidate => {
    const key = getProductDedupeKey(candidate);
    if (!key) {
      seen.set(Symbol('product'), candidate);
      return;
    }

    const existing = seen.get(key);
    if (!existing || existing.source !== 'json-ld') {
      seen.set(key, candidate);
    }
  });

  return Array.from(seen.values());
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

  if (allValues.includes(visibleValue)) {
    return 'variant_match';
  }

  return 'mismatch';
}

function buildPriceUnitAnalysis({
  schemaPrice,
  visiblePrice,
  rawShopifyPrice,
  priceMatchStatus
}) {
  const rawNumber = parseRawShopifyPriceNumber(rawShopifyPrice);
  const schemaNumber = parsePriceNumber(schemaPrice);
  const visibleNumber = parsePriceNumber(visiblePrice);
  const comparisonNumber = schemaNumber ?? visibleNumber;

  if (priceMatchStatus === 'mismatch') {
    return {
      rawShopifyPrice: rawShopifyPrice || '',
      priceUnitStatus: 'real_mismatch',
      priceDebugNote:
        'Schema price and visible UI price differ in business value. Review Product/Offer schema and the selected Shopify variant price.'
    };
  }

  if (!rawShopifyPrice || rawNumber === null || comparisonNumber === null) {
    return {
      rawShopifyPrice: rawShopifyPrice || '',
      priceUnitStatus: 'unknown',
      priceDebugNote: ''
    };
  }

  if (pricesAreEqual(rawNumber, comparisonNumber)) {
    return {
      rawShopifyPrice,
      priceUnitStatus: 'match',
      priceDebugNote:
        'Raw Shopify/app price uses the same major-unit format as schema/UI price.'
    };
  }

  if (pricesAreEqual(rawNumber / 100, comparisonNumber)) {
    return {
      rawShopifyPrice,
      priceUnitStatus: 'minor_unit',
      priceDebugNote:
        `Raw Shopify/app price appears to use minor units (${rawShopifyPrice}) while schema/UI use major units (${comparisonNumber.toFixed(2)}). This is raw-unit context, not a live/schema price mismatch.`
    };
  }

  return {
    rawShopifyPrice,
    priceUnitStatus: 'unknown',
    priceDebugNote:
      `Raw Shopify/app price (${rawShopifyPrice}) does not clearly match schema/UI price (${comparisonNumber.toFixed(2)}) as either major units or Shopify minor units.`
  };
}

function normalizeVisiblePriceForRawShopifyUnits({
  visiblePrice,
  rawShopifyPrice,
  schemaPrice,
  allSchemaPrices = []
}) {
  const normalizedVisiblePrice = normalizePrice(visiblePrice) || '';
  const visibleNumber = parsePriceNumber(normalizedVisiblePrice);
  const rawNumber = parseRawShopifyPriceNumber(rawShopifyPrice);
  const schemaNumbers = uniqueValues([schemaPrice, ...allSchemaPrices])
    .map(parsePriceNumber)
    .filter(value => value !== null);

  if (
    visibleNumber === null ||
    rawNumber === null ||
    schemaNumbers.length === 0
  ) {
    return normalizedVisiblePrice;
  }

  const visibleLooksLikeRaw =
    pricesAreEqual(visibleNumber, rawNumber) ||
    pricesAreEqual(visibleNumber, rawNumber / 100);
  const rawMinorMatchesSchema = schemaNumbers.some(schemaNumber =>
    pricesAreEqual(rawNumber / 100, schemaNumber)
  );

  if (visibleLooksLikeRaw && rawMinorMatchesSchema) {
    return (rawNumber / 100).toFixed(2);
  }

  return normalizedVisiblePrice;
}

function buildSchemaUiConsistency({
  pageType,
  productCandidates,
  visiblePrice,
  visibleAvailability,
  rawShopifyPrice,
  selectedVariantId = ''
}) {
  if (pageType !== 'product') {
    return {
      schemaPrice: '',
      visiblePrice: normalizePrice(visiblePrice) || '',
      rawShopifyPrice: rawShopifyPrice || '',
      priceMatchStatus: 'not_applicable',
      priceUnitStatus: 'unknown',
      priceDebugNote: '',
      schemaAvailability: '',
      visibleAvailability: normalizeAvailability(visibleAvailability) || '',
      availabilityMatchStatus: 'not_applicable',
      selectedVariantId: selectedVariantId || '',
      selectedVariantPrice: '',
      selectedVariantAvailability: '',
      consistencyWarnings: []
    };
  }

  const primaryCandidate = getPrimaryProductCandidate(productCandidates);
  const selectedVariantCandidate = getSelectedVariantCandidate(
    productCandidates,
    selectedVariantId
  );
  const comparisonCandidate = selectedVariantCandidate || primaryCandidate;
  const schemaPrice = getSchemaPrice(comparisonCandidate) || '';
  const allSchemaPrices = getAllSchemaPrices(productCandidates);
  const normalizedVisiblePrice = normalizeVisiblePriceForRawShopifyUnits({
    visiblePrice,
    rawShopifyPrice,
    schemaPrice,
    allSchemaPrices
  });
  const schemaAvailability = getSchemaAvailability(comparisonCandidate) || '';
  const allSchemaAvailabilities = getAllSchemaAvailabilities(productCandidates);
  const normalizedVisibleAvailability =
    normalizeAvailability(visibleAvailability) || '';
  const selectedVariantPrice = selectedVariantCandidate
    ? getSchemaPrice(selectedVariantCandidate) || ''
    : '';
  const selectedVariantAvailability = selectedVariantCandidate
    ? getSchemaAvailability(selectedVariantCandidate) || ''
    : '';
  const rawPriceMatchStatus = getMatchStatus({
    primaryValue: schemaPrice,
    allValues: allSchemaPrices,
    visibleValue: normalizedVisiblePrice
  });
  const priceMatchStatus =
    rawPriceMatchStatus === 'match' || rawPriceMatchStatus === 'variant_match'
      ? 'pass'
      : rawPriceMatchStatus;
  const priceUnitAnalysis = buildPriceUnitAnalysis({
    schemaPrice,
    visiblePrice: normalizedVisiblePrice,
    rawShopifyPrice,
    priceMatchStatus
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

  if (priceUnitAnalysis.priceUnitStatus === 'minor_unit') {
    consistencyWarnings.push({
      priority: 'low',
      type: 'raw_shopify_price_minor_unit',
      issue: 'Shopify raw price uses minor units',
      whyItMatters:
        'Shopify app payloads often store prices in cents/minor units, while schema and UI should show customer-facing major units.',
      howToFix: priceUnitAnalysis.priceDebugNote
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
    rawShopifyPrice: priceUnitAnalysis.rawShopifyPrice,
    priceMatchStatus,
    priceUnitStatus: priceUnitAnalysis.priceUnitStatus,
    priceDebugNote: priceUnitAnalysis.priceDebugNote,
    schemaAvailability,
    visibleAvailability: normalizedVisibleAvailability,
    availabilityMatchStatus,
    selectedVariantId: selectedVariantId || '',
    selectedVariantPrice,
    selectedVariantAvailability,
    consistencyWarnings
  };
}

function buildSchemaScoreBreakdown({
  missingRequired,
  missingRecommended,
  unexpectedSchemaTypes,
  schemaConflicts,
  consistencyWarnings,
  qualityWarnings = [],
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
    const points =
      warning.type === 'raw_shopify_price_unit_mismatch'
        ? 0
        : warning.priority === 'high'
          ? 15
          : 8;

    deductions.push({
      category: 'Schema/UI consistency',
      points,
      reason: warning.issue
    });
  });

  (qualityWarnings || []).forEach(warning => {
    deductions.push({
      category: warning.category || 'Schema quality',
      points:
        warning.priority === 'high'
          ? 8
          : warning.priority === 'medium'
            ? 5
            : 0,
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
  qualityWarnings = [],
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

  (qualityWarnings || []).forEach(warning => {
    recommendations.push(createSchemaRecommendation({
      priority: warning.priority || 'low',
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

function getHasVariantIdentities(productGroupEntity, graphIndex = null) {
  const hasVariant = readJsonLdField(productGroupEntity, 'hasVariant', graphIndex);
  const values = Array.isArray(hasVariant)
    ? hasVariant
    : hasVariant
      ? [hasVariant]
      : [];

  return values
    .map(value => {
      const resolvedValue = resolveJsonLdValue(value, graphIndex);
      if (!value) {
        return '';
      }

      if (typeof resolvedValue === 'string') {
        return String(resolvedValue).trim();
      }

      if (typeof resolvedValue === 'object') {
        return getVariantIdentity(resolvedValue);
      }

      return '';
    })
    .filter(Boolean);
}

function buildPrimaryProductStructureRow(jsonLdDocuments) {
  const graphIndex = createJsonLdEntityIndex(jsonLdDocuments);
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
  const hasVariantIds = getHasVariantIdentities(primaryGroup, graphIndex);

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
  pageTitle = '',
  jsonLdDocuments = [],
  microdataItems = [],
  breadcrumbUiPresent = false,
  breadcrumbLinks = [],
  jsonLdErrorCount = 0,
  schemaParseErrors = [],
  visibleReviewData = {},
  visiblePrice = '',
  visibleAvailability = '',
  rawShopifyPrice = '',
  selectedVariantId = ''
}) {
  const targetTypes = new Set(['Product', 'ProductGroup']);
  const graphIndex = createJsonLdEntityIndex(jsonLdDocuments);
  const jsonLdProductCandidates = jsonLdDocuments.flatMap(document =>
    collectEntitiesByTypes(document, targetTypes)
  ).map(candidate => ({
    ...candidate,
    graphIndex
  }));
  const microdataProductCandidates = microdataItems.filter(item =>
    (item.types || []).some(type => targetTypes.has(type))
  );
  const productCandidates = [
    ...jsonLdProductCandidates,
    ...microdataProductCandidates
  ];
  const dedupedProductCandidates = dedupeProductCandidates(productCandidates);
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
    dedupedProductCandidates
  );
  const consistencyResult = buildSchemaUiConsistency({
    pageType,
    productCandidates: dedupedProductCandidates,
    visiblePrice,
    visibleAvailability,
    rawShopifyPrice,
    selectedVariantId
  });
  const productFieldValidation = buildProductFieldValidation(
    pageType,
    dedupedProductCandidates
  );
  const breadcrumbConsistency = buildBreadcrumbConsistency({
    pageType,
    pageUrl,
    pageTitle,
    jsonLdDocuments,
    microdataItems,
    breadcrumbUiPresent,
    breadcrumbLinks
  });
  const reviewRatingVisibility = buildReviewRatingVisibility({
    jsonLdDocuments,
    microdataItems,
    visibleReviewData
  });
  const qualityWarnings = [
    ...reviewRatingVisibility.warnings.map(warning => ({
      ...warning,
      category: 'Review/rating trust'
    })),
    ...breadcrumbConsistency.warnings.map(issue => ({
      priority:
        breadcrumbConsistency.status === 'mismatch' ||
        breadcrumbConsistency.status === 'missing_schema'
          ? 'medium'
          : 'low',
      issue,
      category: 'Breadcrumb consistency',
      whyItMatters:
        'Breadcrumb schema should match the visible breadcrumb trail so search engines and users see the same hierarchy.',
      howToFix:
        'Align BreadcrumbList names, positions, and URLs with the visible breadcrumb UI.'
    })),
    ...productFieldValidation.recommended
      .filter(item => item.status === 'recommended' || item.status === 'warning')
      .map(item => ({
        priority: 'low',
        issue: `${item.field} is ${item.status === 'warning' ? 'invalid-looking' : 'recommended'} in Product schema`,
        category: 'Product field quality',
        whyItMatters:
          'Complete commerce fields improve product understanding and downstream feed/schema consistency.',
        howToFix:
          `Add or correct ${item.field} in the primary Product or Offer schema.`
      })),
    ...productFieldValidation.optional
      .filter(item => item.status === 'warning')
      .map(item => ({
        priority: 'low',
        issue: `${item.field} has an invalid-looking value`,
        category: 'Product identifier quality',
        whyItMatters:
          'Optional identifiers help product matching only when the values are accurate.',
        howToFix:
          `Correct ${item.field} or omit it until a valid identifier is available.`
      }))
  ];

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
    productCandidates: dedupedProductCandidates,
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
    qualityWarnings,
    jsonLdErrorCount,
    implementationType
  });
  const rows = [
    buildGoogleEligibilityRow(pageType, dedupedProductCandidates),
    buildProductFieldValidationRow(productFieldValidation),
    buildRichResultWarningsRow(pageType, dedupedProductCandidates),
    buildMerchantCenterSyncRow(pageType, consistencyResult),
    ...entityRows,
    buildBreadcrumbFormatRow(
      jsonLdDocuments,
      microdataItems,
      breadcrumbUiPresent
    ),
    buildBreadcrumbConsistencyRow(breadcrumbConsistency),
    ...buildReviewRatingRows(reviewRatingVisibility),
    buildSchemaScopeRow(pageType, allDetectedTypes),
    buildPrimaryProductStructureRow(jsonLdDocuments),
    buildShopifyConflictRow(dedupedProductCandidates),
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
    qualityWarnings,
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
    schemaParseErrors,
    productFieldValidation,
    qualityWarnings,
    breadcrumbConsistencyStatus: breadcrumbConsistency.status,
    breadcrumbConsistencyWarnings: breadcrumbConsistency.warnings,
    breadcrumbConsistency,
    reviewVisibilityStatus: reviewRatingVisibility.reviewVisibilityStatus,
    ratingVisibilityStatus: reviewRatingVisibility.ratingVisibilityStatus,
    reviewRatingWarnings: reviewRatingVisibility.warnings,
    selectedVariantId: consistencyResult.selectedVariantId || '',
    selectedVariantPrice: consistencyResult.selectedVariantPrice || '',
    selectedVariantAvailability:
      consistencyResult.selectedVariantAvailability || '',
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

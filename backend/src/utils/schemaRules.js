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
    required: [
      { label: 'SearchResultsPage or WebPage', anyOf: ['SearchResultsPage', 'WebPage'] }
    ],
    recommended: []
  },
  webpage: {
    required: [{ label: 'WebPage', anyOf: ['WebPage'] }],
    recommended: []
  }
};

const STRUCTURED_DATA_COVERAGE_TYPES = [
  'Product',
  'ProductGroup',
  'Offer',
  'AggregateOffer',
  'BreadcrumbList',
  'ItemList',
  'Article',
  'BlogPosting',
  'FAQPage',
  'Organization',
  'WebSite',
  'WebPage',
  'CollectionPage',
  'SearchResultsPage',
  'Review',
  'AggregateRating',
  'LocalBusiness',
  'ContactPoint'
];

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

function buildMissingSchemas(pageType, detectedTypes, breadcrumbUiPresent = false) {
  const { missingRequired, missingRecommended } = getMissingSchemaGroups(
    pageType,
    detectedTypes,
    breadcrumbUiPresent
  );

  return [...missingRequired, ...missingRecommended];
}

function buildCoverageMap() {
  return STRUCTURED_DATA_COVERAGE_TYPES.reduce((coverage, type) => {
    coverage[type] = 0;
    return coverage;
  }, {});
}

module.exports = {
  PAGE_SCHEMA_RULES,
  STRUCTURED_DATA_COVERAGE_TYPES,
  buildCoverageMap,
  buildMissingSchemas,
  getMissingSchemaGroups,
  getSchemaRules,
  hasAnySchemaType,
  listExpectedSchemaTypes
};

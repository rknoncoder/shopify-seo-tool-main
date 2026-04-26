const SCHEMA_TYPE_ALIASES = {
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
  postaladdress: 'PostalAddress',
  localbusiness: 'LocalBusiness'
};

function normalizeSchemaType(type) {
  const rawValue = String(type || '').trim();
  if (!rawValue) {
    return '';
  }

  const withoutSchemaPrefix = rawValue
    .replace(/^https?:\/\/schema\.org[\/#]/i, '')
    .replace(/^schema:/i, '')
    .trim();
  const compactValue = withoutSchemaPrefix.split(/[?#]/)[0].trim();
  const normalized = compactValue.toLowerCase();

  return SCHEMA_TYPE_ALIASES[normalized] || compactValue;
}

function normalizeSchemaTypes(types = []) {
  const values = Array.isArray(types) ? types : [types];
  return Array.from(
    new Set(values.map(normalizeSchemaType).filter(Boolean))
  );
}

function hasAnySchemaType(detectedTypes = [], expectedTypes = []) {
  const detectedSet = new Set(normalizeSchemaTypes(detectedTypes));
  return normalizeSchemaTypes(expectedTypes).some(type => detectedSet.has(type));
}

module.exports = {
  SCHEMA_TYPE_ALIASES,
  hasAnySchemaType,
  normalizeSchemaType,
  normalizeSchemaTypes
};

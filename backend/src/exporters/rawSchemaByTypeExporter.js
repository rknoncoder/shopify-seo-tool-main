const fs = require('fs');
const path = require('path');
const { normalizeSchemaType, normalizeSchemaTypes } = require('../utils/schemaTypes');
const { buildRawEvidenceRecord } = require('./rawEvidenceExporter');

const SHEET_GROUPS = [
  { key: 'products', title: 'Products', match: pageType => pageType === 'product' },
  { key: 'collections', title: 'Collections', match: pageType => pageType === 'collection' },
  { key: 'blogs', title: 'Blogs Articles', match: pageType => pageType === 'blog' },
  { key: 'pages', title: 'Pages', match: pageType => pageType === 'page' },
  { key: 'homepage', title: 'Homepage', match: pageType => pageType === 'homepage' },
  {
    key: 'other',
    title: 'Unknown Other',
    match: pageType => !['product', 'collection', 'blog', 'page', 'homepage'].includes(pageType)
  }
];

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function createCell(value) {
  return `<Cell><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
}

function createRow(values) {
  return `<Row>${values.map(createCell).join('')}</Row>`;
}

function createWorksheet(name, rows) {
  return `
    <Worksheet ss:Name="${escapeXml(name)}">
      <Table>
        ${rows.map(createRow).join('')}
      </Table>
    </Worksheet>
  `;
}

function getTypeList(entity) {
  const types = Array.isArray(entity?.['@type'])
    ? entity['@type']
    : entity?.['@type']
      ? [entity['@type']]
      : [];

  return normalizeSchemaTypes(types);
}

function collectSchemaEntities(value, predicate, found = [], seen = new WeakSet()) {
  if (!value) {
    return found;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectSchemaEntities(item, predicate, found, seen));
    return found;
  }

  if (typeof value !== 'object') {
    return found;
  }

  if (seen.has(value)) {
    return found;
  }

  seen.add(value);

  if (predicate(value, getTypeList(value))) {
    found.push(value);
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === '@context') {
      return;
    }

    collectSchemaEntities(child, predicate, found, seen);
  });

  return found;
}

function valueToText(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }

  if (Array.isArray(value)) {
    return value.map(valueToText).find(Boolean) || '';
  }

  if (typeof value === 'object') {
    return valueToText(
      value.name ||
        value.headline ||
        value.url ||
        value.href ||
        value.item ||
        value['@id'] ||
        value.price ||
        value.priceCurrency ||
        value.availability ||
        value.query
    );
  }

  return '';
}

function uniqueList(values = []) {
  return Array.from(new Set(values.map(valueToText).filter(Boolean)));
}

function formatValue(value) {
  if (Array.isArray(value)) {
    return value
      .map(item =>
        item && typeof item === 'object' ? JSON.stringify(item) : String(item)
      )
      .join('\n');
  }

  if (value && typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }

  return value || '';
}

function joinValues(values = []) {
  return uniqueList(values).join('\n');
}

function getRawEvidenceRecord(page, index) {
  return buildRawEvidenceRecord(page, index);
}

function getParsedDocuments(record) {
  return record.rawEvidence?.parsedSchemaObjects || [];
}

function getEntitiesByType(record, expectedTypes = []) {
  const typeSet = new Set(normalizeSchemaTypes(expectedTypes));
  return getParsedDocuments(record).flatMap(document =>
    collectSchemaEntities(document, (_, types) =>
      types.some(type => typeSet.has(normalizeSchemaType(type)))
    )
  );
}

function getArticleEntities(record) {
  return getEntitiesByType(record, ['Article', 'BlogPosting']);
}

function getProductEntities(record) {
  return getEntitiesByType(record, ['Product', 'ProductGroup']);
}

function getOfferEntities(record) {
  return getEntitiesByType(record, ['Offer', 'AggregateOffer']);
}

function getEntitiesAsText(record, types, mapper) {
  return joinValues(getEntitiesByType(record, types).map(mapper));
}

function getBooleanFlags(record) {
  const schemaTypes = record.schemaTypes || [];
  const parseErrorCount = record.rawEvidence?.schemaParseErrors?.length || 0;

  return {
    hasProductSchema: schemaTypes.includes('Product'),
    hasProductGroupSchema: schemaTypes.includes('ProductGroup'),
    hasOfferSchema:
      schemaTypes.includes('Offer') || schemaTypes.includes('AggregateOffer'),
    hasBreadcrumbSchema: schemaTypes.includes('BreadcrumbList'),
    hasCollectionPageSchema: schemaTypes.includes('CollectionPage'),
    hasArticleSchema:
      schemaTypes.includes('Article') || schemaTypes.includes('BlogPosting'),
    hasWebSiteSchema: schemaTypes.includes('WebSite'),
    hasOrganizationSchema: schemaTypes.includes('Organization'),
    hasParseErrors: parseErrorCount > 0
  };
}

function booleanColumns(flags) {
  return [
    flags.hasProductSchema ? 'Yes' : 'No',
    flags.hasProductGroupSchema ? 'Yes' : 'No',
    flags.hasOfferSchema ? 'Yes' : 'No',
    flags.hasBreadcrumbSchema ? 'Yes' : 'No',
    flags.hasCollectionPageSchema ? 'Yes' : 'No',
    flags.hasArticleSchema ? 'Yes' : 'No',
    flags.hasWebSiteSchema ? 'Yes' : 'No',
    flags.hasOrganizationSchema ? 'Yes' : 'No',
    flags.hasParseErrors ? 'Yes' : 'No'
  ];
}

function baseColumns(record) {
  return [
    record.url || '',
    record.pageType || '',
    record.canonical || '',
    (record.schemaTypes || []).join(', '),
    formatValue(record.rawEvidence?.schemaJsonLdRawBlocks || [])
  ];
}

function parseErrorCell(record) {
  return formatValue(record.rawEvidence?.schemaParseErrors || []);
}

function buildProductRows(records = []) {
  const rows = [[
    'URL',
    'Page Type',
    'Canonical',
    'Schema Types',
    'Raw JSON-LD Blocks',
    'Product ProductGroup Names',
    'Product URLs',
    'Brand',
    'SKU',
    'Offer Prices',
    'Offer Currency',
    'Offer Availability',
    'Offer URLs',
    'Visible Price Candidates',
    'Raw Shopify Price Candidates',
    'Visible Availability Candidates',
    'Breadcrumb Schema Items',
    'Breadcrumb UI Candidates',
    'Parse Errors',
    'hasProductSchema',
    'hasProductGroupSchema',
    'hasOfferSchema',
    'hasBreadcrumbSchema',
    'hasCollectionPageSchema',
    'hasArticleSchema',
    'hasWebSiteSchema',
    'hasOrganizationSchema',
    'hasParseErrors'
  ]];

  records.forEach(record => {
    const productEntities = getProductEntities(record);
    const offerEntities = getOfferEntities(record);
    const flags = getBooleanFlags(record);

    rows.push([
      ...baseColumns(record),
      joinValues(productEntities.map(entity => entity.name)),
      joinValues(productEntities.map(entity => entity.url || entity['@id'])),
      joinValues(productEntities.map(entity => entity.brand || entity.manufacturer)),
      joinValues(productEntities.map(entity => entity.sku)),
      joinValues(offerEntities.map(entity => entity.price || entity.lowPrice || entity.highPrice)),
      joinValues(offerEntities.map(entity => entity.priceCurrency)),
      joinValues(offerEntities.map(entity => entity.availability)),
      joinValues(offerEntities.map(entity => entity.url || entity['@id'])),
      formatValue(record.rawEvidence?.visiblePriceCandidates || []),
      formatValue(record.rawEvidence?.rawShopifyPriceCandidates || []),
      formatValue(record.rawEvidence?.visibleAvailabilityCandidates || []),
      formatValue(record.rawEvidence?.breadcrumbSchemaItems || []),
      formatValue(record.rawEvidence?.breadcrumbUiCandidates || []),
      parseErrorCell(record),
      ...booleanColumns(flags)
    ]);
  });

  return rows;
}

function buildCollectionRows(records = []) {
  const rows = [[
    'URL',
    'Page Type',
    'Canonical',
    'Schema Types',
    'Raw JSON-LD Blocks',
    'Has CollectionPage WebPage',
    'Has ItemList',
    'Has BreadcrumbList',
    'Product URL Candidates',
    'Breadcrumb UI Candidates',
    'Parse Errors',
    'hasProductSchema',
    'hasProductGroupSchema',
    'hasOfferSchema',
    'hasBreadcrumbSchema',
    'hasCollectionPageSchema',
    'hasArticleSchema',
    'hasWebSiteSchema',
    'hasOrganizationSchema',
    'hasParseErrors'
  ]];

  records.forEach(record => {
    const schemaTypes = record.schemaTypes || [];
    const flags = getBooleanFlags(record);

    rows.push([
      ...baseColumns(record),
      schemaTypes.includes('CollectionPage') || schemaTypes.includes('WebPage') ? 'Yes' : 'No',
      schemaTypes.includes('ItemList') ? 'Yes' : 'No',
      schemaTypes.includes('BreadcrumbList') ? 'Yes' : 'No',
      formatValue(record.rawEvidence?.productUrlCandidates || []),
      formatValue(record.rawEvidence?.breadcrumbUiCandidates || []),
      parseErrorCell(record),
      ...booleanColumns(flags)
    ]);
  });

  return rows;
}

function buildBlogRows(records = []) {
  const rows = [[
    'URL',
    'Page Type',
    'Canonical',
    'Schema Types',
    'Raw JSON-LD Blocks',
    'Article BlogPosting Headline',
    'Author',
    'Publisher',
    'Image',
    'Date Published',
    'Date Modified',
    'Breadcrumb Schema Items',
    'Breadcrumb UI Candidates',
    'Parse Errors',
    'hasProductSchema',
    'hasProductGroupSchema',
    'hasOfferSchema',
    'hasBreadcrumbSchema',
    'hasCollectionPageSchema',
    'hasArticleSchema',
    'hasWebSiteSchema',
    'hasOrganizationSchema',
    'hasParseErrors'
  ]];

  records.forEach(record => {
    const articleEntities = getArticleEntities(record);
    const flags = getBooleanFlags(record);

    rows.push([
      ...baseColumns(record),
      joinValues(articleEntities.map(entity => entity.headline || entity.name)),
      joinValues(articleEntities.map(entity => entity.author)),
      joinValues(articleEntities.map(entity => entity.publisher)),
      joinValues(articleEntities.map(entity => entity.image)),
      joinValues(articleEntities.map(entity => entity.datePublished)),
      joinValues(articleEntities.map(entity => entity.dateModified)),
      formatValue(record.rawEvidence?.breadcrumbSchemaItems || []),
      formatValue(record.rawEvidence?.breadcrumbUiCandidates || []),
      parseErrorCell(record),
      ...booleanColumns(flags)
    ]);
  });

  return rows;
}

function buildHomepagePageRows(records = []) {
  const rows = [[
    'URL',
    'Page Type',
    'Canonical',
    'Schema Types',
    'Raw JSON-LD Blocks',
    'Organization',
    'WebSite',
    'SearchAction',
    'ContactPoint',
    'WebPage',
    'Breadcrumb Schema Items',
    'Parse Errors',
    'hasProductSchema',
    'hasProductGroupSchema',
    'hasOfferSchema',
    'hasBreadcrumbSchema',
    'hasCollectionPageSchema',
    'hasArticleSchema',
    'hasWebSiteSchema',
    'hasOrganizationSchema',
    'hasParseErrors'
  ]];

  records.forEach(record => {
    const flags = getBooleanFlags(record);

    rows.push([
      ...baseColumns(record),
      getEntitiesAsText(record, ['Organization'], entity => entity.name || entity.url || entity['@id']),
      getEntitiesAsText(record, ['WebSite'], entity => entity.name || entity.url || entity['@id']),
      getEntitiesAsText(record, ['SearchAction'], entity => entity.target || entity.query || entity['@id']),
      getEntitiesAsText(record, ['ContactPoint'], entity => entity.contactType || entity.telephone || entity.email),
      getEntitiesAsText(record, ['WebPage'], entity => entity.name || entity.url || entity['@id']),
      formatValue(record.rawEvidence?.breadcrumbSchemaItems || []),
      parseErrorCell(record),
      ...booleanColumns(flags)
    ]);
  });

  return rows;
}

function buildOtherRows(records = []) {
  const rows = [[
    'URL',
    'Page Type',
    'Canonical',
    'Schema Types',
    'Raw JSON-LD Blocks',
    'Breadcrumb Schema Items',
    'Breadcrumb UI Candidates',
    'Parse Errors',
    'hasProductSchema',
    'hasProductGroupSchema',
    'hasOfferSchema',
    'hasBreadcrumbSchema',
    'hasCollectionPageSchema',
    'hasArticleSchema',
    'hasWebSiteSchema',
    'hasOrganizationSchema',
    'hasParseErrors'
  ]];

  records.forEach(record => {
    const flags = getBooleanFlags(record);

    rows.push([
      ...baseColumns(record),
      formatValue(record.rawEvidence?.breadcrumbSchemaItems || []),
      formatValue(record.rawEvidence?.breadcrumbUiCandidates || []),
      parseErrorCell(record),
      ...booleanColumns(flags)
    ]);
  });

  return rows;
}

function buildRowsForGroup(groupKey, records) {
  if (groupKey === 'products') {
    return buildProductRows(records);
  }

  if (groupKey === 'collections') {
    return buildCollectionRows(records);
  }

  if (groupKey === 'blogs') {
    return buildBlogRows(records);
  }

  if (groupKey === 'pages' || groupKey === 'homepage') {
    return buildHomepagePageRows(records);
  }

  return buildOtherRows(records);
}

function buildWorkbookXml(records = []) {
  const worksheets = SHEET_GROUPS.map(group => {
    const matched = records.filter(record => group.match(record.pageType));
    return createWorksheet(group.title, buildRowsForGroup(group.key, matched));
  });

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook
  xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40">
  ${worksheets.join('')}
</Workbook>`;
}

function exportRawSchemaByType(report, options = {}) {
  const outputDir =
    options.outputDir || path.join(__dirname, '..', '..', 'reports');
  const fileName = options.fileName || 'raw-schema-by-type.xml';
  const filePath = path.join(outputDir, fileName);
  const records = (report.pages || []).map((page, index) =>
    getRawEvidenceRecord(page, index)
  );

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, buildWorkbookXml(records), 'utf8');

  const samples = {};
  SHEET_GROUPS.forEach(group => {
    const matched = records.filter(record => group.match(record.pageType));
    const rows = buildRowsForGroup(group.key, matched);
    samples[group.key] = rows[1] || null;
  });

  return {
    filePath,
    fileName,
    sheetNames: SHEET_GROUPS.map(group => group.title),
    samples
  };
}

module.exports = {
  exportRawSchemaByType
};

const fs = require('fs');
const path = require('path');
const { normalizeSchemaTypes } = require('../utils/schemaTypes');

const PAGE_TYPE_FILE_NAMES = {
  product: 'products.json',
  collection: 'collections.json',
  blog: 'blogs.json',
  page: 'pages.json'
};

function toBooleanEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function getRawExportFormat(value = process.env.RAW_EXPORT_FORMAT) {
  return String(value || 'json').trim().toLowerCase() === 'ndjson'
    ? 'ndjson'
    : 'json';
}

function getRawExportSplitByPageType(
  value = process.env.RAW_EXPORT_SPLIT_BY_PAGE_TYPE
) {
  return toBooleanEnv(value, false);
}

function getRawEvidence(page) {
  return (
    page.rawEvidence ||
    page.structuredDataReport?.rawEvidence ||
    page.structuredData?.rawEvidence ||
    {}
  );
}

function getSchemaTypes(page, evidence) {
  return normalizeSchemaTypes([
    ...(evidence.parsedSchemaTypes || []),
    ...(page.detectedSchemaTypes || []),
    ...(page.structuredDataReport?.detectedSchemaTypes || []),
    ...(page.structuredData?.schemaTypes || [])
  ]);
}

function makeRawEvidenceId(index) {
  return `raw-evidence-${String(index + 1).padStart(5, '0')}`;
}

function buildRawEvidenceRecord(page, index = 0) {
  const evidence = getRawEvidence(page);
  const schemaTypes = getSchemaTypes(page, evidence);
  const duplicateUrlCandidates = [
    ...(evidence.duplicateUrlCandidates || []),
    ...(page.collectionProductDuplicateUrls || []),
    ...(page.collectionProductUrls || [])
  ].filter((url, candidateIndex, all) => url && all.indexOf(url) === candidateIndex);

  const record = {
    id: page.rawEvidenceId || makeRawEvidenceId(index),
    url: evidence.url || page.url || '',
    pageType: evidence.pageTypeGuess || page.pageType || '',
    canonical: page.canonical || '',
    auditMode: page.auditMode || '',
    schemaTypes,
    flags: {
      hasProduct: schemaTypes.includes('Product'),
      hasProductGroup: schemaTypes.includes('ProductGroup'),
      hasOffer:
        schemaTypes.includes('Offer') || schemaTypes.includes('AggregateOffer'),
      hasBreadcrumbList: schemaTypes.includes('BreadcrumbList'),
      hasCollectionPage: schemaTypes.includes('CollectionPage'),
      hasArticleOrBlogPosting:
        schemaTypes.includes('Article') || schemaTypes.includes('BlogPosting')
    },
    counts: {
      schemaPriceCount: (evidence.schemaOfferPrices || []).length,
      visiblePriceCandidateCount: (evidence.visiblePriceCandidates || []).length,
      rawShopifyPriceCandidateCount:
        (evidence.rawShopifyPriceCandidates || []).length,
      availabilityCandidateCount:
        (evidence.visibleAvailabilityCandidates || []).length,
      breadcrumbUiCandidateCount: (evidence.breadcrumbUiCandidates || []).length,
      parseErrorCount: (evidence.schemaParseErrors || []).length
    },
    summary: {
      title: page.title || '',
      metaDescription: page.metaDescription || '',
      h1: page.h1 || '',
      noindex: Boolean(page.isNoindex)
    },
    rawEvidence: {
      ...evidence,
      parsedSchemaTypes: schemaTypes,
      duplicateUrlCandidates
    }
  };

  return record;
}

function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeNdjsonFile(filePath, values = []) {
  const body = values.map(value => JSON.stringify(value)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function exportPageTypeFiles(records, outputDir) {
  const files = {};

  Object.entries(PAGE_TYPE_FILE_NAMES).forEach(([pageType, fileName]) => {
    const filtered = records.filter(record => record.pageType === pageType);

    if (filtered.length === 0) {
      return;
    }

    const filePath = path.join(outputDir, fileName);
    writeJsonFile(filePath, filtered);
    files[pageType] = filePath;
  });

  return files;
}

function exportRawEvidence(report, options = {}) {
  const outputDir =
    options.outputDir || path.join(__dirname, '..', '..', 'reports');
  const format = getRawExportFormat(options.format);
  const splitByPageType = options.splitByPageType ?? getRawExportSplitByPageType();
  const records = (report.pages || []).map((page, index) =>
    buildRawEvidenceRecord(page, index)
  );
  const fileName =
    options.fileName || (format === 'ndjson' ? 'raw-evidence.ndjson' : 'raw-evidence.json');
  const filePath = path.join(outputDir, fileName);

  fs.mkdirSync(outputDir, { recursive: true });

  if (format === 'ndjson') {
    writeNdjsonFile(filePath, records);
  } else {
    writeJsonFile(filePath, records);
  }

  const pageTypeFiles = splitByPageType
    ? exportPageTypeFiles(records, outputDir)
    : {};

  return {
    filePath,
    fileName,
    format,
    recordCount: records.length,
    pageTypeFiles,
    sampleRecord: records[0] || null
  };
}

module.exports = {
  buildRawEvidenceRecord,
  exportRawEvidence,
  getRawEvidence,
  getRawExportFormat,
  getRawExportSplitByPageType,
  makeRawEvidenceId,
  PAGE_TYPE_FILE_NAMES
};

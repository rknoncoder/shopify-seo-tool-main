const fs = require('fs');
const path = require('path');

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

function formatIssueForExport(issue) {
  if (typeof issue === 'string') {
    return issue;
  }

  if (!issue || typeof issue !== 'object') {
    return '';
  }

  const severity = issue.severity ? `[${issue.severity}] ` : '';
  const count = issue.count !== undefined ? ` (${issue.count})` : '';
  return `${severity}${issue.message || issue.type || ''}${count}`.trim();
}

function getPageSchema(page) {
  return page.schema || {
    detected: (page.structuredData || {}).schemaTypes || [],
    count: (page.structuredData || {}).totalDetectedItems || 0,
    confidence: (page.structuredData || {}).confidence || 'low'
  };
}

function getSchemaAuditRows(page) {
  return page.schemaAudit?.rows || page.structuredDataReport?.schemaAudit?.rows || [];
}

function getSchemaReport(page) {
  return page.structuredDataReport || page.structuredData || {};
}

function formatSchemaRecommendation(recommendation) {
  if (!recommendation || typeof recommendation !== 'object') {
    return String(recommendation || '');
  }

  return [
    recommendation.priority ? `[${recommendation.priority}]` : '',
    recommendation.issue,
    recommendation.whyItMatters,
    recommendation.howToFix
  ]
    .filter(Boolean)
    .join(' ');
}

function formatGeneratedSamples(samples = {}) {
  return Object.entries(samples)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}:\n${value}`)
    .join('\n\n');
}

function buildSummaryRows(summary) {
  return [
    ['SEO Audit Summary', ''],
    ['Metric', 'Value'],
    ['Duplicate Title Groups', summary.duplicateTitleGroups || 0],
    ['Duplicate Meta Description Groups', summary.duplicateMetaDescriptionGroups || 0],
    ['Duplicate Content Groups', summary.duplicateContentGroups || 0],
    ['Canonical/Indexability Conflicts', summary.canonicalIndexabilityConflicts || 0],
    ['Shopify Collection Product Duplicates', summary.shopifyCollectionProductDuplicateGroups || 0],
    ['Structured Data Issues', summary.structuredDataIssues || 0],
    ['Pages With Structured Data', summary.structuredDataDetectedPages || 0],
    ['Total Structured Data Items', summary.structuredDataItemCount || 0]
  ];
}

function formatParseErrors(errors = []) {
  return (errors || [])
    .map(error => {
      const location = [
        error.scriptIndex !== undefined ? `script ${error.scriptIndex}` : '',
        error.line ? `line ${error.line}` : '',
        error.column ? `column ${error.column}` : ''
      ]
        .filter(Boolean)
        .join(', ');

      return [location, error.message].filter(Boolean).join(': ');
    })
    .join(' | ');
}

function formatProductFieldValidation(validation = {}) {
  return [
    ...(validation.required || []),
    ...(validation.recommended || []),
    ...(validation.optional || []).filter(item => item.status === 'warning')
  ]
    .filter(item => item.status && item.status !== 'pass' && item.status !== 'not_present')
    .map(item => `${item.field}: ${item.status}`)
    .join(' | ');
}

function buildPageRows(pages) {
  const rows = [[
    'URL',
    'Page Type',
    'Score',
    'Title',
    'Meta Description',
    'H1',
    'Canonical',
    'Canonical Issues',
    'Collection Product URLs',
    'Collection Product URL Count',
    'Robots',
    'Noindex',
    'Schema Types',
    'Expected Schema Types',
    'Missing Required Schema',
    'Missing Recommended Schema',
    'Unexpected Schema Types',
    'Schema Conflicts',
    'Rich Result Summary',
    'Schema Score',
    'Schema Price',
    'Visible Price',
    'Visible Price Source',
    'Raw Shopify Price',
    'Price Match Status',
    'Price Unit Status',
    'Price Debug Note',
    'Schema Availability',
    'Visible Availability',
    'Availability Match Status',
    'Schema Parse Diagnostics',
    'Product Field Validation',
    'Breadcrumb Consistency Status',
    'Breadcrumb Consistency Warnings',
    'Review Visibility Status',
    'Rating Visibility Status',
    'Selected Variant ID',
    'Selected Variant Price',
    'Selected Variant Availability',
    'Consistency Warnings',
    'Schema Item Count',
    'Schema Confidence',
    'Schema Audit Types',
    'Schema Audit Statuses',
    'Schema Audit Warnings',
    'Schema Audit Recommendations',
    'Schema Audit Suggestions',
    'Generated Schema Sample',
    'JSON-LD Scripts',
    'Parsed JSON-LD Scripts',
    'Microdata Items',
    'Implementation Type',
    'Structured Data Errors',
    'Word Count',
    'Issues',
    'Duplicate Types',
    'Duplicate URLs',
    'Recommendations'
  ]];

  pages.forEach(page => {
    const schema = getPageSchema(page);
    const structuredData = page.structuredData || {};
    const schemaReport = getSchemaReport(page);
    const schemaAuditRows = getSchemaAuditRows(page);
    const collectionProductUrls =
      page.collectionProductDuplicateUrls ||
      page.collectionProductUrls ||
      [];

    rows.push([
      page.url,
      page.pageType,
      page.score,
      page.title,
      page.metaDescription,
      page.h1,
      page.canonical,
      (page.canonicalConflicts || [])
        .map(item => item.reason || item.message)
        .join(' | '),
      collectionProductUrls.join(', '),
      collectionProductUrls.length,
      page.robotsContent,
      page.isNoindex ? 'Yes' : 'No',
      (schema.detected || []).join(', '),
      (schemaReport.expectedSchemaTypes || page.expectedSchemaTypes || []).join(', '),
      (schemaReport.missingRequiredSchema || page.missingRequiredSchema || []).join(', '),
      (schemaReport.missingRecommendedSchema || page.missingRecommendedSchema || []).join(', '),
      (schemaReport.unexpectedSchemaTypes || page.unexpectedSchemaTypes || [])
        .map(item => item.type || item)
        .join(', '),
      (schemaReport.schemaConflicts || page.schemaConflicts || [])
        .map(item => item.issue || item)
        .join(' | '),
      [
        schemaReport.richResultSummary?.status || page.richResultSummary?.status || '',
        schemaReport.richResultSummary?.notes || page.richResultSummary?.notes || ''
      ]
        .filter(Boolean)
        .join(' - '),
      schemaReport.schemaScoreBreakdown?.score ?? page.schemaScoreBreakdown?.score ?? '',
      schemaReport.schemaPrice || page.schemaPrice || '',
      schemaReport.visiblePrice || page.visiblePrice || '',
      schemaReport.visiblePriceSource || page.visiblePriceSource || '',
      schemaReport.rawShopifyPrice || page.rawShopifyPrice || '',
      schemaReport.priceMatchStatus || page.priceMatchStatus || '',
      schemaReport.priceUnitStatus || page.priceUnitStatus || '',
      schemaReport.priceDebugNote || page.priceDebugNote || '',
      schemaReport.schemaAvailability || page.schemaAvailability || '',
      schemaReport.visibleAvailability || page.visibleAvailability || '',
      schemaReport.availabilityMatchStatus || page.availabilityMatchStatus || '',
      formatParseErrors(
        schemaReport.schemaParseErrors ||
          page.schemaParseErrors ||
          structuredData.schemaParseErrors ||
          structuredData.jsonLdErrors ||
          []
      ),
      formatProductFieldValidation(
        schemaReport.productFieldValidation ||
          page.productFieldValidation ||
          {}
      ),
      schemaReport.breadcrumbConsistencyStatus ||
        page.breadcrumbConsistencyStatus ||
        '',
      (
        schemaReport.breadcrumbConsistencyWarnings ||
        page.breadcrumbConsistencyWarnings ||
        []
      ).join(' | '),
      schemaReport.reviewVisibilityStatus || page.reviewVisibilityStatus || '',
      schemaReport.ratingVisibilityStatus || page.ratingVisibilityStatus || '',
      schemaReport.selectedVariantId || page.selectedVariantId || '',
      schemaReport.selectedVariantPrice || page.selectedVariantPrice || '',
      schemaReport.selectedVariantAvailability ||
        page.selectedVariantAvailability ||
        '',
      (schemaReport.consistencyWarnings || page.consistencyWarnings || [])
        .map(item => item.issue || item)
        .join(' | '),
      schema.count || 0,
      schema.confidence || 'low',
      schemaAuditRows.map(item => item.type).join(' | '),
      schemaAuditRows.map(item => item.status).join(' | '),
      schemaAuditRows
        .map(item => item.warnings || '')
        .filter(Boolean)
        .join(' | '),
      schemaAuditRows.map(item => item.recommendation).join(' | '),
      schemaAuditRows
        .map(item => item.suggestion || '')
        .filter(Boolean)
        .join(' | '),
      formatGeneratedSamples(
        schemaReport.generatedSchemaSamples ||
          page.generatedSchemaSamples ||
          {}
      ) ||
        page.generatedSchemaSample ||
        page.structuredDataReport?.generatedSchemaSample ||
        '',
      structuredData.scriptCount || 0,
      structuredData.parsedScriptCount || 0,
      structuredData.microdataItemCount || 0,
      structuredData.schemaAudit?.implementationType || '',
      formatParseErrors(
        structuredData.schemaParseErrors || structuredData.jsonLdErrors || []
      ),
      page.wordCount,
      (page.issues || []).map(formatIssueForExport).join(' | '),
      (page.duplicates || []).map(item => item.type).join(', '),
      (page.duplicates || [])
        .flatMap(item => item.urls || [])
        .filter((url, index, all) => all.indexOf(url) === index)
        .join(', '),
      (
        schemaReport.schemaRecommendations ||
        page.schemaRecommendations ||
        []
      )
        .map(formatSchemaRecommendation)
        .join(' | ') ||
        (page.structuredDataReport?.recommendations || []).join(' | ')
    ]);
  });

  return rows;
}

function buildWorkbookXml(report) {
  const rows = [
    ...buildSummaryRows(report.summary || {}),
    ['', ''],
    ['Page Audit Details', ''],
    ...buildPageRows(report.pages || [])
  ];

  const worksheet = createWorksheet('SEO Audit', rows);

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook
  xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40">
  ${worksheet}
</Workbook>`;
}

function exportAuditToExcel(report, options = {}) {
  const outputDir =
    options.outputDir || path.join(__dirname, '..', '..', 'reports');
  const fileName = options.fileName || 'seo-audit-latest.xml';
  const filePath = path.join(outputDir, fileName);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, buildWorkbookXml(report), 'utf8');

  return filePath;
}

module.exports = exportAuditToExcel;

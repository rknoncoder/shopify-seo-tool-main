const fs = require('fs');
const path = require('path');
const { getAuditMode } = require('../utils/auditMode');
const { buildRawEvidenceRecord } = require('./rawEvidenceExporter');

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

function buildSummaryRows(summary, auditMode) {
  return [
    ['SEO Audit Summary', ''],
    ['Metric', 'Value'],
    ['Audit Mode', auditMode],
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

function buildRawEvidenceSummaryRows(pages = []) {
  const rows = [[
    'URL',
    'Page Type',
    'Canonical',
    'Schema Types',
    'Has Product',
    'Has ProductGroup',
    'Has Offer',
    'Has BreadcrumbList',
    'Has CollectionPage',
    'Has Article/BlogPosting',
    'Schema Price Count',
    'Visible Price Candidate Count',
    'Raw Shopify Price Candidate Count',
    'Availability Candidate Count',
    'Breadcrumb UI Candidate Count',
    'Parse Error Count',
    'Raw Evidence ID'
  ]];

  pages.forEach((page, index) => {
    const record = buildRawEvidenceRecord(page, index);

    rows.push([
      record.url,
      record.pageType,
      record.canonical,
      record.schemaTypes.join(', '),
      record.flags.hasProduct ? 'Yes' : 'No',
      record.flags.hasProductGroup ? 'Yes' : 'No',
      record.flags.hasOffer ? 'Yes' : 'No',
      record.flags.hasBreadcrumbList ? 'Yes' : 'No',
      record.flags.hasCollectionPage ? 'Yes' : 'No',
      record.flags.hasArticleOrBlogPosting ? 'Yes' : 'No',
      record.counts.schemaPriceCount,
      record.counts.visiblePriceCandidateCount,
      record.counts.rawShopifyPriceCandidateCount,
      record.counts.availabilityCandidateCount,
      record.counts.breadcrumbUiCandidateCount,
      record.counts.parseErrorCount,
      record.id
    ]);
  });

  return rows;
}

function buildWorkbookXml(report) {
  const auditMode = report.auditMode || getAuditMode();
  const rows = [
    ...buildSummaryRows(report.summary || {}, auditMode),
    ['', ''],
    ['Raw Evidence Summary', ''],
    ...buildRawEvidenceSummaryRows(report.pages || [])
  ];

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook
  xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40">
  ${createWorksheet('Summary', rows)}
</Workbook>`;
}

function exportAuditToExcel(report, options = {}) {
  const outputDir =
    options.outputDir || path.join(__dirname, '..', '..', 'reports');
  const fileName = options.fileName || 'seo-audit-summary.xml';
  const filePath = path.join(outputDir, fileName);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, buildWorkbookXml(report), 'utf8');

  return filePath;
}

module.exports = exportAuditToExcel;

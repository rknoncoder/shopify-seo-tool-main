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
    'Robots',
    'Noindex',
    'Schema Types',
    'Schema Item Count',
    'Schema Confidence',
    'JSON-LD Scripts',
    'Parsed JSON-LD Scripts',
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
      (page.collectionProductUrls || []).join(', '),
      page.robotsContent,
      page.isNoindex ? 'Yes' : 'No',
      (schema.detected || []).join(', '),
      schema.count || 0,
      schema.confidence || 'low',
      structuredData.scriptCount || 0,
      structuredData.parsedScriptCount || 0,
      (structuredData.jsonLdErrors || [])
        .map(item => item.message)
        .join(' | '),
      page.wordCount,
      (page.issues || []).map(formatIssueForExport).join(' | '),
      (page.duplicates || []).map(item => item.type).join(', '),
      (page.duplicates || [])
        .flatMap(item => item.urls || [])
        .filter((url, index, all) => all.indexOf(url) === index)
        .join(', '),
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

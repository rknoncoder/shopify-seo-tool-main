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

function buildPagesSheet(pages) {
  const rows = [[
    'URL',
    'Page Type',
    'Score',
    'Title',
    'Meta Description',
    'H1',
    'Canonical',
    'Collection Product URLs',
    'Robots',
    'Noindex',
    'Schema Types',
    'Schema Item Count',
    'Structured Data Confidence',
    'JSON-LD Scripts',
    'Parsed JSON-LD Scripts',
    'Structured Data Errors',
    'Word Count',
    'Issues',
    'Duplicate Types',
    'Duplicate URLs',
    'Variant Duplication Canonical',
    'Variant Duplication URLs',
    'Variant Duplication Severity',
    'Variant Duplication Reason',
    'Variant Grouping Method',
    'Canonical Conflicts'
  ]];

  pages.forEach(page => {
    const structuredData = page.structuredData || {};

    rows.push([
      page.url,
      page.pageType,
      page.score,
      page.title,
      page.metaDescription,
      page.h1,
      page.canonical,
      (page.collectionProductUrls || []).join(', '),
      page.robotsContent,
      page.isNoindex ? 'Yes' : 'No',
      (structuredData.schemaTypes || []).join(', '),
      structuredData.totalDetectedItems || 0,
      structuredData.confidence || 'low',
      structuredData.scriptCount || 0,
      structuredData.parsedScriptCount || 0,
      (structuredData.jsonLdErrors || [])
        .map(item => item.message)
        .join(' | '),
      page.wordCount,
      (page.issues || []).join(' | '),
      (page.duplicates || []).map(item => item.type).join(', '),
      (page.duplicates || [])
        .flatMap(item => item.urls || [])
        .filter((url, index, all) => all.indexOf(url) === index)
        .join(', '),
      (page.variantDuplications || [])
        .map(item => item.canonical)
        .join(', '),
      (page.variantDuplications || [])
        .flatMap(item => item.urls || [])
        .filter((url, index, all) => all.indexOf(url) === index)
        .join(', '),
      (page.variantDuplications || []).map(item => item.severity).join(', '),
      (page.variantDuplications || []).map(item => item.reason).join(', '),
      (page.variantDuplications || []).map(item => item.groupedBy).join(', '),
      [
        ...(page.canonicalConflicts || []).map(item => item.message),
        ...(page.shopifyCollectionDuplicates || []).map(item => item.message)
      ].join(' | ')
    ]);
  });

  return rows;
}

function buildDuplicateSheet(title, groups, valueKey, label) {
  const rows = [[label, 'Affected URLs', 'URL Count']];

  groups.forEach(group => {
    rows.push([
      group[valueKey],
      (group.urls || []).join(', '),
      String((group.urls || []).length)
    ]);
  });

  if (groups.length === 0) {
    rows.push([`No ${title.toLowerCase()} found`, '', '0']);
  }

  return rows;
}

function buildSummarySheet(summary) {
  return [
    ['Metric', 'Value'],
    ['Duplicate Title Groups', summary.duplicateTitleGroups || 0],
    ['Duplicate Meta Description Groups', summary.duplicateMetaDescriptionGroups || 0],
    ['Duplicate Content Groups', summary.duplicateContentGroups || 0],
    ['Variant Duplication Groups', summary.variantDuplicationGroups || 0],
    ['Canonical/Indexability Conflicts', summary.canonicalIndexabilityConflicts || 0],
    ['Shopify Collection Product Duplicates', summary.shopifyCollectionProductDuplicateGroups || 0],
    ['Structured Data Issues', summary.structuredDataIssues || 0],
    ['Pages With Structured Data', summary.structuredDataDetectedPages || 0],
    ['Total Structured Data Items', summary.structuredDataItemCount || 0]
  ];
}

function buildCanonicalConflictSheet(conflicts) {
  const rows = [[
    'URL',
    'Type',
    'Severity',
    'Message',
    'Canonical Target',
    'Final Target'
  ]];

  conflicts.forEach(conflict => {
    rows.push([
      conflict.url,
      conflict.type,
      conflict.severity,
      conflict.message,
      conflict.canonicalTarget || '',
      conflict.finalTarget || ''
    ]);
  });

  if (conflicts.length === 0) {
    rows.push(['No canonical or indexability conflicts found', '', '', '', '', '']);
  }

  return rows;
}

function buildShopifyCollectionDuplicateSheet(findings) {
  const rows = [[
    'Product URL',
    'Canonical Target',
    'Severity',
    'Message',
    'Collection Duplicate URLs'
  ]];

  findings.forEach(finding => {
    rows.push([
      finding.productUrl,
      finding.canonicalTarget || '',
      finding.severity,
      finding.message,
      (finding.duplicateUrls || []).join(', ')
    ]);
  });

  if (findings.length === 0) {
    rows.push(['No Shopify collection-product duplicate URLs found', '', '', '', '']);
  }

  return rows;
}

function buildStructuredDataSheet(findings, coverage) {
  const rows = [
    ['Coverage Metric', 'Value'],
    ['Organization schema pages', coverage.Organization || 0],
    ['WebSite schema pages', coverage.WebSite || 0],
    ['Product schema pages', coverage.Product || 0],
    ['ProductGroup schema pages', coverage.ProductGroup || 0],
    ['BreadcrumbList schema pages', coverage.BreadcrumbList || 0],
    ['ItemList schema pages', coverage.ItemList || 0],
    ['Article schema pages', coverage.Article || 0],
    ['BlogPosting schema pages', coverage.BlogPosting || 0],
    ['FAQPage schema pages', coverage.FAQPage || 0],
    [' ', ' '],
    ['URL', 'Page Type', 'Severity', 'Message', 'Issue Type', 'Error Count', 'Recommendation']
  ];

  findings.forEach(finding => {
    rows.push([
      finding.url,
      finding.pageType,
      finding.severity,
      finding.message,
      finding.type,
      finding.errorCount || '',
      finding.recommendation || ''
    ]);
  });

  if (findings.length === 0) {
    rows.push(['No structured data issues found', '', '', '', '', '', '']);
  }

  return rows;
}

function buildStructuredDataSeoReportSheet(reportItems) {
  const rows = [[
    'URL',
    'Detected Schemas',
    'Missing Schemas',
    'Confidence',
    'Issues',
    'Structured Data Found',
    'Missing Structured Data',
    'Recommendations'
  ]];

  reportItems.forEach(item => {
    rows.push([
      item.url,
      (item.detectedSchemas || []).join(', '),
      (item.missingSchemas || []).join(' | '),
      item.confidence || 'low',
      (item.issues || []).map(issue => issue.message || issue.type).join(' | '),
      (item.structuredDataFound || []).join(' | '),
      (item.missingStructuredData || []).join(' | '),
      (item.recommendations || []).join(' | ')
    ]);
  });

  if (reportItems.length === 0) {
    rows.push(['No structured data SEO report items found', '', '', '', '', '', '', '']);
  }

  return rows;
}

function buildVariantDuplicationSheet(items) {
  const rows = [[
    'Canonical',
    'URLs',
    'URL Count',
    'Issue',
    'Severity',
    'Reason',
    'Grouping Method',
    'Pattern Match',
    'Recommendations'
  ]];

  items.forEach(item => {
    rows.push([
      item.canonical,
      (item.urls || []).join(', '),
      item.urlCount || 0,
      item.issue || '',
      item.severity || '',
      item.reason || '',
      item.groupedBy || '',
      item.hasPatternMatch ? 'Yes' : 'No',
      (item.recommendations || []).join(' | ')
    ]);
  });

  if (items.length === 0) {
    rows.push(['No variant duplication found', '', '0', '', '', '', '', '', '']);
  }

  return rows;
}

function buildWorkbookXml(report) {
  const worksheets = [
    createWorksheet('Summary', buildSummarySheet(report.summary || {})),
    createWorksheet('Pages', buildPagesSheet(report.pages || [])),
    createWorksheet(
      'Duplicate Titles',
      buildDuplicateSheet(
        'Duplicate Titles',
        report.duplicateTitles || [],
        'value',
        'Title'
      )
    ),
    createWorksheet(
      'Duplicate Meta',
      buildDuplicateSheet(
        'Duplicate Meta',
        report.duplicateMetaDescriptions || [],
        'value',
        'Meta Description'
      )
    ),
    createWorksheet(
      'Duplicate Content',
      buildDuplicateSheet(
        'Duplicate Content',
        report.duplicateContent || [],
        'fingerprint',
        'Content Fingerprint'
      )
    ),
    createWorksheet(
      'Variant Duplications',
      buildVariantDuplicationSheet(report.variantDuplications || [])
    ),
    createWorksheet(
      'Canonical Conflicts',
      buildCanonicalConflictSheet(report.canonicalIndexabilityConflicts || [])
    ),
    createWorksheet(
      'Shopify URL Duplicates',
      buildShopifyCollectionDuplicateSheet(
        report.shopifyCollectionProductDuplicates || []
      )
    ),
    createWorksheet(
      'Structured Data',
      buildStructuredDataSheet(
        report.structuredDataFindings || [],
        report.structuredDataCoverage || {}
      )
    ),
    createWorksheet(
      'Structured Data SEO',
      buildStructuredDataSeoReportSheet(report.structuredDataSeoReport || [])
    )
  ].join('');

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook
  xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:o="urn:schemas-microsoft-com:office:office"
  xmlns:x="urn:schemas-microsoft-com:office:excel"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:html="http://www.w3.org/TR/REC-html40">
  ${worksheets}
</Workbook>`;
}

function exportAuditToExcel(report, options = {}) {
  const outputDir = options.outputDir || path.join(process.cwd(), 'backend', 'reports');
  const fileName =
    options.fileName ||
    `seo-audit-${new Date().toISOString().replace(/[:.]/g, '-')}.xml`;
  const filePath = path.join(outputDir, fileName);

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(filePath, buildWorkbookXml(report), 'utf8');

  return filePath;
}

module.exports = exportAuditToExcel;

const path = require('path');
const exportAuditToExcel = require('./excelExporter');
const {
  exportRawEvidence,
  getRawExportFormat,
  getRawExportSplitByPageType,
  buildRawEvidenceRecord
} = require('./rawEvidenceExporter');
const { exportRawSchemaByType } = require('./rawSchemaByTypeExporter');

function getExportMode(value = process.env.EXPORT_MODE) {
  return String(value || '').trim().toLowerCase();
}

function exportAuditArtifacts(report, options = {}) {
  const outputDir =
    options.outputDir || path.join(__dirname, '..', '..', 'reports');
  const rawFormat = getRawExportFormat(options.rawFormat);
  const exportMode = getExportMode(options.exportMode);
  const splitByPageType =
    options.splitByPageType ?? getRawExportSplitByPageType();
  const rawEvidenceExport = exportRawEvidence(report, {
    outputDir,
    format: rawFormat,
    splitByPageType
  });
  const excelPath = exportAuditToExcel(report, { outputDir });
  const rawSchemaByTypeExport =
    exportMode === 'raw_schema_by_type'
      ? exportRawSchemaByType(report, { outputDir })
      : null;
  const sampleSummaryRow = report.pages?.length
    ? buildRawEvidenceRecord(report.pages[0], 0)
    : null;

  return {
    outputDir,
    excelSummaryPath: excelPath,
    rawEvidencePath: rawEvidenceExport.filePath,
    rawEvidenceFormat: rawEvidenceExport.format,
    rawEvidencePageTypeFiles: rawEvidenceExport.pageTypeFiles,
    sampleRawEvidenceRecord: rawEvidenceExport.sampleRecord,
    exportMode,
    rawSchemaByTypePath: rawSchemaByTypeExport?.filePath || '',
    rawSchemaByTypeSamples: rawSchemaByTypeExport?.samples || {},
    sampleExcelSummaryRow: sampleSummaryRow
      ? [
          sampleSummaryRow.url,
          sampleSummaryRow.pageType,
          sampleSummaryRow.canonical,
          sampleSummaryRow.schemaTypes.join(', '),
          sampleSummaryRow.flags.hasProduct ? 'Yes' : 'No',
          sampleSummaryRow.flags.hasProductGroup ? 'Yes' : 'No',
          sampleSummaryRow.flags.hasOffer ? 'Yes' : 'No',
          sampleSummaryRow.flags.hasBreadcrumbList ? 'Yes' : 'No',
          sampleSummaryRow.flags.hasCollectionPage ? 'Yes' : 'No',
          sampleSummaryRow.flags.hasArticleOrBlogPosting ? 'Yes' : 'No',
          sampleSummaryRow.counts.schemaPriceCount,
          sampleSummaryRow.counts.visiblePriceCandidateCount,
          sampleSummaryRow.counts.rawShopifyPriceCandidateCount,
          sampleSummaryRow.counts.availabilityCandidateCount,
          sampleSummaryRow.counts.breadcrumbUiCandidateCount,
          sampleSummaryRow.counts.parseErrorCount,
          sampleSummaryRow.id
        ]
      : null
  };
}

exportAuditArtifacts.getExportMode = getExportMode;

module.exports = exportAuditArtifacts;

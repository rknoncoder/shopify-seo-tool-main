const startCrawler = require('./index');
const analyzeSEO = require('./analyzers/seoAnalyzer');
const analyzeSitewideData = require('./analyzers/sitewideAnalyzer');
const exportAuditArtifacts = require('./exporters/reportExporter');
const { getAuditMode } = require('./utils/auditMode');

(async () => {
  const auditMode = getAuditMode();
  const crawlUrl = process.env.AUDIT_URL || 'https://nobero.com';
  const crawlResult = await startCrawler([], crawlUrl);
  const results = crawlResult.pages || [];
  const sitewideData = analyzeSitewideData(results);
  const analyzed = results.map(page => analyzeSEO(page, sitewideData));
  const report = {
    auditMode,
    summary: {
      ...crawlResult.summary,
      ...sitewideData.summary
    },
    pages: analyzed,
    duplicateTitles: sitewideData.duplicateTitles,
    duplicateMetaDescriptions: sitewideData.duplicateMetaDescriptions,
    duplicateContent: sitewideData.duplicateContent,
    structuredDataCoverage: sitewideData.structuredDataCoverage,
    structuredDataFindings: sitewideData.structuredDataFindings,
    canonicalIndexabilityConflicts:
      sitewideData.canonicalIndexabilityConflicts,
    shopifyCollectionProductDuplicates:
      sitewideData.shopifyCollectionProductDuplicates
  };

  report.structuredDataSeoReport = analyzed.map(page => ({
    url: page.url,
    auditMode: page.auditMode,
    rawEvidence: page.rawEvidence,
    schema: page.structuredDataReport.schema,
    schemaAudit: page.structuredDataReport.schemaAudit,
    detectedSchemas: page.structuredDataReport.detectedSchemas,
    detectedSchemaTypes: page.structuredDataReport.detectedSchemaTypes,
    expectedSchemaTypes: page.structuredDataReport.expectedSchemaTypes,
    missingSchemas: page.structuredDataReport.missingSchemas,
    missingRequiredSchema: page.structuredDataReport.missingRequiredSchema,
    missingRecommendedSchema: page.structuredDataReport.missingRecommendedSchema,
    unexpectedSchemaTypes: page.structuredDataReport.unexpectedSchemaTypes,
    schemaConflicts: page.structuredDataReport.schemaConflicts,
    richResultSummary: page.structuredDataReport.richResultSummary,
    schemaRecommendations: page.structuredDataReport.schemaRecommendations,
    generatedSchemaSamples: page.structuredDataReport.generatedSchemaSamples,
    schemaScoreBreakdown: page.structuredDataReport.schemaScoreBreakdown,
    schemaPrice: page.structuredDataReport.schemaPrice,
    visiblePrice: page.structuredDataReport.visiblePrice,
    visiblePriceSource: page.structuredDataReport.visiblePriceSource,
    rawShopifyPrice: page.structuredDataReport.rawShopifyPrice,
    priceMatchStatus: page.structuredDataReport.priceMatchStatus,
    priceUnitStatus: page.structuredDataReport.priceUnitStatus,
    priceDebugNote: page.structuredDataReport.priceDebugNote,
    schemaAvailability: page.structuredDataReport.schemaAvailability,
    visibleAvailability: page.structuredDataReport.visibleAvailability,
    availabilityMatchStatus: page.structuredDataReport.availabilityMatchStatus,
    schemaParseErrors: page.structuredDataReport.schemaParseErrors,
    productFieldValidation: page.structuredDataReport.productFieldValidation,
    qualityWarnings: page.structuredDataReport.qualityWarnings,
    breadcrumbConsistencyStatus:
      page.structuredDataReport.breadcrumbConsistencyStatus,
    breadcrumbConsistencyWarnings:
      page.structuredDataReport.breadcrumbConsistencyWarnings,
    reviewVisibilityStatus: page.structuredDataReport.reviewVisibilityStatus,
    ratingVisibilityStatus: page.structuredDataReport.ratingVisibilityStatus,
    selectedVariantId: page.structuredDataReport.selectedVariantId,
    selectedVariantPrice: page.structuredDataReport.selectedVariantPrice,
    selectedVariantAvailability:
      page.structuredDataReport.selectedVariantAvailability,
    consistencyWarnings: page.structuredDataReport.consistencyWarnings,
    confidence: page.structuredDataReport.confidence,
    issues: page.structuredDataReport.issues,
    missingStructuredData: page.structuredDataReport.missingStructuredData,
    recommendations: page.structuredDataReport.recommendations
  }));

  const artifacts = exportAuditArtifacts(report);

  console.log('\nSEO AUDIT RESULTS:\n');
  console.log(`Excel summary saved to: ${artifacts.excelSummaryPath}`);
  console.log(`Raw evidence (${artifacts.rawEvidenceFormat}) saved to: ${artifacts.rawEvidencePath}`);
  if (artifacts.rawSchemaByTypePath) {
    console.log(`Raw schema by type report saved to: ${artifacts.rawSchemaByTypePath}`);
  }
  if (Object.keys(artifacts.rawEvidencePageTypeFiles || {}).length > 0) {
    console.log('Page-type raw evidence files:');
    Object.entries(artifacts.rawEvidencePageTypeFiles).forEach(
      ([pageType, filePath]) => {
        console.log(`- ${pageType}: ${filePath}`);
      }
    );
  }
  console.log(
    JSON.stringify(
      {
        auditMode,
        summary: report.summary
      },
      null,
      2
    )
  );
})();

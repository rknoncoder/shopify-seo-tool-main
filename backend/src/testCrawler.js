const startCrawler = require('./index');
const analyzeSEO = require('./analyzers/seoAnalyzer');
const analyzeSitewideData = require('./analyzers/sitewideAnalyzer');
const exportAuditToExcel = require('./exporters/excelExporter');

(async () => {
  const crawlUrl = process.env.AUDIT_URL || 'https://www.nobero.com';
  const crawlResult = await startCrawler([], crawlUrl);
  const results = crawlResult.pages || [];
  const sitewideData = analyzeSitewideData(results);
  const analyzed = results.map(page => analyzeSEO(page, sitewideData));
  const report = {
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
    consistencyWarnings: page.structuredDataReport.consistencyWarnings,
    confidence: page.structuredDataReport.confidence,
    issues: page.structuredDataReport.issues,
    missingStructuredData: page.structuredDataReport.missingStructuredData,
    recommendations: page.structuredDataReport.recommendations
  }));

  const excelPath = exportAuditToExcel(report);

  console.log('\nSEO AUDIT RESULTS:\n');
  console.log(`Excel report saved to: ${excelPath}`);
  console.log(JSON.stringify(report, null, 2));
})();

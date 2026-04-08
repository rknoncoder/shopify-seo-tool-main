const ShopifyCrawler = require('./crawlers/shopifyCrawler');
const analyzeSEO = require('./analyzers/seoAnalyzer');
const analyzeSitewideData = require('./analyzers/sitewideAnalyzer');
const exportAuditToExcel = require('./exporters/excelExporter');

(async () => {
  const crawlUrl = process.env.AUDIT_URL || 'https://triprindia.com';
  const crawler = new ShopifyCrawler(crawlUrl);
  const results = await crawler.start();
  const sitewideData = analyzeSitewideData(results);
  const analyzed = results.map(page => analyzeSEO(page, sitewideData));
  const report = {
    summary: sitewideData.summary,
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
    detectedSchemas: page.structuredDataReport.detectedSchemas,
    missingSchemas: page.structuredDataReport.missingSchemas,
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

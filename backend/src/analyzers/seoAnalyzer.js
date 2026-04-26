const { parseIssues } = require('../utils/issueParser');
const { isRawAuditMode } = require('../utils/auditMode');

function analyzeSEO(page, sitewideData = {}) {
  const rawIssues = [];
  const duplicateFindings = sitewideData.pageDuplicates?.get(page.url) || [];
  const canonicalFindings =
    sitewideData.pageCanonicalConflicts?.get(page.url) || [];
  const shopifyDuplicateFindings =
    sitewideData.pageShopifyCollectionDuplicates?.get(page.url) || [];
  const structuredDataFindings =
    sitewideData.pageStructuredDataFindings?.get(page.url) || [];

  if (!page.title) {
    rawIssues.push('Missing title');
  } else if (page.title.length < 30 || page.title.length > 60) {
    rawIssues.push(`Warning: Title length issue (${page.title.length} chars)`);
  }

  if (!page.metaDescription) {
    rawIssues.push('Missing meta description');
  } else if (
    page.metaDescription.length < 70 ||
    page.metaDescription.length > 160
  ) {
    rawIssues.push(
      `Warning: Meta description length issue (${page.metaDescription.length} chars)`
    );
  }

  if (!page.h1) {
    rawIssues.push('Missing H1');
  }

  if (page.imagesWithoutAlt > 0) {
    rawIssues.push(`Warning: ${page.imagesWithoutAlt} images missing alt text`);
  }

  if (page.totalImages > 100) {
    rawIssues.push(`Warning: Too many images (${page.totalImages})`);
  }

  duplicateFindings.forEach(finding => {
    if (finding.type === 'title') {
      rawIssues.push(
        `Critical: Duplicate title shared with ${finding.urls.length} other page(s)`
      );
    }

    if (finding.type === 'metaDescription') {
      rawIssues.push(
        `Warning: Duplicate meta description shared with ${finding.urls.length} other page(s)`
      );
    }

    if (finding.type === 'content') {
      rawIssues.push(
        `Critical: Duplicate body content pattern shared with ${finding.urls.length} other page(s)`
      );
    }
  });

  canonicalFindings.forEach(finding => {
    const label =
      finding.severity === 'critical'
        ? 'Critical:'
        : finding.severity === 'high'
          ? 'High:'
          : 'Warning:';
    rawIssues.push(`${label} ${finding.message}`);
  });

  shopifyDuplicateFindings.forEach(finding => {
    const label = finding.severity === 'critical' ? 'Critical:' : 'Warning:';
    rawIssues.push(
      `${label} ${finding.message} (${finding.duplicateUrls.length} collection URL(s))`
    );
  });

  structuredDataFindings.forEach(finding => {
    if (finding.severity === 'info') {
      return;
    }

    const label =
      finding.severity === 'critical'
        ? 'Critical:'
        : finding.severity === 'high'
          ? 'High:'
          : 'Warning:';
    rawIssues.push(`${label} ${finding.message}`);
  });

  const issues = parseIssues(rawIssues.join(' | '));
  const collectionDuplicateIssues = shopifyDuplicateFindings.map(finding => ({
    type: 'collection_product_duplicate',
    severity: 'warning',
    message: finding.message,
    count: (finding.duplicateUrls || []).length
  }));
  const structuredDataReport = buildStructuredDataReport(
    page,
    structuredDataFindings
  );

  return {
    ...page,
    auditMode: structuredDataReport.auditMode,
    rawEvidence: structuredDataReport.rawEvidence,
    schema: structuredDataReport.schema,
    schemaAudit: structuredDataReport.schemaAudit,
    generatedSchemaSample: structuredDataReport.generatedSchemaSample,
    generatedSchemaSamples: structuredDataReport.generatedSchemaSamples,
    detectedSchemaTypes: structuredDataReport.detectedSchemaTypes,
    expectedSchemaTypes: structuredDataReport.expectedSchemaTypes,
    missingRequiredSchema: structuredDataReport.missingRequiredSchema,
    missingRecommendedSchema: structuredDataReport.missingRecommendedSchema,
    unexpectedSchemaTypes: structuredDataReport.unexpectedSchemaTypes,
    schemaConflicts: structuredDataReport.schemaConflicts,
    richResultSummary: structuredDataReport.richResultSummary,
    schemaRecommendations: structuredDataReport.schemaRecommendations,
    schemaScoreBreakdown: structuredDataReport.schemaScoreBreakdown,
    schemaPrice: structuredDataReport.schemaPrice,
    visiblePrice: structuredDataReport.visiblePrice,
    visiblePriceSource: structuredDataReport.visiblePriceSource,
    rawShopifyPrice: structuredDataReport.rawShopifyPrice,
    priceMatchStatus: structuredDataReport.priceMatchStatus,
    priceUnitStatus: structuredDataReport.priceUnitStatus,
    priceDebugNote: structuredDataReport.priceDebugNote,
    schemaAvailability: structuredDataReport.schemaAvailability,
    visibleAvailability: structuredDataReport.visibleAvailability,
    availabilityMatchStatus: structuredDataReport.availabilityMatchStatus,
    schemaParseErrors: structuredDataReport.schemaParseErrors,
    productFieldValidation: structuredDataReport.productFieldValidation,
    qualityWarnings: structuredDataReport.qualityWarnings,
    breadcrumbConsistencyStatus:
      structuredDataReport.breadcrumbConsistencyStatus,
    breadcrumbConsistencyWarnings:
      structuredDataReport.breadcrumbConsistencyWarnings,
    reviewVisibilityStatus: structuredDataReport.reviewVisibilityStatus,
    ratingVisibilityStatus: structuredDataReport.ratingVisibilityStatus,
    selectedVariantId: structuredDataReport.selectedVariantId,
    selectedVariantPrice: structuredDataReport.selectedVariantPrice,
    selectedVariantAvailability:
      structuredDataReport.selectedVariantAvailability,
    consistencyWarnings: structuredDataReport.consistencyWarnings,
    issues: [...issues, ...collectionDuplicateIssues],
    duplicates: duplicateFindings,
    canonicalConflicts: canonicalFindings,
    shopifyCollectionDuplicates: shopifyDuplicateFindings,
    structuredDataFindings,
    structuredDataReport,
    score: calculateScore(issues),
    rawIssues
  };
}

function parseSchemaFromLegacyFound(found = []) {
  const legacyItems = Array.isArray(found) ? found : [];
  const detected = new Set();
  let count;
  let confidence;

  legacyItems.forEach(item => {
    const text = String(item || '').trim();

    const countMatch = text.match(/structured data found with\s+(\d+)\s+item/i);
    if (countMatch) {
      count = Number(countMatch[1]);
    }

    const typeMatch = text.match(/^schema types:\s*(.+)$/i);
    if (typeMatch) {
      typeMatch[1]
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
        .forEach(value => detected.add(value));
    }

    const confidenceMatch = text.match(/^confidence level:\s*(.+)$/i);
    if (confidenceMatch) {
      confidence = confidenceMatch[1].trim().toLowerCase();
    }
  });

  return {
    detected: Array.from(detected),
    count,
    confidence
  };
}

function buildSchemaSummary(page) {
  const structuredData = page.structuredData || {};
  const legacy = parseSchemaFromLegacyFound(structuredData.structuredDataFound);
  const detected = structuredData.schemaTypes || legacy.detected || [];
  const count = structuredData.totalDetectedItems ?? legacy.count ?? 0;
  const confidence = structuredData.confidence || legacy.confidence || 'low';

  return {
    detected,
    count,
    confidence
  };
}

function buildStructuredDataReport(page, findings) {
  const structuredData = page.structuredData || {};
  const rawMode = isRawAuditMode();
  const missing = [];
  const recommendations = [];
  const schema = buildSchemaSummary(page);
  const missingSchemas = structuredData.missingSchemas || [];
  const schemaAudit = structuredData.schemaAudit || { rows: [] };

  findings.forEach(finding => {
    if (finding.type.startsWith('missing')) {
      missing.push(finding.message);
    }

    if (finding.recommendation) {
      recommendations.push(finding.recommendation);
    }
  });

  if (!rawMode && !structuredData.hasStructuredData) {
    recommendations.push(
      'Add valid JSON-LD markup for the primary page type and key business entities.'
    );
  }

  if (!rawMode) (structuredData.recommendations || []).forEach(recommendation => {
    recommendations.push(recommendation);
  });

  if (!rawMode) (schemaAudit.rows || []).forEach(row => {
    if (row.status === 'Warning' || row.status === 'Error') {
      recommendations.push(row.recommendation);
    }
  });

  if (!rawMode) (structuredData.schemaRecommendations || []).forEach(recommendation => {
    const text = [
      recommendation.priority ? `[${recommendation.priority}]` : '',
      recommendation.issue,
      recommendation.howToFix
    ]
      .filter(Boolean)
      .join(' ');

    if (text) {
      recommendations.push(text);
    }
  });

  return {
    schema,
    auditMode: structuredData.auditMode || (rawMode ? 'raw' : 'evaluated'),
    rawEvidence: structuredData.rawEvidence || {},
    schemaAudit,
    generatedSchemaSample: structuredData.generatedSchemaSample || '',
    generatedSchemaSamples: structuredData.generatedSchemaSamples || {},
    detectedSchemas: schema.detected,
    detectedSchemaTypes:
      structuredData.detectedSchemaTypes || schema.detected || [],
    expectedSchemaTypes: structuredData.expectedSchemaTypes || [],
    missingSchemas,
    missingRequiredSchema: structuredData.missingRequiredSchema || [],
    missingRecommendedSchema:
      structuredData.missingRecommendedSchema || [],
    unexpectedSchemaTypes: structuredData.unexpectedSchemaTypes || [],
    schemaConflicts: structuredData.schemaConflicts || [],
    richResultSummary: structuredData.richResultSummary || {},
    schemaRecommendations: structuredData.schemaRecommendations || [],
    schemaScoreBreakdown: structuredData.schemaScoreBreakdown || {},
    schemaPrice: structuredData.schemaPrice || '',
    visiblePrice: structuredData.visiblePrice || '',
    visiblePriceSource: structuredData.visiblePriceSource || '',
    rawShopifyPrice: structuredData.rawShopifyPrice || '',
    priceMatchStatus: structuredData.priceMatchStatus || '',
    priceUnitStatus: structuredData.priceUnitStatus || '',
    priceDebugNote: structuredData.priceDebugNote || '',
    schemaAvailability: structuredData.schemaAvailability || '',
    visibleAvailability: structuredData.visibleAvailability || '',
    availabilityMatchStatus: structuredData.availabilityMatchStatus || '',
    schemaParseErrors:
      structuredData.schemaParseErrors || structuredData.jsonLdErrors || [],
    productFieldValidation: structuredData.productFieldValidation || {},
    qualityWarnings: structuredData.qualityWarnings || [],
    breadcrumbConsistencyStatus:
      structuredData.breadcrumbConsistencyStatus || '',
    breadcrumbConsistencyWarnings:
      structuredData.breadcrumbConsistencyWarnings || [],
    reviewVisibilityStatus: structuredData.reviewVisibilityStatus || '',
    ratingVisibilityStatus: structuredData.ratingVisibilityStatus || '',
    selectedVariantId: structuredData.selectedVariantId || '',
    selectedVariantPrice: structuredData.selectedVariantPrice || '',
    selectedVariantAvailability:
      structuredData.selectedVariantAvailability || '',
    consistencyWarnings: structuredData.consistencyWarnings || [],
    confidence: schema.confidence,
    issues: structuredData.issues || [],
    missingStructuredData: missing,
    recommendations: rawMode ? [] : Array.from(new Set(recommendations))
  };
}

function calculateScore(issues) {
  let score = 100;

  issues.forEach(issue => {
    if (issue.severity === 'critical') {
      score -= 20;
    }

    if (issue.severity === 'high') {
      score -= 15;
    }

    if (issue.severity === 'warning') {
      score -= 10;
    }
  });

  return score < 0 ? 0 : score;
}

module.exports = analyzeSEO;

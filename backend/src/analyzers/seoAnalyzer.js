function analyzeSEO(page, sitewideData = {}) {
  const issues = [];
  const duplicateFindings = sitewideData.pageDuplicates?.get(page.url) || [];
  const variantDuplicationFindings =
    sitewideData.pageVariantDuplications?.get(page.url) || [];
  const canonicalFindings =
    sitewideData.pageCanonicalConflicts?.get(page.url) || [];
  const shopifyDuplicateFindings =
    sitewideData.pageShopifyCollectionDuplicates?.get(page.url) || [];
  const structuredDataFindings =
    sitewideData.pageStructuredDataFindings?.get(page.url) || [];

  if (!page.title) {
    issues.push('Missing title');
  } else if (page.title.length < 30 || page.title.length > 60) {
    issues.push(`Warning: Title length issue (${page.title.length} chars)`);
  }

  if (!page.metaDescription) {
    issues.push('Missing meta description');
  } else if (
    page.metaDescription.length < 70 ||
    page.metaDescription.length > 160
  ) {
    issues.push(
      `Warning: Meta description length issue (${page.metaDescription.length} chars)`
    );
  }

  if (!page.h1) {
    issues.push('Missing H1');
  }

  if (page.imagesWithoutAlt > 0) {
    issues.push(`Warning: ${page.imagesWithoutAlt} images missing alt text`);
  }

  if (page.totalImages > 100) {
    issues.push(`Warning: Too many images (${page.totalImages})`);
  }

  duplicateFindings.forEach(finding => {
    if (finding.type === 'title') {
      issues.push(
        `Critical: Duplicate title shared with ${finding.urls.length} other page(s)`
      );
    }

    if (finding.type === 'metaDescription') {
      issues.push(
        `Warning: Duplicate meta description shared with ${finding.urls.length} other page(s)`
      );
    }

    if (finding.type === 'content') {
      issues.push(
        `Critical: Duplicate body content pattern shared with ${finding.urls.length} other page(s)`
      );
    }
  });

  variantDuplicationFindings.forEach(finding => {
    const label = finding.severity === 'HIGH' ? 'High:' : 'Warning:';
    issues.push(
      `${label} Variant duplication detected across ${finding.urlCount} URL(s) for canonical ${finding.canonical || page.url}. ${finding.reason}`
    );
  });

  canonicalFindings.forEach(finding => {
    const label = finding.severity === 'critical' ? 'Critical:' : 'Warning:';
    issues.push(`${label} ${finding.message}`);
  });

  shopifyDuplicateFindings.forEach(finding => {
    const label = finding.severity === 'critical' ? 'Critical:' : 'Warning:';
    issues.push(
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
    issues.push(`${label} ${finding.message}`);
  });

  const structuredDataReport = buildStructuredDataReport(
    page,
    structuredDataFindings
  );

  return {
    ...page,
    issues,
    duplicates: duplicateFindings,
    variantDuplications: variantDuplicationFindings,
    canonicalConflicts: canonicalFindings,
    shopifyCollectionDuplicates: shopifyDuplicateFindings,
    structuredDataFindings,
    structuredDataReport,
    score: calculateScore(issues)
  };
}

function buildStructuredDataReport(page, findings) {
  const structuredData = page.structuredData || {};
  const found = [];
  const missing = [];
  const recommendations = [];
  const detectedSchemas = structuredData.schemaTypes || [];
  const missingSchemas = structuredData.missingSchemas || [];

  if (structuredData.hasStructuredData) {
    found.push(
      `Structured data found with ${structuredData.totalDetectedItems || 0} item(s)`
    );
  }

  if (detectedSchemas.length > 0) {
    found.push(`Schema types: ${detectedSchemas.join(', ')}`);
  }

  if (structuredData.breadcrumbUiPresent) {
    found.push('Visible breadcrumb UI detected');
  }

  found.push(`Confidence level: ${structuredData.confidence || 'low'}`);

  findings.forEach(finding => {
    if (finding.type.startsWith('missing')) {
      missing.push(finding.message);
    }

    if (finding.recommendation) {
      recommendations.push(finding.recommendation);
    }
  });

  if (!structuredData.hasStructuredData) {
    recommendations.push(
      'Add valid JSON-LD markup for the primary page type and key business entities.'
    );
  }

  (structuredData.recommendations || []).forEach(recommendation => {
    recommendations.push(recommendation);
  });

  return {
    detectedSchemas,
    missingSchemas,
    confidence: structuredData.confidence || 'low',
    issues: structuredData.issues || [],
    structuredDataFound: found,
    missingStructuredData: missing,
    recommendations: Array.from(new Set(recommendations))
  };
}

function calculateScore(issues) {
  let score = 100;

  issues.forEach(issue => {
    if (issue.startsWith('Critical:') || issue.startsWith('Missing')) {
      score -= 20;
    }

    if (issue.startsWith('High:')) {
      score -= 15;
    }

    if (issue.startsWith('Warning:')) {
      score -= 10;
    }
  });

  return score < 0 ? 0 : score;
}

module.exports = analyzeSEO;

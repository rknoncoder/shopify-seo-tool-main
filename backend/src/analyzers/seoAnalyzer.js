const { parseIssues } = require('../utils/issueParser');

const BREADCRUMB_ISSUE_TYPES = new Set([
  'breadcrumb_schema_missing',
  'breadcrumb_ui_missing',
  'breadcrumb_missing',
  'breadcrumb_mismatch'
]);

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
    if (finding.severity === 'info' || BREADCRUMB_ISSUE_TYPES.has(finding.type)) {
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

  const structuredDataReport = buildStructuredDataReport(
    page,
    structuredDataFindings
  );
  const issues = mergeIssues(
    parseIssues(rawIssues.join(' | ')),
    structuredDataReport.issues || []
  );

  return {
    ...page,
    schema: structuredDataReport.schema,
    breadcrumb: structuredDataReport.breadcrumb,
    issues,
    duplicates: duplicateFindings,
    canonicalConflicts: canonicalFindings,
    shopifyCollectionDuplicates: shopifyDuplicateFindings,
    structuredDataFindings,
    structuredDataReport,
    score: calculateScore(issues),
    rawIssues
  };
}

function buildSchemaSummary(page) {
  const structuredData = page.structuredData || {};

  return {
    detected: structuredData.schemaTypes || [],
    count: structuredData.totalDetectedItems ?? 0,
    confidence: structuredData.confidence || 'low'
  };
}

function buildStructuredDataReport(page, findings) {
  const structuredData = page.structuredData || {};
  const missing = [];
  const recommendations = [];
  const schema = buildSchemaSummary(page);
  const missingSchemas = structuredData.missingSchemas || [];

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
    schema,
    breadcrumb: structuredData.breadcrumb || {
      ui_present: false,
      schema_present: false,
      ui_path: [],
      schema_path: []
    },
    detectedSchemas: schema.detected,
    missingSchemas,
    confidence: schema.confidence,
    issues: structuredData.issues || [],
    missingStructuredData: missing,
    recommendations: Array.from(new Set(recommendations))
  };
}

function mergeIssues(parsedIssues = [], structuredIssues = []) {
  const merged = [];
  const seen = new Set();

  [...parsedIssues, ...structuredIssues].forEach(issue => {
    if (!issue || !issue.message) {
      return;
    }

    const normalizedIssue = {
      type: issue.type || 'general_issue',
      severity: issue.severity || 'warning',
      message: issue.message,
      ...(issue.count !== undefined ? { count: issue.count } : {}),
      ...(issue.details ? { details: issue.details } : {})
    };
    const key = JSON.stringify({
      type: normalizedIssue.type,
      severity: normalizedIssue.severity,
      message: normalizedIssue.message,
      count: normalizedIssue.count,
      details: normalizedIssue.details || null
    });

    if (!seen.has(key)) {
      seen.add(key);
      merged.push(normalizedIssue);
    }
  });

  return merged;
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

const { buildCoverageMap } = require('../utils/schemaRules');
const { normalizeSchemaTypes } = require('../utils/schemaTypes');
const { isRawAuditMode } = require('../utils/auditMode');

function normalizeField(value) {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function buildDuplicateMap(pages, field) {
  const groups = new Map();
  pages.forEach(page => {
    const value = normalizeField(page[field]);
    if (!value) return;
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(page.url);
  });
  return Array.from(groups.entries())
    .filter(([, urls]) => urls.length > 1)
    .map(([value, urls]) => ({ value, urls }));
}

function buildContentGroups(pages) {
  const groups = new Map();
  pages.forEach(page => {
    const fingerprint = normalizeField(page.contentFingerprint);
    if (!fingerprint || (page.wordCount || 0) < 150) return;
    if (!groups.has(fingerprint)) groups.set(fingerprint, []);
    groups.get(fingerprint).push(page.url);
  });
  return Array.from(groups.entries())
    .filter(([, urls]) => urls.length > 1)
    .map(([fingerprint, urls]) => ({ fingerprint, urls }));
}

function indexDuplicates(groups, type, valueKey) {
  const index = new Map();
  groups.forEach(group => {
    group.urls.forEach(url => {
      const findings = index.get(url) || [];
      findings.push({
        type,
        matchValue: group[valueKey],
        urls: group.urls.filter(candidate => candidate !== url)
      });
      index.set(url, findings);
    });
  });
  return index;
}

function mergeIndexes(...indexes) {
  const merged = new Map();
  indexes.forEach(index => {
    index.forEach((findings, url) => {
      merged.set(url, [...(merged.get(url) || []), ...findings]);
    });
  });
  return merged;
}

function buildPageMap(pages) {
  return new Map(pages.map(page => [page.url, page]));
}

function appendFinding(index, url, finding) {
  if (!index.has(url)) index.set(url, []);
  index.get(url).push(finding);
}

function createCanonicalFinding(page, details) {
  return {
    url: page.url,
    canonical: page.canonical || '',
    canonicalTarget: page.canonical || '',
    issueType: details.issueType,
    type: details.issueType,
    severity: details.severity,
    reason: details.reason,
    message: details.reason,
    finalTarget: details.finalTarget || '',
    statusCode: details.statusCode || ''
  };
}

function getCanonicalNextTarget(url, pageMap, inspectionMap) {
  if (pageMap.has(url)) {
    return pageMap.get(url).canonical || '';
  }

  return inspectionMap.get(url)?.canonical || '';
}

function analyzeCanonicalAndIndexability(pages) {
  const pageMap = buildPageMap(pages);
  const inspectionMap = new Map(
    pages
      .map(page => page.canonicalInspection)
      .filter(Boolean)
      .map(inspection => [inspection.url, inspection])
  );
  const pageConflicts = new Map();
  const conflicts = [];

  pages.forEach(page => {
    const canonicalTarget = page.canonical;

    if (!canonicalTarget) {
      const finding = createCanonicalFinding(page, {
        issueType: 'missingCanonical',
        severity: 'medium',
        reason: 'Missing canonical tag'
      });
      conflicts.push(finding);
      appendFinding(pageConflicts, page.url, finding);
      return;
    }

    if ((page.canonicalTagCount || 0) > 1) {
      const finding = createCanonicalFinding(page, {
        issueType: 'multipleCanonicalTags',
        severity: 'critical',
        reason: 'Multiple canonical tags found on the page'
      });
      conflicts.push(finding);
      appendFinding(pageConflicts, page.url, finding);
    }

    if (page.isNoindex) {
      const finding = createCanonicalFinding(page, {
        issueType: 'noindexCanonicalConflict',
        severity: 'critical',
        reason: 'Page is noindex but also declares a canonical URL'
      });
      conflicts.push(finding);
      appendFinding(pageConflicts, page.url, finding);
    }

    if (canonicalTarget === page.url) {
      return;
    }

    const inspection = page.canonicalInspection;
    if (inspection && inspection.status && inspection.status !== 200) {
      const finding = createCanonicalFinding(page, {
        issueType: 'brokenCanonical',
        severity: 'critical',
        reason: 'Canonical points to non-200 page',
        statusCode: inspection.status
      });
      conflicts.push(finding);
      appendFinding(pageConflicts, page.url, finding);
    }

    const targetPage = pageMap.get(canonicalTarget);
    const targetIsNoindex = Boolean(
      targetPage?.isNoindex || inspection?.isNoindex
    );
    const targetIsBlockedByRobots = Boolean(inspection?.isBlockedByRobots);

    if (targetIsNoindex || targetIsBlockedByRobots) {
      const finding = createCanonicalFinding(page, {
        issueType: 'canonicalToNonIndexable',
        severity: 'critical',
        reason: 'Canonical points to non-indexable page'
      });
      conflicts.push(finding);
      appendFinding(pageConflicts, page.url, finding);
    }

    const seen = new Set([page.url]);
    let currentTarget = canonicalTarget;
    let finalTarget = '';
    let loopDetected = false;

    while (currentTarget) {
      if (seen.has(currentTarget)) {
        loopDetected = true;
        finalTarget = currentTarget;
        break;
      }

      seen.add(currentTarget);
      const nextTarget = getCanonicalNextTarget(
        currentTarget,
        pageMap,
        inspectionMap
      );

      if (!nextTarget || nextTarget === currentTarget) {
        finalTarget = currentTarget;
        break;
      }

      currentTarget = nextTarget;
    }

    if (loopDetected) {
      const finding = createCanonicalFinding(page, {
        issueType: 'canonicalLoop',
        severity: 'high',
        reason: 'Canonical loop',
        finalTarget
      });
      conflicts.push(finding);
      appendFinding(pageConflicts, page.url, finding);
      return;
    }

    if (finalTarget && finalTarget !== canonicalTarget) {
      const finding = createCanonicalFinding(page, {
        issueType: 'canonicalChain',
        severity: 'high',
        reason: 'Canonical chain detected',
        finalTarget
      });
      conflicts.push(finding);
      appendFinding(pageConflicts, page.url, finding);
    }
  });

  return {
    canonicalIndexabilityConflicts: conflicts,
    pageCanonicalConflicts: pageConflicts
  };
}

function analyzeShopifyCollectionProductDuplicates(pages) {
  const findings = [];
  const pageFindings = new Map();
  pages.forEach(page => {
    const duplicateUrls =
      page.collectionProductDuplicateUrls || page.collectionProductUrls || [];
    if (page.pageType !== 'product' || duplicateUrls.length === 0) return;
    const finding = {
      type: 'collection_product_duplicate',
      severity: page.canonical && page.canonical !== page.url ? 'critical' : 'warning',
      message:
        page.canonical && page.canonical !== page.url
          ? 'Product is reachable through collection URLs but canonical does not point to the base product URL'
          : 'Product is reachable through collection-based duplicate URLs',
      productUrl: page.url,
      canonicalTarget: page.canonical || '',
      duplicateUrls
    };
    findings.push(finding);
    pageFindings.set(page.url, [finding]);
  });
  return {
    shopifyCollectionProductDuplicates: findings,
    pageShopifyCollectionDuplicates: pageFindings
  };
}

function getStructuredDataRecommendation(type) {
  const recommendationMap = {
    missingStructuredData:
      'Add baseline JSON-LD such as Organization, WebSite, and page-specific schema.',
    missingHomepageOrganizationSchema:
      'Add Organization schema on the homepage to define your brand identity and business details.',
    missingHomepageWebSiteSchema:
      'Add WebSite schema on the homepage to help search engines understand the site entity and search actions.',
    structuredDataParseError:
      'Fix invalid JSON-LD syntax so search engines can parse all schema blocks.',
    missingProductSchema:
      'Add Product schema with name, image, offers, availability, and aggregateRating when available.',
    missingArticleSchema:
      'Add Article or BlogPosting schema with headline, author, datePublished, and image.',
    missingBreadcrumbSchema:
      'Add BreadcrumbList schema to help search engines understand page hierarchy.',
    breadcrumb_schema_missing:
      'Add BreadcrumbList schema to match visible breadcrumb navigation and help search engines understand page hierarchy.',
    breadcrumb_ui_missing:
      'Render breadcrumb navigation in the page UI so users and search engines see the same hierarchy.',
    breadcrumb_missing:
      'Add breadcrumb navigation in the UI and BreadcrumbList schema to clarify page hierarchy.',
    breadcrumb_mismatch:
      'Align breadcrumb schema names with the visible breadcrumb UI so search engines and users see the same hierarchy.'
  };
  return recommendationMap[type] || '';
}

function appendStructuredDataFinding(index, page, finding, findings) {
  findings.push({ url: page.url, pageType: page.pageType, ...finding });
  appendFinding(index, page.url, finding);
}

function analyzeStructuredData(pages) {
  const findings = [];
  const pageFindings = new Map();
  const coverageByType = buildCoverageMap();
  const rawMode = isRawAuditMode();

  pages.forEach(page => {
    const structuredData = page.structuredData || {};
    const schemaTypes = normalizeSchemaTypes([
      ...(structuredData.schemaTypes || []),
      ...(structuredData.detectedSchemaTypes || [])
    ]);
    const schemaTypeSet = new Set(schemaTypes);
    const jsonLdErrors = structuredData.jsonLdErrors || [];

    schemaTypes.forEach(type => {
      if (coverageByType[type] !== undefined) coverageByType[type] += 1;
    });

    if (!rawMode && !structuredData.hasStructuredData) {
      appendStructuredDataFinding(pageFindings, page, {
        type: 'missingStructuredData',
        severity: 'warning',
        message: 'No structured data detected on the page',
        recommendation: getStructuredDataRecommendation('missingStructuredData')
      }, findings);
    }

    if (!rawMode && jsonLdErrors.length > 0) {
      appendStructuredDataFinding(pageFindings, page, {
        type: 'structuredDataParseError',
        severity: 'critical',
        message: `JSON-LD parsing failed in ${jsonLdErrors.length} block(s)`,
        errorCount: jsonLdErrors.length,
        recommendation: getStructuredDataRecommendation('structuredDataParseError')
      }, findings);
    }

    if (!rawMode) (structuredData.issues || []).forEach(issue => {
      appendStructuredDataFinding(pageFindings, page, {
        type: issue.type,
        severity: issue.severity,
        message: issue.message,
        details: issue.details || {},
        recommendation: issue.recommendation || getStructuredDataRecommendation(issue.type)
      }, findings);
    });

    if (!rawMode && page.url && /^(https?:\/\/[^/]+)\/?$/.test(page.url)) {
      if (!schemaTypeSet.has('Organization')) {
        appendStructuredDataFinding(pageFindings, page, {
          type: 'missingHomepageOrganizationSchema',
          severity: 'warning',
          message: 'Homepage is missing Organization schema',
          recommendation: getStructuredDataRecommendation('missingHomepageOrganizationSchema')
        }, findings);
      }

      if (!schemaTypeSet.has('WebSite')) {
        appendStructuredDataFinding(pageFindings, page, {
          type: 'missingHomepageWebSiteSchema',
          severity: 'warning',
          message: 'Homepage is missing WebSite schema',
          recommendation: getStructuredDataRecommendation('missingHomepageWebSiteSchema')
        }, findings);
      }
    }

    if (!rawMode && page.pageType === 'product' && !schemaTypeSet.has('Product') && !schemaTypeSet.has('ProductGroup')) {
      appendStructuredDataFinding(pageFindings, page, {
        type: 'missingProductSchema',
        severity: 'critical',
        message: 'Product page is missing Product schema',
        recommendation: getStructuredDataRecommendation('missingProductSchema')
      }, findings);
    }

    if (!rawMode && page.pageType === 'blog' && !schemaTypeSet.has('Article') && !schemaTypeSet.has('BlogPosting')) {
      appendStructuredDataFinding(pageFindings, page, {
        type: 'missingArticleSchema',
        severity: 'warning',
        message: 'Blog page is missing Article or BlogPosting schema',
        recommendation: getStructuredDataRecommendation('missingArticleSchema')
      }, findings);
    }
  });

  return {
    structuredDataCoverage: coverageByType,
    structuredDataFindings: findings,
    structuredDataDetectedPages: pages.filter(page => page.structuredData?.hasStructuredData).length,
    structuredDataItemCount: pages.reduce((total, page) => total + (page.structuredData?.totalDetectedItems || 0), 0),
    pageStructuredDataFindings: pageFindings
  };
}

function analyzeSitewideData(pages) {
  const duplicateTitles = buildDuplicateMap(pages, 'title');
  const duplicateMetaDescriptions = buildDuplicateMap(pages, 'metaDescription');
  const duplicateContent = buildContentGroups(pages);
  const canonicalData = analyzeCanonicalAndIndexability(pages);
  const shopifyDuplicateData = analyzeShopifyCollectionProductDuplicates(pages);
  const structuredDataAnalysis = analyzeStructuredData(pages);

  return {
    summary: {
      duplicateTitleGroups: duplicateTitles.length,
      duplicateMetaDescriptionGroups: duplicateMetaDescriptions.length,
      duplicateContentGroups: duplicateContent.length,
      canonicalIndexabilityConflicts: canonicalData.canonicalIndexabilityConflicts.length,
      shopifyCollectionProductDuplicateGroups: shopifyDuplicateData.shopifyCollectionProductDuplicates.length,
      structuredDataIssues: structuredDataAnalysis.structuredDataFindings.length,
      structuredDataDetectedPages: structuredDataAnalysis.structuredDataDetectedPages,
      structuredDataItemCount: structuredDataAnalysis.structuredDataItemCount
    },
    duplicateTitles,
    duplicateMetaDescriptions,
    duplicateContent,
    structuredDataCoverage: structuredDataAnalysis.structuredDataCoverage,
    structuredDataFindings: structuredDataAnalysis.structuredDataFindings,
    canonicalIndexabilityConflicts: canonicalData.canonicalIndexabilityConflicts,
    shopifyCollectionProductDuplicates: shopifyDuplicateData.shopifyCollectionProductDuplicates,
    pageDuplicates: mergeIndexes(
      indexDuplicates(duplicateTitles, 'title', 'value'),
      indexDuplicates(duplicateMetaDescriptions, 'metaDescription', 'value'),
      indexDuplicates(duplicateContent, 'content', 'fingerprint')
    ),
    pageCanonicalConflicts: canonicalData.pageCanonicalConflicts,
    pageShopifyCollectionDuplicates: shopifyDuplicateData.pageShopifyCollectionDuplicates,
    pageStructuredDataFindings: structuredDataAnalysis.pageStructuredDataFindings
  };
}

module.exports = analyzeSitewideData;

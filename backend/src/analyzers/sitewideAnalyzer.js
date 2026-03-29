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

function normalizeProductIdentifier(value) {
  return normalizeField(value)
    .replace(/[-_\s]+copy\b/g, ' ')
    .replace(/[-_\s]+\d+\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractProductHandle(url) {
  const match = (url || '').match(/\/products\/([^/?#]+)/i);
  return match ? match[1] : '';
}

function hasShopifyDuplicateHandlePattern(url) {
  const handle = extractProductHandle(url);
  return /(?:-\d+|-copy)$/i.test(handle);
}

function getVariantDuplicationGroupKey(page) {
  if (page.canonical) {
    return {
      key: normalizeField(page.canonical),
      canonical: page.canonical,
      reason: 'Multiple URLs share same canonical',
      groupedBy: 'canonical'
    };
  }

  const normalizedHandle = normalizeProductIdentifier(extractProductHandle(page.url));
  if (!normalizedHandle) {
    return null;
  }

  return {
    key: normalizedHandle,
    canonical: '',
    reason: 'Canonical missing; grouped by normalized URL handle',
    groupedBy: 'normalizedHandle'
  };
}

function analyzeVariantDuplications(pages) {
  const groups = new Map();
  const pageFindings = new Map();

  pages.forEach(page => {
    if (page.pageType !== 'product') {
      return;
    }

    const groupKey = getVariantDuplicationGroupKey(page);
    if (!groupKey) {
      return;
    }

    if (!groups.has(groupKey.key)) {
      groups.set(groupKey.key, {
        canonical: groupKey.canonical,
        groupedBy: groupKey.groupedBy,
        reason: groupKey.reason,
        urls: new Set()
      });
    }

    const group = groups.get(groupKey.key);
    group.urls.add(page.url);

    if (!group.canonical && groupKey.canonical) {
      group.canonical = groupKey.canonical;
    }
  });

  const findings = Array.from(groups.entries())
    .map(([, group]) => {
      const urlList = Array.from(group.urls).sort();
      return {
        canonical: group.canonical || urlList[0] || '',
        urls: urlList,
        urlCount: urlList.length,
        groupedBy: group.groupedBy,
        reason: group.groupedBy === 'canonical'
          ? 'Multiple URLs share same canonical'
          : group.reason,
        hasPatternMatch: urlList.some(url => hasShopifyDuplicateHandlePattern(url))
      };
    })
    .filter(group => group.urlCount > 1)
    .map(group => ({
      ...group,
      issue: 'Multiple URLs for same product',
      severity: group.urlCount >= 5 ? 'HIGH' : 'MEDIUM',
      recommendations: [
        'Use canonical to main product URL',
        'Avoid duplicate product handles',
        'Consolidate variants under one product'
      ]
    }));

  findings.forEach(finding => {
    finding.urls.forEach(url => {
      pageFindings.set(url, [
        {
          type: 'variantDuplication',
          canonical: finding.canonical,
          urls: finding.urls.filter(candidate => candidate !== url),
          urlCount: finding.urlCount,
          groupedBy: finding.groupedBy,
          reason: finding.reason,
          hasPatternMatch: finding.hasPatternMatch,
          severity: finding.severity,
          issue: finding.issue,
          recommendations: finding.recommendations
        }
      ]);
    });
  });

  return {
    variantDuplications: findings,
    pageVariantDuplications: pageFindings
  };
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

function analyzeCanonicalAndIndexability(pages) {
  const pageMap = buildPageMap(pages);
  const pageConflicts = new Map();
  const conflicts = [];

  pages.forEach(page => {
    const canonicalTarget = page.canonical;
    if (!canonicalTarget) return;

    if (page.isNoindex) {
      const finding = {
        type: 'noindexCanonicalConflict',
        severity: 'critical',
        message: 'Page is noindex but also declares a canonical URL',
        canonicalTarget
      };
      conflicts.push({ url: page.url, ...finding });
      appendFinding(pageConflicts, page.url, finding);
    }

    if (canonicalTarget !== page.url) {
      const targetPage = pageMap.get(canonicalTarget);
      if (!targetPage) {
        const finding = {
          type: 'canonicalTargetMissing',
          severity: 'critical',
          message: 'Canonical points to a URL that was not crawled',
          canonicalTarget
        };
        conflicts.push({ url: page.url, ...finding });
        appendFinding(pageConflicts, page.url, finding);
        return;
      }

      if (targetPage.isNoindex) {
        const finding = {
          type: 'canonicalToNoindex',
          severity: 'critical',
          message: 'Canonical points to a page marked noindex',
          canonicalTarget
        };
        conflicts.push({ url: page.url, ...finding });
        appendFinding(pageConflicts, page.url, finding);
      }

      if (targetPage.canonical && targetPage.canonical !== canonicalTarget) {
        const finding = {
          type: 'canonicalChain',
          severity: 'warning',
          message: 'Canonical target points somewhere else, creating a canonical chain',
          canonicalTarget,
          finalTarget: targetPage.canonical
        };
        conflicts.push({ url: page.url, ...finding });
        appendFinding(pageConflicts, page.url, finding);
      }
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
    const duplicateUrls = page.collectionProductUrls || [];
    if (page.pageType !== 'product' || duplicateUrls.length === 0) return;
    const finding = {
      type: 'shopifyCollectionProductDuplicate',
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
    'breadcrumb-missing-schema':
      'Add BreadcrumbList schema to match visible breadcrumb navigation and help search engines understand page hierarchy.'
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
  const coverageByType = {
    Product: 0,
    ProductGroup: 0,
    BreadcrumbList: 0,
    ItemList: 0,
    Article: 0,
    BlogPosting: 0,
    FAQPage: 0,
    Organization: 0,
    WebSite: 0
  };

  pages.forEach(page => {
    const structuredData = page.structuredData || {};
    const schemaTypes = structuredData.schemaTypes || [];
    const schemaTypeSet = new Set(schemaTypes);
    const jsonLdErrors = structuredData.jsonLdErrors || [];

    schemaTypes.forEach(type => {
      if (coverageByType[type] !== undefined) coverageByType[type] += 1;
    });

    if (!structuredData.hasStructuredData) {
      appendStructuredDataFinding(pageFindings, page, {
        type: 'missingStructuredData',
        severity: 'warning',
        message: 'No structured data detected on the page',
        recommendation: getStructuredDataRecommendation('missingStructuredData')
      }, findings);
    }

    if (jsonLdErrors.length > 0) {
      appendStructuredDataFinding(pageFindings, page, {
        type: 'structuredDataParseError',
        severity: 'critical',
        message: `JSON-LD parsing failed in ${jsonLdErrors.length} block(s)`,
        errorCount: jsonLdErrors.length,
        recommendation: getStructuredDataRecommendation('structuredDataParseError')
      }, findings);
    }

    (structuredData.issues || []).forEach(issue => {
      appendStructuredDataFinding(pageFindings, page, {
        type: issue.type,
        severity: issue.severity,
        message: issue.message,
        recommendation: getStructuredDataRecommendation(issue.type)
      }, findings);
    });

    if (page.url && /^(https?:\/\/[^/]+)\/?$/.test(page.url)) {
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

    if (page.pageType === 'product' && !schemaTypeSet.has('Product') && !schemaTypeSet.has('ProductGroup')) {
      appendStructuredDataFinding(pageFindings, page, {
        type: 'missingProductSchema',
        severity: 'critical',
        message: 'Product page is missing Product schema',
        recommendation: getStructuredDataRecommendation('missingProductSchema')
      }, findings);
    }

    if (page.pageType === 'blog' && !schemaTypeSet.has('Article') && !schemaTypeSet.has('BlogPosting')) {
      appendStructuredDataFinding(pageFindings, page, {
        type: 'missingArticleSchema',
        severity: 'warning',
        message: 'Blog page is missing Article or BlogPosting schema',
        recommendation: getStructuredDataRecommendation('missingArticleSchema')
      }, findings);
    }

    if ((page.pageType === 'product' || page.pageType === 'collection') &&
      !schemaTypeSet.has('BreadcrumbList') &&
      !(structuredData.issues || []).some(issue => issue.type === 'breadcrumb-missing-schema')) {
      appendStructuredDataFinding(pageFindings, page, {
        type: 'missingBreadcrumbSchema',
        severity: 'warning',
        message: 'Page is missing BreadcrumbList schema',
        recommendation: getStructuredDataRecommendation('missingBreadcrumbSchema')
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
  const variantDuplicationAnalysis = analyzeVariantDuplications(pages);
  const canonicalData = analyzeCanonicalAndIndexability(pages);
  const shopifyDuplicateData = analyzeShopifyCollectionProductDuplicates(pages);
  const structuredDataAnalysis = analyzeStructuredData(pages);

  return {
    summary: {
      duplicateTitleGroups: duplicateTitles.length,
      duplicateMetaDescriptionGroups: duplicateMetaDescriptions.length,
      duplicateContentGroups: duplicateContent.length,
      variantDuplicationGroups: variantDuplicationAnalysis.variantDuplications.length,
      canonicalIndexabilityConflicts: canonicalData.canonicalIndexabilityConflicts.length,
      shopifyCollectionProductDuplicateGroups: shopifyDuplicateData.shopifyCollectionProductDuplicates.length,
      structuredDataIssues: structuredDataAnalysis.structuredDataFindings.length,
      structuredDataDetectedPages: structuredDataAnalysis.structuredDataDetectedPages,
      structuredDataItemCount: structuredDataAnalysis.structuredDataItemCount
    },
    duplicateTitles,
    duplicateMetaDescriptions,
    duplicateContent,
    variantDuplications: variantDuplicationAnalysis.variantDuplications,
    structuredDataCoverage: structuredDataAnalysis.structuredDataCoverage,
    structuredDataFindings: structuredDataAnalysis.structuredDataFindings,
    canonicalIndexabilityConflicts: canonicalData.canonicalIndexabilityConflicts,
    shopifyCollectionProductDuplicates: shopifyDuplicateData.shopifyCollectionProductDuplicates,
    pageDuplicates: mergeIndexes(
      indexDuplicates(duplicateTitles, 'title', 'value'),
      indexDuplicates(duplicateMetaDescriptions, 'metaDescription', 'value'),
      indexDuplicates(duplicateContent, 'content', 'fingerprint')
    ),
    pageVariantDuplications: variantDuplicationAnalysis.pageVariantDuplications,
    pageCanonicalConflicts: canonicalData.pageCanonicalConflicts,
    pageShopifyCollectionDuplicates: shopifyDuplicateData.pageShopifyCollectionDuplicates,
    pageStructuredDataFindings: structuredDataAnalysis.pageStructuredDataFindings
  };
}

module.exports = analyzeSitewideData;

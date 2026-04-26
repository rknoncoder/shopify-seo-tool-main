const SHOPIFY_PAGE_TYPE_ALIASES = {
  index: 'homepage',
  home: 'homepage',
  product: 'product',
  collection: 'collection',
  article: 'blog',
  blog: 'blog',
  page: 'page',
  search: 'search'
};

function normalizeDetectedPageType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SHOPIFY_PAGE_TYPE_ALIASES[normalized] || normalized || '';
}

function detectPageTypeFromUrl(url) {
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    const lowerPath = path.toLowerCase();

    if (lowerPath === '/') return 'homepage';
    if (
      lowerPath.startsWith('/products/') ||
      /\/collections\/[^/]+\/products\//.test(lowerPath)
    ) {
      return 'product';
    }
    if (lowerPath.startsWith('/collections/')) return 'collection';
    if (lowerPath.startsWith('/blogs/')) return 'blog';
    if (lowerPath.startsWith('/pages/')) return 'page';
    if (lowerPath === '/search' || lowerPath.startsWith('/search/')) {
      return 'search';
    }
  } catch (error) {
    return '';
  }

  return '';
}

function isRootUrl(url = '') {
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname.replace(/\/+$/, '') || '/';
    return path === '/';
  } catch (error) {
    return false;
  }
}

function detectPageTypeFromHtml($, html = '', url = '') {
  const urlType = detectPageTypeFromUrl(url);
  if (urlType && urlType !== 'homepage') {
    return urlType;
  }

  const bodyClass = $('body').attr('class') || '';
  const templateClass = $('[class*="template-"]')
    .map((_, element) => $(element).attr('class') || '')
    .get()
    .join(' ');
  const classSource = `${bodyClass} ${templateClass}`.toLowerCase();

  const classMatches = [
    { pattern: /template-(index|home)\b/, type: 'homepage' },
    { pattern: /template-product\b/, type: 'product' },
    { pattern: /template-collection\b/, type: 'collection' },
    { pattern: /template-(article|blog)\b/, type: 'blog' },
    { pattern: /template-page\b/, type: 'page' },
    { pattern: /template-search\b/, type: 'search' }
  ];
  const classMatch = classMatches.find(match => match.pattern.test(classSource));
  if (classMatch) {
    return classMatch.type;
  }

  const metaPageType =
    $('meta[property="og:type"]').attr('content') ||
    $('meta[name="page-type"]').attr('content') ||
    $('meta[name="template"]').attr('content') ||
    '';
  const normalizedMetaType = normalizeDetectedPageType(metaPageType);
  if (normalizedMetaType === 'product') return 'product';
  if (normalizedMetaType === 'article') return 'blog';
  if (normalizedMetaType === 'website' && isRootUrl(url)) return 'homepage';
  if (SHOPIFY_PAGE_TYPE_ALIASES[normalizedMetaType]) {
    return SHOPIFY_PAGE_TYPE_ALIASES[normalizedMetaType];
  }

  const shopifyPageTypeMatch = String(html || '').match(
    /ShopifyAnalytics\.meta[^<]*["']page(?:_|)type["']\s*:\s*["']([^"']+)["']/i
  );
  const analyticsType = normalizeDetectedPageType(shopifyPageTypeMatch?.[1]);
  if (analyticsType) {
    return analyticsType;
  }

  if ($('[data-product-json], [data-product-id], form[action*="/cart/add"]').length > 0) {
    return 'product';
  }

  if ($('[data-collection-id], [data-section-type*="collection" i]').length > 0) {
    return 'collection';
  }

  return '';
}

function detectShopifyPageType({ url = '', html = '', $ = null, fallback = '' }) {
  const urlType = detectPageTypeFromUrl(url);
  if (urlType && urlType !== 'homepage') {
    return urlType;
  }

  if ($) {
    const htmlType = detectPageTypeFromHtml($, html, url);
    if (htmlType) {
      return htmlType;
    }
  }

  const fallbackType = normalizeDetectedPageType(fallback);
  if (fallbackType && fallbackType !== 'other') {
    return fallbackType;
  }

  return urlType || 'webpage';
}

module.exports = {
  detectPageTypeFromUrl,
  detectPageTypeFromHtml,
  detectShopifyPageType,
  isRootUrl,
  normalizeDetectedPageType
};

function stripUrlDecorations(url) {
  return url.split('#')[0].split('?')[0].replace(/\/$/, '');
}

function getShopifyProductUrlInfo(url) {
  const cleanedUrl = stripUrlDecorations(url || '');
  const match = cleanedUrl.match(/^(https?:\/\/[^/]+)\/collections\/([^/]+)\/products\/([^/?#]+)/i);

  if (!match) {
    return {
      normalizedUrl: cleanedUrl,
      isCollectionProductUrl: false,
      collectionProductUrl: '',
      baseProductUrl: ''
    };
  }

  const [, origin, collectionHandle, productHandle] = match;
  const baseProductUrl = `${origin}/products/${productHandle}`;

  return {
    normalizedUrl: baseProductUrl,
    isCollectionProductUrl: true,
    collectionHandle,
    collectionProductUrl: cleanedUrl,
    baseProductUrl
  };
}

function normalizeUrl(url) {
  if (!url) {
    return '';
  }

  const productUrlInfo = getShopifyProductUrlInfo(url);

  if (productUrlInfo.isCollectionProductUrl) {
    return productUrlInfo.baseProductUrl;
  }

  return stripUrlDecorations(url);
}

normalizeUrl.getShopifyProductUrlInfo = getShopifyProductUrlInfo;
normalizeUrl.stripUrlDecorations = stripUrlDecorations;

module.exports = normalizeUrl;

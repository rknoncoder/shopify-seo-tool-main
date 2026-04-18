const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_URLS = Number.MAX_SAFE_INTEGER;

function classifySitemapType(sitemapUrl) {
  const normalized = String(sitemapUrl || '').toLowerCase();

  if (normalized.includes('post')) {
    return 'post';
  }

  if (normalized.includes('page')) {
    return 'page';
  }

  if (normalized.includes('product')) {
    return 'product';
  }

  if (normalized.includes('collection')) {
    return 'collection';
  }

  if (normalized.includes('blog')) {
    return 'blog';
  }

  return 'other';
}

function createHttpClient(timeout = DEFAULT_TIMEOUT_MS) {
  return axios.create({
    headers: {
      'User-Agent': 'Mozilla/5.0 (SEO Audit Bot)'
    },
    timeout,
    maxRedirects: 5,
    validateStatus: () => true
  });
}

function createXmlParser() {
  return new XMLParser({
    ignoreAttributes: false,
    trimValues: true
  });
}

async function fetchSitemap(sitemapUrl, options = {}) {
  const client = options.client || createHttpClient(options.timeout);

  try {
    const response = await client.get(sitemapUrl);

    if (!response || response.status >= 400 || typeof response.data !== 'string') {
      return {
        ok: false,
        url: sitemapUrl,
        error: `Failed to fetch sitemap (${response?.status || 'no response'})`
      };
    }

    return {
      ok: true,
      url: sitemapUrl,
      xml: response.data
    };
  } catch (error) {
    return {
      ok: false,
      url: sitemapUrl,
      error: error.code === 'ECONNABORTED' ? 'Sitemap request timed out' : error.message
    };
  }
}

function parseSitemap(xml, options = {}) {
  const parser = options.parser || createXmlParser();

  try {
    return {
      ok: true,
      parsed: parser.parse(xml)
    };
  } catch (error) {
    return {
      ok: false,
      error: `Invalid sitemap XML: ${error.message}`
    };
  }
}

function normalizeEntries(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function extractLocValues(entries) {
  return normalizeEntries(entries)
    .map(entry => String(entry?.loc || '').trim())
    .filter(Boolean);
}

function extractUrlsFromSitemap(parsedXml) {
  if (!parsedXml || typeof parsedXml !== 'object') {
    return {
      type: 'unknown',
      sitemapUrls: [],
      pageUrls: []
    };
  }

  if (parsedXml.sitemapindex) {
    return {
      type: 'sitemapindex',
      sitemapUrls: extractLocValues(parsedXml.sitemapindex.sitemap),
      pageUrls: []
    };
  }

  if (parsedXml.urlset) {
    return {
      type: 'urlset',
      sitemapUrls: [],
      pageUrls: extractLocValues(parsedXml.urlset.url)
    };
  }

  return {
    type: 'unknown',
    sitemapUrls: [],
    pageUrls: []
  };
}

async function expandSitemapRecursive(sitemapUrl, options = {}, state) {
  const runtimeState = state || {
    visitedSitemaps: new Set(),
    urls: new Set(),
    urlsBySitemap: new Map(),
    sitemapDetails: [],
    maxUrls: options.maxUrls || DEFAULT_MAX_URLS,
    client: options.client || createHttpClient(options.timeout),
    parser: options.parser || createXmlParser()
  };

  if (!sitemapUrl || runtimeState.visitedSitemaps.has(sitemapUrl)) {
    return runtimeState;
  }

  if (runtimeState.urls.size >= runtimeState.maxUrls) {
    return runtimeState;
  }

  runtimeState.visitedSitemaps.add(sitemapUrl);

  const sitemapResponse = await fetchSitemap(sitemapUrl, {
    client: runtimeState.client
  });

  if (!sitemapResponse.ok) {
    console.log(`[sitemap] ${sitemapResponse.error}: ${sitemapUrl}`);
    return runtimeState;
  }

  const parsedResponse = parseSitemap(sitemapResponse.xml, {
    parser: runtimeState.parser
  });

  if (!parsedResponse.ok) {
    console.log(`[sitemap] ${parsedResponse.error}: ${sitemapUrl}`);
    return runtimeState;
  }

  const extracted = extractUrlsFromSitemap(parsedResponse.parsed);

  if (extracted.type === 'urlset') {
    const sitemapUrls = [];

    extracted.pageUrls.forEach(url => {
      if (runtimeState.urls.size >= runtimeState.maxUrls) {
        return;
      }

      if (!runtimeState.urls.has(url)) {
        runtimeState.urls.add(url);
      }

      sitemapUrls.push(url);
    });

    runtimeState.urlsBySitemap.set(sitemapUrl, Array.from(new Set(sitemapUrls)));

    runtimeState.sitemapDetails.push({
      url: sitemapUrl,
      type: 'urlset',
      sitemapType: classifySitemapType(sitemapUrl),
      urlCount: runtimeState.urlsBySitemap.get(sitemapUrl).length
    });

    return runtimeState;
  }

  const detail = {
    url: sitemapUrl,
    type: extracted.type,
    sitemapType: classifySitemapType(sitemapUrl),
    urlCount: 0
  };
  runtimeState.sitemapDetails.push(detail);

  for (const nestedSitemapUrl of extracted.sitemapUrls) {
    if (runtimeState.urls.size >= runtimeState.maxUrls) {
      break;
    }

    const urlCountBeforeExpansion = runtimeState.urls.size;
    await expandSitemapRecursive(nestedSitemapUrl, options, runtimeState);
    detail.urlCount += runtimeState.urls.size - urlCountBeforeExpansion;
  }

  return runtimeState;
}

async function sitemapParser(sitemapUrl, options = {}) {
  const state = await expandSitemapRecursive(sitemapUrl, options);
  const allUrls = Array.from(state.urls);
  const sanitizedUrls = Array.from(
    new Set(
      allUrls.filter(url => {
        const lower = String(url || '').toLowerCase();
        return !lower.includes('?utm') && !lower.includes('?replytocom');
      })
    )
  );

  console.log(`Total URLs from all sitemaps: ${sanitizedUrls.length}`);

  return {
    urls: sanitizedUrls,
    total: sanitizedUrls.length,
    selectedTotal: sanitizedUrls.length,
    strategy: 'all',
    sitemaps: state.sitemapDetails
  };
}

module.exports = {
  classifySitemapType,
  fetchSitemap,
  parseSitemap,
  extractUrlsFromSitemap,
  sitemapParser
};

const cheerio = require('cheerio');
const {
  extractMicrodataItems,
  buildSchemaAudit,
  normalizePrice,
  normalizeAvailability
} = require('../audits/schemaAudit');
const { detectShopifyPageType } = require('../utils/pageTypeDetector');
const { buildMissingSchemas } = require('../utils/schemaRules');
const { isRawAuditMode } = require('../utils/auditMode');

const SCHEMA_ALIASES = {
  product: 'Product',
  productgroup: 'ProductGroup',
  breadcrumblist: 'BreadcrumbList',
  itemlist: 'ItemList',
  faqpage: 'FAQPage',
  article: 'Article',
  blogposting: 'BlogPosting',
  organization: 'Organization',
  website: 'WebSite',
  webpage: 'WebPage',
  collectionpage: 'CollectionPage',
  searchresultspage: 'SearchResultsPage',
  contactpoint: 'ContactPoint',
  searchaction: 'SearchAction',
  aggregaterating: 'AggregateRating',
  aggregateoffer: 'AggregateOffer',
  offer: 'Offer',
  review: 'Review',
  rating: 'Rating',
  person: 'Person',
  imageobject: 'ImageObject',
  listitem: 'ListItem',
  postaladdress: 'PostalAddress'
};


const PRICE_CANDIDATE_SELECTORS = [
  { selector: 'select[name="id"] option[selected][data-price]', source: 'selected variant data-price', score: 180, allowPlainNumber: true },
  { selector: 'option[selected][data-variant-qty][data-price]', source: 'selected variant data-price', score: 175, allowPlainNumber: true },
  { selector: 'button[name="add"][data-product-price]', source: 'add-to-cart product price', score: 150, allowPlainNumber: true },
  { selector: 'button[data-product-price]', source: 'button product price', score: 130, allowPlainNumber: true },
  { selector: '[itemprop="price"]', source: 'itemprop=price', score: 120, allowPlainNumber: true },
  { selector: '[data-product-price]', source: 'data-product-price', score: 115, allowPlainNumber: true },
  { selector: '[data-price]', source: 'data-price', score: 105, allowPlainNumber: true },
  { selector: '[data-testid*="price" i]', source: 'data-testid-price', score: 95 },
  { selector: '.product__info-container .price-item--sale', source: 'product-info sale price', score: 110, allowPlainNumber: true },
  { selector: '.product__info-container .price-item--regular', source: 'product-info regular price', score: 105, allowPlainNumber: true },
  { selector: '.product__info-container .price', source: 'product-info price', score: 100 },
  { selector: '.product-form .price', source: 'product-form price', score: 95 },
  { selector: '.product__price', source: 'product price', score: 95, allowPlainNumber: true },
  { selector: '.price__sale .price-item--sale', source: 'sale price item', score: 92, allowPlainNumber: true },
  { selector: '.price-item--sale', source: 'sale price item', score: 90, allowPlainNumber: true },
  { selector: '.price-item--regular', source: 'regular price item', score: 85, allowPlainNumber: true },
  { selector: '.price-item', source: 'price item', score: 75, allowPlainNumber: true },
  { selector: '.price', source: 'price class', score: 65 },
  { selector: '.money', source: 'money class', score: 60 }
];

function normalizeText(value) {
  return String(value || '')
    .replace(/&rsaquo;|&raquo;|&gt;/gi, match => {
      const normalized = match.toLowerCase();
      if (normalized === '&gt;') return '>';
      if (normalized === '&raquo;') return '\u00bb';
      return '\u203a';
    })
    .replace(/\u00e2\u201a\u00b9/g, '\u20b9')
    .replace(/\u00e2\u20ac\u00ba/g, '\u203a')
    .replace(/\u00c2\u00bb/g, '\u00bb')
    .replace(/\u00e2\u2020\u2019/g, '\u2192')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasCurrencyPrice(text) {
  const normalized = normalizeText(text);
  return /(?:\u20b9|rs\.?|inr)\s*[0-9]/i.test(normalized) || /[0-9][0-9,]*(?:\.\d{1,2})?\s*(?:\u20b9|rs\.?|inr)/i.test(normalized);
}

function extractCurrencyPriceTokens(text) {
  const normalized = normalizeText(text);
  const tokens = [];
  const patterns = [
    /(?:\u20b9|rs\.?|inr)\s*([0-9][0-9,]*(?:\.\d{1,2})?)/gi,
    /([0-9][0-9,]*(?:\.\d{1,2})?)\s*(?:\u20b9|rs\.?|inr)/gi
  ];

  patterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(normalized)) !== null) {
      tokens.push({
        raw: match[0],
        value: normalizePrice(match[1]),
        index: match.index
      });
    }
  });

  return tokens.filter(token => token.value);
}

function hasRejectedPriceContext(text) {
  return /(lowest\s+price\s+in\s+last\s+\d+\s+days|last\s+\d+\s+days|\b\d+\s+days\b|countdown|timer|hurry|offer\s+ending|coupon|promo\s+code|code\s*:|free\s+return|people\s+bought|save\s+extra|as\s+low\s+as|get\s+it\s+for|final\s+price|pick\s+any|buy\s+\d+|flat\s+\d+%|\boff\b|discount|shop\s+the\s+full\s+look|complete\s+the\s+look|frequently\s+bought\s+together|bundle|combo|upsell|cross-?sell|recommended)/i.test(text);
}

function hasRejectedMerchandisingContext($, element, contextText = '') {
  if (!element) {
    return /(shop\s+the\s+full\s+look|complete\s+the\s+look|frequently\s+bought\s+together|bundle|combo|upsell|cross-?sell|recommended)/i.test(contextText);
  }

  const node = $(element);
  const attributeText = normalizeText(
    Object.entries(element.attribs || {})
      .map(([key, value]) => `${key} ${value}`)
      .join(' ')
  );
  const moduleSelector = [
    '[data-testid^="stl-full-look-product-price" i]',
    '[data-testid^="stl-full-look-product-compare-price" i]',
    '[data-testid^="stl-full-look-product-discount" i]',
    '[data-testid*="full-look" i]',
    '[data-testid*="complete-look" i]',
    '[data-testid*="frequently-bought" i]',
    '[data-testid*="bundle" i]',
    '[data-testid*="combo" i]',
    '[data-testid*="upsell" i]',
    '[data-testid*="cross-sell" i]',
    '[class*="full-look" i]',
    '[class*="complete-look" i]',
    '[class*="frequently-bought" i]',
    '[class*="bundle" i]',
    '[class*="combo" i]',
    '[class*="upsell" i]',
    '[class*="cross-sell" i]',
    '[id*="full-look" i]',
    '[id*="complete-look" i]',
    '[id*="frequently-bought" i]',
    '[id*="bundle" i]',
    '[id*="combo" i]',
    '[id*="upsell" i]',
    '[id*="cross-sell" i]'
  ].join(',');
  const module = node.closest(moduleSelector);
  const moduleText = module.length
    ? normalizeText(
        [
          module.attr('class'),
          module.attr('id'),
          module.attr('data-testid'),
          module.find('h2,h3,h4,[data-testid*="title" i]').first().text()
        ].join(' ')
      )
    : '';

  return /(stl-full-look|shop\s+the\s+full\s+look|complete\s+the\s+look|frequently\s+bought\s+together|bundle|combo|upsell|cross-?sell|recommended)/i.test(
    `${attributeText} ${moduleText} ${contextText}`
  );
}

function hasRejectedCurrencyTokenContext(text, token) {
  const normalized = normalizeText(text);
  const tokenStart = Math.max(0, token.index || 0);
  const tokenEnd = tokenStart + String(token.raw || '').length;
  const before = normalized.slice(Math.max(0, tokenStart - 70), tokenStart);
  const after = normalized.slice(tokenEnd, Math.min(normalized.length, tokenEnd + 70));
  const localContext = `${before} ${after}`;

  // Discount amounts usually read "Rs. 400 OFF"; do not let them beat the selling price.
  if (/^\s*(?:off|discount|cashback|saved?|extra|back)\b/i.test(after)) {
    return true;
  }

  // Offer/coupon/final-price widgets often include lower calculated prices that are not
  // the primary visible product price shown beside the title and variant selector.
  if (/(as\s+low\s+as|get\s+it\s+for|final\s+price|minimum\s+cart|cashback|coupon|promo|code\s*:|offer\s+t&c|offer\s+will|save\s+extra)\s*$/i.test(before)) {
    return true;
  }

  if (/(sale\s+ends|countdown|timer|offer\s+ending|hurry)\b/i.test(localContext)) {
    return true;
  }

  return false;
}

function hasMrpContext(text, element) {
  const classSource = normalizeText(
    `${element?.attribs?.class || ''} ${element?.attribs?.id || ''}`
  );
  return /(mrp|compare|compare-at|was-price|old-price|strike|strikethrough|line-through)/i.test(`${text} ${classSource}`);
}

function getElementContext($, element) {
  const node = $(element);
  const ownText = normalizeText(
    node.attr('content') ||
      node.attr('data-product-price') ||
      node.attr('data-price') ||
      node.attr('data-product-price') ||
      node.text()
  );
  const classSource = normalizeText(
    [
      node.attr('class'),
      node.attr('id'),
      node.attr('data-testid'),
      node.attr('name'),
      node.parent().attr('class'),
      node.parent().attr('id'),
      node.closest('form[action*="/cart/add"], [class*="product" i], [class*="price" i], [class*="cart" i], [class*="offer" i], [class*="buy" i]').attr('class'),
      node.closest('form[action*="/cart/add"]').attr('action')
    ].join(' ')
  );

  return {
    ownText,
    classSource,
    combined: `${ownText} ${classSource}`
  };
}

function scorePriceCandidate({ $, element, selectorConfig, token, candidateText }) {
  const context = element
    ? getElementContext($, element)
    : { ownText: candidateText, classSource: '', combined: candidateText };
  const directText = context.ownText || candidateText;
  const combinedContext = `${directText} ${context.classSource}`;

  if (hasRejectedMerchandisingContext($, element, combinedContext)) {
    return null;
  }

  const shouldUseTokenAwareContext =
    selectorConfig?.tokenAwareOnly ||
    extractCurrencyPriceTokens(directText).length > 1;

  if (shouldUseTokenAwareContext) {
    if (hasRejectedCurrencyTokenContext(directText, token)) {
      return null;
    }
  } else if (hasRejectedPriceContext(directText)) {
    return null;
  }

  const isMrp = hasMrpContext(directText, element);
  const hasCurrency = hasCurrencyPrice(directText || token.raw);

  if (!hasCurrency && !selectorConfig?.allowPlainNumber) {
    return null;
  }

  let score = selectorConfig?.score || 30;

  if (hasCurrency) score += 40;
  if (/(product__info|product-info|product-meta|product-form|product-single|main-product|buy-buttons|add-to-cart|cart\/add|name addmain|selected variant|variant)/i.test(context.classSource)) {
    score += 25;
  }
  if (/form|cart\/add|button product price|add-to-cart|selected variant/i.test(`${selectorConfig?.source || ''} ${context.classSource}`)) {
    score += 35;
  }
  if (/(sale|selling|current|final-price|price__sale)/i.test(context.classSource)) {
    score += 10;
  }
  if (isMrp) {
    score -= 60;
  }
  if (/(offer|coupon|promo|banner|discount)/i.test(context.classSource)) {
    score -= 45;
  }

  return {
    value: token.value,
    score,
    source: selectorConfig?.source || 'body currency fallback',
    text: directText || token.raw,
    isMrp
  };
}

function extractVisiblePriceResult($) {
  const candidates = [];

  PRICE_CANDIDATE_SELECTORS.forEach(selectorConfig => {
    $(selectorConfig.selector).each((_, element) => {
      const node = $(element);
      const rawText = normalizeText(
        node.attr('content') ||
          node.attr('data-product-price') ||
          node.attr('data-price') ||
          node.text()
      );
      const tokens = extractCurrencyPriceTokens(rawText);
      const priceTokens =
        tokens.length > 0
          ? tokens
          : selectorConfig.allowPlainNumber
            ? [{ raw: rawText, value: normalizePrice(rawText), index: 0 }]
            : [];

      priceTokens
        .filter(token => token.value)
        .forEach(token => {
          const candidate = scorePriceCandidate({
            $,
            element,
            selectorConfig,
            token,
            candidateText: rawText
          });

          if (candidate) {
            candidates.push(candidate);
          }
        });
    });
  });

  if (candidates.length === 0) {
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    extractCurrencyPriceTokens(bodyText).forEach(token => {
      const start = Math.max(0, token.index - 60);
      const end = Math.min(bodyText.length, token.index + token.raw.length + 60);
      const nearbyText = bodyText.slice(start, end);
      const candidate = scorePriceCandidate({
        $,
        element: null,
        selectorConfig: {
          source: 'body currency fallback',
          score: 20,
          tokenAwareOnly: true
        },
        token: {
          ...token,
          index: token.index - start
        },
        candidateText: nearbyText
      });

      if (candidate) {
        candidates.push(candidate);
      }
    });
  }

  const primaryCandidates = candidates.filter(candidate => !candidate.isMrp);
  const sorted = (primaryCandidates.length > 0 ? primaryCandidates : candidates)
    .sort((left, right) => right.score - left.score);
  const best = sorted[0];

  return {
    value: best?.value || '',
    source: best
      ? `${best.source}: ${best.text.slice(0, 120)}`
      : 'not detected',
    candidates: sorted.map(candidate => ({
      value: candidate.value,
      label: candidate.source,
      source: candidate.source,
      context: candidate.text,
      isMrp: candidate.isMrp
    }))
  };
}

function extractVisiblePrice($) {
  return extractVisiblePriceResult($).value;
}

function collectPriceValuesFromObject(value, found = []) {
  if (!value) {
    return found;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectPriceValuesFromObject(item, found));
    return found;
  }

  if (typeof value !== 'object') {
    return found;
  }

  Object.entries(value).forEach(([key, child]) => {
    if (/^(price|price_min|price_max|compare_at_price|compare_at_price_min|compare_at_price_max)$/i.test(key)) {
      if (typeof child === 'number' || /^\d+$/.test(String(child || ''))) {
        found.push({
          value: String(child),
          kind: /^compare_at/i.test(key) ? 'compare_at' : 'price'
        });
      }
    }

    collectPriceValuesFromObject(child, found);
  });

  return found;
}

function selectRawShopifyPrice(candidates = [], visiblePrice = '') {
  const normalizedVisiblePrice = Number(normalizePrice(visiblePrice));
  const normalizedCandidates = candidates
    .map(candidate =>
      typeof candidate === 'object'
        ? candidate
        : { value: String(candidate || ''), kind: 'price' }
    )
    .filter(candidate => candidate.value);
  const uniqueCandidates = Array.from(
    new Map(
      normalizedCandidates.map(candidate => [
        `${candidate.kind}:${candidate.value}`,
        candidate
      ])
    ).values()
  );
  const sellingPriceCandidates = uniqueCandidates.filter(
    candidate => candidate.kind !== 'compare_at'
  );
  const preferredCandidates =
    sellingPriceCandidates.length > 0 ? sellingPriceCandidates : uniqueCandidates;

  if (uniqueCandidates.length === 0) {
    return '';
  }

  if (Number.isFinite(normalizedVisiblePrice)) {
    const minorUnitMatch = preferredCandidates.find(candidate => {
      const raw = Number(candidate.value);
      return Number.isFinite(raw) && Math.abs(raw / 100 - normalizedVisiblePrice) < 0.01;
    });

    if (minorUnitMatch) {
      return minorUnitMatch.value;
    }

    const majorUnitMatch = preferredCandidates.find(candidate => {
      const raw = Number(candidate.value);
      return Number.isFinite(raw) && Math.abs(raw - normalizedVisiblePrice) < 0.01;
    });

    if (majorUnitMatch) {
      return majorUnitMatch.value;
    }
  }

  return preferredCandidates[0].value;
}

function extractRawShopifyPriceCandidates($, html = '') {
  if (!/Shopify|cdn\.shopify\.com|\/cart\/add|ProductJson|data-product-json/i.test(html)) {
    return [];
  }

  const candidates = [];

  $('script').each((_, element) => {
    const type = String($(element).attr('type') || '').toLowerCase();
    if (type.includes('ld+json')) {
      return;
    }

    const content = $(element).html() || '';

    if (/json/i.test(type)) {
      try {
        const beforeCount = candidates.length;
        collectPriceValuesFromObject(JSON.parse(content), candidates);
        candidates.slice(beforeCount).forEach(candidate => {
          candidate.source = type || 'script json';
          candidate.context = 'JSON script price field';
        });
      } catch (error) {
        // Fall through to regex extraction for app/theme payloads that are JS-like.
      }
    }

    const pricePattern = /["']?(price|price_min|price_max|compare_at_price|compare_at_price_min|compare_at_price_max)["']?\s*:\s*["']?(\d{3,})(?!\.)["']?/gi;
    let match;
    while ((match = pricePattern.exec(content)) !== null) {
      candidates.push({
        value: match[2],
        kind: /^compare_at/i.test(match[1]) ? 'compare_at' : 'price',
        source: match[1],
        context: content.slice(Math.max(0, match.index - 80), match.index + 120)
      });
    }
  });

  $('[data-product-json], [data-variant-json], [data-shopify-product]')
    .each((_, element) => {
      Object.values(element.attribs || {}).forEach(value => {
        const match = String(value || '').match(/\b\d{3,}\b/);
        if (match) {
          candidates.push({
            value: match[0],
            kind: 'price',
            source: 'data attribute',
            context: String(value || '').slice(0, 160)
          });
        }
      });
    });

  return candidates.map(candidate => ({
    rawValue: String(candidate.value || ''),
    normalizedValue: normalizePrice(
      Number(candidate.value) > 999 ? Number(candidate.value) / 100 : candidate.value
    ),
    kind: candidate.kind || 'price',
    source: candidate.source || '',
    context: normalizeText(candidate.context || '')
  }));
}

function extractRawShopifyPrice($, html = '', visiblePrice = '') {
  const candidates = extractRawShopifyPriceCandidates($, html).map(candidate => ({
    value: candidate.rawValue,
    kind: candidate.kind,
    source: candidate.source,
    context: candidate.context
  }));

  return selectRawShopifyPrice(candidates, visiblePrice);
}

function extractSelectedVariantId($, html = '', pageUrl = '') {
  try {
    const variantFromUrl = new URL(pageUrl).searchParams.get('variant');
    if (variantFromUrl) {
      return variantFromUrl;
    }
  } catch (error) {
    // Continue with DOM/script detection when the page URL is not parseable.
  }

  const selectors = [
    'input[name="id"][value]',
    'select[name="id"] option[selected][value]',
    '[data-selected-variant-id]',
    '[data-current-variant-id]',
    '[data-variant-id][aria-selected="true"]',
    '[data-variant-id].is-selected',
    '[data-variant-id].selected'
  ];

  for (const selector of selectors) {
    const match = $(selector).first();
    const value =
      match.attr('value') ||
      match.attr('data-selected-variant-id') ||
      match.attr('data-current-variant-id') ||
      match.attr('data-variant-id') ||
      '';

    if (value) {
      return String(value).trim();
    }
  }

  const scriptMatch = String(html || '').match(
    /(?:selectedVariantId|current_variant_id|currentVariantId|variantId)["']?\s*[:=]\s*["']?(\d{5,})/i
  );

  return scriptMatch?.[1] || '';
}

function normalizeVariantQuantityAvailability(value) {
  const quantity = Number(String(value || '').trim());

  if (!Number.isFinite(quantity)) {
    return '';
  }

  return quantity > 0 ? 'in_stock' : 'out_of_stock';
}

function getSelectedVariantOption($, selectedVariantId = '') {
  if (selectedVariantId) {
    const byValue = $(`option[value="${selectedVariantId}"]`).first();
    if (byValue.length > 0) {
      return byValue;
    }

    const byDataId = $(`[data-variant-id="${selectedVariantId}"]`).first();
    if (byDataId.length > 0) {
      return byDataId;
    }
  }

  const selectedOption = $('select[name="id"] option[selected], option[selected][data-variant-qty], option[selected][data-stock]')
    .first();
  if (selectedOption.length > 0) {
    return selectedOption;
  }

  return $('input[name="id"][value]').first();
}

function readVariantAvailabilityFromElement(node) {
  const quantityAvailability =
    normalizeVariantQuantityAvailability(node.attr('data-variant-qty')) ||
    normalizeVariantQuantityAvailability(node.attr('data-inventory-quantity')) ||
    normalizeVariantQuantityAvailability(node.attr('data-quantity'));

  if (quantityAvailability) {
    return quantityAvailability;
  }

  return normalizeAvailability(
    [
      node.attr('data-availability'),
      node.attr('data-stock'),
      node.attr('data-inventory-policy'),
      node.attr('aria-label'),
      node.attr('value'),
      node.text()
    ]
      .filter(Boolean)
      .join(' ')
  );
}

function readNearestAddToCartAvailability($, selectedNode = null) {
  const form = selectedNode?.length
    ? selectedNode.closest('form[action*="/cart/add"]')
    : $('form[action*="/cart/add"]').first();
  const searchRoot = form?.length ? form : $('body');
  const buttons = searchRoot
    .find('button[name="add"], button[type="submit"], [data-product-price]')
    .add(searchRoot.is('button') ? searchRoot : $())
    .filter((_, element) => {
      const node = $(element);
      const text = normalizeText(
        [
          node.attr('aria-label'),
          node.attr('value'),
          node.text(),
          node.attr('disabled') !== undefined ? 'sold out' : ''
        ]
          .filter(Boolean)
          .join(' ')
      );

      return /(add\s+to\s+cart|buy\s+now|sold\s+out|notify\s+me|unavailable|pre-?order|back-?order)/i.test(text);
    })
    .toArray();

  for (const button of buttons) {
    const node = $(button);
    const text = normalizeText(
      [
        node.attr('aria-label'),
        node.attr('value'),
        node.text(),
        node.attr('disabled') !== undefined ? 'sold out' : ''
      ]
        .filter(Boolean)
        .join(' ')
    );
    const availability = normalizeAvailability(text);

    if (availability) {
      return availability;
    }
  }

  return '';
}

function extractVisibleAvailability($, selectedVariantId = '') {
  const selectedVariantNode = getSelectedVariantOption($, selectedVariantId);
  if (selectedVariantNode.length > 0) {
    const selectedVariantAvailability =
      readVariantAvailabilityFromElement(selectedVariantNode);

    if (selectedVariantAvailability) {
      return selectedVariantAvailability;
    }
  }

  const nearestButtonAvailability = readNearestAddToCartAvailability(
    $,
    selectedVariantNode
  );

  if (nearestButtonAvailability) {
    return nearestButtonAvailability;
  }

  const selectors = [
    '[itemprop="availability"]',
    '[data-product-availability]',
    '[data-availability]',
    '[data-stock]',
    '.product__inventory',
    '.inventory',
    '.stock',
    '.availability',
    '.product-form__submit'
  ];

  for (const selector of selectors) {
    const values = $(selector)
      .map((_, element) => {
        const node = $(element);
        const text = [
          node.attr('content'),
          node.attr('data-product-availability'),
          node.attr('data-availability'),
          node.attr('data-stock'),
          node.attr('aria-label'),
          node.attr('value'),
          node.text(),
          node.attr('disabled') !== undefined ? 'sold out' : ''
        ]
          .filter(Boolean)
          .join(' ');

        return normalizeAvailability(text);
      })
      .get()
      .filter(Boolean);

    if (values.length > 0) {
      return values[0];
    }
  }

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  return normalizeAvailability(bodyText.match(/sold out|out of stock|pre-?order|back-?order/i)?.[0] || '');
}

function extractVisibleAvailabilityCandidates($, selectedVariantId = '') {
  const candidates = [];
  const selectedVariantNode = getSelectedVariantOption($, selectedVariantId);

  if (selectedVariantNode.length > 0) {
    const availability = readVariantAvailabilityFromElement(selectedVariantNode);
    if (availability) {
      candidates.push({
        value: availability,
        selector: 'selected variant',
        context: normalizeText(selectedVariantNode.text() || selectedVariantNode.attr('value') || '')
      });
    }
  }

  const nearestButtonAvailability = readNearestAddToCartAvailability(
    $,
    selectedVariantNode
  );
  if (nearestButtonAvailability) {
    candidates.push({
      value: nearestButtonAvailability,
      selector: 'nearest add-to-cart button',
      context: 'nearest selected product form'
    });
  }

  [
    '[itemprop="availability"]',
    '[data-product-availability]',
    '[data-availability]',
    '[data-stock]',
    '.product__inventory',
    '.inventory',
    '.stock',
    '.availability',
    '.product-form__submit'
  ].forEach(selector => {
    $(selector).each((_, element) => {
      const node = $(element);
      const text = [
        node.attr('content'),
        node.attr('data-product-availability'),
        node.attr('data-availability'),
        node.attr('data-stock'),
        node.attr('aria-label'),
        node.attr('value'),
        node.text(),
        node.attr('disabled') !== undefined ? 'disabled' : ''
      ]
        .filter(Boolean)
        .join(' ');
      const value = normalizeAvailability(text);

      if (value) {
        candidates.push({
          value,
          selector,
          context: normalizeText(text).slice(0, 200)
        });
      }
    });
  });

  return candidates;
}

function extractVisibleReviewData($) {
  const bodyText = normalizeText($('body').text());
  const reviewContainers = [
    '[class*="review" i]',
    '[id*="review" i]',
    '[data-review]',
    '[class*="rating" i]',
    '[id*="rating" i]',
    '[aria-label*="rating" i]'
  ].join(',');
  const containerText = normalizeText(
    $(reviewContainers)
      .map((_, element) => $(element).text())
      .get()
      .join(' ')
  );
  const combinedText = `${containerText} ${bodyText}`;
  const lazyReviewHint =
    /judgeme|judge\.me|loox|yotpo|stamped|okendo|reviews-widget|shopify-product-reviews|spr-badge|data-review/i
      .test($.html() || '');
  const hasRatingSignal =
    /(\b[1-5](?:\.\d)?\s*(?:out of|\/)\s*5\b|\bstar(?:s)?\b|\brating\b)/i
      .test(combinedText);
  const hasReviewSignal =
    /(\bcustomer reviews?\b|\breviews?\b|\bverified buyer\b|\bwrite a review\b|\bbased on\s+\d+\s+reviews?\b)/i
      .test(combinedText) ||
    $(reviewContainers).length > 0;

  return {
    hasReviewSignal,
    hasRatingSignal,
    lazyReviewHint,
    evidence: normalizeText(containerText || combinedText).slice(0, 200)
  };
}

function toBreadcrumbLabel(segment) {
  return decodeURIComponent(String(segment || ''))
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

function resolveBreadcrumbUrl(pageUrl, href) {
  const rawHref = String(href || '').trim();

  if (!rawHref || !pageUrl) {
    return '';
  }

  try {
    return new URL(rawHref, pageUrl).href;
  } catch (error) {
    return '';
  }
}

function buildBreadcrumbListFromLinks(links = []) {
  const normalizedLinks = [...links];
  const firstLabel = String(normalizedLinks[0]?.name || '').trim().toLowerCase();

  if (normalizedLinks.length > 0 && firstLabel !== 'home') {
    let homeUrl = '';

    try {
      homeUrl = new URL(normalizedLinks[0].item || normalizedLinks[0].href).origin + '/';
    } catch (error) {
      homeUrl = '';
    }

    normalizedLinks.unshift({
      name: 'Home',
      href: '/',
      item: homeUrl
    });
  }

  const itemListElement = normalizedLinks
    .map((link, index) => {
      const name = String(link?.name || '').replace(/\s+/g, ' ').trim();

      if (!name) {
        return null;
      }

      const item = {
        '@type': 'ListItem',
        position: index + 1,
        name
      };

      if (link.item) {
        item.item = link.item;
      }

      return item;
    })
    .filter(Boolean);

  if (itemListElement.length === 0) {
    return '';
  }

  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement
  }, null, 2);
}

function buildBreadcrumbListSample(pageUrl, breadcrumbLinks = []) {
  const sampleFromLinks = buildBreadcrumbListFromLinks(breadcrumbLinks);

  if (sampleFromLinks) {
    return sampleFromLinks;
  }

  try {
    const parsedUrl = new URL(pageUrl);
    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    const itemListElement = [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Home',
        item: parsedUrl.origin + '/'
      }
    ];

    let cumulativePath = '';
    segments.forEach((segment, index) => {
      cumulativePath += '/' + segment;
      itemListElement.push({
        '@type': 'ListItem',
        position: index + 2,
        name: toBreadcrumbLabel(segment),
        item: parsedUrl.origin + cumulativePath
      });
    });

    return JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement
    }, null, 2);
  } catch (error) {
    return '';
  }
}

function hasBreadcrumbTrailText(text) {
  const normalized = normalizeText(text)
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return false;
  }

  return /(home\s*(>|\/|\u203a|\u00bb|\u2192|&rsaquo;).+\s*(>|\/|\u203a|\u00bb|\u2192|&rsaquo;).+)/i.test(normalized);
}

function hasBreadcrumbEvidence(links = [], text = '') {
  if ((links || []).length >= 2) {
    return true;
  }

  return hasBreadcrumbTrailText(text);
}

function extractBreadcrumbLinksFromElement($, element, pageUrl = '') {
  return $(element)
    .find('a')
    .map((_, link) => {
      const name = $(link).text().replace(/\s+/g, ' ').trim();
      const rawHref = $(link).attr('href') || '';

      if (!name) {
        return null;
      }

      return {
        name,
        href: rawHref,
        item: resolveBreadcrumbUrl(pageUrl, rawHref)
      };
    })
    .get()
    .filter(Boolean);
}

function extractBreadcrumbTrailFromCheerio($, pageUrl = '') {
  const explicitMatches = [
    'nav[aria-label="Breadcrumb" i]',
    'nav[aria-label*="breadcrumb" i]',
    'nav[aria-label*="breadcrumbs" i]',
    '.breadcrumb',
    '.breadcrumbs',
    '.b-crumbs',
    '[class*="breadcrumb" i]',
    '[class*="breadcrumbs" i]',
    '[class*="b-crumbs" i]',
    '[data-testid*="breadcrumb" i]'
  ];
  const explicitElements = $(explicitMatches.join(',')).toArray();

  for (const element of explicitElements) {
    const links = extractBreadcrumbLinksFromElement($, element, pageUrl);
    const text = $(element).text();

    if (hasBreadcrumbEvidence(links, text)) {
      return {
        present: true,
        links
      };
    }
  }

  const explicitTrailText = explicitElements
    .map(element => $(element).text())
    .join(' ');
  if (explicitElements.length > 0 && hasBreadcrumbTrailText(explicitTrailText)) {
    return {
      present: true,
      links: []
    };
  }

  let trail = {
    present: false,
    links: []
  };

  $('nav, ol, ul, div').each((_, el) => {
    const links = $(el).find('a');
    const text = $(el).text();

    if (hasBreadcrumbEvidence(extractBreadcrumbLinksFromElement($, el, pageUrl), text)) {
      trail = {
        present: true,
        links: extractBreadcrumbLinksFromElement($, el, pageUrl)
      };
      return false;
    }

    return undefined;
  });

  return trail;
}

function detectBreadcrumbUiFromCheerio($) {
  return extractBreadcrumbTrailFromCheerio($).present;
}

function resolveSchemaPageType(url, pageType, html = '', $ = null) {
  return detectShopifyPageType({
    url,
    html,
    $,
    fallback: pageType
  });
}

function normalizeSchemaType(type) {
  const rawValue = String(type || '').trim();
  const normalized = rawValue.toLowerCase();

  if (SCHEMA_ALIASES[normalized]) {
    return SCHEMA_ALIASES[normalized];
  }

  return rawValue;
}

function collectSchemaTypes(value, detected = new Set(), seen = new WeakSet()) {
  if (!value) {
    return detected;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectSchemaTypes(item, detected, seen));
    return detected;
  }

  if (typeof value !== 'object') {
    return detected;
  }

  if (seen.has(value)) {
    return detected;
  }

  seen.add(value);

  const typeValue = value['@type'];
  if (Array.isArray(typeValue)) {
    typeValue.forEach(type => detected.add(normalizeSchemaType(type)));
  } else if (typeValue) {
    detected.add(normalizeSchemaType(typeValue));
  }

  if (Array.isArray(value['@graph'])) {
    value['@graph'].forEach(item => {
      collectSchemaTypes(item, detected, seen);
    });
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === '@context' || key === '@graph') {
      return;
    }

    collectSchemaTypes(child, detected, seen);
  });

  return detected;
}

function getTypeList(value) {
  const types = Array.isArray(value?.['@type'])
    ? value['@type']
    : value?.['@type']
      ? [value['@type']]
      : [];

  return types.map(normalizeSchemaType).filter(Boolean);
}

function collectSchemaEntities(value, predicate, found = [], seen = new WeakSet()) {
  if (!value) {
    return found;
  }

  if (Array.isArray(value)) {
    value.forEach(item => collectSchemaEntities(item, predicate, found, seen));
    return found;
  }

  if (typeof value !== 'object') {
    return found;
  }

  if (seen.has(value)) {
    return found;
  }

  seen.add(value);

  if (predicate(value, getTypeList(value))) {
    found.push(value);
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === '@context') {
      return;
    }

    collectSchemaEntities(child, predicate, found, seen);
  });

  return found;
}

function valueToText(value) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim();
  }

  if (Array.isArray(value)) {
    return value.map(valueToText).find(Boolean) || '';
  }

  if (typeof value === 'object') {
    return valueToText(
      value.name ||
        value.url ||
        value.href ||
        value.item ||
        value['@id'] ||
        value.price ||
        value.priceCurrency ||
        value.availability
    );
  }

  return '';
}

function uniqueList(values = []) {
  return Array.from(new Set(values.map(valueToText).filter(Boolean)));
}

function getSchemaOffers(parsedDocuments = []) {
  return parsedDocuments.flatMap(document =>
    collectSchemaEntities(document, (_, types) =>
      types.some(type => type === 'Offer' || type === 'AggregateOffer')
    )
  );
}

function getSchemaProducts(parsedDocuments = []) {
  return parsedDocuments.flatMap(document =>
    collectSchemaEntities(document, (_, types) =>
      types.some(type => type === 'Product' || type === 'ProductGroup')
    )
  );
}

function collectBreadcrumbSchemaItems(parsedDocuments = []) {
  return parsedDocuments
    .flatMap(document =>
      collectSchemaEntities(document, (_, types) => types.includes('BreadcrumbList'))
    )
    .flatMap(entity => {
      const items = Array.isArray(entity.itemListElement)
        ? entity.itemListElement
        : entity.itemListElement
          ? [entity.itemListElement]
          : [];

      return items.map((item, index) => ({
        name: valueToText(item.name || item.item?.name),
        url: valueToText(item.item?.url || item.item || item.url),
        position: item.position || index + 1
      }));
    });
}

function collectProductUrlCandidates($, pageUrl = '') {
  return $('a[href*="/products/"]')
    .map((_, element) => {
      const href = $(element).attr('href') || '';
      return resolveBreadcrumbUrl(pageUrl, href) || href;
    })
    .get()
    .filter(Boolean)
    .filter((url, index, all) => all.indexOf(url) === index);
}

function buildRawSchemaEvidence({
  pageUrl,
  pageType,
  scripts = [],
  parseResult,
  parsedSchemaTypes = [],
  visiblePriceResult = {},
  rawShopifyPriceCandidates = [],
  visibleAvailabilityCandidates = [],
  breadcrumbUiCandidates = [],
  productUrlCandidates = []
}) {
  const schemaTypes = parsedSchemaTypes.length > 0
    ? parsedSchemaTypes
    : parseResult.detectedSchemas || [];
  const products = getSchemaProducts(parseResult.parsedDocuments || []);
  const offers = getSchemaOffers(parseResult.parsedDocuments || []);

  return {
    url: pageUrl,
    pageTypeGuess: pageType,
    schemaJsonLdRawBlocks: scripts,
    parsedSchemaTypes: schemaTypes,
    schemaParseErrors: parseResult.errors || [],
    schemaProductNames: uniqueList(products.map(product => product.name)),
    schemaProductUrls: uniqueList(products.map(product => product.url || product['@id'])),
    schemaOfferPrices: uniqueList(offers.map(offer => offer.price || offer.lowPrice || offer.highPrice)),
    schemaOfferCurrencies: uniqueList(offers.map(offer => offer.priceCurrency)),
    schemaOfferAvailability: uniqueList(offers.map(offer => offer.availability)),
    schemaOfferUrls: uniqueList(offers.map(offer => offer.url || offer['@id'])),
    schemaBrands: uniqueList(products.map(product => product.brand || product.manufacturer)),
    visiblePriceCandidates: visiblePriceResult.candidates || [],
    rawShopifyPriceCandidates,
    visibleAvailabilityCandidates,
    breadcrumbUiCandidates,
    breadcrumbSchemaItems: collectBreadcrumbSchemaItems(parseResult.parsedDocuments || []),
    productUrlCandidates,
    duplicateUrlCandidates: [],
    hasProductSchema: schemaTypes.includes('Product') || schemaTypes.includes('ProductGroup'),
    hasOfferSchema: schemaTypes.includes('Offer') || schemaTypes.includes('AggregateOffer'),
    hasBreadcrumbSchema: schemaTypes.includes('BreadcrumbList'),
    hasCollectionPageSchema: schemaTypes.includes('CollectionPage'),
    hasParseErrors: (parseResult.errors || []).length > 0
  };
}

function countSchemaObjects(value, seen = new WeakSet()) {
  if (!value) {
    return 0;
  }

  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countSchemaObjects(item, seen), 0);
  }

  if (typeof value !== 'object') {
    return 0;
  }

  if (seen.has(value)) {
    return 0;
  }

  seen.add(value);

  let count = value['@type'] ? 1 : 0;

  if (Array.isArray(value['@graph'])) {
    count += value['@graph'].reduce(
      (total, item) => total + countSchemaObjects(item, seen),
      0
    );
  }

  Object.entries(value).forEach(([key, child]) => {
    if (key === '@context' || key === '@graph') {
      return;
    }

    count += countSchemaObjects(child, seen);
  });

  return count;
}

function extractBreadcrumbUiCandidates($, pageUrl = '') {
  const candidates = [];
  const selectors = [
    'nav[aria-label="Breadcrumb" i]',
    'nav[aria-label*="breadcrumb" i]',
    'nav[aria-label*="breadcrumbs" i]',
    '.breadcrumb',
    '.breadcrumbs',
    '.b-crumbs',
    '[class*="breadcrumb" i]',
    '[class*="breadcrumbs" i]',
    '[class*="b-crumbs" i]',
    '[data-testid*="breadcrumb" i]'
  ];

  $(selectors.join(',')).each((_, element) => {
    const links = extractBreadcrumbLinksFromElement($, element, pageUrl);
    candidates.push({
      selector: selectors.find(selector => $(element).is(selector)) || 'breadcrumb-like element',
      names: links.map(link => link.name),
      urls: links.map(link => link.item || link.href || ''),
      context: normalizeText($(element).text()).slice(0, 260)
    });
  });

  return candidates;
}

function getJsonParseErrorLocation(rawContent, error) {
  const positionMatch = String(error?.message || '').match(/position\s+(\d+)/i);
  const position = positionMatch ? Number(positionMatch[1]) : null;

  if (!Number.isFinite(position)) {
    return {
      position: null,
      line: null,
      column: null,
      snippet: rawContent.slice(0, 200)
    };
  }

  const before = rawContent.slice(0, position);
  const lines = before.split(/\r?\n/);
  const start = Math.max(0, position - 100);
  const end = Math.min(rawContent.length, position + 100);

  return {
    position,
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
    snippet: rawContent.slice(start, end)
  };
}

function parseJsonLdScripts(scriptContents = []) {
  const detected = new Set();
  const errors = [];
  const parsedDocuments = [];
  let parsedScriptCount = 0;
  let schemaObjectCount = 0;

  scriptContents.forEach((content, index) => {
    const rawContent = String(content || '').trim();

    if (!rawContent) {
      return;
    }

    try {
      const parsed = JSON.parse(rawContent);
      parsedScriptCount += 1;
      parsedDocuments.push(parsed);
      collectSchemaTypes(parsed, detected);
      schemaObjectCount += countSchemaObjects(parsed);
    } catch (error) {
      const location = getJsonParseErrorLocation(rawContent, error);
      errors.push({
        scriptIndex: index,
        message: error.message,
        line: location.line,
        column: location.column,
        position: location.position,
        snippet: location.snippet,
        parsedOtherBlocks: false
      });
    }
  });

  errors.forEach(error => {
    error.parsedOtherBlocks = parsedScriptCount > 0;
  });

  return {
    scriptCount: scriptContents.length,
    parsedScriptCount,
    schemaObjectCount,
    detectedSchemas: Array.from(detected).sort(),
    parsedDocuments,
    errors
  };
}

function buildBreadcrumbSchemaIssue(detectedSchemas, breadcrumbUiPresent) {
  if (!breadcrumbUiPresent || detectedSchemas.includes('BreadcrumbList')) {
    return null;
  }

  return {
    type: 'breadcrumb-missing-schema',
    severity: 'high',
    message:
      'Visual breadcrumbs detected but Structured Data is missing. Search engines cannot generate breadcrumb snippets for this page.'
  };
}

function buildStructuredDataResult(
  pageType,
  parseResult,
  source,
  pageUrl,
  scripts = [],
  breadcrumbTrail = { present: false, links: [] },
  microdataItems = [],
  visiblePriceResult = {},
  visibleAvailability = '',
  rawShopifyPrice = '',
  rawShopifyPriceCandidates = [],
  visibleAvailabilityCandidates = [],
  breadcrumbUiCandidates = [],
  productUrlCandidates = [],
  selectedVariantId = '',
  visibleReviewData = {},
  pageTitle = ''
) {
  const visiblePrice = visiblePriceResult.value || '';
  const visiblePriceSource = visiblePriceResult.source || '';
  const normalizedBreadcrumbTrail =
    typeof breadcrumbTrail === 'boolean'
      ? { present: breadcrumbTrail, links: [] }
      : breadcrumbTrail || { present: false, links: [] };
  const breadcrumbUiPresent = Boolean(normalizedBreadcrumbTrail.present);
  const microdataTypes = microdataItems
    .flatMap(item => item.types || [])
    .filter((type, index, all) => type && all.indexOf(type) === index)
    .sort();
  const combinedDetectedSchemas = Array.from(
    new Set([...(parseResult.detectedSchemas || []), ...microdataTypes])
  ).sort();
  const missingSchemas = buildMissingSchemas(
    pageType,
    combinedDetectedSchemas,
    breadcrumbUiPresent
  );
  const issues = [];
  const recommendations = [];
  const breadcrumbIssue = buildBreadcrumbSchemaIssue(
    combinedDetectedSchemas,
    breadcrumbUiPresent
  );
  const generatedSchemaSample = breadcrumbIssue
    ? buildBreadcrumbListSample(pageUrl, normalizedBreadcrumbTrail.links || [])
    : '';

  if (breadcrumbIssue) {
    issues.push(breadcrumbIssue);

    if (!missingSchemas.includes('BreadcrumbList')) {
      missingSchemas.push('BreadcrumbList');
    }

    recommendations.push(
      'Add BreadcrumbList schema to match visible breadcrumb navigation and help search engines understand page hierarchy.'
    );
  }

  let confidence = 'low';
  if (parseResult.scriptCount > 0) {
    confidence = parseResult.parsedScriptCount > 0 ? 'high' : 'medium';
  }

  const rawEvidence = buildRawSchemaEvidence({
    pageUrl,
    pageType,
    scripts,
    parseResult,
    parsedSchemaTypes: combinedDetectedSchemas,
    visiblePriceResult,
    rawShopifyPriceCandidates,
    visibleAvailabilityCandidates,
    breadcrumbUiCandidates,
    productUrlCandidates
  });
  const rawMode = isRawAuditMode();
  const schemaAudit = rawMode
    ? {
        implementationType: source === 'puppeteer' ? 'App-level' : 'Theme-level',
        visiblePrice: normalizePrice(visiblePrice) || '',
        detectedSchemaTypes: combinedDetectedSchemas,
        expectedSchemaTypes: [],
        missingRequiredSchema: [],
        missingRecommendedSchema: [],
        unexpectedSchemaTypes: [],
        schemaConflicts: [],
        richResultSummary: {},
        schemaRecommendations: [],
        generatedSchemaSamples: {},
        schemaScoreBreakdown: {},
        schemaParseErrors: parseResult.errors,
        productFieldValidation: {},
        qualityWarnings: [],
        breadcrumbConsistencyStatus: '',
        breadcrumbConsistencyWarnings: [],
        reviewVisibilityStatus: '',
        ratingVisibilityStatus: '',
        reviewRatingWarnings: [],
        selectedVariantId: selectedVariantId || '',
        selectedVariantPrice: '',
        selectedVariantAvailability: '',
        schemaPrice: '',
        rawShopifyPrice: rawShopifyPrice || '',
        priceMatchStatus: '',
        priceUnitStatus: '',
        priceDebugNote: '',
        schemaAvailability: '',
        visibleAvailability: normalizeAvailability(visibleAvailability) || '',
        availabilityMatchStatus: '',
        consistencyWarnings: [],
        rows: []
      }
    : buildSchemaAudit({
        pageType,
        source,
        pageUrl,
        pageTitle,
        jsonLdDocuments: parseResult.parsedDocuments,
        microdataItems,
        breadcrumbUiPresent,
        breadcrumbLinks: normalizedBreadcrumbTrail.links || [],
        jsonLdErrorCount: parseResult.errors.length,
        schemaParseErrors: parseResult.errors,
        visibleReviewData,
        visiblePrice,
        visibleAvailability,
        rawShopifyPrice,
        selectedVariantId
      });

  (schemaAudit.consistencyWarnings || []).forEach(warning => {
    issues.push({
      type: warning.type || 'schema-ui-consistency',
      severity: warning.priority === 'high' ? 'high' : 'warning',
      message: warning.issue,
      recommendation: warning.howToFix,
      details: {
        schemaPrice: schemaAudit.schemaPrice || '',
        visiblePrice: schemaAudit.visiblePrice || '',
        visiblePriceSource,
        rawShopifyPrice: schemaAudit.rawShopifyPrice || '',
        priceMatchStatus: schemaAudit.priceMatchStatus || '',
        priceUnitStatus: schemaAudit.priceUnitStatus || '',
        priceDebugNote: schemaAudit.priceDebugNote || '',
        schemaAvailability: schemaAudit.schemaAvailability || '',
        visibleAvailability: schemaAudit.visibleAvailability || '',
        availabilityMatchStatus: schemaAudit.availabilityMatchStatus || ''
      }
    });
  });

  (schemaAudit.qualityWarnings || []).forEach(warning => {
    if (warning.priority === 'low') {
      return;
    }

    issues.push({
      type: warning.type || 'schema-quality',
      severity: warning.priority === 'high' ? 'high' : 'warning',
      message: warning.issue,
      recommendation: warning.howToFix,
      details: {
        category: warning.category || ''
      }
    });
  });

  const generatedSchemaSamples = {
    ...(schemaAudit.generatedSchemaSamples || {})
  };
  if (generatedSchemaSample && !generatedSchemaSamples.breadcrumbList) {
    generatedSchemaSamples.breadcrumbList = generatedSchemaSample;
  }
  const jsonLdTypeSet = new Set(parseResult.detectedSchemas || []);
  const uniqueMicrodataItemCount = microdataItems.filter(
    item => !(item.types || []).some(type => jsonLdTypeSet.has(type))
  ).length;
  const detectedItemCount =
    parseResult.schemaObjectCount + uniqueMicrodataItemCount;

  return {
    detectedSchemas: combinedDetectedSchemas,
    missingSchemas: rawMode ? [] : missingSchemas,
    confidence,
    source,
    auditMode: rawMode ? 'raw' : 'evaluated',
    rawEvidence,
    breadcrumbUiPresent,
    breadcrumbLinks: normalizedBreadcrumbTrail.links || [],
    issues: rawMode ? [] : issues,
    recommendations: rawMode ? [] : recommendations,
    scriptCount: parseResult.scriptCount,
    parsedScriptCount: parseResult.parsedScriptCount,
    schemaObjectCount: parseResult.schemaObjectCount,
    jsonLdErrors: parseResult.errors,
    schemaParseErrors: schemaAudit.schemaParseErrors || parseResult.errors,
    hasStructuredData:
      parseResult.scriptCount > 0 || microdataItems.length > 0,
    schemaTypes: combinedDetectedSchemas,
    microdataTypes,
    microdataItemCount: microdataItems.length,
    schemaAudit,
    generatedSchemaSample,
    generatedSchemaSamples,
    detectedSchemaTypes: schemaAudit.detectedSchemaTypes || combinedDetectedSchemas,
    expectedSchemaTypes: rawMode ? [] : schemaAudit.expectedSchemaTypes || [],
    missingRequiredSchema: rawMode ? [] : schemaAudit.missingRequiredSchema || [],
    missingRecommendedSchema: rawMode ? [] : schemaAudit.missingRecommendedSchema || [],
    unexpectedSchemaTypes: rawMode ? [] : schemaAudit.unexpectedSchemaTypes || [],
    schemaConflicts: rawMode ? [] : schemaAudit.schemaConflicts || [],
    richResultSummary: schemaAudit.richResultSummary || {},
    schemaRecommendations: rawMode ? [] : schemaAudit.schemaRecommendations || [],
    schemaScoreBreakdown: schemaAudit.schemaScoreBreakdown || {},
    schemaPrice: schemaAudit.schemaPrice || '',
    visiblePriceSource,
    rawShopifyPrice: schemaAudit.rawShopifyPrice || '',
    priceMatchStatus: schemaAudit.priceMatchStatus || '',
    priceUnitStatus: schemaAudit.priceUnitStatus || '',
    priceDebugNote: schemaAudit.priceDebugNote || '',
    schemaAvailability: schemaAudit.schemaAvailability || '',
    visibleAvailability: schemaAudit.visibleAvailability || '',
    availabilityMatchStatus: schemaAudit.availabilityMatchStatus || '',
    breadcrumbConsistencyStatus:
      schemaAudit.breadcrumbConsistencyStatus || '',
    breadcrumbConsistencyWarnings:
      schemaAudit.breadcrumbConsistencyWarnings || [],
    reviewVisibilityStatus: schemaAudit.reviewVisibilityStatus || '',
    ratingVisibilityStatus: schemaAudit.ratingVisibilityStatus || '',
    productFieldValidation: schemaAudit.productFieldValidation || {},
    qualityWarnings: schemaAudit.qualityWarnings || [],
    selectedVariantId: schemaAudit.selectedVariantId || selectedVariantId || '',
    selectedVariantPrice: schemaAudit.selectedVariantPrice || '',
    selectedVariantAvailability: schemaAudit.selectedVariantAvailability || '',
    consistencyWarnings: schemaAudit.consistencyWarnings || [],
    visiblePrice: schemaAudit.visiblePrice || normalizePrice(visiblePrice) || '',
    visiblePriceSource,
    totalDetectedItems:
      detectedItemCount > 0
        ? detectedItemCount
        : combinedDetectedSchemas.length > 0
          ? combinedDetectedSchemas.length
          : 0
  };
}

function extractStructuredDataFromHtml(html, pageType, pageUrl = '') {
  const $ = cheerio.load(html);
  const effectivePageType = resolveSchemaPageType(pageUrl, pageType, html, $);
  const scripts = $('script[type="application/ld+json"]')
    .map((_, el) => $(el).html() || '')
    .get();
  const parseResult = parseJsonLdScripts(scripts);
  const breadcrumbTrail = extractBreadcrumbTrailFromCheerio($, pageUrl);
  const breadcrumbUiCandidates = extractBreadcrumbUiCandidates($, pageUrl);
  const microdataItems = extractMicrodataItems($);
  const visiblePriceResult = extractVisiblePriceResult($);
  const visiblePrice = visiblePriceResult.value;
  const rawShopifyPriceCandidates = extractRawShopifyPriceCandidates($, html);
  const rawShopifyPrice = extractRawShopifyPrice($, html, visiblePrice);
  const selectedVariantId = extractSelectedVariantId($, html, pageUrl);
  const visibleAvailability = extractVisibleAvailability($, selectedVariantId);
  const visibleAvailabilityCandidates = extractVisibleAvailabilityCandidates(
    $,
    selectedVariantId
  );
  const visibleReviewData = extractVisibleReviewData($);
  const pageTitle = normalizeText($('h1').first().text() || $('title').text());
  const productUrlCandidates = collectProductUrlCandidates($, pageUrl);

  return buildStructuredDataResult(
    effectivePageType,
    parseResult,
    'raw-html',
    pageUrl,
    scripts,
    breadcrumbTrail,
    microdataItems,
    visiblePriceResult,
    visibleAvailability,
    rawShopifyPrice,
    rawShopifyPriceCandidates,
    visibleAvailabilityCandidates,
    breadcrumbUiCandidates,
    productUrlCandidates,
    selectedVariantId,
    visibleReviewData,
    pageTitle
  );
}

async function extractStructuredDataWithPuppeteer(url, pageType) {
  let puppeteer;

  try {
    puppeteer = require('puppeteer');
  } catch (error) {
    return {
      error: 'Puppeteer not installed'
    };
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true
    });

    const page = await browser.newPage();
    await page.goto(url, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });

    const renderedData = await page.evaluate(() => {
      const scriptContents = Array.from(
        document.querySelectorAll('script[type="application/ld+json"]')
      ).map(node => node.textContent || '');

      const selectorMatches = document.querySelectorAll(
        'nav[aria-label*="breadcrumb" i], nav[aria-label*="breadcrumbs" i], [class*="breadcrumb" i], [class*="breadcrumbs" i], [data-testid*="breadcrumb" i]'
      ).length;

      const containers = Array.from(document.querySelectorAll('nav, ol, ul, div'));
      const breadcrumbTrail = containers.some(node => {
        const links = node.querySelectorAll('a').length;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();

        return links >= 3 && /home\s*(>|\/|\u203a|\u00bb|\u2192|&rsaquo;).+\s*(>|\/|\u203a|\u00bb|\u2192|&rsaquo;).+/i.test(text);
      });

      const priceSelectors = [
        '[itemprop="price"]',
        '[data-product-price]',
        '[data-testid*="price" i]',
        '.price-item--regular',
        '.price-item',
        '.product__price',
        '.price',
        '.money'
      ];

      let visiblePrice = '';
      for (const selector of priceSelectors) {
        const match = Array.from(document.querySelectorAll(selector))
          .map(node => (node.getAttribute('content') || node.textContent || '').replace(/\s+/g, ' ').trim())
          .find(Boolean);

        if (match) {
          visiblePrice = match;
          break;
        }
      }

      if (!visiblePrice) {
        const bodyText = (document.body?.textContent || '').replace(/\s+/g, ' ').trim();
        const fallbackMatch = bodyText.match(/(?:\u20b9|Rs\.?|INR)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i);
        visiblePrice = fallbackMatch ? fallbackMatch[1] : '';
      }

      const selectedVariantId =
        new URL(window.location.href).searchParams.get('variant') ||
        document.querySelector('input[name="id"][value]')?.getAttribute('value') ||
        document.querySelector('select[name="id"] option[selected][value]')?.getAttribute('value') ||
        document.querySelector('[data-selected-variant-id]')?.getAttribute('data-selected-variant-id') ||
        document.querySelector('[data-current-variant-id]')?.getAttribute('data-current-variant-id') ||
        document.querySelector('[data-variant-id][aria-selected="true"], [data-variant-id].is-selected, [data-variant-id].selected')?.getAttribute('data-variant-id') ||
        '';

      return {
        scriptContents,
        visiblePrice,
        selectedVariantId,
        breadcrumbUiPresent: selectorMatches > 0 || breadcrumbTrail
      };
    });

    const parseResult = parseJsonLdScripts(renderedData.scriptContents);
    const renderedHtml = await page.content();
    const rendered$ = cheerio.load(renderedHtml);
    const renderedMicrodataItems = extractMicrodataItems(rendered$);
    const breadcrumbTrail = extractBreadcrumbTrailFromCheerio(rendered$, url);
    const breadcrumbUiCandidates = extractBreadcrumbUiCandidates(rendered$, url);
    const visiblePriceResult = extractVisiblePriceResult(rendered$);
    const selectedVariantId =
      extractSelectedVariantId(rendered$, renderedHtml, url) ||
      renderedData.selectedVariantId ||
      '';
    const rawShopifyPrice = extractRawShopifyPrice(
      rendered$,
      renderedHtml,
      visiblePriceResult.value || renderedData.visiblePrice
    );
    const rawShopifyPriceCandidates = extractRawShopifyPriceCandidates(
      rendered$,
      renderedHtml
    );
    const visibleAvailability = extractVisibleAvailability(
      rendered$,
      selectedVariantId
    );
    const visibleAvailabilityCandidates = extractVisibleAvailabilityCandidates(
      rendered$,
      selectedVariantId
    );
    const visibleReviewData = extractVisibleReviewData(rendered$);
    const pageTitle = normalizeText(
      rendered$('h1').first().text() || rendered$('title').text()
    );

    return buildStructuredDataResult(
      pageType,
      parseResult,
      'puppeteer',
      url,
      renderedData.scriptContents,
      breadcrumbTrail,
      renderedMicrodataItems,
      visiblePriceResult.value
        ? visiblePriceResult
        : {
            value: normalizePrice(renderedData.visiblePrice) || '',
            source: 'rendered page probe',
            candidates: []
          },
      visibleAvailability,
      rawShopifyPrice,
      rawShopifyPriceCandidates,
      visibleAvailabilityCandidates,
      breadcrumbUiCandidates,
      collectProductUrlCandidates(rendered$, url),
      selectedVariantId,
      visibleReviewData,
      pageTitle
    );
  } catch (error) {
    return {
      error: error.message
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function extractStructuredDataForPage({ url, html, pageType }) {
  const effectivePageType = resolveSchemaPageType(url, pageType, html, cheerio.load(html));
  const rawResult = extractStructuredDataFromHtml(html, effectivePageType, url);

  console.log(
    `[structured-data:raw] ${url} pageType=${effectivePageType} scripts=${rawResult.scriptCount} parsed=${rawResult.parsedScriptCount} types=${rawResult.detectedSchemas.join(', ') || 'none'}`
  );

  if (
    rawResult.detectedSchemas.length > 0 ||
    rawResult.microdataItemCount > 0 ||
    rawResult.hasStructuredData
  ) {
    return rawResult;
  }

  const renderedResult = await extractStructuredDataWithPuppeteer(
    url,
    effectivePageType
  );

  if (!renderedResult.error) {
    console.log(
      `[structured-data:puppeteer] ${url} pageType=${effectivePageType} scripts=${renderedResult.scriptCount} parsed=${renderedResult.parsedScriptCount} types=${renderedResult.detectedSchemas.join(', ') || 'none'}`
    );

    return renderedResult;
  }

  console.log(
    `[structured-data:fallback] ${url} using raw HTML result because Puppeteer failed: ${renderedResult.error}`
  );

  return {
    ...rawResult,
    fallbackReason: renderedResult.error
  };
}

module.exports = {
  normalizeSchemaType,
  parseJsonLdScripts,
  resolveSchemaPageType,
  detectBreadcrumbUiFromCheerio,
  extractBreadcrumbTrailFromCheerio,
  extractStructuredDataFromHtml,
  extractStructuredDataWithPuppeteer,
  extractStructuredDataForPage,
  buildBreadcrumbListSample
};

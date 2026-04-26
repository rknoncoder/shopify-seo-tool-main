const cheerio = require('cheerio');
const {
  extractMicrodataItems,
  buildSchemaAudit,
  normalizePrice,
  normalizeAvailability
} = require('../audits/schemaAudit');
const { detectShopifyPageType } = require('../utils/pageTypeDetector');
const { buildMissingSchemas } = require('../utils/schemaRules');
const {
  hasAnySchemaType,
  normalizeSchemaType,
  normalizeSchemaTypes
} = require('../utils/schemaTypes');

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

function getNodeDescriptor($, element) {
  if (!element) {
    return '';
  }

  const node = $(element);
  return normalizeText(
    [
      element.name,
      node.attr('class'),
      node.attr('id'),
      node.attr('data-testid'),
      node.attr('name'),
      node.parent().attr('class'),
      node.parent().attr('id'),
      node.closest('[class*="stl-" i], [class*="bundle" i], [class*="combo" i], [class*="look" i], [data-testid*="bundle" i], [data-testid*="combo" i], [data-testid*="look" i]').attr('class'),
      node.closest('form[action*="/cart/add"], [class*="product" i], [class*="price" i], [class*="cart" i], [class*="offer" i], [class*="buy" i]').attr('class')
    ].join(' ')
  );
}

function isHiddenVariantPriceElement($, element) {
  if (!element) {
    return false;
  }

  const node = $(element);
  const descriptor = getNodeDescriptor($, element);
  const hasVariantPriceAttribute =
    node.attr('data-price') !== undefined ||
    node.attr('data-variant-price') !== undefined ||
    node.attr('data-product-price') !== undefined;

  return (
    node.is('option') ||
    node.is('select') ||
    (
      hasVariantPriceAttribute &&
      (
        node.closest('select[name="id"], .stl-option-select, [data-variant-json]').length > 0 ||
        /(stl-option-select|selected variant)/i.test(descriptor)
      )
    )
  );
}

function isLookBundleProductPage($) {
  const pageDescriptor = normalizeText(
    [
      $('body').attr('class'),
      $('h1').first().text(),
      $('[class*="stl-product-section" i], [class*="combo" i], [class*="bundle" i], [class*="complete-look" i], [class*="full-look" i], [data-testid*="bundle" i], [data-testid*="combo" i], [data-testid*="look" i]')
        .slice(0, 8)
        .map((_, element) =>
          [
            $(element).attr('class'),
            $(element).attr('id'),
            $(element).attr('data-testid')
          ].join(' ')
        )
        .get()
        .join(' ')
    ].join(' ')
  );

  return /(stl-product-section|shop\s+the\s+look|complete\s+the\s+look|full\s+look|\blook\b|bundle|combo)/i.test(pageDescriptor);
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
      node.closest('[class*="stl-" i], [class*="bundle" i], [class*="combo" i], [class*="look" i], [data-testid*="bundle" i], [data-testid*="combo" i], [data-testid*="look" i]').attr('class'),
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
  const isHiddenVariantPrice = isHiddenVariantPriceElement($, element);

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
  if (isHiddenVariantPrice) {
    score -= 120;
  }

  return {
    value: token.value,
    score,
    source: selectorConfig?.source || 'body currency fallback',
    text: directText || token.raw,
    isMrp,
    isHiddenVariantPrice
  };
}

function buildIgnoredHiddenVariantPriceNote(hiddenCandidates = [], selectedCandidate, isLookBundlePage) {
  if (!selectedCandidate || hiddenCandidates.length === 0) {
    return '';
  }

  const hiddenValues = Array.from(
    new Set(hiddenCandidates.map(candidate => candidate.value).filter(Boolean))
  );
  if (hiddenValues.length === 0) {
    return '';
  }

  const context = isLookBundlePage ? ' on look/combo/bundle-style page' : '';
  return `Ignored hidden variant data-price value(s) ${hiddenValues.join(', ')}${context}; selected visible page-level selling price ${selectedCandidate.value}.`;
}

function extractVisiblePriceResult($) {
  const candidates = [];
  const lookBundlePage = isLookBundleProductPage($);

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
  const visiblePrimaryCandidates = primaryCandidates.filter(
    candidate => !candidate.isHiddenVariantPrice
  );
  const hiddenVariantCandidates = primaryCandidates.filter(
    candidate => candidate.isHiddenVariantPrice
  );
  const candidatePool =
    visiblePrimaryCandidates.length > 0
      ? visiblePrimaryCandidates
      : primaryCandidates.length > 0
        ? primaryCandidates
        : candidates;
  const sorted = candidatePool
    .sort((left, right) => right.score - left.score);
  const best = sorted[0];
  const ignoredHiddenVariantCandidates =
    best && visiblePrimaryCandidates.length > 0
      ? hiddenVariantCandidates
      : [];

  return {
    value: best?.value || '',
    source: best
      ? `${best.source}: ${best.text.slice(0, 120)}`
      : 'not detected',
    debugNote: buildIgnoredHiddenVariantPriceNote(
      ignoredHiddenVariantCandidates,
      best,
      lookBundlePage
    ),
    supportingHiddenVariantPrices: Array.from(
      new Set(hiddenVariantCandidates.map(candidate => candidate.value).filter(Boolean))
    )
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

function extractRawShopifyPrice($, html = '', visiblePrice = '') {
  if (!/Shopify|cdn\.shopify\.com|\/cart\/add|ProductJson|data-product-json/i.test(html)) {
    return '';
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
        collectPriceValuesFromObject(JSON.parse(content), candidates);
      } catch (error) {
        // Fall through to regex extraction for app/theme payloads that are JS-like.
      }
    }

    const pricePattern = /["']?(price|price_min|price_max|compare_at_price|compare_at_price_min|compare_at_price_max)["']?\s*:\s*["']?(\d{3,})(?!\.)["']?/gi;
    let match;
    while ((match = pricePattern.exec(content)) !== null) {
      candidates.push({
        value: match[2],
        kind: /^compare_at/i.test(match[1]) ? 'compare_at' : 'price'
      });
    }
  });

  $('[data-product-json], [data-variant-json], [data-shopify-product]')
    .each((_, element) => {
      Object.values(element.attribs || {}).forEach(value => {
        const match = String(value || '').match(/\b\d{3,}\b/);
        if (match) {
          candidates.push({ value: match[0], kind: 'price' });
        }
      });
    });

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

function normalizeBreadcrumbComparableText(value) {
  return normalizeText(value)
    .replace(/[-_]+/g, ' ')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getCurrentPageBreadcrumbLabel(pageUrl = '') {
  try {
    const parsedUrl = new URL(pageUrl);
    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    return normalizeBreadcrumbComparableText(
      toBreadcrumbLabel(segments[segments.length - 1] || '')
    );
  } catch (error) {
    return '';
  }
}

function isIgnoredBreadcrumbContainer($, element) {
  const node = $(element);
  const descriptor = normalizeText(
    [
      element?.name,
      node.attr('class'),
      node.attr('id'),
      node.attr('role'),
      node.attr('aria-label'),
      node.attr('data-testid')
    ].join(' ')
  );

  return (
    node.closest('header, footer, aside').length > 0 ||
    /(header|footer|site-nav|main-menu|mega-menu|drawer|mobile-menu|pagination|product-tab|tabs?|tablist|social|newsletter)/i.test(descriptor)
  );
}

function isPageRelevantBreadcrumbText(text = '', pageUrl = '') {
  const currentLabel = getCurrentPageBreadcrumbLabel(pageUrl);
  if (!currentLabel) {
    return true;
  }

  return normalizeBreadcrumbComparableText(text).includes(currentLabel);
}

function hasBreadcrumbEvidence({
  links = [],
  text = '',
  explicit = false,
  pageUrl = '',
  $ = null,
  element = null
}) {
  const normalizedLinks = links || [];
  const normalizedText = normalizeText(text);
  const startsWithHome =
    normalizedLinks.length > 0 &&
    /^home$/i.test(String(normalizedLinks[0].name || '').trim());

  if (!explicit && $ && element && isIgnoredBreadcrumbContainer($, element)) {
    return false;
  }

  if (explicit) {
    return (
      (normalizedLinks.length >= 2 && (startsWithHome || hasBreadcrumbTrailText(normalizedText))) ||
      hasBreadcrumbTrailText(normalizedText)
    );
  }

  return (
    hasBreadcrumbTrailText(normalizedText) &&
    isPageRelevantBreadcrumbText(normalizedText, pageUrl)
  );
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

    if (hasBreadcrumbEvidence({
      links,
      text,
      explicit: true,
      pageUrl,
      $,
      element
    })) {
      return {
        present: true,
        links
      };
    }
  }

  const explicitTrailText = explicitElements
    .map(element => $(element).text())
    .join(' ');
  if (
    explicitElements.length > 0 &&
    hasBreadcrumbEvidence({
      text: explicitTrailText,
      explicit: true,
      pageUrl
    })
  ) {
    return {
      present: true,
      links: []
    };
  }

  let trail = {
    present: false,
    links: []
  };

  $('main nav, main ol, main ul, main div, [role="main"] nav, [role="main"] ol, [role="main"] ul, [role="main"] div').each((_, el) => {
    const links = extractBreadcrumbLinksFromElement($, el, pageUrl);
    const text = $(el).text();

    if (hasBreadcrumbEvidence({
      links,
      text,
      explicit: false,
      pageUrl,
      $,
      element: el
    })) {
      trail = {
        present: true,
        links
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
  breadcrumbTrail = { present: false, links: [] },
  microdataItems = [],
  visiblePrice = '',
  visiblePriceSource = '',
  visiblePriceDebugNote = '',
  supportingHiddenVariantPrices = [],
  visibleAvailability = '',
  rawShopifyPrice = '',
  selectedVariantId = '',
  visibleReviewData = {},
  pageTitle = ''
) {
  const normalizedBreadcrumbTrail =
    typeof breadcrumbTrail === 'boolean'
      ? { present: breadcrumbTrail, links: [] }
      : breadcrumbTrail || { present: false, links: [] };
  const breadcrumbUiPresent = Boolean(normalizedBreadcrumbTrail.present);
  const microdataTypes = normalizeSchemaTypes(
    microdataItems.flatMap(item => item.types || [])
  ).sort();
  const combinedDetectedSchemas = normalizeSchemaTypes([
    ...(parseResult.detectedSchemas || []),
    ...microdataTypes
  ]).sort();
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

  const schemaAudit = buildSchemaAudit({
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
    visiblePriceDebugNote,
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
    missingSchemas,
    confidence,
    source,
    breadcrumbUiPresent,
    breadcrumbLinks: normalizedBreadcrumbTrail.links || [],
    issues,
    recommendations,
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
    expectedSchemaTypes: schemaAudit.expectedSchemaTypes || [],
    missingRequiredSchema: schemaAudit.missingRequiredSchema || [],
    missingRecommendedSchema: schemaAudit.missingRecommendedSchema || [],
    unexpectedSchemaTypes: schemaAudit.unexpectedSchemaTypes || [],
    schemaConflicts: schemaAudit.schemaConflicts || [],
    richResultSummary: schemaAudit.richResultSummary || {},
    schemaRecommendations: schemaAudit.schemaRecommendations || [],
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
    visiblePrice: normalizePrice(visiblePrice) || '',
    visiblePriceSource,
    visiblePriceDebugNote,
    supportingHiddenVariantPrices,
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
  const microdataItems = extractMicrodataItems($);
  const visiblePriceResult = extractVisiblePriceResult($);
  const visiblePrice = visiblePriceResult.value;
  const rawShopifyPrice = extractRawShopifyPrice($, html, visiblePrice);
  const selectedVariantId = extractSelectedVariantId($, html, pageUrl);
  const visibleAvailability = extractVisibleAvailability($, selectedVariantId);
  const visibleReviewData = extractVisibleReviewData($);
  const pageTitle = normalizeText($('h1').first().text() || $('title').text());

  return buildStructuredDataResult(
    effectivePageType,
    parseResult,
    'raw-html',
    pageUrl,
    breadcrumbTrail,
    microdataItems,
    visiblePrice,
    visiblePriceResult.source,
    visiblePriceResult.debugNote,
    visiblePriceResult.supportingHiddenVariantPrices,
    visibleAvailability,
    rawShopifyPrice,
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
    const visibleAvailability = extractVisibleAvailability(
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
      breadcrumbTrail,
      renderedMicrodataItems,
      visiblePriceResult.value || normalizePrice(renderedData.visiblePrice) || '',
      visiblePriceResult.source,
      visiblePriceResult.debugNote,
      visiblePriceResult.supportingHiddenVariantPrices,
      visibleAvailability,
      rawShopifyPrice,
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

function hasExpectedSchemaForPageType(pageType, schemaTypes = []) {
  if (pageType === 'product') {
    return (
      hasAnySchemaType(schemaTypes, ['Product', 'ProductGroup']) &&
      hasAnySchemaType(schemaTypes, ['Offer', 'AggregateOffer'])
    );
  }

  if (pageType === 'collection') {
    return (
      hasAnySchemaType(schemaTypes, ['CollectionPage', 'WebPage']) &&
      hasAnySchemaType(schemaTypes, ['BreadcrumbList'])
    );
  }

  if (pageType === 'blog') {
    return hasAnySchemaType(schemaTypes, ['Article', 'BlogPosting']);
  }

  if (pageType === 'homepage') {
    return (
      hasAnySchemaType(schemaTypes, ['Organization']) &&
      hasAnySchemaType(schemaTypes, ['WebSite'])
    );
  }

  if (pageType === 'search') {
    return hasAnySchemaType(schemaTypes, ['SearchResultsPage', 'WebPage']);
  }

  return hasAnySchemaType(schemaTypes, ['WebPage']);
}

function shouldRunRenderedSchemaExtraction(rawResult, pageType) {
  if (!rawResult?.hasStructuredData) {
    return true;
  }

  if ((rawResult.jsonLdErrors || []).length > 0) {
    return true;
  }

  return !hasExpectedSchemaForPageType(
    pageType,
    rawResult.detectedSchemaTypes || rawResult.schemaTypes || []
  );
}

function mergeErrorLists(...errorLists) {
  return Array.from(
    new Map(
      errorLists
        .flat()
        .filter(Boolean)
        .map(error => [
          [error.message, error.line, error.column, error.snippet].join('|'),
          error
        ])
    ).values()
  );
}

function mergeStructuredDataResults(rawResult, renderedResult) {
  const schemaTypes = normalizeSchemaTypes([
    ...(rawResult.schemaTypes || rawResult.detectedSchemas || []),
    ...(renderedResult.schemaTypes || renderedResult.detectedSchemas || [])
  ]).sort();
  const detectedSchemaTypes = normalizeSchemaTypes([
    ...(rawResult.detectedSchemaTypes || []),
    ...(renderedResult.detectedSchemaTypes || []),
    ...schemaTypes
  ]).sort();
  const jsonLdErrors = mergeErrorLists(
    rawResult.jsonLdErrors || [],
    renderedResult.jsonLdErrors || []
  );
  const schemaParseErrors = mergeErrorLists(
    rawResult.schemaParseErrors || [],
    renderedResult.schemaParseErrors || []
  );

  return {
    ...renderedResult,
    source:
      rawResult.source && renderedResult.source && rawResult.source !== renderedResult.source
        ? `${rawResult.source}+${renderedResult.source}`
        : renderedResult.source || rawResult.source,
    detectedSchemas: schemaTypes,
    schemaTypes,
    detectedSchemaTypes,
    scriptCount: Math.max(rawResult.scriptCount || 0, renderedResult.scriptCount || 0),
    parsedScriptCount: Math.max(
      rawResult.parsedScriptCount || 0,
      renderedResult.parsedScriptCount || 0
    ),
    schemaObjectCount: Math.max(
      rawResult.schemaObjectCount || 0,
      renderedResult.schemaObjectCount || 0
    ),
    microdataTypes: normalizeSchemaTypes([
      ...(rawResult.microdataTypes || []),
      ...(renderedResult.microdataTypes || [])
    ]).sort(),
    microdataItemCount: Math.max(
      rawResult.microdataItemCount || 0,
      renderedResult.microdataItemCount || 0
    ),
    totalDetectedItems: Math.max(
      rawResult.totalDetectedItems || 0,
      renderedResult.totalDetectedItems || 0,
      detectedSchemaTypes.length
    ),
    jsonLdErrors,
    schemaParseErrors,
    hasStructuredData: Boolean(
      rawResult.hasStructuredData || renderedResult.hasStructuredData
    ),
    renderedMergeReason:
      'Raw HTML lacked expected page-type schema, so rendered/app-injected schema was evaluated.'
  };
}

async function extractStructuredDataForPage({ url, html, pageType }) {
  const effectivePageType = resolveSchemaPageType(url, pageType, html, cheerio.load(html));
  const rawResult = extractStructuredDataFromHtml(html, effectivePageType, url);

  console.log(
    `[structured-data:raw] ${url} pageType=${effectivePageType} scripts=${rawResult.scriptCount} parsed=${rawResult.parsedScriptCount} types=${rawResult.detectedSchemas.join(', ') || 'none'}`
  );

  if (!shouldRunRenderedSchemaExtraction(rawResult, effectivePageType)) {
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

    return mergeStructuredDataResults(rawResult, renderedResult);
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

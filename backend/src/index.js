const ShopifyCrawler = require('./crawlers/shopifyCrawler');

async function startCrawler(initialUrls = [], startUrl = process.env.AUDIT_URL || 'https://www.triprindia.com') {
  const crawler = new ShopifyCrawler(startUrl);
  return crawler.start(initialUrls);
}

module.exports = startCrawler;

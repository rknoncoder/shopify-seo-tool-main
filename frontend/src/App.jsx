import { useEffect, useState } from 'react';

const fallbackAudit = {
  pages: [
    {
      url: 'https://triprindia.com/products/mens-round-neck-full-sleeve-plain-t-shirts-9-colours',
      pageType: 'product',
      title: "Men's Round Neck Full Sleeve Plain T-shirt - TRIPR",
      metaDescription:
        "Buy men's round neck full sleeve plain t-shirt online at TRIPR. Comfortable fabric, multiple colors, and fast delivery.",
      h1: "Men's Round Neck Full Sleeve Plain T-shirt",
      structuredData: {
        schemaAudit: {
          visiblePrice: '349.00',
          rows: [
            {
              type: 'Google Eligibility',
              status: 'Pass',
              recommendation:
                'Keep the Product markup complete with name, image, price, and availability.'
            },
            {
              type: 'Rich Result Warnings',
              status: 'Warning',
              warnings: 'gtin13, color, material',
              recommendation:
                'Add optional Product fields like gtin13, color, material to improve filtered search visibility.'
            }
          ]
        }
      }
    }
  ]
};

function getAuditPages() {
  if (typeof window !== 'undefined' && window.__SEO_AUDIT__?.pages) {
    return window.__SEO_AUDIT__.pages;
  }

  return fallbackAudit.pages;
}

function getSchemaAuditRows(page) {
  return (
    page?.schemaAudit?.rows ||
    page?.structuredDataReport?.schemaAudit?.rows ||
    page?.structuredData?.schemaAudit?.rows ||
    []
  );
}

function getSchemaAuditRow(page, type) {
  return getSchemaAuditRows(page).find(row => row.type === type);
}

function hasEligibilityPass(page) {
  return getSchemaAuditRow(page, 'Google Eligibility')?.status === 'Pass';
}

function getVisiblePrice(page) {
  return (
    page?.structuredData?.schemaAudit?.visiblePrice ||
    page?.schemaAudit?.visiblePrice ||
    ''
  );
}

function getAvailabilityLabel(page) {
  const eligibilityRow = getSchemaAuditRow(page, 'Google Eligibility');

  if (eligibilityRow?.status === 'Pass') {
    return 'In stock';
  }

  return 'Availability not confirmed';
}

function buildPreviewModel(page) {
  const title = page.h1 || page.title || 'Untitled product';
  const price = getVisiblePrice(page);

  return {
    title,
    url: page.url,
    siteName: new URL(page.url).hostname.replace(/^www\./, ''),
    description: page.metaDescription || 'No meta description available.',
    price: price ? `Rs. ${price}` : 'Price unavailable',
    availability: getAvailabilityLabel(page)
  };
}

function ResultRow({ page, onPreview }) {
  const googleEligibility = getSchemaAuditRow(page, 'Google Eligibility');
  const richWarnings = getSchemaAuditRow(page, 'Rich Result Warnings');

  return (
    <div className="result-row">
      <div className="result-main">
        <div className="result-url">{page.url}</div>
        <div className="result-title">{page.h1 || page.title}</div>
        <div className="result-badges">
          <span className={`badge badge-${(googleEligibility?.status || 'warning').toLowerCase()}`}>
            Google Eligibility: {googleEligibility?.status || 'Unknown'}
          </span>
          {richWarnings?.warnings ? (
            <span className="badge badge-warning">
              Warnings: {richWarnings.warnings}
            </span>
          ) : null}
        </div>
      </div>

      {hasEligibilityPass(page) ? (
        <button className="preview-button" onClick={() => onPreview(page)}>
          Rich Result Preview
        </button>
      ) : (
        <span className="preview-disabled">Preview unavailable</span>
      )}
    </div>
  );
}

function PreviewCard({ page }) {
  if (!page) {
    return (
      <div className="preview-empty">
        Select a product page with a Google Eligibility pass to preview its rich result card.
      </div>
    );
  }

  const model = buildPreviewModel(page);

  return (
    <div className="preview-card">
      <div className="preview-searchbar">google.com/search?q={encodeURIComponent(model.title)}</div>
      <div className="preview-site">{model.siteName}</div>
      <div className="preview-link">{model.url}</div>
      <div className="preview-heading">{model.title}</div>
      <div className="preview-meta">
        <span className="preview-price">{model.price}</span>
        <span className="preview-dot">&middot;</span>
        <span className="preview-availability">{model.availability}</span>
      </div>
      <div className="preview-description">{model.description}</div>
    </div>
  );
}

export default function App() {
  const [pages, setPages] = useState([]);
  const [selectedPage, setSelectedPage] = useState(null);

  useEffect(() => {
    const nextPages = getAuditPages();
    setPages(nextPages);
    setSelectedPage(nextPages.find(hasEligibilityPass) || null);
  }, []);

  return (
    <div className="app-shell">
      <style>{`
        :root {
          color: #1e2430;
          background: linear-gradient(180deg, #f7f1e6 0%, #f5f8fb 100%);
          font-family: "Segoe UI", "Trebuchet MS", sans-serif;
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
        }

        .app-shell {
          min-height: 100vh;
          padding: 32px 20px 48px;
        }

        .app-grid {
          display: grid;
          grid-template-columns: minmax(320px, 1.2fr) minmax(320px, 0.8fr);
          gap: 24px;
          max-width: 1400px;
          margin: 0 auto;
        }

        .panel {
          background: rgba(255, 255, 255, 0.92);
          border: 1px solid rgba(28, 42, 61, 0.08);
          border-radius: 24px;
          box-shadow: 0 18px 50px rgba(34, 49, 63, 0.08);
          padding: 24px;
          backdrop-filter: blur(8px);
        }

        .eyebrow {
          display: inline-block;
          border-radius: 999px;
          padding: 6px 12px;
          background: #ecf4eb;
          color: #215a30;
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
        }

        h1 {
          margin: 14px 0 8px;
          font-size: 34px;
          line-height: 1.08;
        }

        .subcopy {
          margin: 0 0 24px;
          color: #5b6474;
          line-height: 1.6;
        }

        .results-list {
          display: grid;
          gap: 14px;
        }

        .result-row {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          padding: 16px;
          border-radius: 18px;
          background: #fbfcfe;
          border: 1px solid #e5ebf2;
          align-items: center;
        }

        .result-main {
          min-width: 0;
        }

        .result-url {
          color: #64748b;
          font-size: 12px;
          overflow-wrap: anywhere;
        }

        .result-title {
          margin-top: 6px;
          font-size: 17px;
          font-weight: 700;
          color: #1f2937;
        }

        .result-badges {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          margin-top: 10px;
        }

        .badge {
          border-radius: 999px;
          padding: 6px 10px;
          font-size: 12px;
          font-weight: 600;
        }

        .badge-pass {
          background: #e7f8ea;
          color: #17663b;
        }

        .badge-warning {
          background: #fff2d8;
          color: #8a5a00;
        }

        .badge-error {
          background: #ffe0dc;
          color: #9b2c2c;
        }

        .preview-button {
          border: none;
          border-radius: 14px;
          background: #1f5eff;
          color: white;
          padding: 12px 16px;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
        }

        .preview-button:hover {
          background: #194ddb;
        }

        .preview-disabled {
          color: #8b95a7;
          font-size: 13px;
          font-weight: 600;
          white-space: nowrap;
        }

        .preview-card,
        .preview-empty {
          border-radius: 22px;
          background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
          border: 1px solid #e5ebf2;
          padding: 24px;
          min-height: 280px;
        }

        .preview-searchbar {
          border-radius: 999px;
          border: 1px solid #dde5ef;
          padding: 12px 16px;
          color: #6b7280;
          margin-bottom: 20px;
          font-size: 13px;
        }

        .preview-site {
          color: #188038;
          font-size: 13px;
          margin-bottom: 4px;
        }

        .preview-link {
          color: #5f6368;
          font-size: 12px;
          margin-bottom: 10px;
          overflow-wrap: anywhere;
        }

        .preview-heading {
          color: #1a0dab;
          font-size: 24px;
          line-height: 1.25;
          margin-bottom: 10px;
        }

        .preview-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          color: #3c4043;
          font-weight: 600;
          margin-bottom: 12px;
        }

        .preview-price {
          color: #137333;
        }

        .preview-dot {
          color: #9aa4b2;
        }

        .preview-description,
        .preview-empty {
          color: #4b5563;
          line-height: 1.7;
        }

        @media (max-width: 980px) {
          .app-grid {
            grid-template-columns: 1fr;
          }

          .result-row {
            flex-direction: column;
            align-items: stretch;
          }

          .preview-button,
          .preview-disabled {
            width: 100%;
            text-align: center;
          }
        }
      `}</style>

      <div className="app-grid">
        <section className="panel">
          <span className="eyebrow">Rich Result Lab</span>
          <h1>Google Eligibility Preview</h1>
          <p className="subcopy">
            Product URLs with a Google Eligibility pass can open a mock Google
            rich result preview so you can quickly review title, price, and
            availability presentation.
          </p>

          <div className="results-list">
            {pages.map(page => (
              <ResultRow
                key={page.url}
                page={page}
                onPreview={setSelectedPage}
              />
            ))}
          </div>
        </section>

        <aside className="panel">
          <span className="eyebrow">Preview</span>
          <h1>Mock Search Result</h1>
          <p className="subcopy">
            This is a visual preview, not a Google guarantee. Availability is
            inferred as in stock when Google Eligibility passes because the
            backend does not yet expose the raw availability label separately.
          </p>
          <PreviewCard page={selectedPage} />
        </aside>
      </div>
    </div>
  );
}

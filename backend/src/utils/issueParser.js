function toSnakeCase(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.toLowerCase())
    .join('_');
}

function inferSeverity(rawIssue) {
  if (/^Critical:/i.test(rawIssue)) {
    return 'critical';
  }

  if (/^High:/i.test(rawIssue)) {
    return 'high';
  }

  if (/^Warning:/i.test(rawIssue)) {
    return 'warning';
  }

  if (/^Info:/i.test(rawIssue)) {
    return 'info';
  }

  if (/^Missing\b/i.test(rawIssue)) {
    return 'critical';
  }

  return 'info';
}

function cleanSeverityPrefix(rawIssue) {
  return String(rawIssue || '')
    .replace(/^(Critical|High|Warning|Info):\s*/i, '')
    .trim();
}

function extractCount(rawIssue) {
  const bracketMatch = String(rawIssue || '').match(/\((\d+)[^)]+\)/);
  if (bracketMatch) {
    return Number(bracketMatch[1]);
  }

  const leadingMatch = String(rawIssue || '').match(/^Warning:\s*(\d+)\b/i);
  if (leadingMatch) {
    return Number(leadingMatch[1]);
  }

  return undefined;
}

function cleanMessage(rawIssue) {
  return cleanSeverityPrefix(rawIssue)
    .replace(/\s*\([^)]*\)\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferType(message) {
  const normalized = message.toLowerCase();

  const knownPatterns = [
    { pattern: /title length issue/, type: 'title_length' },
    { pattern: /meta description length issue/, type: 'meta_description_length' },
    { pattern: /missing title/, type: 'missing_title' },
    { pattern: /missing meta description/, type: 'missing_meta_description' },
    { pattern: /missing h1/, type: 'missing_h1' },
    { pattern: /images missing alt text/, type: 'missing_alt_text' },
    { pattern: /too many images/, type: 'too_many_images' },
    { pattern: /duplicate title/, type: 'duplicate_title' },
    { pattern: /duplicate meta description/, type: 'duplicate_meta_description' },
    { pattern: /duplicate body content pattern/, type: 'duplicate_content' },
    { pattern: /breadcrumb ui found but schema missing/, type: 'breadcrumb_schema_missing' },
    { pattern: /canonical chain detected/, type: 'canonical_chain' },
    { pattern: /canonical loop/, type: 'canonical_loop' },
    { pattern: /canonical points to non-200 page/, type: 'broken_canonical' },
    { pattern: /canonical points to non-indexable page/, type: 'canonical_non_indexable' },
    { pattern: /missing canonical tag/, type: 'missing_canonical' },
    { pattern: /multiple canonical tags found/, type: 'multiple_canonical_tags' }
  ];

  const match = knownPatterns.find(item => item.pattern.test(normalized));
  if (match) {
    return match.type;
  }

  return toSnakeCase(
    normalized
      .replace(/\b(issue|found|shared|with|other|page|pages)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function parseIssues(issueString) {
  if (!issueString) {
    return [];
  }

  return String(issueString)
    .split('|')
    .map(issue => issue.trim())
    .filter(Boolean)
    .map(rawIssue => {
      const severity = inferSeverity(rawIssue);
      const message = cleanMessage(rawIssue);
      const count = extractCount(rawIssue);
      const parsed = {
        type: inferType(message),
        severity,
        message
      };

      if (count !== undefined) {
        parsed.count = count;
      }

      return parsed;
    });
}

module.exports = {
  parseIssues
};

function getAuditMode() {
  return String(process.env.AUDIT_MODE || 'raw').trim().toLowerCase() ===
    'evaluated'
    ? 'evaluated'
    : 'raw';
}

function isRawAuditMode() {
  return getAuditMode() === 'raw';
}

module.exports = {
  getAuditMode,
  isRawAuditMode
};

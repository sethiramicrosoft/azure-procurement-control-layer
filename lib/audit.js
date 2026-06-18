const crypto = require('crypto');

function computeAuditHash(entry, prevHash) {
  const payload = {
    at: entry.at,
    action: entry.action,
    actor: entry.actor,
    subject: entry.subject,
    details: entry.details || null,
    prevHash: prevHash || 'GENESIS',
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function appendAuditEvent(state, event) {
  const latest = state.audit[0];
  const prevHash = latest ? latest.hash : 'GENESIS';
  const entry = {
    at: event.at,
    action: event.action,
    actor: event.actor,
    subject: event.subject,
    details: event.details || null,
    prevHash,
  };
  entry.hash = computeAuditHash(entry, prevHash);
  state.audit.unshift(entry);
  return entry;
}

function hydrateAuditChain(audit) {
  if (!Array.isArray(audit)) {
    return [];
  }
  const chronological = [...audit].reverse();
  let prevHash = 'GENESIS';
  for (const entry of chronological) {
    const normalized = {
      at: entry.at,
      action: entry.action,
      actor: entry.actor,
      subject: entry.subject,
      details: entry.details || null,
      prevHash,
    };
    normalized.hash = computeAuditHash(normalized, prevHash);
    Object.assign(entry, normalized);
    prevHash = normalized.hash;
  }
  return chronological.reverse();
}

module.exports = {
  appendAuditEvent,
  hydrateAuditChain,
};

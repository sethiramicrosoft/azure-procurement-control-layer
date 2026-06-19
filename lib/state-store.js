const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function buildAuditExporter(auditExportPath, auditExportSecret) {
  if (!auditExportPath) {
    return () => {};
  }
  const outputPath = path.resolve(auditExportPath);
  ensureDir(path.dirname(outputPath));

  return entry => {
    const signature = auditExportSecret
      ? crypto.createHmac('sha256', auditExportSecret).update(JSON.stringify(entry)).digest('hex')
      : null;
    const exported = {
      exportedAt: new Date().toISOString(),
      ...entry,
      exportSignature: signature,
    };
    fs.appendFileSync(outputPath, `${JSON.stringify(exported)}\n`, 'utf8');
  };
}

function createFileStore({ dataDir, dataFile, exportAudit }) {
  const statePath = path.resolve(dataFile);

  return {
    loadState(seedState, normalizeState) {
      ensureDir(dataDir);
      if (!fs.existsSync(statePath)) {
        const seed = seedState();
        fs.writeFileSync(statePath, JSON.stringify(seed, null, 2));
        return normalizeState(seed);
      }
      const raw = fs.readFileSync(statePath, 'utf8');
      const parsed = JSON.parse(raw);
      return normalizeState(parsed);
    },
    saveState(state) {
      ensureDir(dataDir);
      const payload = { ...state };
      delete payload._storeVersion;
      const tempFile = `${statePath}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(payload, null, 2));
      fs.renameSync(tempFile, statePath);
    },
    tryConsumeEntitlement(request, entitlement, actor) {
      if (entitlement.consumedAt) return false;
      entitlement.consumedAt = new Date().toISOString();
      entitlement.consumedBy = actor;
      return true;
    },
    exportAudit,
  };
}

function createSqliteStore({ dataDir, sqliteDbPath, exportAudit }) {
  const dbPath = path.resolve(sqliteDbPath);
  ensureDir(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS state_snapshots (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entitlement_consumptions (
      token_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      consumed_at TEXT NOT NULL,
      consumed_by TEXT NOT NULL
    );
  `);

  const selectSnapshot = db.prepare('SELECT payload, version FROM state_snapshots WHERE id = 1');
  const insertSnapshot = db.prepare('INSERT INTO state_snapshots (id, payload, version, updated_at) VALUES (1, ?, 1, ?)');
  const updateSnapshot = db.prepare('UPDATE state_snapshots SET payload = ?, version = ?, updated_at = ? WHERE id = 1 AND version = ?');
  const insertConsumption = db.prepare('INSERT INTO entitlement_consumptions (token_id, request_id, consumed_at, consumed_by) VALUES (?, ?, ?, ?)');

  return {
    loadState(seedState, normalizeState) {
      ensureDir(dataDir);
      const row = selectSnapshot.get();
      if (!row) {
        const seed = seedState();
        insertSnapshot.run(JSON.stringify(seed), new Date().toISOString());
        const normalized = normalizeState(seed);
        normalized._storeVersion = 1;
        return normalized;
      }
      const parsed = JSON.parse(row.payload);
      const normalized = normalizeState(parsed);
      normalized._storeVersion = Number(row.version || 1);
      return normalized;
    },
    saveState(state) {
      const payload = { ...state };
      const currentVersion = Number(payload._storeVersion || 1);
      delete payload._storeVersion;
      const nextVersion = currentVersion + 1;
      const result = updateSnapshot.run(
        JSON.stringify(payload),
        nextVersion,
        new Date().toISOString(),
        currentVersion
      );
      if (result.changes !== 1) {
        throw new Error('state write conflict detected; retry request');
      }
      state._storeVersion = nextVersion;
    },
    tryConsumeEntitlement(request, entitlement, actor) {
      if (entitlement.consumedAt) return false;
      const consumedAt = new Date().toISOString();
      try {
        insertConsumption.run(entitlement.id, request.id, consumedAt, actor);
      } catch {
        return false;
      }
      entitlement.consumedAt = consumedAt;
      entitlement.consumedBy = actor;
      return true;
    },
    exportAudit,
  };
}

function createStateStore({ dataDir, dataFile, sqliteDbPath, backend, auditExportPath, auditExportSecret }) {
  const exportAudit = buildAuditExporter(auditExportPath, auditExportSecret);
  const selected = String(backend || 'file').toLowerCase();
  if (selected === 'sqlite') {
    return createSqliteStore({ dataDir, sqliteDbPath, exportAudit });
  }
  return createFileStore({ dataDir, dataFile, exportAudit });
}

module.exports = {
  createStateStore,
};

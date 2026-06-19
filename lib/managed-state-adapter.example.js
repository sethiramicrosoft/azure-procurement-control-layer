const fs = require('fs');
const path = require('path');

const SNAPSHOT_FILE = process.env.APCL_MANAGED_STATE_SNAPSHOT_FILE || path.resolve(__dirname, '..', 'data', 'managed-state-snapshot.json');

function ensureDirFor(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

module.exports = {
  loadState(seedState, normalizeState) {
    ensureDirFor(SNAPSHOT_FILE);
    if (!fs.existsSync(SNAPSHOT_FILE)) {
      const seed = seedState();
      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(seed, null, 2), 'utf8');
      return normalizeState(seed);
    }
    const parsed = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    return normalizeState(parsed);
  },

  saveState(state) {
    const payload = { ...state };
    delete payload._storeVersion;
    ensureDirFor(SNAPSHOT_FILE);
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(payload, null, 2), 'utf8');
  },

  tryConsumeEntitlement(request, entitlement, actor) {
    if (entitlement.consumedAt) return false;
    entitlement.consumedAt = new Date().toISOString();
    entitlement.consumedBy = actor;
    return true;
  },
};

'use strict';

const fs = require('fs');
const path = require('path');

// Prototype-level persistence: a JSON file on disk. This is enough to make
// "Change" and "Best Position" real (computed from previously observed
// positions) rather than fabricated — but it is NOT safe for a real
// multi-instance deployment. Swap for a real database (Postgres, etc.)
// before running this anywhere with more than one server process, since
// concurrent writes to this file can race and lose data.
const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'rank-history.json');

function loadAll() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveAll(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to persist rank history:', err.message);
  }
}

function keyFor(domain, keyword) {
  return `${domain.toLowerCase()}::${keyword.toLowerCase()}`;
}

/**
 * Record a new observed position for domain+keyword (position may be null
 * if not found in the checked results) and return { change, bestPosition }
 * computed from real prior observations — never fabricated.
 */
function recordAndDiff(domain, keyword, position) {
  const all = loadAll();
  const key = keyFor(domain, keyword);
  const history = all[key] || [];
  const previous = history.length ? history[history.length - 1] : null;

  history.push({ timestamp: Date.now(), position });
  all[key] = history.slice(-50); // keep last 50 checks per keyword
  saveAll(all);

  const positionsEver = history.map((h) => h.position).filter((p) => p != null);
  const bestPosition = positionsEver.length ? Math.min(...positionsEver) : null;
  const change =
    previous && previous.position != null && position != null ? previous.position - position : null; // positive = improved (moved up)

  return { change, bestPosition, previousPosition: previous ? previous.position : null };
}

module.exports = { recordAndDiff };

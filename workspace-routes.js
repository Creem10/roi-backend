// ══════════════════════════════════════════════════════════════
// workspace-routes.js
//
// Companion backend module for Sustainability ROI Builder — Session 1
// (multi-tenant identity & save state).
//
// Adds three endpoints to your existing roi-backend Render service,
// alongside the /extract-bill route you already have:
//
//   POST /workspace/new          -> { ok:true, code:'GRN-7F3K9Q' }
//   POST /workspace/save         -> { ok:true, savedAt: ISOString }
//   GET  /workspace/load?code=.. -> { ok:true, data:{...} }
//                                   or { ok:false, error:'...' }
//
// Storage: a single SQLite file on disk (via better-sqlite3). This is
// intentionally the simplest thing that works for an MVP demo — one
// file, no external database service to provision. See the "IMPORTANT —
// Render persistent disk" note in the README before you deploy, or
// every workspace will vanish on your next redeploy.
//
// HOW TO WIRE THIS IN
// --------------------
// In your existing server file (server.js / worker.js / index.js —
// wherever you currently define `const app = express()` and mount
// `/extract-bill`), add:
//
//   const workspaceRoutes = require('./workspace-routes');
//   workspaceRoutes(app);
//
// That's it — this file is self-contained and attaches its own routes
// directly onto the app instance you pass in.
// ══════════════════════════════════════════════════════════════

const Database = require('better-sqlite3');
const express = require('express');
const path = require('path');
const crypto = require('crypto');

// DB_PATH lets you point this at a Render persistent disk mount
// (e.g. /data/workspaces.db) via an environment variable. Falls back
// to a local file for quick local testing.
const DB_PATH = process.env.WORKSPACE_DB_PATH || path.join(__dirname, 'workspaces.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS workspaces (
    code TEXT PRIMARY KEY,
    data TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
function generateCode() {
  // Format: XXXX-XXXXXX (e.g. GRN7-4F3K9Q) — short enough to read aloud
  // or type back in, long enough to not collide or be guessable.
  const part = (len) =>
    Array.from(crypto.randomBytes(len))
      .map((b) => CODE_CHARS[b % CODE_CHARS.length])
      .join('');
  return `${part(4)}-${part(6)}`;
}

function findUnusedCode() {
  const existing = db.prepare('SELECT 1 FROM workspaces WHERE code = ?');
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode();
    if (!existing.get(code)) return code;
  }
  // Astronomically unlikely to ever hit this, but fail loudly instead
  // of silently colliding if it ever does.
  throw new Error('Could not generate a unique workspace code after 10 attempts');
}

// Basic CORS handling for these three routes specifically, independent
// of whatever CORS setup your existing /extract-bill route uses — so
// this module works standalone even if mounted into a bare app.
function withCors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

module.exports = function registerWorkspaceRoutes(app) {
  app.use('/workspace', withCors);

  // ── Create a new workspace ─────────────────────────────────────
  app.post('/workspace/new', (req, res) => {
    try {
      const code = findUnusedCode();
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO workspaces (code, data, created_at, updated_at) VALUES (?, ?, ?, ?)'
      ).run(code, null, now, now);
      res.json({ ok: true, code });
    } catch (err) {
      console.error('[workspace/new] error:', err);
      res.status(500).json({ ok: false, error: 'Could not create workspace: ' + err.message });
    }
  });

  // ── Save (upsert) a workspace's data ───────────────────────────
  app.post('/workspace/save', express.json({ limit: '2mb' }), (req, res) => {
    const { code, data } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid workspace code' });
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ ok: false, error: 'Missing workspace data' });
    }
    try {
      const now = new Date().toISOString();
      const result = db
        .prepare('UPDATE workspaces SET data = ?, updated_at = ? WHERE code = ?')
        .run(JSON.stringify(data), now, code);
      if (result.changes === 0) {
        // Code not found — create it rather than silently failing, so
        // a save never gets lost even if the /new call was somehow
        // missed (e.g. a resumed code that expired server-side).
        db.prepare(
          'INSERT INTO workspaces (code, data, created_at, updated_at) VALUES (?, ?, ?, ?)'
        ).run(code, JSON.stringify(data), now, now);
      }
      res.json({ ok: true, savedAt: now });
    } catch (err) {
      console.error('[workspace/save] error:', err);
      res.status(500).json({ ok: false, error: 'Could not save workspace: ' + err.message });
    }
  });

  // ── Load a workspace's data ─────────────────────────────────────
  app.get('/workspace/load', (req, res) => {
    const code = (req.query.code || '').toString().trim();
    if (!code) {
      return res.status(400).json({ ok: false, error: 'Missing workspace code' });
    }
    try {
      const row = db.prepare('SELECT data FROM workspaces WHERE code = ?').get(code);
      if (!row) {
        return res.json({ ok: false, error: 'Workspace not found' });
      }
      const data = row.data ? JSON.parse(row.data) : null;
      if (!data) {
        // Workspace exists (was created) but nothing has been saved to
        // it yet — treat as "not found" from the frontend's point of
        // view so it falls back to the create/resume gate cleanly.
        return res.json({ ok: false, error: 'Workspace has no saved data yet' });
      }
      res.json({ ok: true, data });
    } catch (err) {
      console.error('[workspace/load] error:', err);
      res.status(500).json({ ok: false, error: 'Could not load workspace: ' + err.message });
    }
  });
};

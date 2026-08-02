// ══════════════════════════════════════════════════════════════
// workspace-routes.js  (v2 — no paid Render plan required)
//
// Companion backend module for Sustainability ROI Builder — Session 1
// (multi-tenant identity & save state).
//
// Adds three endpoints to your existing roi-backend Render service,
// alongside the /extract-bill route you already have:
//
//   POST /workspace/new          -> { ok:true, code:'GRN4-3F2K9Q' }
//   POST /workspace/save         -> { ok:true, savedAt: ISOString }
//   GET  /workspace/load?code=.. -> { ok:true, data:{...} }
//                                   or { ok:false, error:'...' }
//
// STORAGE: this version uses Upstash Redis — a free, hosted, key-value
// "filing cabinet" reached over plain HTTP. No database software to
// install, no Render disk (which requires a paid plan), and no new
// npm package to add to package.json — it's called with the same
// built-in `fetch` your server.js already uses to call Claude's API.
//
// You DO need two things from a free Upstash account (see the setup
// guide): UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN, set as
// environment variables on your Render service.
// ══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Sends one Redis command to Upstash over its REST API, e.g.
// redisCommand(['SET', 'workspace:ABCD-123456', '{"fields":{...}}'])
async function redisCommand(commandArray) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error(
      'Server is missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN. ' +
      'In Render, go to your service → Environment, and confirm both are set.'
    );
  }
  const resp = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commandArray),
  });
  const json = await resp.json();
  if (json.error) throw new Error('Upstash error: ' + json.error);
  return json.result;
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
function generateCode() {
  // Format: XXXX-XXXXXX — short enough to read aloud or retype,
  // long enough to not collide or be guessable.
  const part = (len) =>
    Array.from(crypto.randomBytes(len))
      .map((b) => CODE_CHARS[b % CODE_CHARS.length])
      .join('');
  return `${part(4)}-${part(6)}`;
}

async function findUnusedCode() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode();
    const exists = await redisCommand(['EXISTS', `workspace:${code}`]);
    if (!exists) return code;
  }
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
  const express = require('express');
  app.use('/workspace', withCors);

  // ── Create a new workspace ─────────────────────────────────────
  app.post('/workspace/new', async (req, res) => {
    try {
      const code = await findUnusedCode();
      res.json({ ok: true, code });
    } catch (err) {
      console.error('[workspace/new] error:', err);
      res.status(500).json({ ok: false, error: 'Could not create workspace: ' + err.message });
    }
  });

  // ── Save (upsert) a workspace's data ───────────────────────────
  app.post('/workspace/save', express.json({ limit: '2mb' }), async (req, res) => {
    const { code, data } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid workspace code' });
    }
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ ok: false, error: 'Missing workspace data' });
    }
    try {
      await redisCommand(['SET', `workspace:${code}`, JSON.stringify(data)]);
      res.json({ ok: true, savedAt: new Date().toISOString() });
    } catch (err) {
      console.error('[workspace/save] error:', err);
      res.status(500).json({ ok: false, error: 'Could not save workspace: ' + err.message });
    }
  });

  // ── Load a workspace's data ─────────────────────────────────────
  app.get('/workspace/load', async (req, res) => {
    const code = (req.query.code || '').toString().trim();
    if (!code) {
      return res.status(400).json({ ok: false, error: 'Missing workspace code' });
    }
    try {
      const raw = await redisCommand(['GET', `workspace:${code}`]);
      if (raw === null || raw === undefined) {
        return res.json({ ok: false, error: 'Workspace not found' });
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        return res.status(500).json({ ok: false, error: 'Saved data was corrupted and could not be read.' });
      }
      res.json({ ok: true, data });
    } catch (err) {
      console.error('[workspace/load] error:', err);
      res.status(500).json({ ok: false, error: 'Could not load workspace: ' + err.message });
    }
  });
};

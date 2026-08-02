// ══════════════════════════════════════════════════════════════
// workspace-routes.js  (v3 — adds firm/consultant accounts, Session 2)
//
// Companion backend module for Sustainability ROI Builder.
//
// EXISTING ROUTES (Session 1 — unchanged behavior, still backward
// compatible with the tool you already have working):
//
//   POST /workspace/new          -> { ok:true, code:'GRN4-3F2K9Q' }
//   POST /workspace/save         -> { ok:true, savedAt: ISOString }
//   GET  /workspace/load?code=.. -> { ok:true, data:{...} }
//
// NEW ROUTES (Session 2 — white-label / consultant firm accounts):
//
//   POST /firm/new                -> { ok:true, code:'FIRM-3F2K9Q' }
//   POST /firm/save                body {code,name,logoDataUrl,color}
//                                  -> { ok:true }
//   POST /firm/add-client          body {code,clientCode,label}
//                                  -> { ok:true }
//   GET  /firm/load?code=..       -> { ok:true, firm:{name,logoDataUrl,
//                                       color}, clients:[{code,label,
//                                       savedAt,summary}, ...] }
//
// STORAGE: Upstash Redis (same as Session 1 — no new setup needed if
// you already have UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
// configured on Render).
//
// Every individual client workspace still saves/loads exactly as
// before at `workspace:{code}`. This version additionally writes a
// small companion key `workspace:{code}:meta` on every save (just a
// timestamp + a short summary block the frontend includes), so the
// firm dashboard can list many clients quickly without pulling each
// client's full, larger data blob.
// ══════════════════════════════════════════════════════════════

const crypto = require('crypto');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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
function generateCode(prefix) {
  const part = (len) =>
    Array.from(crypto.randomBytes(len))
      .map((b) => CODE_CHARS[b % CODE_CHARS.length])
      .join('');
  return prefix ? `${prefix}-${part(6)}` : `${part(4)}-${part(6)}`;
}

async function findUnusedCode(redisKeyPrefix, codePrefix) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = generateCode(codePrefix);
    const exists = await redisCommand(['EXISTS', `${redisKeyPrefix}:${code}`]);
    if (!exists) return code;
  }
  throw new Error('Could not generate a unique code after 10 attempts');
}

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
  app.use('/firm', withCors);

  // ── Create a new individual workspace ──────────────────────────
  app.post('/workspace/new', async (req, res) => {
    try {
      const code = await findUnusedCode('workspace');
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
      const now = new Date().toISOString();
      await redisCommand(['SET', `workspace:${code}`, JSON.stringify(data)]);
      // Lightweight companion record for fast dashboard listing. Never
      // required for the tool itself to work — if this write fails
      // for any reason, the main save above still succeeded.
      try {
        const meta = { savedAt: now, summary: data.summary || null };
        await redisCommand(['SET', `workspace:${code}:meta`, JSON.stringify(meta)]);
      } catch (metaErr) {
        console.error('[workspace/save] meta write failed (non-fatal):', metaErr);
      }
      res.json({ ok: true, savedAt: now });
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

  // ══════════════════════════════════════════════
  // Session 2 — firm / consultant accounts
  // ══════════════════════════════════════════════

  // ── Create a new firm ───────────────────────────────────────────
  app.post('/firm/new', async (req, res) => {
    try {
      const code = await findUnusedCode('firm', 'FIRM');
      const record = { name: '', logoDataUrl: null, color: '#3B6D11', clients: [] };
      await redisCommand(['SET', `firm:${code}`, JSON.stringify(record)]);
      res.json({ ok: true, code });
    } catch (err) {
      console.error('[firm/new] error:', err);
      res.status(500).json({ ok: false, error: 'Could not create firm account: ' + err.message });
    }
  });

  // ── Save a firm's branding (name / logo / color) ───────────────
  app.post('/firm/save', express.json({ limit: '4mb' }), async (req, res) => {
    const { code, name, logoDataUrl, color } = req.body || {};
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing or invalid firm code' });
    }
    try {
      const raw = await redisCommand(['GET', `firm:${code}`]);
      if (raw === null || raw === undefined) {
        return res.json({ ok: false, error: 'Firm not found' });
      }
      const record = JSON.parse(raw);
      if (typeof name === 'string') record.name = name;
      if (typeof logoDataUrl === 'string' || logoDataUrl === null) record.logoDataUrl = logoDataUrl;
      if (typeof color === 'string') record.color = color;
      await redisCommand(['SET', `firm:${code}`, JSON.stringify(record)]);
      res.json({ ok: true });
    } catch (err) {
      console.error('[firm/save] error:', err);
      res.status(500).json({ ok: false, error: 'Could not save firm: ' + err.message });
    }
  });

  // ── Link a client workspace to a firm ──────────────────────────
  app.post('/firm/add-client', express.json({ limit: '1mb' }), async (req, res) => {
    const { code, clientCode, label } = req.body || {};
    if (!code || !clientCode) {
      return res.status(400).json({ ok: false, error: 'Missing firm code or client code' });
    }
    try {
      const raw = await redisCommand(['GET', `firm:${code}`]);
      if (raw === null || raw === undefined) {
        return res.json({ ok: false, error: 'Firm not found' });
      }
      const record = JSON.parse(raw);
      record.clients = record.clients || [];
      const existing = record.clients.find((c) => c.code === clientCode);
      if (existing) {
        if (label) existing.label = label;
      } else {
        record.clients.push({ code: clientCode, label: label || clientCode });
      }
      await redisCommand(['SET', `firm:${code}`, JSON.stringify(record)]);
      res.json({ ok: true });
    } catch (err) {
      console.error('[firm/add-client] error:', err);
      res.status(500).json({ ok: false, error: 'Could not link client to firm: ' + err.message });
    }
  });

  // ── Load a firm + its client list with summary stats ───────────
  app.get('/firm/load', async (req, res) => {
    const code = (req.query.code || '').toString().trim();
    if (!code) {
      return res.status(400).json({ ok: false, error: 'Missing firm code' });
    }
    try {
      const raw = await redisCommand(['GET', `firm:${code}`]);
      if (raw === null || raw === undefined) {
        return res.json({ ok: false, error: 'Firm not found' });
      }
      const record = JSON.parse(raw);
      const clients = record.clients || [];
      const clientDetails = [];
      for (const c of clients) {
        let savedAt = null;
        let summary = null;
        try {
          const metaRaw = await redisCommand(['GET', `workspace:${c.code}:meta`]);
          if (metaRaw) {
            const meta = JSON.parse(metaRaw);
            savedAt = meta.savedAt || null;
            summary = meta.summary || null;
          }
        } catch (e) {
          // A single client's metadata failing to load shouldn't break
          // the whole dashboard — just show it with no stats yet.
        }
        clientDetails.push({ code: c.code, label: c.label || c.code, savedAt, summary });
      }
      res.json({
        ok: true,
        firm: { name: record.name || '', logoDataUrl: record.logoDataUrl || null, color: record.color || '#3B6D11' },
        clients: clientDetails,
      });
    } catch (err) {
      console.error('[firm/load] error:', err);
      res.status(500).json({ ok: false, error: 'Could not load firm: ' + err.message });
    }
  });
};

/**
 * Sustainability ROI Builder — Bill Extraction Backend (Render version)
 * ───────────────────────────────────────────────────────────────────
 * This is a plain Node.js + Express server — the standard format Render
 * (and most "click-to-deploy" hosting services) expect.
 *
 * What it does: receives an uploaded bill from your ROI Builder webpage,
 * forwards it to Claude (Anthropic's API) using YOUR secret key (which
 * is stored safely on Render's servers, never in this file, never in
 * your browser), and sends the extracted data back.
 *
 * You should not need to edit this file. Render will run it
 * automatically once deployed.
 */

const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());                 // Allows your webpage to call this server
app.use(express.json({ limit: '15mb' })); // Allows large file uploads (bill PDFs/images)

const SYSTEM_PROMPT =
  "You are a utility bill data extraction specialist. Extract billing data from the provided utility bill image or PDF and return ONLY valid JSON — no markdown fences, no explanation, no other text.";

function buildUserPrompt(billType) {
  return `Extract all available data from this ${billType} utility bill and return ONLY this JSON object. For fields you cannot determine with confidence, use null. CCF values should be converted to therms (multiply by 1.0366):
{
  "bill_type": "electric" | "gas" | "combined",
  "utility_name": string | null,
  "account_number_masked": "****XXXX format" | null,
  "billing_period_start": "YYYY-MM-DD" | null,
  "billing_period_end": "YYYY-MM-DD" | null,
  "billing_days": number | null,
  "total_kwh": number | null,
  "total_therms": number | null,
  "average_rate_per_kwh": number | null,
  "average_rate_per_therm": number | null,
  "on_peak_kwh": number | null,
  "mid_peak_kwh": number | null,
  "off_peak_kwh": number | null,
  "on_peak_rate": number | null,
  "mid_peak_rate": number | null,
  "off_peak_rate": number | null,
  "weighted_avg_kwh_rate": number | null,
  "max_demand_kw": number | null,
  "demand_charge_per_kw": number | null,
  "total_demand_charge": number | null,
  "total_energy_charge": number | null,
  "total_bill_amount": number | null,
  "state_code": "2-letter state" | null,
  "notes": "brief note on rate structure if TOU or demand-based" | null
}
Return ONLY the JSON object, nothing else.`;
}

// Simple "is this thing alive?" check — visiting this URL in a browser
// should just show {"ok":true,"status":"healthy"}
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

// The main endpoint your ROI Builder webpage calls
app.post('/extract-bill', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({
        ok: false,
        error: 'Server is missing its API key. In Render, go to your service → Environment, and confirm ANTHROPIC_API_KEY is set.',
      });
    }

    const { base64, mediaType, billType } = req.body || {};
    if (!base64 || !mediaType) {
      return res.status(400).json({ ok: false, error: 'Missing required data: base64 or mediaType' });
    }

    const isImage = mediaType.startsWith('image/');
    const contentBlock = isImage
      ? { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } };

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: [contentBlock, { type: 'text', text: buildUserPrompt(billType || 'electric') }] },
        ],
      }),
    });

    if (!anthropicResp.ok) {
      const errText = await anthropicResp.text().catch(() => '(no error detail available)');
      return res.status(502).json({
        ok: false,
        error: `Claude's API returned an error (status ${anthropicResp.status}): ${errText.substring(0, 300)}`,
      });
    }

    const data = await anthropicResp.json();
    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ ok: false, error: 'Claude did not return any readable text in its response.' });
    }

    const cleaned = textBlock.text.replace(/```json/g, '').replace(/```/g, '').trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: `Could not understand Claude's response as data. Raw response: ${cleaned.substring(0, 300)}`,
      });
    }

    return res.json({ ok: true, data: parsed });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'Unexpected server error: ' + (err && err.message) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ROI Builder bill-extraction backend running on port ${PORT}`);
});

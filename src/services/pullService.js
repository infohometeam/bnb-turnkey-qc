// pullService.js — safely fetch recent calls from Aloware/Fathom REST APIs
// and run them through the SAME ingestCall path webhooks use (dedup-safe).
// Every failure is caught; this can never throw up to the caller.
const { ingestCall } = require('./ingestion');

// ── Fathom ────────────────────────────────────────────────
// GET /meetings then GET /recordings/{id}/transcript (per research).
async function pullFathom({ sinceHours = 72, limit = 25 } = {}) {
  const key = process.env.FATHOM_API_KEY;
  if (!key) return { source: 'Fathom', ok: false, reason: 'no FATHOM_API_KEY set', pulled: 0, ingested: 0 };
  try {
    const r = await fetch(`https://api.fathom.ai/external/v1/meetings?limit=${limit}`, {
      headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
    });
    if (!r.ok) return { source: 'Fathom', ok: false, reason: `API ${r.status}`, pulled: 0, ingested: 0 };
    const data = await r.json();
    const meetings = data.items || data.meetings || data.data || [];
    let ingested = 0, errors = 0;
    for (const m of meetings) {
      try {
        // Reshape into the webhook-style payload ingestCall understands.
        // ingestCall + its dedup handles new-vs-existing; safe to re-run.
        const payload = { source: 'fathom-pull', meeting: m, ...m };
        const res = await ingestCall(JSON.stringify(payload), 'fathom-closers');
        if (res && (res.ok || res.status === 'ingested' || res.id)) ingested++;
      } catch (e) { errors++; }
    }
    return { source: 'Fathom', ok: true, pulled: meetings.length, ingested, errors };
  } catch (e) {
    return { source: 'Fathom', ok: false, reason: e.message.slice(0, 120), pulled: 0, ingested: 0 };
  }
}

// ── Aloware ───────────────────────────────────────────────
// GET /api/v1/contacts/communications (per research; token auth).
async function pullAloware({ limit = 25 } = {}) {
  const token = process.env.ALOWARE_API_TOKEN;
  if (!token) return { source: 'Aloware', ok: false, reason: 'no ALOWARE_API_TOKEN set', pulled: 0, ingested: 0 };
  try {
    const r = await fetch(`https://app.aloware.io/api/v1/communications?type=call&per_page=${limit}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });
    if (!r.ok) return { source: 'Aloware', ok: false, reason: `API ${r.status}`, pulled: 0, ingested: 0 };
    const data = await r.json();
    const calls = data.data || data.communications || [];
    let ingested = 0, errors = 0;
    for (const c of calls) {
      try {
        // Shape to look like an Aloware Recording-Saved webhook body.
        const payload = { event: 'Recording-Saved', source: 'aloware-pull', communication: c, ...c };
        const res = await ingestCall(JSON.stringify(payload), 'aloware-setters');
        if (res && (res.ok || res.status === 'ingested' || res.id)) ingested++;
      } catch (e) { errors++; }
    }
    return { source: 'Aloware', ok: true, pulled: calls.length, ingested, errors };
  } catch (e) {
    return { source: 'Aloware', ok: false, reason: e.message.slice(0, 120), pulled: 0, ingested: 0 };
  }
}

// Pull from one or both. Never throws.
async function pullCalls({ sources = ['aloware', 'fathom'], limit = 25 } = {}) {
  const results = [];
  if (sources.includes('aloware')) results.push(await pullAloware({ limit }));
  if (sources.includes('fathom')) results.push(await pullFathom({ limit }));
  const totalIngested = results.reduce((s, r) => s + (r.ingested || 0), 0);
  return { ok: true, totalIngested, results };
}

module.exports = { pullCalls, pullAloware, pullFathom };

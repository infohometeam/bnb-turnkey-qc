// pullService.js — safely fetch recent calls from Aloware/Fathom REST APIs
// and run them through the SAME ingestCall path webhooks use (dedup-safe).
// Every failure is caught; this can never throw up to the caller.
const { ingestCall } = require('./ingestion');

// ── Targeted backfill for ONE rep's missed Fathom webhooks ──
// dryRun (default) fetches + REPORTS meetings WITHOUT ingesting — so we can verify
// the API works and see whether the key returns just this rep or the whole org.
// commit ingests each meeting tagged to `srcTag` (which forces routing to that rep),
// and REQUIRES a hostMatch filter unless allowUnfiltered — so we can never
// misattribute another rep's calls by tagging them all as this rep.
async function pullFathomBackfill({ srcTag, limit = 25, dryRun = true, hostMatch = '', allowUnfiltered = false } = {}) {
  const key = process.env.FATHOM_API_KEY;
  if (!key) return { ok: false, reason: 'no FATHOM_API_KEY set' };
  if (!srcTag) return { ok: false, reason: 'srcTag required (e.g. fathom-closers-1)' };

  let data;
  try {
    const r = await fetch(`https://api.fathom.ai/external/v1/meetings?limit=${limit}`, {
      headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
    });
    if (!r.ok) return { ok: false, reason: `Fathom API ${r.status}` };
    data = await r.json();
  } catch (e) { return { ok: false, reason: e.message.slice(0, 160) }; }

  const meetings = data.items || data.meetings || data.data || (Array.isArray(data) ? data : []);
  const pick = (m, keys) => { for (const k of keys) { if (m && m[k] != null && m[k] !== '') return m[k]; } return null; };
  const summarize = (m) => ({
    id: pick(m, ['id', 'recording_id', 'meeting_id', 'external_id']),
    title: pick(m, ['title', 'meeting_title', 'name']),
    host: pick(m, ['host', 'owner', 'host_email', 'owner_email', 'recorded_by', 'user_email', 'email']),
    started: pick(m, ['scheduled_start_time', 'started_at', 'start_time', 'recording_start_time', 'created_at', 'date']),
    duration: pick(m, ['duration', 'duration_seconds', 'length', 'recording_duration']),
    has_transcript: !!(m && (m.transcript || m.transcript_url || m.transcript_plaintext)),
  });
  const matchHost = (m) => !hostMatch || JSON.stringify(m || {}).toLowerCase().includes(hostMatch.toLowerCase());

  // Dry run: report only. Also expose the raw field names of the first meeting so
  // we can see the schema and pick the right host/date fields before committing.
  if (dryRun) {
    return {
      ok: true, dryRun: true, srcTag,
      total_returned: meetings.length,
      matched_by_hostMatch: hostMatch ? meetings.filter(matchHost).length : null,
      sample_keys: meetings[0] ? Object.keys(meetings[0]) : [],
      meetings: meetings.map(summarize),
    };
  }

  // Commit: refuse to run unfiltered unless explicitly allowed (misattribution guard).
  if (!hostMatch && !allowUnfiltered) {
    return { ok: false, reason: 'commit blocked: pass hostMatch to isolate this rep, or allowUnfiltered:true only if the key returns a single rep. Prevents tagging another rep\u2019s calls as this one.' };
  }
  let ingested = 0, skipped = 0, errors = 0;
  for (const m of meetings) {
    if (!matchHost(m)) { skipped++; continue; }
    try {
      const payload = { source: 'fathom-backfill', meeting: m, ...m };
      const res = await ingestCall(JSON.stringify(payload), srcTag);   // ingestCall dedups — safe to re-run
      if (res && (res.ok || res.status === 'ingested' || res.id)) ingested++;
    } catch (e) { errors++; }
  }
  return { ok: true, dryRun: false, srcTag, total_returned: meetings.length, ingested, skipped, errors };
}

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

module.exports = { pullCalls, pullAloware, pullFathom, pullFathomBackfill };

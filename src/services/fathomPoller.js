// ─── Fathom API backfill poller ──────────────────────────────────────────────
// WHY THIS EXISTS
// Webhooks are push-only: if a delivery is missed, it is gone forever — there is
// no catch-up. Fathom also AUTO-DISABLES a webhook after repeated delivery
// failures and provides no event to tell you it happened, so a dead webhook is
// indistinguishable from an empty calendar. Both look like silence.
//
// That failure mode has now cost us weeks of closer calls twice. This poller is
// the safety net: it asks Fathom directly what meetings exist and ingests
// anything we do not already have. A disabled webhook then costs ONE DAY of lag
// instead of three weeks.
//
// Webhooks stay in place for speed. This is belt-and-braces, not a replacement.
//
// DESIGN NOTES (verified against developers.fathom.ai, Nov 2026)
//  · Base https://api.fathom.ai/external/v1, auth via X-Api-Key header
//  · GET /meetings supports include_transcript, created_after (ISO), cursor
//  · Page size is fixed at 10 and CANNOT be raised — so a week of calls is
//    several round trips; the pacing below is deliberate, not cautious.
//  · Rate limit on transcript-bearing requests is 30 requests / 60 seconds.
//  · An API key is USER-SCOPED and never grants access to another user's private
//    meetings — hence one key per closer, mapped by src_tag.
//
// The API's meeting object has the SAME SHAPE as the webhook payload
// (recorded_by, transcript[], share_url…), so each item is handed to the
// existing ingestCall() untouched. No duplicated parsing, no second code path
// that can drift from the first. Deduplication is already handled there by
// external_call_key, so re-polling the same meeting is a no-op.

const { q } = require('../../migrations/run');
const { ingestCall } = require('./ingestion');

const API_BASE = 'https://api.fathom.ai/external/v1';

// Keys are configured per source tag, e.g.
//   FATHOM_API_KEY_CLOSERS_1=...   → src_tag fathom-closers-1  (Matt)
//   FATHOM_API_KEY_CLOSERS_2=...   → src_tag fathom-closers-2  (Kevin)
// Any src_tag following the fathom-<name> convention is picked up automatically.
function configuredAccounts() {
  return Object.keys(process.env)
    .filter(k => k.startsWith('FATHOM_API_KEY_') && process.env[k])
    .map(k => ({
      envKey: k,
      srcTag: 'fathom-' + k.replace('FATHOM_API_KEY_', '').toLowerCase().replace(/_/g, '-'),
      apiKey: process.env[k],
    }));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchPage(apiKey, params) {
  const url = `${API_BASE}/meetings?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'X-Api-Key': apiKey } });
  if (res.status === 429) {
    // Respect the documented 30/60s limit rather than hammering through it.
    const wait = Number(res.headers.get('retry-after') || 30) * 1000;
    console.warn(`[FathomPoll] rate limited, waiting ${wait / 1000}s`);
    await sleep(wait);
    return fetchPage(apiKey, params);
  }
  if (!res.ok) throw new Error(`Fathom API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Pull one account's recent meetings and ingest anything new.
async function pollAccount({ srcTag, apiKey }, { days = 7, maxPages = 12 } = {}) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const out = { srcTag, fetched: 0, ingested: 0, duplicates: 0, errors: 0, pages: 0 };
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const params = { include_transcript: 'true', created_after: since };
    if (cursor) params.cursor = cursor;

    const data = await fetchPage(apiKey, params);
    const items = data.items || [];
    out.pages++;
    out.fetched += items.length;

    for (const item of items) {
      try {
        // Same entry point the webhook uses, so scoring, rep resolution, voicemail
        // detection and dedupe all behave identically whichever route a call took.
        const r = await ingestCall(JSON.stringify(item), srcTag);
        if (r && r.duplicate) out.duplicates++; else out.ingested++;
      } catch (e) {
        out.errors++;
        console.error(`[FathomPoll] ${srcTag} ingest failed:`, e.message);
      }
    }

    cursor = data.next_cursor;
    if (!cursor || !items.length) break;
    await sleep(2500);   // ~24 req/min, comfortably under the 30/60s ceiling
  }
  return out;
}

async function pollFathom({ days = 7 } = {}) {
  const accounts = configuredAccounts();
  if (!accounts.length) {
    return { ok: false, reason: 'NO_API_KEYS',
             hint: 'Set FATHOM_API_KEY_CLOSERS_1 / _2 in Render (one per closer; keys are user-scoped and cannot see another user\'s meetings).' };
  }

  const results = [];
  for (const acct of accounts) {
    try {
      results.push(await pollAccount(acct, { days }));
    } catch (e) {
      // One bad key must not stop the other account from being backfilled.
      console.error(`[FathomPoll] ${acct.srcTag} FAILED:`, e.message);
      results.push({ srcTag: acct.srcTag, error: e.message });
    }
  }

  const newCalls = results.reduce((s, r) => s + (r.ingested || 0), 0);
  // A non-zero count here means webhooks MISSED those calls — worth noticing, not
  // just logging, because it is the early warning that a webhook has gone quiet.
  if (newCalls > 0) {
    console.warn(`[FathomPoll] Recovered ${newCalls} call(s) the webhooks did not deliver.`);
    try {
      const { postToSlack } = require('./slackService');
      const ch = process.env.SLACK_ACTIVITY_CHANNEL || process.env.SLACK_DIGEST_CHANNEL;
      if (ch) await postToSlack({
        channel: ch,
        text: `🔄 *Fathom backfill* recovered *${newCalls}* call(s) the webhooks missed.\n` +
              results.filter(r => r.ingested).map(r => `• ${r.srcTag}: ${r.ingested}`).join('\n') +
              `\n_Worth checking that account's webhook — Fathom disables them silently after repeated failures._`,
      });
    } catch (e) { console.error('[FathomPoll] Slack notify failed:', e.message); }
  }

  return { ok: true, days, accounts: results, recovered: newCalls };
}

module.exports = { pollFathom, pollAccount, configuredAccounts };

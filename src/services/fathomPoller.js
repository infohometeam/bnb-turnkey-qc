// ─── Fathom API backfill poller ──────────────────────────────────────────────
// WHY THIS EXISTS
// Closer calls have repeatedly stopped arriving while both Fathom webhooks showed
// as active and our server took 160–310 Aloware webhooks every weekday. Fathom
// documents no retry policy, no failure events and no "webhook disabled" signal,
// and recommends reconciling with scheduled GET /meetings calls because webhook
// deliveries can be missed. This poller is that reconciliation: it asks Fathom
// what meetings exist and ingests any we do not already have.
//
// Webhooks stay in place for speed; this is the safety net. A missed webhook now
// costs at most one night instead of weeks.
//
// DESIGN NOTES
//  · Base https://api.fathom.ai/external/v1, auth via X-Api-Key header.
//  · GET /meetings with include_transcript=true, created_after (ISO), cursor.
//    Page size is fixed (~10), so a week is several requests.
//  · Transcript-bearing requests are "heavy": 30/min normally, can drop to 5/min
//    under load. 429s carry RateLimit-Reset; we honour it, bounded retries.
//  · API keys are USER-scoped — one key per closer, mapped by src_tag:
//      FATHOM_API_KEY_CLOSERS_1 → fathom-closers-1 (Matt)
//      FATHOM_API_KEY_CLOSERS_2 → fathom-closers-2 (Kevin)
//  · The API meeting object has the same shape as the webhook payload, so each
//    one goes through the SAME ingestCall() the webhook uses. Dedupe is by
//    share_url (see ingestion.js), so webhook + poller never double-score a call.
//  · Meetings whose transcript isn't ready yet are SKIPPED, not ingested — an
//    empty row would otherwise claim that share_url and block the real one.
//    They're picked up on the next run.
//  · Recovered calls are dated by when the meeting happened (recording start),
//    not when we found them, so digests and weekly trends stay correct.

const { q } = require('../../migrations/run');
const { ingestCall } = require('./ingestion');

const API_BASE = 'https://api.fathom.ai/external/v1';
const MAX_429_RETRIES = 4;

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

// Fathom timestamps are ISO-8601 UTC; calls.received_at is 'YYYY-MM-DD HH:MM:SS' UTC.
function toDbTs(iso) {
  const d = new Date(iso);
  return isNaN(d) ? null : d.toISOString().replace('T', ' ').slice(0, 19);
}

function hasTranscript(item) {
  return Array.isArray(item?.transcript) && item.transcript.some(t => String(t?.text || '').trim());
}

async function fetchPage(apiKey, params, attempt = 0) {
  const url = `${API_BASE}/meetings?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' } });
  if (res.status === 429) {
    if (attempt >= MAX_429_RETRIES) throw new Error('Fathom API rate limit: gave up after retries');
    const reset = Number(res.headers.get('ratelimit-reset') || res.headers.get('retry-after') || 30);
    const waitS = Math.min(Math.max(reset, 5), 90);
    console.warn(`[FathomPoll] rate limited, waiting ${waitS}s (attempt ${attempt + 1})`);
    await sleep(waitS * 1000);
    return fetchPage(apiKey, params, attempt + 1);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Fathom API ${res.status}: key rejected — check the key in Render`);
  }
  if (!res.ok) throw new Error(`Fathom API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// audit=true → report only: list what Fathom has and whether we have it. No
// ingest, no scoring cost. This is the diagnostic that answers "did Fathom record
// it and fail to send it, or never record it at all?"
async function pollAccount({ srcTag, apiKey }, { days = 7, maxPages = 30, audit = false } = {}) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const out = { srcTag, fetched: 0, already_had: 0, recovered: 0, pending_transcript: 0,
                errors: 0, pages: 0, missing: [] };
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const params = { include_transcript: 'true', created_after: since };
    if (cursor) params.cursor = cursor;

    const data = await fetchPage(apiKey, params);
    const items = data.items || [];
    out.pages++;
    out.fetched += items.length;

    for (const item of items) {
      const shareUrl = item.share_url || item.url || '';
      const when = toDbTs(item.recording_start_time || item.created_at);
      const summary = { title: item.title || item.meeting_title || '(untitled)', when,
                        recorded_by: item.recorded_by?.email || null, has_transcript: hasTranscript(item) };

      const have = shareUrl
        ? (await q("SELECT id FROM calls WHERE base_source='Fathom' AND call_url=? LIMIT 1", [shareUrl])).rows[0]
        : null;
      if (have) { out.already_had++; continue; }

      if (!summary.has_transcript) {
        out.pending_transcript++;
        if (audit) out.missing.push({ ...summary, note: 'transcript not ready / not recorded' });
        continue;
      }

      if (audit) { out.missing.push(summary); continue; }

      try {
        const r = await ingestCall(JSON.stringify(item), srcTag, { receivedAt: when });
        if (r && r.duplicate) out.already_had++;
        else { out.recovered++; if (out.missing.length < 25) out.missing.push(summary); }
      } catch (e) {
        out.errors++;
        console.error(`[FathomPoll] ${srcTag} ingest failed:`, e.message);
      }
    }

    cursor = data.next_cursor;
    if (!cursor || !items.length) break;
    await sleep(2500);   // ~24 req/min — under the normal 30/min heavy limit
  }
  return out;
}

async function pollFathom({ days = 7, audit = false } = {}) {
  const accounts = configuredAccounts();
  if (!accounts.length) {
    return { ok: false, reason: 'NO_API_KEYS',
             hint: 'Set FATHOM_API_KEY_CLOSERS_1 (Matt) and FATHOM_API_KEY_CLOSERS_2 (Kevin) in Render. Keys are user-scoped — one per closer.' };
  }

  const results = [];
  for (const acct of accounts) {
    try {
      results.push(await pollAccount(acct, { days, audit }));
    } catch (e) {
      // One bad key must not stop the other closer from being backfilled.
      console.error(`[FathomPoll] ${acct.srcTag} FAILED:`, e.message);
      results.push({ srcTag: acct.srcTag, error: e.message });
    }
  }

  const recovered = results.reduce((s, r) => s + (r.recovered || 0), 0);
  const failed = results.filter(r => r.error);

  // Recovered calls are proof the webhook missed them — say so loudly, not just
  // in logs. Key failures likewise: a dead safety net must not be silent either.
  if (!audit && (recovered > 0 || failed.length)) {
    try {
      const { postToSlack } = require('./slackService');
      const ch = process.env.SLACK_ACTIVITY_CHANNEL || process.env.SLACK_DIGEST_CHANNEL;
      const lines = [];
      if (recovered > 0) {
        lines.push(`🔄 *Fathom backfill* recovered *${recovered}* call(s) the webhooks never delivered.`);
        results.filter(r => r.recovered).forEach(r => lines.push(`• ${r.srcTag}: ${r.recovered}`));
      }
      failed.forEach(r => lines.push(`⚠️ *Fathom backfill failed* for ${r.srcTag}: ${r.error}`));
      if (ch) await postToSlack({ channel: ch, text: lines.join('\n') });
    } catch (e) { console.error('[FathomPoll] Slack notify failed:', e.message); }
  }

  return { ok: true, audit, days, accounts: results, recovered };
}

module.exports = { pollFathom, pollAccount, configuredAccounts, toDbTs, hasTranscript };

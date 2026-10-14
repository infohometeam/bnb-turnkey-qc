// ═══════════════════════════════════════════════════════════════
// Slack service — posts the morning QC digest to #qc-bot-reports-digest.
// Reuses the EXACT digest the Reports tab builds (via the /report endpoint),
// so the Slack post and the on-screen digest can never drift apart.
// Never throws — a Slack failure must never take down the app or a cron tick.
// ═══════════════════════════════════════════════════════════════

// Post text to Slack. Prefers a bot token (chat.postMessage — needed for DMs
// later); falls back to an incoming webhook if that's all that's configured.
async function postToSlack({ text, channel }) {
  const token = process.env.SLACK_BOT_TOKEN;
  const webhook = process.env.SLACK_WEBHOOK_URL;
  const ch = channel || process.env.SLACK_DIGEST_CHANNEL;

  try {
    if (token) {
      if (!ch) return { ok: false, error: 'SLACK_DIGEST_CHANNEL not set' };
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: ch, text, unfurl_links: false, unfurl_media: false }),
      });
      const data = await r.json().catch(() => ({}));
      if (!data.ok) return { ok: false, error: `slack: ${data.error || r.status}` };
      return { ok: true, ts: data.ts, channel: data.channel };
    }
    if (webhook) {
      const r = await fetch(webhook, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) return { ok: false, error: `webhook ${r.status}` };
      return { ok: true, via: 'webhook' };
    }
    return { ok: false, error: 'No SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL configured' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Channel-wide mention prefix so the team is notified the digest has landed.
// SLACK_DIGEST_MENTION = 'channel' (@channel, all members) | 'here' (active only) | 'none'.
function mentionPrefix() {
  const m = (process.env.SLACK_DIGEST_MENTION || 'channel').toLowerCase();
  if (m === 'channel') return '<!channel>\n\n';
  if (m === 'here') return '<!here>\n\n';
  return '';
}

// Build + post the digest for a window (default yesterday, ET). Pulls the same
// payload the Reports tab uses so there's one source of truth for the content.
async function sendDailyDigest({ preset = 'yesterday', force = false } = {}) {
  const port = process.env.PORT || 3001;
  let report;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/report?preset=${encodeURIComponent(preset)}`);
    report = await r.json();
  } catch (e) {
    return { posted: false, reason: `report fetch failed: ${e.message}` };
  }
  if (!report || report.error || !report.sam_digest_slack) {
    return { posted: false, reason: 'no digest in report response' };
  }

  const d = report.sam_digest || {};
  const total = (d.setters?.count || 0) + (d.closers?.count || 0);
  if (total === 0 && !force) {
    return { posted: false, reason: 'no scored calls in window (skipped to avoid an empty post)' };
  }

  const text = mentionPrefix() + report.sam_digest_slack;
  const res = await postToSlack({ text });
  return res.ok
    ? { posted: true, window: report.window_label, calls: total, channel: res.channel }
    : { posted: false, reason: res.error, window: report.window_label, calls: total };
}

// Post a lightweight "someone's using the bot" ping to a dedicated activity
// channel. Off unless SLACK_ACTIVITY_CHANNEL is set. No user identity exists in
// the app, so this is intentionally anonymous ("a teammate").
async function postActivity(page) {
  const ch = process.env.SLACK_ACTIVITY_CHANNEL;
  if (!ch) return { ok: false, reason: 'activity channel not configured' };
  const where = page ? ` — landed on *${String(page).slice(0, 40)}*` : '';
  return postToSlack({ text: `👀 A teammate is active in the QC Bot${where}`, channel: ch });
}

// Build + post the daily usage summary to the activity channel. Reuses the
// /activity/summary endpoint so the numbers match anything shown in-app.
async function sendUsageSummary({ preset = 'yesterday', force = false } = {}) {
  const ch = process.env.SLACK_ACTIVITY_CHANNEL;
  if (!ch) return { posted: false, reason: 'SLACK_ACTIVITY_CHANNEL not set' };
  const port = process.env.PORT || 3001;
  let data;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/activity/summary?preset=${encodeURIComponent(preset)}`);
    data = await r.json();
  } catch (e) { return { posted: false, reason: `summary fetch failed: ${e.message}` }; }
  if (!data || !data.summary_slack) return { posted: false, reason: 'no summary' };
  if (!data.opens && !force) return { posted: false, reason: 'no activity in window (skipped)' };
  const res = await postToSlack({ text: data.summary_slack, channel: ch });
  return res.ok ? { posted: true, opens: data.opens, visitors: data.visitors } : { posted: false, reason: res.error };
}

function slackStatus() {
  return {
    configured: !!(process.env.SLACK_BOT_TOKEN || process.env.SLACK_WEBHOOK_URL),
    method: process.env.SLACK_BOT_TOKEN ? 'bot_token' : (process.env.SLACK_WEBHOOK_URL ? 'webhook' : 'none'),
    channel: process.env.SLACK_DIGEST_CHANNEL || null,
    mention: (process.env.SLACK_DIGEST_MENTION || 'channel'),
    public_base_url: process.env.PUBLIC_BASE_URL || null,
  };
}

// ─── Top & Bottom 5 calls digest (Francis + Sam, Oct 6) ──────────────────────
// Built as Sam's PRIMARY surface, not an extra report. Usage data showed he has
// 634 scored calls and a 458-item review queue, and has never used calibration,
// comments, 1:1 logging or golden-moment pins. The fix is not another console
// view — it is bringing ten calls a day to him where he already is.
//
// Window: the previous working day. On MONDAY it reaches back to FRIDAY, so the
// weekend never produces an empty post and Friday's calls are never skipped.
function previousWorkingDay(now = new Date()) {
  // Compute in US Eastern so the window matches the cron's timezone.
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const d = new Date(et);
  const dow = et.getDay();                 // 0 Sun … 6 Sat
  if (dow === 1) d.setDate(d.getDate() - 3);        // Mon → Fri
  else if (dow === 0) d.setDate(d.getDate() - 2);   // Sun → Fri
  else d.setDate(d.getDate() - 1);                  // otherwise → yesterday
  const iso = d.toISOString().slice(0, 10);
  const label = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  return { iso, label };
}

// Mention for the top/bottom post. Separate from SLACK_DIGEST_MENTION because
// this list is built for one person — pinging @channel every morning for a post
// aimed at Sam trains the whole team to mute it.
//
// Accepts: a Slack USER ID (U… / W…) → <@U…>  ·  an already-formatted <@U…>
//          · 'channel' / 'here'  ·  'none' or unset → no mention.
//
// ⚠️ A plain "@sam" does NOT notify anyone in Slack — the API only resolves real
// member IDs. Get it from the member's profile → ⋮ → Copy member ID.
function topBottomMention() {
  const raw = (process.env.SLACK_TOPBOTTOM_MENTION || '').trim();
  if (!raw || raw.toLowerCase() === 'none') return '';
  const v = raw.toLowerCase();
  if (v === 'channel') return '<!channel>\n\n';
  if (v === 'here') return '<!here>\n\n';
  if (/^<@[UW][A-Z0-9]+>$/i.test(raw)) return `${raw}\n\n`;       // already formatted
  if (/^[UW][A-Z0-9]{6,}$/i.test(raw)) return `<@${raw.toUpperCase()}>\n\n`;  // bare member ID
  console.warn(`[Slack] SLACK_TOPBOTTOM_MENTION="${raw}" is not a Slack member ID — it will appear as plain text and will NOT notify anyone. Use the member ID (U…) instead.`);
  return `${raw}\n\n`;
}

async function sendTopBottomDigest({ dateIso = null, force = false } = {}) {
  const { q } = require('../../migrations/run');   // same helper api.js uses; there is no src/db.js
  const channel = process.env.SLACK_TOPBOTTOM_CHANNEL || process.env.SLACK_DIGEST_CHANNEL;
  if (!channel) return { posted: false, reason: 'NO_CHANNEL' };

  const win = dateIso ? { iso: dateIso, label: dateIso } : previousWorkingDay();

  // Calls deliberately EXCLUDED from both lists:
  //  - anything carrying a confirmed excludes_from_average tag (Disqualified,
  //    Not Ready, Partnership, Legacy…). Platform principle: a call the lead could
  //    never have closed must not drag a rep's average — and must certainly not be
  //    published as one of the day's worst.
  //  - degraded transcripts, where the score reflects a bad recording rather than
  //    the rep's work.
  // Restrict to the core selling team. Driven off rep_roster rather than hardcoded
  // names so it stays correct as people join or leave:
  //   active = 1          → excludes departed reps
  //   role IN Setter/Closer → excludes 'Both' accounts (Francis, Tyler), which are
  //                           admin/hybrid rather than people being QC'd
  // This also drops "Unknown Setter" and any other unrostered caller, which were
  // appearing in the digest and are not a person to coach.
  // SLACK_TOPBOTTOM_REPS (comma-separated names) overrides this entirely if the
  // team ever needs a different list without a deploy.
  const repOverride = (process.env.SLACK_TOPBOTTOM_REPS || '')
    .split(',').map(x => x.trim()).filter(Boolean);
  const repFilter = repOverride.length
    ? `AND c.rep_name IN (${repOverride.map(() => '?').join(',')})`
    : `AND EXISTS (SELECT 1 FROM rep_roster r
                   WHERE r.name = c.rep_name AND r.active = 1
                     AND r.role IN ('Setter','Closer'))`;

  const rows = (await q(
    `SELECT id, rep_name, client_name, role, overall_score_adj AS score,
            ROUND(call_duration_sec/60.0) AS mins, quick_summary
     FROM calls c
     WHERE status='SCORED'
       AND substring(received_at,1,10) = ?
       ${repFilter}
       AND overall_score_adj IS NOT NULL
       AND COALESCE(transcript_quality,'clean') <> 'degraded'
       AND NOT EXISTS (SELECT 1 FROM call_tag_assignments a JOIN call_tags t ON t.key=a.tag_key
                       WHERE a.call_id=c.id AND a.status='CONFIRMED' AND t.excludes_from_average=true)
     ORDER BY overall_score_adj DESC, call_duration_sec DESC`,
    [win.iso, ...repOverride])).rows;

  if (!rows.length && !force) return { posted: false, reason: 'NO_SCORED_CALLS', window: win.iso };

  const base = process.env.PUBLIC_BASE_URL || '';
  const link = (c) => base ? `<${base}/#/calls/${c.id}|#${c.id}>` : `#${c.id}`;
  const line = (c) => `${link(c)} · *${c.rep_name}* → ${c.client_name || 'unknown'} · *${c.score}/10* · ${c.mins}m`;

  // With few calls a "top 5 / bottom 5" split would list the same call twice.
  // Below 6, show one honest ranked list instead of inventing two.
  const n = rows.length;
  let body;
  if (n === 0) {
    body = `_No calls were scored on ${win.label}._`;
  } else if (n < 6) {
    body = `*All ${n} scored call${n === 1 ? '' : 's'}* (too few for a top/bottom split):\n`
         + rows.map(c => '• ' + line(c)).join('\n');
  } else {
    const top = rows.slice(0, 5);
    const bottom = rows.slice(-5).reverse();
    body =
      `*🏆 Top 5 — worth a listen*\n` + top.map(c => '• ' + line(c)).join('\n') +
      `\n\n*🎯 Bottom 5 — coaching opportunities*\n` + bottom.map(c => '• ' + line(c)).join('\n');
  }

  const avg = n ? (rows.reduce((s, c) => s + Number(c.score), 0) / n).toFixed(1) : '—';
  const text =
    topBottomMention() +
    `📞 *QC — ${win.label}*  ·  ${n} call${n === 1 ? '' : 's'} scored  ·  team avg *${avg}/10*\n\n` +
    body +
    `\n\n_Calls that couldn't be closed (DQ, not ready, partnership, legacy) and calls with unreliable transcripts are excluded from both lists._`;

  // postToSlack RETURNS {ok:false,error} rather than throwing — Slack signals
  // failure with HTTP 200 and an error body. Ignoring this return value meant the
  // digest reported success while Slack was rejecting every post.
  // The usual cause is `not_in_channel`: a bot must be invited to a channel before
  // it can post, and a newly created channel never has it.
  const sent = await postToSlack({ text, channel });
  if (!sent.ok) {
    console.error(`[Slack] Top/Bottom post REJECTED for channel ${channel}: ${sent.error}` +
      (String(sent.error || '').includes('not_in_channel')
        ? ' → invite the bot: type "/invite @<botname>" in that channel.' : ''));
    return { posted: false, reason: 'SLACK_REJECTED', slack_error: sent.error, channel, window: win.iso, calls: n };
  }
  return { posted: true, window: win.iso, calls: n, channel, ts: sent.ts };
}

module.exports = { postToSlack, sendDailyDigest, postActivity, sendUsageSummary, slackStatus, sendTopBottomDigest, previousWorkingDay };

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

module.exports = { postToSlack, sendDailyDigest, postActivity, sendUsageSummary, slackStatus };

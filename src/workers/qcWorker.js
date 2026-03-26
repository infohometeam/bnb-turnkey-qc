// ═══════════════════════════════════════════════════════════════
// QC Queue Worker — FIXED
// Fix: replaced all datetime("now") with JS-generated timestamps
// Fix: proper error capture and return
// Fix: transcript validation before API call
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../migrations/run');
const { callAIJson, callAI, estimateCost } = require('../services/ai');
const { buildSmartSlice, needsTwoPass, buildMiddleSummaryPrompt, buildQCPrompt } = require('../services/prompts');

const MAX_RETRY = 5;

function nowStr() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function adjustScore(ai, dur, agPct) {
  const notes = [];
  if (typeof ai !== 'number' || !isFinite(ai)) return { adjusted: ai, notes: ['No score'] };
  let s = ai;
  if (isFinite(dur)) {
    if (dur < 60) { s = Math.min(s, 4); notes.push('Dur<60s→cap4'); }
    else if (dur < 180) { s = Math.min(s, 6); notes.push('Dur<3m→cap6'); }
    else if (dur < 300) { s -= 0.5; notes.push('Dur<5m→-0.5'); }
  }
  if (isFinite(agPct)) {
    if (agPct > 90) { s -= 2; notes.push('Ag>90%→-2'); }
    else if (agPct > 80) { s -= 1; notes.push('Ag>80%→-1'); }
    if (agPct < 10) { s -= 2; notes.push('Ag<10%→-2'); }
    else if (agPct < 20) { s -= 1; notes.push('Ag<20%→-1'); }
  }
  s = Math.max(0, Math.min(10, Math.round(s * 10) / 10));
  if (!notes.length) notes.push('No adjustments');
  return { adjusted: s, notes };
}

function isFlagged(result, adjScore, dur, agPct) {
  const cs = result.category_scores || {};
  const pf = result.pass_fail || {};
  const ov = isFinite(adjScore) ? adjScore : result.overall_score;
  if (isFinite(ov) && ov < 6) return true;
  if (isFinite(dur) && dur < 90) return true;
  if (isFinite(agPct) && (agPct > 85 || agPct < 15)) return true;
  for (const v of Object.values(cs)) if (isFinite(v) && v < 5) return true;
  if (pf.explained_offer === false || pf.clear_next_step === false || pf.qualified_investor_fit === false) return true;
  return false;
}

async function processCall(row) {
  console.log(`[QC] Processing #${row.id} | ${row.rep_name} (${row.role}) | ${row.transcript_chars}ch`);

  if (!row.transcript || row.transcript.trim().length < 50) {
    throw new Error('NO_TRANSCRIPT: Only ' + (row.transcript_chars || 0) + ' chars');
  }

  const engine = process.env.AI_ENGINE || 'gemini';
  if (engine === 'gemini' && !process.env.GEMINI_API_KEY) {
    throw new Error('MISSING_GEMINI_API_KEY');
  }

  const db1 = getDb();
  const role = row.role || 'Setter';
  const rubricItems = db1.prepare('SELECT * FROM rubric_items WHERE version=1 AND role=? ORDER BY weight DESC').all(role);
  db1.close();

  if (!rubricItems.length) {
    throw new Error('NO_RUBRIC for role: ' + role);
  }

  let slice = buildSmartSlice(row.transcript);
  let midSummary = null;

  if (needsTwoPass(row.transcript_chars, row.call_duration_sec)) {
    try {
      const { text } = await callAI(buildMiddleSummaryPrompt(row.transcript), { maxTokens: 800 });
      midSummary = text;
    } catch (e) {
      console.warn(`[QC] #${row.id} mid-summary skipped: ${e.message}`);
    }
  }

  const prompt = buildQCPrompt({
    role, repName: row.rep_name || 'Unknown', source: row.source || 'Unknown',
    transcript: slice, rubricItems,
    metrics: { durationSec: row.call_duration_sec, agentTalkPct: row.agent_talk_pct, contactTalkPct: row.contact_talk_pct },
    middleSummary: midSummary,
  });

  console.log(`[QC] #${row.id} calling ${engine} (${prompt.length} chars)...`);
  const { result, usage } = await callAIJson(prompt);

  if (!result || result.overall_score === undefined) {
    throw new Error('INVALID_RESPONSE: ' + JSON.stringify(result).slice(0, 300));
  }

  console.log(`[QC] #${row.id} scored: ${result.overall_score}`);

  const cost = estimateCost(usage);
  const adj = adjustScore(result.overall_score, row.call_duration_sec, row.agent_talk_pct);
  const flagged = isFlagged(result, adj.adjusted, row.call_duration_sec, row.agent_talk_pct);
  const now = nowStr();

  const db2 = getDb();
  db2.prepare(`UPDATE calls SET
    overall_score=?, overall_score_adj=?, score_adjust_notes=?,
    category_scores=?, pass_fail=?,
    coaching_notes=?, quick_summary=?, strengths=?, improvements=?,
    next_step_text=?, golden_moments=?,
    flagged=?, status='SCORED', error='',
    processed_at=?, model_used=?, transcript_slice=?
    WHERE id=?`).run(
    result.overall_score, adj.adjusted, adj.notes.join(' | '),
    JSON.stringify(result.category_scores || {}), JSON.stringify(result.pass_fail || {}),
    result.coaching_notes || '', result.quick_summary || '',
    JSON.stringify(result.strengths || []), JSON.stringify(result.improvements || []),
    result.next_step_text || '', JSON.stringify(result.golden_moments || []),
    flagged ? 1 : 0, now,
    usage.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    slice, row.id
  );

  const dk = now.slice(0, 10);
  db2.prepare('INSERT INTO daily_counters (date_key, full_qc_used, est_cost_usd, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(date_key) DO UPDATE SET full_qc_used=full_qc_used+1, est_cost_usd=est_cost_usd+?, updated_at=?')
    .run(dk, cost, now, cost, now);
  db2.close();

  const summary = `#${row.id} → ${adj.adjusted}/10 (raw ${result.overall_score}) ${flagged ? 'FLAGGED' : 'OK'} $${cost}`;
  console.log(`[QC] ✓ ${summary}`);
  return { callId: row.id, score: adj.adjusted, rawScore: result.overall_score, flagged, cost, summary };
}

async function processQueue(max = 3) {
  const db = getDb();
  const batch = db.prepare('SELECT * FROM calls WHERE status IN (?, ?, ?) AND retry_count < ? ORDER BY CASE status WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END, received_at ASC LIMIT ?')
    .all('NEW', 'REQC', 'WAIT_RETRY_FULL', MAX_RETRY, 'REQC', 'NEW', max);

  if (!batch.length) { db.close(); return { processed: 0, total: 0, reason: 'QUEUE_EMPTY', results: [] }; }

  console.log(`[QC] Found ${batch.length} calls to process`);
  const now = nowStr();
  for (const row of batch) {
    db.prepare('UPDATE calls SET last_tried_at=?, retry_count=retry_count+1 WHERE id=?').run(now, row.id);
  }
  db.close();

  let processed = 0;
  const results = [];

  for (const row of batch) {
    try {
      const r = await processCall(row);
      processed++;
      results.push({ id: row.id, rep: row.rep_name, client: row.client_name, status: 'SCORED', score: r.score });
    } catch (err) {
      const msg = String(err?.message || err);
      console.error(`[QC] #${row.id} FAILED: ${msg}`);

      const isRetryable = /429|503|529|JSON_PARSE|EMPTY|TIMEOUT|ECONNRESET|MAX_RETRIES|fetch|network|GEMINI_HTTP/i.test(msg);
      const db2 = getDb();
      const newStatus = isRetryable ? 'WAIT_RETRY_FULL' : 'ERROR';
      db2.prepare('UPDATE calls SET status=?, error=? WHERE id=?').run(newStatus, (isRetryable ? 'RETRYABLE: ' : '') + msg.slice(0, 500), row.id);
      db2.close();
      results.push({ id: row.id, rep: row.rep_name, status: newStatus, error: msg.slice(0, 200) });
    }
  }

  console.log(`[QC] Done: ${processed}/${batch.length} scored`);
  return { processed, total: batch.length, results };
}

function unpauseDailyRows() {
  const db = getDb();
  const r = db.prepare("UPDATE calls SET status='NEW', error='' WHERE status='PAUSED_DAILY_LIMIT'").run();
  db.close();
  if (r.changes) console.log(`[QC] Unpaused ${r.changes} rows`);
}

module.exports = { processQueue, processCall, unpauseDailyRows, adjustScore };

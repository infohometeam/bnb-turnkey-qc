// ═══════════════════════════════════════════════════════════════
// QC Queue Worker — Processes calls using Gemini or Claude
// ═══════════════════════════════════════════════════════════════

const { getDb } = require('../../migrations/run');
const { callAIJson, callAI, estimateCost } = require('../services/ai');
const { buildSmartSlice, needsTwoPass, buildMiddleSummaryPrompt, buildQCPrompt } = require('../services/prompts');

const QC_STATUSES = ['NEW', 'REQC', 'WAIT_RETRY_FULL'];
const MAX_RETRY = 5;

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
  const db = getDb();
  console.log(`[QC] Processing #${row.id} | ${row.rep_name} (${row.role}) | ${row.transcript_chars}ch`);

  // Load rubric
  const rubricItems = db.prepare('SELECT * FROM rubric_items WHERE version=1 AND role=? ORDER BY weight DESC').all(row.role);

  // Smart slice
  let slice = buildSmartSlice(row.transcript);
  let midSummary = null;

  // Two-pass for long closer calls
  if (needsTwoPass(row.transcript_chars, row.call_duration_sec)) {
    console.log(`[QC] #${row.id} two-pass (${row.transcript_chars}ch)`);
    try {
      const { text } = await callAI(buildMiddleSummaryPrompt(row.transcript), { maxTokens: 800 });
      midSummary = text;
    } catch (e) { console.warn(`[QC] Mid-summary failed: ${e.message}`); }
  }

  // Build prompt + call AI
  const prompt = buildQCPrompt({
    role: row.role, repName: row.rep_name, source: row.source,
    transcript: slice, rubricItems,
    metrics: { durationSec: row.call_duration_sec, agentTalkPct: row.agent_talk_pct, contactTalkPct: row.contact_talk_pct },
    middleSummary: midSummary,
  });

  const { result, usage } = await callAIJson(prompt);
  const cost = estimateCost(usage);
  const adj = adjustScore(result.overall_score, row.call_duration_sec, row.agent_talk_pct);
  const flagged = isFlagged(result, adj.adjusted, row.call_duration_sec, row.agent_talk_pct);

  db.prepare(`UPDATE calls SET
    overall_score=?, overall_score_adj=?, score_adjust_notes=?,
    category_scores=?, pass_fail=?,
    coaching_notes=?, quick_summary=?, strengths=?, improvements=?,
    next_step_text=?, golden_moments=?,
    flagged=?, status='SCORED', error='',
    processed_at=datetime('now'), model_used=?, transcript_slice=?
    WHERE id=?`).run(
    result.overall_score, adj.adjusted, adj.notes.join(' | '),
    JSON.stringify(result.category_scores||{}), JSON.stringify(result.pass_fail||{}),
    result.coaching_notes||'', result.quick_summary||'',
    JSON.stringify(result.strengths||[]), JSON.stringify(result.improvements||[]),
    result.next_step_text||'', JSON.stringify(result.golden_moments||[]),
    flagged ? 1 : 0, usage.model || process.env.GEMINI_MODEL || process.env.CLAUDE_MODEL, slice,
    row.id
  );

  // Update daily counter
  const dk = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO daily_counters (date_key,full_qc_used,est_cost_usd) VALUES (?,1,?)
    ON CONFLICT(date_key) DO UPDATE SET full_qc_used=full_qc_used+1, est_cost_usd=est_cost_usd+?, updated_at=datetime('now')`)
    .run(dk, cost, cost);

  db.close();
  console.log(`[QC] ✓ #${row.id} → ${adj.adjusted}/10 (raw ${result.overall_score}) ${flagged ? '⚠ FLAGGED' : '✓'} $${cost}`);
  return { callId: row.id, score: adj.adjusted, flagged, cost };
}

async function processQueue(max = 3) {
  const db = getDb();

  const batch = db.prepare(`SELECT * FROM calls WHERE status IN ('NEW','REQC','WAIT_RETRY_FULL') AND retry_count < ?
    ORDER BY CASE status WHEN 'REQC' THEN 0 WHEN 'NEW' THEN 1 ELSE 2 END, received_at ASC LIMIT ?`)
    .all(MAX_RETRY, max);

  if (!batch.length) { db.close(); return { processed: 0, reason: 'QUEUE_EMPTY' }; }

  let processed = 0;
  for (const row of batch) {
    db.prepare('UPDATE calls SET last_tried_at=datetime("now"), retry_count=retry_count+1 WHERE id=?').run(row.id);
    db.close(); // close before async

    try {
      await processCall(row);
      processed++;
    } catch (err) {
      const msg = String(err?.message || err);
      const retry = msg.includes('429') || msg.includes('503') || msg.includes('JSON_PARSE') || msg.includes('EMPTY') || msg.includes('TIMEOUT');
      const db2 = getDb();
      if (retry) {
        db2.prepare("UPDATE calls SET status='WAIT_RETRY_FULL', error=? WHERE id=?").run(`RETRYABLE: ${msg}`, row.id);
      } else {
        db2.prepare("UPDATE calls SET status='ERROR', error=? WHERE id=?").run(msg, row.id);
      }
      db2.close();
      console.warn(`[QC] #${row.id} ${retry ? 'retryable' : 'permanent'}: ${msg.slice(0, 200)}`);
    }
  }
  return { processed, total: batch.length };
}

function unpauseDailyRows() {
  const db = getDb();
  const r = db.prepare("UPDATE calls SET status='NEW', error='' WHERE status='PAUSED_DAILY_LIMIT'").run();
  db.close();
  if (r.changes) console.log(`[QC] Unpaused ${r.changes} rows`);
}

module.exports = { processQueue, processCall, unpauseDailyRows, adjustScore };

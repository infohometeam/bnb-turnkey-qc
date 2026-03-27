const { q } = require('../../migrations/run');
const { callAIJson, callAI, estimateCost } = require('../services/ai');
const { buildSmartSlice, needsTwoPass, buildMiddleSummaryPrompt, buildQCPrompt } = require('../services/prompts');

const MAX_RETRY = 5;
function now() { return new Date().toISOString().replace('T',' ').slice(0,19); }

// Turso/libsql returns INTEGER columns as BigInt — convert to Number safely
function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function adjustScore(ai, dur, agPct) {
  const notes = [];
  if (typeof ai !== 'number' || !isFinite(ai)) return { adjusted: ai, notes: ['No score'] };
  let s = ai;

  // Duration adjustments — ONLY if we have a real positive duration
  // null/undefined/0 means duration wasn't extracted, so DON'T penalize
  if (dur !== null && dur !== undefined && dur > 0) {
    if (dur < 60) { s = Math.min(s, 4); notes.push('Dur<60s→cap4'); }
    else if (dur < 180) { s = Math.min(s, 6); notes.push('Dur<3m→cap6'); }
    else if (dur < 300) { s -= 0.5; notes.push('Dur<5m→-0.5'); }
  } else if (dur === null || dur === undefined) {
    notes.push('Duration unknown — no duration adjustment');
  }

  // Agent talk % adjustments — ONLY if we have a real value
  if (agPct !== null && agPct !== undefined && agPct > 0) {
    if (agPct > 90) { s -= 2; notes.push('Ag>90%→-2'); }
    else if (agPct > 80) { s -= 1; notes.push('Ag>80%→-1'); }
    if (agPct < 10) { s -= 2; notes.push('Ag<10%→-2'); }
    else if (agPct < 20) { s -= 1; notes.push('Ag<20%→-1'); }
  }

  s = Math.max(0, Math.min(10, Math.round(s*10)/10));
  if (!notes.length) notes.push('No adjustments');
  return { adjusted: s, notes };
}

function isFlagged(result, adj, dur, agPct) {
  const cs = result.category_scores || {}, pf = result.pass_fail || {};
  const ov = (adj !== null && adj !== undefined && isFinite(adj)) ? adj : result.overall_score;
  if (typeof ov === 'number' && isFinite(ov) && ov < 6) return true;
  // Only flag short duration if we KNOW the duration
  if (dur !== null && dur !== undefined && dur > 0 && dur < 90) return true;
  // Only flag talk % if we KNOW it
  if (agPct !== null && agPct !== undefined && agPct > 0 && (agPct > 85 || agPct < 15)) return true;
  for (const v of Object.values(cs)) if (typeof v === 'number' && isFinite(v) && v < 5) return true;
  if (pf.explained_offer===false || pf.clear_next_step===false || pf.qualified_investor_fit===false) return true;
  return false;
}

async function processCall(row) {
  // Convert all numeric fields from BigInt to Number
  const durSec = toNum(row.call_duration_sec);
  const agTalk = toNum(row.agent_talk_pct);
  const coTalk = toNum(row.contact_talk_pct);
  const txChars = toNum(row.transcript_chars) || 0;

  console.log(`[QC] #${row.id} | ${row.rep_name} (${row.role}) | ${txChars}ch | dur:${durSec}s | ag:${agTalk}%`);

  if (!row.transcript || row.transcript.trim().length < 50) throw new Error('NO_TRANSCRIPT: ' + txChars + 'ch');

  const engine = process.env.AI_ENGINE || 'gemini';
  if (engine==='gemini' && !process.env.GEMINI_API_KEY) throw new Error('MISSING_GEMINI_API_KEY');
  if (engine==='claude' && !process.env.ANTHROPIC_API_KEY) throw new Error('MISSING_ANTHROPIC_API_KEY');

  const role = row.role || 'Setter';
  const rubric = await q('SELECT * FROM rubric_items WHERE version=1 AND role=? ORDER BY weight DESC', [role]);
  if (!rubric.rows.length) throw new Error('NO_RUBRIC for ' + role);

  let slice = buildSmartSlice(row.transcript), midSummary = null;
  if (needsTwoPass(txChars, durSec)) {
    try { const r = await callAI(buildMiddleSummaryPrompt(row.transcript), {maxTokens:800}); midSummary = r.text; } catch(e) { console.warn(`[QC] #${row.id} mid-summary skipped`); }
  }

  const prompt = buildQCPrompt({
    role, repName: row.rep_name||'Unknown', source: row.source||'Unknown',
    transcript: slice, rubricItems: rubric.rows,
    metrics: { durationSec: durSec, agentTalkPct: agTalk, contactTalkPct: coTalk },
    middleSummary: midSummary,
  });

  console.log(`[QC] #${row.id} calling ${engine} (${prompt.length}ch)...`);
  const { result, usage } = await callAIJson(prompt);
  if (!result || result.overall_score === undefined) throw new Error('INVALID_RESPONSE: ' + JSON.stringify(result).slice(0,300));

  console.log(`[QC] #${row.id} raw score: ${result.overall_score}`);
  const cost = estimateCost(usage);
  const adj = adjustScore(result.overall_score, durSec, agTalk);
  const flagged = isFlagged(result, adj.adjusted, durSec, agTalk);
  const ts = now();

  await q('UPDATE calls SET overall_score=?,overall_score_adj=?,score_adjust_notes=?,category_scores=?,pass_fail=?,coaching_notes=?,quick_summary=?,strengths=?,improvements=?,next_step_text=?,golden_moments=?,flagged=?,status=?,error=?,processed_at=?,model_used=?,transcript_slice=? WHERE id=?',
    [result.overall_score, adj.adjusted, adj.notes.join(' | '), JSON.stringify(result.category_scores||{}), JSON.stringify(result.pass_fail||{}), result.coaching_notes||'', result.quick_summary||'', JSON.stringify(result.strengths||[]), JSON.stringify(result.improvements||[]), result.next_step_text||'', JSON.stringify(result.golden_moments||[]), flagged?1:0, 'SCORED', '', ts, usage.model||'unknown', slice, row.id]);

  const dk = ts.slice(0,10);
  await q('INSERT INTO daily_counters (date_key,full_qc_used,est_cost_usd,updated_at) VALUES (?,1,?,?) ON CONFLICT(date_key) DO UPDATE SET full_qc_used=full_qc_used+1, est_cost_usd=est_cost_usd+?, updated_at=?', [dk,cost,ts,cost,ts]);

  const summary = `#${row.id} → ${adj.adjusted}/10 (raw ${result.overall_score}) ${flagged?'FLAGGED':'OK'} $${cost}`;
  console.log(`[QC] ✓ ${summary}`);
  return { callId: row.id, score: adj.adjusted, flagged, cost, summary };
}

async function processQueue(max = 3) {
  const batch = await q('SELECT * FROM calls WHERE status IN (?,?,?) AND retry_count < ? ORDER BY CASE status WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END, received_at ASC LIMIT ?',
    ['NEW','REQC','WAIT_RETRY_FULL', MAX_RETRY, 'REQC','NEW', max]);

  if (!batch.rows.length) return { processed: 0, total: 0, reason: 'QUEUE_EMPTY', results: [] };
  console.log(`[QC] Found ${batch.rows.length} calls`);

  const ts = now();
  for (const row of batch.rows) await q('UPDATE calls SET last_tried_at=?, retry_count=retry_count+1 WHERE id=?', [ts, row.id]);

  let processed = 0; const results = [];
  for (const row of batch.rows) {
    try {
      const r = await processCall(row); processed++;
      results.push({ id: row.id, rep: row.rep_name, client: row.client_name, status: 'SCORED', score: r.score });
    } catch (err) {
      const msg = String(err?.message || err);
      console.error(`[QC] #${row.id} FAILED: ${msg}`);
      const retry = /429|503|529|JSON_PARSE|EMPTY|TIMEOUT|ECONNRESET|MAX_RETRIES|fetch|network|GEMINI_HTTP/i.test(msg);
      await q('UPDATE calls SET status=?, error=? WHERE id=?', [retry?'WAIT_RETRY_FULL':'ERROR', (retry?'RETRYABLE: ':'')+msg.slice(0,500), row.id]);
      results.push({ id: row.id, rep: row.rep_name, status: retry?'RETRY':'ERROR', error: msg.slice(0,200) });
    }
  }
  console.log(`[QC] Done: ${processed}/${batch.rows.length}`);
  return { processed, total: batch.rows.length, results };
}

async function unpauseDailyRows() {
  const r = await q("UPDATE calls SET status='NEW', error='' WHERE status='PAUSED_DAILY_LIMIT'");
  if (r.rowsAffected) console.log(`[QC] Unpaused ${r.rowsAffected} rows`);
}

module.exports = { processQueue, processCall, unpauseDailyRows, adjustScore };

const { q } = require('../../migrations/run');
const { callAIJson, callAI, estimateCost } = require('../services/ai');
const { buildSmartSlice, needsTwoPass, buildMiddleSummaryPrompt, buildQCPrompt } = require('../services/prompts');

const MAX_RETRY = 5;
function now() { return new Date().toISOString().replace('T',' ').slice(0,19); }

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// Score adjustments — ONLY talk % imbalance, NO duration caps
// Duration caps removed: if a call is classified as a real sales call,
// the AI rubric score stands on its own. A rep who books a closer
// in 2 minutes shouldn't be penalized for being efficient.
function adjustScore(ai, dur, agPct) {
  const notes = [];
  if (typeof ai !== 'number' || !isFinite(ai)) return { adjusted: ai, notes: ['No score'] };
  let s = ai;

  // Talk % adjustments only — extreme imbalance is a real quality issue
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
  if (agPct !== null && agPct !== undefined && agPct > 0 && (agPct > 85 || agPct < 15)) return true;
  for (const v of Object.values(cs)) if (typeof v === 'number' && isFinite(v) && v < 5) return true;
  if (pf.explained_offer===false || pf.clear_next_step===false || pf.qualified_investor_fit===false) return true;
  return false;
}

// ── Call Classification ──────────────────────────────────────
const CLASSIFY_PROMPT = `You are a call classifier for a real estate investment sales team (BNB Turnkey / The Rise Collective).

Read this transcript excerpt and classify the call into ONE of these types:

1. "full_sales_call" — A genuine setter or closer sales conversation. Rep is doing discovery, qualifying the investor, pitching BNB Turnkey, handling objections, or closing. This is the majority of calls.
2. "reschedule" — The primary purpose is to reschedule or confirm an existing appointment. Very little sales content.
3. "follow_up" — A quick follow-up or check-in. Not a full sales conversation — just touching base, confirming receipt of materials, or brief status update.
4. "wrong_number" — Wrong number, disconnected, or the person says they're not interested within the first 30 seconds and hangs up.
5. "admin_internal" — Internal team call, not a client conversation.

IMPORTANT RULES:
- If ANY meaningful sales conversation happens (discovery questions, qualification, pitch, objection handling, or closing), classify as "full_sales_call" even if the call is short.
- Only classify as "reschedule" if the ENTIRE call is about scheduling/rescheduling with no sales content.
- Only classify as "follow_up" if it's a brief check-in with no substantive sales discussion.
- When in doubt, classify as "full_sales_call" — it's better to score a borderline call than to skip a real one.

Return ONLY valid JSON:
{"call_type": "full_sales_call|reschedule|follow_up|wrong_number|admin_internal", "reason": "1 sentence explaining why"}

Transcript excerpt:
`;

async function classifyCall(transcript) {
  const excerpt = transcript.slice(0, 2000);
  try {
    const { result, usage } = await callAIJson(CLASSIFY_PROMPT + excerpt, { maxTokens: 100 });
    const cost = estimateCost(usage);
    const callType = result?.call_type || 'full_sales_call';
    const reason = result?.reason || '';
    console.log(`[QC] Classification: ${callType} (${reason.slice(0, 80)}) $${cost}`);
    return { callType, reason, cost };
  } catch (e) {
    console.warn(`[QC] Classification failed, defaulting to full_sales_call: ${e.message}`);
    return { callType: 'full_sales_call', reason: 'Classification failed — defaulting to score', cost: 0 };
  }
}

const SKIP_STATUSES = {
  reschedule: 'SKIP_RESCHEDULE',
  follow_up: 'SKIP_FOLLOWUP',
  wrong_number: 'SKIP_WRONG_NUMBER',
  admin_internal: 'SKIP_INTERNAL',
};

// ── Main Process Call ────────────────────────────────────────
async function processCall(row) {
  let durSec = toNum(row.call_duration_sec);
  const agTalk = toNum(row.agent_talk_pct);
  const coTalk = toNum(row.contact_talk_pct);
  const txChars = toNum(row.transcript_chars) || 0;

  // Estimate duration from transcript timestamps if missing
  if (durSec === null && row.transcript) {
    const regex = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;
    let maxSec = 0, m;
    while ((m = regex.exec(row.transcript)) !== null) {
      const parts = m[1].split(':').map(Number);
      let sec = 0;
      if (parts.length === 2) sec = parts[0]*60 + parts[1];
      else if (parts.length === 3) sec = parts[0]*3600 + parts[1]*60 + parts[2];
      if (sec > maxSec) maxSec = sec;
    }
    if (maxSec > 0) {
      durSec = maxSec;
      console.log(`[QC] #${row.id} estimated duration: ${durSec}s`);
      await q('UPDATE calls SET call_duration_sec=? WHERE id=? AND call_duration_sec IS NULL', [durSec, row.id]);
    }
  }

  console.log(`[QC] #${row.id} | ${row.rep_name} (${row.role}) | ${txChars}ch | dur:${durSec}s | ag:${agTalk}%`);
  if (!row.transcript || row.transcript.trim().length < 50) throw new Error('NO_TRANSCRIPT: ' + txChars + 'ch');

  const engine = process.env.AI_ENGINE || 'gemini';
  if (engine==='gemini' && !process.env.GEMINI_API_KEY) throw new Error('MISSING_GEMINI_API_KEY');
  if (engine==='claude' && !process.env.ANTHROPIC_API_KEY) throw new Error('MISSING_ANTHROPIC_API_KEY');

  // STEP 1: Classify
  const classification = await classifyCall(row.transcript);
  const ts = now();

  if (classification.callType !== 'full_sales_call') {
    const skipStatus = SKIP_STATUSES[classification.callType] || 'SKIP_SHORT';
    const summary = `${classification.callType.replace(/_/g, ' ')} — ${classification.reason}`;
    console.log(`[QC] #${row.id} → ${skipStatus}`);
    await q('UPDATE calls SET status=?, quick_summary=?, error=?, processed_at=?, model_used=?, call_duration_sec=COALESCE(?,call_duration_sec) WHERE id=?',
      [skipStatus, summary, `Classified: ${classification.callType}`, ts, 'classifier', durSec, row.id]);
    if (classification.cost > 0) {
      const dk = ts.slice(0,10);
      await q('INSERT INTO daily_counters (date_key,full_qc_used,est_cost_usd,updated_at) VALUES (?,0,?,?) ON CONFLICT(date_key) DO UPDATE SET est_cost_usd=est_cost_usd+?, updated_at=?',
        [dk, classification.cost, ts, classification.cost, ts]);
    }
    return { callId: row.id, score: null, flagged: false, cost: classification.cost, classified: classification.callType };
  }

  // STEP 2: Full scoring
  const role = row.role || 'Setter';
  const rubric = await q('SELECT * FROM rubric_items WHERE version=1 AND role=? ORDER BY weight DESC', [role]);
  if (!rubric.rows.length) throw new Error('NO_RUBRIC for ' + role);

  let slice = buildSmartSlice(row.transcript), midSummary = null;
  if (needsTwoPass(txChars, durSec)) {
    try { const r = await callAI(buildMiddleSummaryPrompt(row.transcript), {maxTokens:800}); midSummary = r.text; } catch(e) {}
  }

  const prompt = buildQCPrompt({
    role, repName: row.rep_name||'Unknown', source: row.source||'Unknown',
    transcript: slice, rubricItems: rubric.rows,
    metrics: { durationSec: durSec, agentTalkPct: agTalk, contactTalkPct: coTalk },
    middleSummary: midSummary,
  });

  console.log(`[QC] #${row.id} scoring (${prompt.length}ch)...`);
  const { result, usage } = await callAIJson(prompt);
  if (!result || result.overall_score === undefined) throw new Error('INVALID_RESPONSE: ' + JSON.stringify(result).slice(0,300));

  const scoringCost = estimateCost(usage);
  const totalCost = scoringCost + (classification.cost || 0);
  const adj = adjustScore(result.overall_score, durSec, agTalk);
  const flagged = isFlagged(result, adj.adjusted, durSec, agTalk);

  await q('UPDATE calls SET overall_score=?,overall_score_adj=?,score_adjust_notes=?,category_scores=?,pass_fail=?,coaching_notes=?,quick_summary=?,strengths=?,improvements=?,next_step_text=?,golden_moments=?,flagged=?,status=?,error=?,processed_at=?,model_used=?,transcript_slice=?,call_duration_sec=COALESCE(?,call_duration_sec) WHERE id=?',
    [result.overall_score, adj.adjusted, adj.notes.join(' | '), JSON.stringify(result.category_scores||{}), JSON.stringify(result.pass_fail||{}), result.coaching_notes||'', result.quick_summary||'', JSON.stringify(result.strengths||[]), JSON.stringify(result.improvements||[]), result.next_step_text||'', JSON.stringify(result.golden_moments||[]), flagged?1:0, 'SCORED', '', ts, usage.model||'unknown', slice, durSec, row.id]);

  const dk = ts.slice(0,10);
  await q('INSERT INTO daily_counters (date_key,full_qc_used,est_cost_usd,updated_at) VALUES (?,1,?,?) ON CONFLICT(date_key) DO UPDATE SET full_qc_used=full_qc_used+1, est_cost_usd=est_cost_usd+?, updated_at=?', [dk,totalCost,ts,totalCost,ts]);

  console.log(`[QC] ✓ #${row.id} → ${adj.adjusted}/10 $${totalCost.toFixed(4)}`);
  return { callId: row.id, score: adj.adjusted, flagged, cost: totalCost };
}

async function processQueue(max = 3) {
  const batch = await q('SELECT * FROM calls WHERE status IN (?,?,?) AND retry_count < ? ORDER BY CASE status WHEN ? THEN 0 WHEN ? THEN 1 ELSE 2 END, received_at ASC LIMIT ?',
    ['NEW','REQC','WAIT_RETRY_FULL', MAX_RETRY, 'REQC','NEW', max]);
  if (!batch.rows.length) return { processed: 0, total: 0, reason: 'QUEUE_EMPTY', results: [] };
  console.log(`[QC] Found ${batch.rows.length} calls`);
  const ts = now();
  for (const row of batch.rows) await q('UPDATE calls SET last_tried_at=?, retry_count=retry_count+1 WHERE id=?', [ts, row.id]);

  let processed = 0, classified = 0;
  const results = [];
  for (const row of batch.rows) {
    try {
      const r = await processCall(row);
      if (r.classified) { classified++; results.push({ id: row.id, rep: row.rep_name, client: row.client_name, status: r.classified.toUpperCase() }); }
      else { processed++; results.push({ id: row.id, rep: row.rep_name, client: row.client_name, status: 'SCORED', score: r.score }); }
    } catch (err) {
      const msg = String(err?.message || err);
      console.error(`[QC] #${row.id} FAILED: ${msg}`);
      const retry = /429|503|529|JSON_PARSE|EMPTY|TIMEOUT|ECONNRESET|MAX_RETRIES|fetch|network|GEMINI_HTTP/i.test(msg);
      await q('UPDATE calls SET status=?, error=? WHERE id=?', [retry?'WAIT_RETRY_FULL':'ERROR', (retry?'RETRYABLE: ':'')+msg.slice(0,500), row.id]);
      results.push({ id: row.id, rep: row.rep_name, status: retry?'RETRY':'ERROR', error: msg.slice(0,200) });
    }
  }
  console.log(`[QC] Done: ${processed} scored, ${classified} classified`);
  return { processed, classified, total: batch.rows.length, results };
}

async function unpauseDailyRows() {
  const r = await q("UPDATE calls SET status='NEW', error='' WHERE status='PAUSED_DAILY_LIMIT'");
  if (r.rowsAffected) console.log(`[QC] Unpaused ${r.rowsAffected} rows`);
}

module.exports = { processQueue, processCall, unpauseDailyRows, adjustScore };

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
//
// Sam's rules are now DEDUCTIONS not caps — you see the AI's honest score
// with transparent point deductions labeled with what triggered them.
// Each deduction is also available as a structured flag for filtering.
function adjustScore(ai, dur, agPct, result) {
  const deductions = []; // structured: [{rule, label, points, severity}]
  if (typeof ai !== 'number' || !isFinite(ai)) return { adjusted: ai, notes: ['No score'], deductions: [] };
  let s = ai;

  // Sam's philosophy rules — deductions instead of caps
  const pf = result?.pass_fail || {};
  if (pf.has_discovery === false) {
    s -= 3;
    deductions.push({ rule: 'no_discovery', label: 'Failed: No Discovery', points: -3, severity: 'critical', source: "Sam's philosophy" });
  }
  if (pf.financial_qualification === false) {
    s -= 2;
    deductions.push({ rule: 'no_financial_qual', label: 'Failed: No Financial Qualification', points: -2, severity: 'critical', source: "Sam's philosophy" });
  }
  if (pf.handled_objections === false) {
    s -= 2;
    deductions.push({ rule: 'no_objection_handling', label: 'Failed: No Objection Handling', points: -2, severity: 'critical', source: "Sam's philosophy" });
  }
  if (pf.tailored_pitch === false) {
    s -= 1;
    deductions.push({ rule: 'untailored_pitch', label: 'Untailored Pitch', points: -1, severity: 'warning', source: "Sam's philosophy" });
  }

  // Talk % adjustments — call mechanics, kept as-is
  if (agPct !== null && agPct !== undefined && agPct > 0) {
    if (agPct > 90) {
      s -= 2;
      deductions.push({ rule: 'agent_talk_too_high', label: `Agent talk ${agPct}% (>90%)`, points: -2, severity: 'warning', source: 'Call mechanics' });
    } else if (agPct > 80) {
      s -= 1;
      deductions.push({ rule: 'agent_talk_high', label: `Agent talk ${agPct}% (>80%)`, points: -1, severity: 'warning', source: 'Call mechanics' });
    }
    if (agPct < 10) {
      s -= 2;
      deductions.push({ rule: 'agent_talk_too_low', label: `Agent talk ${agPct}% (<10%)`, points: -2, severity: 'warning', source: 'Call mechanics' });
    } else if (agPct < 20) {
      s -= 1;
      deductions.push({ rule: 'agent_talk_low', label: `Agent talk ${agPct}% (<20%)`, points: -1, severity: 'warning', source: 'Call mechanics' });
    }
  }

  s = Math.max(0, Math.min(10, Math.round(s*10)/10));
  const notes = deductions.length ? deductions.map(d => `${d.label} (${d.points})`) : ['No adjustments'];
  return { adjusted: s, notes, deductions };
}

function isFlagged(result, adj, dur, agPct) {
  const cs = result.category_scores || {}, pf = result.pass_fail || {};
  const ov = (adj !== null && adj !== undefined && isFinite(adj)) ? adj : result.overall_score;
  if (typeof ov === 'number' && isFinite(ov) && ov < 6) return true;
  if (agPct !== null && agPct !== undefined && agPct > 0 && (agPct > 85 || agPct < 15)) return true;
  for (const v of Object.values(cs)) if (typeof v === 'number' && isFinite(v) && v < 5) return true;
  // Sam's non-negotiables
  if (pf.has_discovery === false || pf.financial_qualification === false || pf.handled_objections === false) return true;
  if (pf.explained_offer === false || pf.clear_next_step === false || pf.qualified_investor_fit === false) return true;
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
  // Rescued calls (manually pulled back from Non-Sales) carry a marker that forces
  // full scoring and skips re-classification — otherwise the classifier could bounce
  // them straight back to the skip status they were rescued from.
  const forceScore = row.error === 'FORCE_SCORE_RESCUED';
  const classification = forceScore
    ? { callType: 'full_sales_call', reason: 'forced (rescued from Non-Sales)', cost: 0 }
    : await classifyCall(row.transcript);
  const ts = now();

  if (classification.callType !== 'full_sales_call') {
    const skipStatus = SKIP_STATUSES[classification.callType] || 'SKIP_SHORT';
    const summary = `${classification.callType.replace(/_/g, ' ')} — ${classification.reason}`;
    console.log(`[QC] #${row.id} → ${skipStatus}`);
    await q('UPDATE calls SET status=?, quick_summary=?, error=?, processed_at=?, model_used=?, call_duration_sec=COALESCE(?,call_duration_sec) WHERE id=?',
      [skipStatus, summary, `Classified: ${classification.callType}`, ts, 'classifier', durSec, row.id]);
    if (classification.cost > 0) {
      const dk = ts.slice(0,10);
      await q('INSERT INTO daily_counters (date_key,full_qc_used,est_cost_usd,updated_at) VALUES (?,0,?,?) ON CONFLICT(date_key) DO UPDATE SET est_cost_usd=daily_counters.est_cost_usd+?, updated_at=?',
        [dk, classification.cost, ts, classification.cost, ts]);
    }
    return { callId: row.id, score: null, flagged: false, cost: classification.cost, classified: classification.callType };
  }

  // STEP 2: Full scoring — prefer rubric v2 (Sam's philosophy), fallback to v1
  const role = row.role || 'Setter';
  let rubric = await q('SELECT * FROM rubric_items WHERE version=2 AND role=? ORDER BY weight DESC', [role]);
  if (!rubric.rows.length) {
    rubric = await q('SELECT * FROM rubric_items WHERE version=1 AND role=? ORDER BY weight DESC', [role]);
  }
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
  const adj = adjustScore(result.overall_score, durSec, agTalk, result);
  const flagged = isFlagged(result, adj.adjusted, durSec, agTalk);

  // Append confidence to adjustment notes
  const confidence = result.confidence || 'unknown';
  const confReason = result.confidence_reason || '';
  const adjustNotes = [adj.notes.join(' | '), `Confidence: ${confidence}${confReason ? ' — ' + confReason : ''}`].join(' | ');

  // Determine which rubric version we're using
  const rubricVersion = rubric.rows[0]?.version || 1;

  // If this call was previously scored (re-scoring), snapshot the old scores into score_history
  if (row.overall_score !== null && row.overall_score !== undefined && row.overall_score !== '') {
    try {
      const snapshot = {
        call_id: row.id,
        snapshot_at: ts,
        rubric_version: row.rubric_version || 1,
        overall_score: row.overall_score,
        overall_score_adj: row.overall_score_adj,
        category_scores: row.category_scores,
        pass_fail: row.pass_fail,
        score_adjust_notes: row.score_adjust_notes,
        quick_summary: row.quick_summary,
        coaching_notes: row.coaching_notes,
        strengths: row.strengths,
        improvements: row.improvements,
        model_used: row.model_used,
      };
      await q(
        'INSERT INTO score_history (call_id, snapshot_at, rubric_version, overall_score, overall_score_adj, category_scores, pass_fail, score_adjust_notes, quick_summary, coaching_notes, strengths, improvements, model_used) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [snapshot.call_id, snapshot.snapshot_at, snapshot.rubric_version, snapshot.overall_score, snapshot.overall_score_adj, snapshot.category_scores, snapshot.pass_fail, snapshot.score_adjust_notes, snapshot.quick_summary, snapshot.coaching_notes, snapshot.strengths, snapshot.improvements, snapshot.model_used]
      );
      console.log(`[QC] #${row.id} snapshot saved (v${snapshot.rubric_version})`);
    } catch (snapErr) {
      console.error(`[QC] #${row.id} snapshot failed: ${snapErr.message} — continuing with scoring`);
    }
  }

  // Merge Sam's philosophy fields AND deductions into pass_fail so no schema change is needed
  const enrichedPassFail = {
    ...(result.pass_fail || {}),
    beliefs_covered: result.beliefs_covered || null,
    frame_assessment: result.frame_assessment || null,
    temperature_check: result.temperature_check || null,
    deductions: adj.deductions || [],
    rubric_version: rubricVersion,
  };

  await q('UPDATE calls SET overall_score=?,overall_score_adj=?,score_adjust_notes=?,category_scores=?,pass_fail=?,coaching_notes=?,quick_summary=?,strengths=?,improvements=?,next_step_text=?,golden_moments=?,flagged=?,status=?,error=?,processed_at=?,model_used=?,transcript_slice=?,rubric_version=?,call_duration_sec=COALESCE(?,call_duration_sec) WHERE id=?',
    [result.overall_score, adj.adjusted, adjustNotes, JSON.stringify(result.category_scores||{}), JSON.stringify(enrichedPassFail), result.coaching_notes||'', result.quick_summary||'', JSON.stringify(result.strengths||[]), JSON.stringify(result.improvements||[]), result.next_step_text||'', JSON.stringify(result.golden_moments||[]), flagged?1:0, 'SCORED', '', ts, usage.model||'unknown', slice, rubricVersion, durSec, row.id]);

  const dk = ts.slice(0,10);
  await q('INSERT INTO daily_counters (date_key,full_qc_used,est_cost_usd,updated_at) VALUES (?,1,?,?) ON CONFLICT(date_key) DO UPDATE SET full_qc_used=daily_counters.full_qc_used+1, est_cost_usd=daily_counters.est_cost_usd+?, updated_at=?', [dk,totalCost,ts,totalCost,ts]);

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
      // Smart retry: only retry recoverable errors
      const isTimeout = /429|503|529|TIMEOUT|ECONNRESET|fetch|network/i.test(msg);
      const isParseError = /JSON_PARSE|EMPTY|INVALID_RESPONSE/i.test(msg);
      const isPermanent = /NO_TRANSCRIPT|NO_RUBRIC|MISSING.*KEY/i.test(msg);
      const retry = !isPermanent && (isTimeout || isParseError);
      const errPrefix = isPermanent ? 'PERMANENT: ' : isTimeout ? 'RETRYABLE_NETWORK: ' : isParseError ? 'RETRYABLE_PARSE: ' : 'ERROR: ';
      await q('UPDATE calls SET status=?, error=? WHERE id=?', [retry?'WAIT_RETRY_FULL':'ERROR', errPrefix+msg.slice(0,500), row.id]);
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

// ─── Stuck-transcript fallback ──────────────────────────────
// WAIT_TRANSCRIPT calls sit until Aloware's transcript event arrives.
// If it never comes, they'd wait forever. This sweep flags calls that
// have waited beyond a threshold so they surface instead of vanishing.
// Runs on a timer (see index.js). Non-destructive: only changes status
// of calls that are genuinely overdue AND still have no transcript.
async function sweepStuckTranscripts(maxHours = 4) {
  // Find WAIT_TRANSCRIPT calls older than maxHours with still-empty transcripts
  const stuck = await q(
    `SELECT id, rep_name, client_name, call_duration_sec, received_at
     FROM calls
     WHERE status='WAIT_TRANSCRIPT'
       AND (transcript IS NULL OR LENGTH(transcript)=0)
       AND received_at::timestamp < (NOW() - (? || ' hours')::interval)`,
    [String(maxHours)]);

  if (!stuck.rows.length) return { swept: 0 };

  const ts = now();
  for (const row of stuck.rows) {
    // Mark as NO_TRANSCRIPT so it's visible as needing attention (not silently waiting).
    // We keep the row and all its metadata — this is a flag, not a delete.
    await q("UPDATE calls SET status='NO_TRANSCRIPT', error=? WHERE id=?",
      [`Transcript never arrived after ${maxHours}h wait (Aloware). Call ${row.call_duration_sec}s. May need manual pull.`, row.id]);
    console.log(`[QC] Stuck transcript flagged: #${row.id} ${row.rep_name} → ${row.client_name} (waited >${maxHours}h)`);
  }
  return { swept: stuck.rows.length, ids: stuck.rows.map(r => r.id) };
}

module.exports = { processQueue, processCall, unpauseDailyRows, adjustScore, sweepStuckTranscripts };

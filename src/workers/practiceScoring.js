// ═══════════════════════════════════════════════════════════════
// Practice Scoring — Stage 2 Trainer
// REUSES the real QC engine (adjustScore, buildQCPrompt, callAIJson)
// so practice sessions are scored identically to real calls.
// New code here is only: transcript building, metrics, scenario context.
// ═══════════════════════════════════════════════════════════════

const { callAIJson } = require('../services/ai');
const { buildQCPrompt } = require('../services/prompts');
const { adjustScore } = require('./qcWorker');
const { q } = require('../../migrations/run');

function now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

// ─── Turn the stored messages into the transcript format the scorer expects ──
// messages_json is an array: [{ role: 'rep'|'prospect', text, ts }]
function buildPracticeTranscript(messagesJson) {
  let msgs = [];
  try { msgs = JSON.parse(messagesJson || '[]'); } catch { msgs = []; }
  return msgs.map(m => {
    const who = m.role === 'rep' ? 'Rep' : 'Prospect';
    const ts = m.ts ? `[${m.ts}] ` : '';
    return `${ts}${who}: ${m.text || ''}`;
  }).join('\n');
}

// ─── Compute talk ratio + duration from the messages (scorer uses these) ──
function practiceMetrics(messagesJson, startedAt, endedAt) {
  let msgs = [];
  try { msgs = JSON.parse(messagesJson || '[]'); } catch { msgs = []; }
  const repChars = msgs.filter(m => m.role === 'rep').reduce((a, m) => a + (m.text || '').length, 0);
  const proChars = msgs.filter(m => m.role === 'prospect').reduce((a, m) => a + (m.text || '').length, 0);
  const total = repChars + proChars;
  const agentTalkPct = total > 0 ? Math.round((repChars / total) * 100) : null;
  let durationSec = null;
  if (startedAt && endedAt) {
    durationSec = Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000));
  }
  return { agentTalkPct, contactTalkPct: agentTalkPct != null ? 100 - agentTalkPct : null, durationSec };
}

// ─── Build the scenario-context paragraph appended to the QC prompt ──
// This is the ONLY scoring difference between practice and real calls:
// the scorer is told what the rep was practicing against.
function buildScenarioContext(scenario) {
  if (!scenario) return '';
  const parts = ['\n═══ PRACTICE SCENARIO CONTEXT ═══',
    'This was a PRACTICE call against an AI prospect, not a real call. Score the rep exactly as you would a real call, but use this context:'];
  if (scenario.title) parts.push(`- Scenario: ${scenario.title}`);
  if (scenario.target_role) parts.push(`- Rep was practicing as: ${scenario.target_role}`);
  const beliefs = safeArr(scenario.target_beliefs);
  if (beliefs.length) parts.push(`- Expected to uncover beliefs: ${beliefs.join(', ')}`);
  const cats = safeArr(scenario.target_categories);
  if (cats.length) parts.push(`- Focus skills being trained: ${cats.join(', ')}`);
  if (scenario.scoring_focus_json) {
    try {
      const sf = JSON.parse(scenario.scoring_focus_json);
      if (sf && sf.notes) parts.push(`- Scoring focus: ${sf.notes}`);
    } catch {}
  }
  // The hidden truth helps the scorer judge whether the rep dug correctly —
  // it's revealed to the SCORER (not shown to the rep during the call).
  if (scenario.hidden_truth_json) {
    try {
      const ht = JSON.parse(scenario.hidden_truth_json);
      if (ht && ht.summary) parts.push(`- Hidden truth the rep needed to surface: ${ht.summary}`);
    } catch {}
  }
  return parts.join('\n');
}

function safeArr(v) { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }

// ─── The integration heart: score a finished practice session ──
async function scorePracticeSession(session, scenario, rubricItems) {
  const transcript = buildPracticeTranscript(session.messages_json);
  const { agentTalkPct, contactTalkPct, durationSec } = practiceMetrics(
    session.messages_json, session.started_at, session.ended_at);

  // SAME prompt builder, with scenario context appended (backward-compatible param)
  const prompt = buildQCPrompt({
    role: scenario.target_role || 'Closer',
    repName: session.rep_name || 'Unknown',
    source: 'practice',
    transcript,
    rubricItems: rubricItems || [],
    metrics: { agentTalkPct, contactTalkPct, durationSec },
    scenarioContext: buildScenarioContext(scenario),  // NEW — see prompts.js change
  });

  // SAME Claude call
  const { result, usage } = await callAIJson(prompt);

  // SAME deductions engine — zero changes
  const raw = toNum(result?.overall_score);
  const { adjusted, notes, deductions } = adjustScore(raw, durationSec, agentTalkPct, result);
  if (result?.pass_fail) result.pass_fail.deductions = deductions;

  // Vs-last-attempt delta (Train live signals, Jul 24): the rep's most recent PRIOR
  // scored session on this SAME scenario — not scenario type or difficulty, the
  // exact scenario, so the comparison is apples-to-apples. Excludes the current
  // session (it isn't 'scored' yet at this point in the flow anyway, but excluded
  // explicitly for clarity). Null when this is a first attempt — never fabricate a
  // delta from nothing, same discipline as the rest of this platform.
  const priorRow = await q(
    `SELECT overall_score_adj FROM practice_sessions
     WHERE scenario_id=? AND rep_name=? AND status='scored' AND id<>?
     ORDER BY id DESC LIMIT 1`,
    [session.scenario_id, session.rep_name, session.id]);
  const priorScore = priorRow.rows.length ? toNum(priorRow.rows[0].overall_score_adj) : null;
  const scoreDelta = (priorScore != null && adjusted != null) ? Math.round((adjusted - priorScore) * 10) / 10 : null;

  const ts = now();
  await q(`UPDATE practice_sessions SET status='scored',
      overall_score=?, overall_score_adj=?, score_adjust_notes=?,
      category_scores=?, pass_fail=?, coaching_notes=?, quick_summary=?,
      strengths=?, improvements=?, golden_moments=?, model_used=?, rubric_version=2,
      duration_sec=?, ended_at=COALESCE(ended_at, ?),
      prior_attempt_score=?, score_delta=?
      WHERE id=?`,
    [raw, adjusted, notes.join(' | '),
     JSON.stringify(result?.category_scores || {}),
     JSON.stringify(result?.pass_fail || {}),
     result?.coaching_notes || '', result?.quick_summary || '',
     JSON.stringify(result?.strengths || []), JSON.stringify(result?.improvements || []),
     JSON.stringify(result?.golden_moments || []),
     usage?.model || 'claude', durationSec, ts,
     priorScore, scoreDelta,
     session.id]);

  return { ok: true, sessionId: session.id, overall: raw, adjusted, deductions, usage,
    prior_attempt_score: priorScore, score_delta: scoreDelta };
}

function toNum(v) { const n = Number(v); return isFinite(n) ? n : null; }

module.exports = {
  scorePracticeSession, buildPracticeTranscript, practiceMetrics, buildScenarioContext,
};

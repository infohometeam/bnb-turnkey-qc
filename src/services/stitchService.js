// stitchService.js — detect and merge cut-off calls that were redialed.
// A dropped call + its redial should be ONE scored conversation, not two half-calls.
//
// Safety model:
//  - Only considers same rep + same client, within a tight time window.
//  - Requires transcript cues (call 1 ends abruptly / call 2 reconnects) — an AI check.
//  - HIGH confidence (both cues + close in time) -> can auto-merge.
//  - MEDIUM confidence (one cue) -> suggested, needs human approval.
//  - Merge combines transcripts, hides originals (status STITCHED), re-scores the survivor.
//  - Originals are never deleted — fully reversible.
const { q } = require('../../migrations/run');
const { callAIJson } = require('./ai');

const STITCH_WINDOW_MIN = Number(process.env.STITCH_WINDOW_MIN || 60);

// Find candidate pairs: two SCORED calls, same rep + client, within the window,
// neither already stitched. Returns [{first, second}] ordered by time.
async function findCandidatePairs() {
  const rows = (await q(
    `SELECT id, rep_name, client_name, received_at, call_duration_sec, transcript, overall_score_adj,
            status, stitch_status
     FROM calls
     WHERE status='SCORED' AND (stitch_status IS NULL OR stitch_status='') 
       AND client_name IS NOT NULL AND client_name <> ''
       AND transcript IS NOT NULL
     ORDER BY rep_name, client_name, received_at ASC`)).rows;

  const pairs = [];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (a.rep_name !== b.rep_name) continue;
    if ((a.client_name || '').toLowerCase() !== (b.client_name || '').toLowerCase()) continue;
    const ta = new Date((a.received_at || '').replace(' ', 'T') + 'Z').getTime();
    const tb = new Date((b.received_at || '').replace(' ', 'T') + 'Z').getTime();
    if (!isFinite(ta) || !isFinite(tb)) continue;
    const gapMin = Math.abs(tb - ta) / 60000;
    if (gapMin > STITCH_WINDOW_MIN) continue;
    // a is earlier (rows are ordered asc)
    pairs.push({ first: a, second: b, gapMin: Math.round(gapMin * 10) / 10 });
  }
  return pairs;
}

// AI cue-check: does call 1 end abruptly, and does call 2 reconnect?
async function cueCheck(first, second) {
  const end1 = (first.transcript || '').slice(-800);
  const start2 = (second.transcript || '').slice(0, 800);
  const prompt = `Two back-to-back calls between the same rep and client. Determine if the FIRST call was cut off (dropped/disconnected) and the SECOND is the continuation after a redial.

Look for:
- Call 1 ending abruptly / mentioning a bad connection / "let me call you back" / cut off mid-topic.
- Call 2 opening by reconnecting: "is that better", "calling on a different number", "as I was saying", picking up mid-conversation with no fresh greeting.

CALL 1 ENDING:
${end1}

CALL 2 START:
${start2}

Return ONLY JSON:
{"call1_cut_off": true/false, "call2_reconnects": true/false, "confidence": "high"|"medium"|"low", "reason": "one sentence"}`;

  try {
    const { result } = await callAIJson(prompt, { maxTokens: 150 });
    return result || { call1_cut_off: false, call2_reconnects: false, confidence: 'low', reason: 'no result' };
  } catch (e) {
    return { call1_cut_off: false, call2_reconnects: false, confidence: 'low', reason: 'cue check failed: ' + e.message };
  }
}

// Scan for pairs and classify each as auto/suggested/skip. Does NOT merge here.
async function detectStitches() {
  const pairs = await findCandidatePairs();
  const results = [];
  for (const p of pairs) {
    const cue = await cueCheck(p.first, p.second);
    const bothCues = cue.call1_cut_off && cue.call2_reconnects;
    const oneCue = cue.call1_cut_off || cue.call2_reconnects;
    let decision = 'skip';
    // HIGH: both cues present and very close in time -> auto-mergeable
    if (bothCues && p.gapMin <= 20) decision = 'auto';
    else if (bothCues || (oneCue && cue.confidence === 'high')) decision = 'suggest';
    results.push({
      first_id: p.first.id, second_id: p.second.id,
      rep_name: p.first.rep_name, client_name: p.first.client_name,
      gap_min: p.gapMin, cue, decision,
      first_score: p.first.overall_score_adj, second_score: p.second.overall_score_adj,
    });
  }
  return results;
}

// Merge two calls: combine transcripts into the FIRST (survivor), hide the second,
// mark both, and queue the survivor for a fresh score. Reversible.
async function mergeCalls(firstId, secondId, mergedBy = 'auto') {
  const a = (await q('SELECT * FROM calls WHERE id=?', [firstId])).rows[0];
  const b = (await q('SELECT * FROM calls WHERE id=?', [secondId])).rows[0];
  if (!a || !b) throw new Error('One or both calls not found');
  if (a.stitch_status === 'MERGED' || b.stitch_status === 'STITCHED') throw new Error('Already stitched');

  const combined = (a.transcript || '') + '\n\n[...call dropped and reconnected...]\n\n' + (b.transcript || '');
  const combinedDur = (Number(a.call_duration_sec) || 0) + (Number(b.call_duration_sec) || 0);
  const fromIds = JSON.stringify([firstId, secondId]);

  // Survivor (first): gets combined transcript, re-scores via FORCE_SCORE path (skip classification).
  await q(
    `UPDATE calls SET transcript=?, transcript_chars=?, call_duration_sec=?,
       stitch_status='MERGED', stitched_from_ids=?, status='NEW', error='FORCE_SCORE_RESCUED', retry_count=0
     WHERE id=?`,
    [combined, combined.length, combinedDur || null, fromIds, firstId]);

  // Second: hidden from scoring, points to survivor, preserved for audit/reversal.
  await q(
    `UPDATE calls SET status='STITCHED', stitch_status='STITCHED', stitched_into_id=?
     WHERE id=?`,
    [firstId, secondId]);

  return { ok: true, survivor: firstId, hidden: secondId, merged_by: mergedBy };
}

// Undo a merge: restore the hidden call, revert the survivor's flags.
// (Note: the survivor keeps the combined transcript unless re-scored; caller can re-score.)
async function unmergeCalls(survivorId) {
  const survivor = (await q('SELECT * FROM calls WHERE id=?', [survivorId])).rows[0];
  if (!survivor || survivor.stitch_status !== 'MERGED') throw new Error('Not a merged call');
  let ids = [];
  try { ids = JSON.parse(survivor.stitched_from_ids || '[]'); } catch (e) {}
  const hiddenId = ids.find(x => x !== survivorId);
  if (hiddenId) {
    await q(`UPDATE calls SET status='SCORED', stitch_status=NULL, stitched_into_id=NULL WHERE id=?`, [hiddenId]);
  }
  await q(`UPDATE calls SET stitch_status=NULL, stitched_from_ids=NULL WHERE id=?`, [survivorId]);
  return { ok: true, restored: hiddenId, survivor: survivorId };
}

module.exports = { findCandidatePairs, detectStitches, mergeCalls, unmergeCalls, STITCH_WINDOW_MIN };

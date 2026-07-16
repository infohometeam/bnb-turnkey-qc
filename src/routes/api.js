const express = require('express');
const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════
// SHARED TAG EXCLUSION — defined ONCE so it can never drift between queries.
// A call carrying a CONFIRMED tag whose tag has excludes_from_average=true
// (Disqualified / Not Ready / Long-Term Nurture / Info Seeker) does NOT count
// toward any rep or team performance average — but it STAYS attributed to the
// rep and stays fully visible. SUGGESTED tags have zero effect.
//
// ⚠️ This MUST be appended to every performance-average query. We previously
// shipped a bug where 'Unknown Setter' was excluded from the leaderboard but
// not the main stats, and one bad call polluted every headline number.
// ═══════════════════════════════════════════════════════════════════════
const NOT_TAGGED = `NOT EXISTS (SELECT 1 FROM call_tag_assignments cta JOIN call_tags ct ON ct.key = cta.tag_key WHERE cta.call_id = calls.id AND cta.status = 'CONFIRMED' AND ct.excludes_from_average = true)`;
// For WHERE clauses:
const EXCL_TAGGED = `AND ${NOT_TAGGED}`;
// For use INSIDE FILTER(WHERE ...) aggregates — so a tagged call still counts as a call
// the rep made (total_calls), but does NOT pull their AVERAGE. That distinction matters:
// the call stays theirs, only the score stops counting.
const SCORED_UNTAGGED = `status='SCORED' AND ${NOT_TAGGED}`;
const { q } = require('../../migrations/run');
const { ingestCall } = require('../services/ingestion');
const { processQueue } = require('../workers/qcWorker');

function parseJ(c) {
  if (!c) return c;
  try { c.category_scores = JSON.parse(c.category_scores); } catch(e) { c.category_scores = null; }
  try { c.pass_fail = JSON.parse(c.pass_fail); } catch(e) { c.pass_fail = null; }
  try { c.strengths = JSON.parse(c.strengths); } catch(e) { c.strengths = []; }
  try { c.improvements = JSON.parse(c.improvements); } catch(e) { c.improvements = []; }
  try { c.golden_moments = JSON.parse(c.golden_moments); } catch(e) { c.golden_moments = []; }
  c.flagged = !!c.flagged;
  return c;
}

// ─── Webhook ─────────────────────────────────────────────────
router.post('/webhook', express.text({ type: '*/*', limit: '5mb' }), async (req, res) => {
  try {
    const key = req.query.key || '', expected = process.env.WEBHOOK_SECRET_KEY || '';
    if (!expected || key !== expected) return res.status(401).json({ error: 'Unauthorized' });
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const result = await ingestCall(raw, req.query.src || '');
    if (result.duplicate) return res.json({ status: 'duplicate_skipped', callId: result.callId });
    res.json({ status: 'ok', callId: result.callId, qcStatus: result.status });
  } catch (err) { console.error('[Webhook]', err); res.status(500).json({ error: err.message }); }
});
router.get('/webhook/health', (req, res) => { res.json({ status: 'ok', engine: process.env.AI_ENGINE || 'gemini' }); });

// ─── Calls (hides non-sales by default) ─────────────────────
router.get('/calls', async (req, res) => {
  try {
    const { status, rep, role, period, flagged, from, to, limit = 500, offset = 0, hideVm = 'true' } = req.query;
    let w = '1=1', p = [];
    if (hideVm === 'true') w += " AND status NOT IN ('SKIP_VOICEMAIL','SKIP_SHORT','SKIP_RESCHEDULE','SKIP_FOLLOWUP','SKIP_WRONG_NUMBER','SKIP_INTERNAL','SKIP_NOT_ROSTERED','STITCHED')";
    if (status && status !== 'ALL') { w += ' AND status=?'; p.push(status); }
    if (rep) { w += ' AND rep_name=?'; p.push(rep); }
    if (role) { w += ' AND role=?'; p.push(role); }
    if (flagged === 'true') w += ' AND flagged=1';
    if (from) { w += ' AND received_at >= ?'; p.push(from); }
    if (to) { w += ' AND received_at <= ?'; p.push(to + ' 23:59:59'); }
    if (!from && !to) {
      if (period === 'day') w += " AND received_at::timestamp >= CURRENT_DATE";
      // Yesterday only — the full previous calendar day, not "last 24h".
      if (period === 'yesterday') w += " AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '1 day') AND received_at::timestamp < CURRENT_DATE";
      if (period === 'week') w += " AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '7 days')";
      if (period === 'month') w += " AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '30 days')";
    }
    // Filter by a confirmed tag (e.g. show me every Long-Term Nurture call)
    if (req.query.tag) {
      w += ` AND EXISTS (SELECT 1 FROM call_tag_assignments a WHERE a.call_id=calls.id AND a.tag_key=? AND a.status='CONFIRMED')`;
      p.push(req.query.tag);
    }
    const r = await q(`SELECT id,received_at,source,rep_name,rep_id,role,team,client_name,call_url,audio_url,call_duration_sec,agent_talk_pct,contact_talk_pct,overall_score,overall_score_adj,score_adjust_notes,category_scores,pass_fail,quick_summary,strengths,improvements,next_step_text,coaching_notes,golden_moments,status,flagged,error,retry_count,weekstart,processed_at,stitch_status,stitched_from_ids,aloware_contact_id,aloware_call_id FROM calls WHERE ${w} ORDER BY received_at DESC LIMIT ? OFFSET ?`, [...p, Number(limit), Number(offset)]);
    const cnt = await q(`SELECT COUNT(*) as c FROM calls WHERE ${w}`, p);

    // Attach tags to each call in ONE query (avoids N+1) so the list can show them.
    const rows = r.rows.map(parseJ);
    if (rows.length) {
      const ids = rows.map(x => x.id);
      const tg = await q(
        `SELECT a.call_id, a.tag_key, a.status, t.label, t.color, t.tag_group, t.excludes_from_average
         FROM call_tag_assignments a JOIN call_tags t ON t.key = a.tag_key
         WHERE a.call_id = ANY(?) AND a.status <> 'DISMISSED'`, [ids]);
      const byCall = {};
      for (const x of tg.rows) (byCall[x.call_id] = byCall[x.call_id] || []).push(x);
      rows.forEach(c => { c.tags = byCall[c.id] || []; });
    }
    res.json({ calls: rows, total: Number(cnt.rows[0].c) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/calls/:id', async (req, res) => {
  try {
    const r = await q('SELECT * FROM calls WHERE id=?', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const call = parseJ(r.rows[0]);
    // Fill in Rep/Lead for moments the AI didn't tag — same inference as the library.
    for (const key of ['golden_moments', 'tough_moments']) {
      let arr = call[key];
      if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = null; } }
      if (Array.isArray(arr)) {
        arr.forEach(m => {
          if (m && m.quote && !m.speaker) {
            const sp = inferMomentSpeaker(m.quote, call.transcript, call.rep_name, call.transcript_quality);
            if (sp) m.speaker = sp;
          }
        });
        call[key] = arr;
      }
    }
    res.json(call);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/calls/:id', async (req, res) => {
  try {
    const allowed = ['rep_name','client_name','role','team','call_duration_sec','agent_talk_pct','contact_talk_pct','status','error'];
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(req.body)) { if (allowed.includes(k)) { sets.push(`${k}=?`); vals.push(v); } }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields' });
    vals.push(req.params.id);
    await q(`UPDATE calls SET ${sets.join(',')} WHERE id=?`, vals);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/calls/:id', async (req, res) => {
  try { await q('DELETE FROM calls WHERE id=?', [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/calls/bulk-delete', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Provide ids array' });
    for (const id of ids) await q('DELETE FROM calls WHERE id=?', [id]);
    res.json({ ok: true, deleted: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/calls/:id/reqc', async (req, res) => {
  try { await q("UPDATE calls SET status='REQC', error='', retry_count=0 WHERE id=?", [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Bulk Re-score Endpoints ────────────────────────────────
// Estimated cost per call: Claude Haiku scoring ~$0.006 avg (~$0.37 for 62 calls)
const RESCORE_COST_PER_CALL = 0.006;

// Preview what would be re-scored (shows counts + cost estimate without doing anything)
router.get('/rescore/preview', async (req, res) => {
  try {
    const { scope = 'all', days, ids } = req.query;
    let where = "status='SCORED'";
    let params = [];
    if (scope === 'recent' && days) {
      where += ` AND received_at::timestamp >= (NOW() - INTERVAL '${Number(days)} days')`;
    } else if (scope === 'selected' && ids) {
      const idList = String(ids).split(',').map(Number).filter(Boolean);
      if (!idList.length) return res.status(400).json({ error: 'No valid IDs' });
      where += ` AND id IN (${idList.map(()=>'?').join(',')})`;
      params = idList;
    }
    const r = await q(`SELECT COUNT(*) as count FROM calls WHERE ${where}`, params);
    const count = Number(r.rows[0]?.count || 0);
    const breakdown = await q(`SELECT role, COUNT(*) as count FROM calls WHERE ${where} GROUP BY role`, params);
    res.json({
      scope, days, count,
      estimatedCostUsd: +(count * RESCORE_COST_PER_CALL).toFixed(3),
      breakdown: breakdown.rows.map(r => ({ role: r.role, count: Number(r.count) })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Execute the re-score (flags calls as REQC so the worker picks them up on next cycle)
router.post('/rescore/execute', async (req, res) => {
  try {
    const { scope = 'all', days, ids } = req.body || {};
    let where = "status='SCORED'";
    let params = [];
    if (scope === 'recent' && days) {
      where += ` AND received_at::timestamp >= (NOW() - INTERVAL '${Number(days)} days')`;
    } else if (scope === 'selected') {
      if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Provide ids array for scope=selected' });
      where += ` AND id IN (${ids.map(()=>'?').join(',')})`;
      params = ids;
    } else if (scope !== 'all') {
      return res.status(400).json({ error: 'Invalid scope. Use: all, recent, selected' });
    }
    const r = await q(`UPDATE calls SET status='REQC', error='', retry_count=0 WHERE ${where}`, params);
    const affected = r.rowsAffected || r.changes || 0;
    res.json({ ok: true, queued: affected, scope, message: `${affected} calls queued for re-scoring. Worker will process on next cycle.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Score History ──────────────────────────────────────────
// Returns all archived score snapshots for a specific call
router.get('/calls/:id/history', async (req, res) => {
  try {
    const r = await q('SELECT * FROM score_history WHERE call_id=? ORDER BY snapshot_at DESC', [req.params.id]);
    const rows = r.rows.map(row => {
      try { row.category_scores = JSON.parse(row.category_scores || '{}'); } catch(e) {}
      try { row.pass_fail = JSON.parse(row.pass_fail || '{}'); } catch(e) {}
      try { row.strengths = JSON.parse(row.strengths || '[]'); } catch(e) {}
      try { row.improvements = JSON.parse(row.improvements || '[]'); } catch(e) {}
      return row;
    });
    res.json({ history: rows, count: rows.length });
  } catch (err) {
    // Table may not exist yet
    if (/no such table/i.test(err.message)) return res.json({ history: [], count: 0, note: 'score_history table not yet created' });
    res.status(500).json({ error: err.message });
  }
});

// ─── Rubric Comparison ──────────────────────────────────────
// Aggregates scores by rubric version. Shows avg overall, category avgs, flag rates.
router.get('/rubric-comparison', async (req, res) => {
  try {
    // Get all unique rubric versions that have been used
    const versions = await q('SELECT DISTINCT rubric_version FROM calls WHERE rubric_version IS NOT NULL AND status=?', ['SCORED']);
    const activeVersions = versions.rows.map(r => Number(r.rubric_version)).filter(Boolean);

    // Also check history table
    let historyVersions = [];
    try {
      const h = await q('SELECT DISTINCT rubric_version FROM score_history');
      historyVersions = h.rows.map(r => Number(r.rubric_version)).filter(Boolean);
    } catch(e) {}

    const allVersions = [...new Set([...activeVersions, ...historyVersions])].sort();
    const comparison = {};

    for (const v of allVersions) {
      // Current scores on this version
      const current = await q('SELECT overall_score_adj, category_scores, pass_fail, flagged, role FROM calls WHERE rubric_version=? AND status=?', [v, 'SCORED']);
      // Historical scores on this version
      let historical = { rows: [] };
      try {
        historical = await q('SELECT overall_score_adj, category_scores, pass_fail FROM score_history WHERE rubric_version=?', [v]);
      } catch(e) {}

      const allRows = [...current.rows, ...historical.rows];
      if (!allRows.length) continue;

      const scores = allRows.map(r => Number(r.overall_score_adj)).filter(n => isFinite(n));
      const avgScore = scores.length ? +(scores.reduce((a,b)=>a+b,0) / scores.length).toFixed(2) : 0;

      // Category averages
      const catTotals = {}, catCounts = {};
      for (const row of allRows) {
        try {
          const cs = typeof row.category_scores === 'string' ? JSON.parse(row.category_scores) : (row.category_scores || {});
          for (const [k, v] of Object.entries(cs)) {
            if (typeof v === 'number' && isFinite(v)) {
              catTotals[k] = (catTotals[k] || 0) + v;
              catCounts[k] = (catCounts[k] || 0) + 1;
            }
          }
        } catch(e) {}
      }
      const categoryAvgs = {};
      for (const k of Object.keys(catTotals)) categoryAvgs[k] = +(catTotals[k] / catCounts[k]).toFixed(2);

      // Pass/fail flag rates (from Sam's rules)
      const failCounts = { has_discovery: 0, financial_qualification: 0, handled_objections: 0, tailored_pitch: 0 };
      for (const row of allRows) {
        try {
          const pf = typeof row.pass_fail === 'string' ? JSON.parse(row.pass_fail) : (row.pass_fail || {});
          if (pf.has_discovery === false) failCounts.has_discovery++;
          if (pf.financial_qualification === false) failCounts.financial_qualification++;
          if (pf.handled_objections === false) failCounts.handled_objections++;
          if (pf.tailored_pitch === false) failCounts.tailored_pitch++;
        } catch(e) {}
      }
      const failRates = {};
      for (const k of Object.keys(failCounts)) failRates[k] = +(failCounts[k] / allRows.length * 100).toFixed(1);

      comparison[`v${v}`] = {
        version: v,
        total_calls: allRows.length,
        current_calls: current.rows.length,
        historical_calls: historical.rows.length,
        avg_score: avgScore,
        category_avgs: categoryAvgs,
        fail_rates: failRates,
      };
    }

    res.json({ versions: allVersions, comparison });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── End bulk rescore / history / comparison ────────────────

router.post('/calls/:id/override', express.json(), async (req, res) => {
  try {
    // category_scores is optional — Sam can score just the overall, or go category-by-category.
    const { override_score, reason, override_by = 'Sam', category_scores } = req.body;
    const c = await q('SELECT overall_score_adj, category_scores FROM calls WHERE id=?', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Not found' });
    const now = new Date().toISOString().replace('T',' ').slice(0,19);
    await q(`INSERT INTO score_overrides (call_id,override_by,original_score,override_score,reason,created_at,category_scores,original_categories)
             VALUES (?,?,?,?,?,?,?,?)`,
      [req.params.id, override_by, c.rows[0].overall_score_adj, override_score, reason, now,
       category_scores ? JSON.stringify(category_scores) : null,
       c.rows[0].category_scores ? (typeof c.rows[0].category_scores === 'string' ? c.rows[0].category_scores : JSON.stringify(c.rows[0].category_scores)) : null]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Read the current deduction weights (Sam's non-negotiables) + how they're set.
// Tuning is done via Render env vars (DEDUCT_*), so this shows current values + guidance.
router.get('/deduction-weights', async (req, res) => {
  try {
    const { DEDUCT } = require('../workers/qcWorker');
    res.json({
      weights: [
        { rule: 'no_discovery', label: 'No Discovery', points: DEDUCT.no_discovery, env: 'DEDUCT_NO_DISCOVERY', default: 3, severity: 'critical' },
        { rule: 'no_financial_qual', label: 'No Financial Qualification', points: DEDUCT.no_financial_qual, env: 'DEDUCT_NO_FINANCIAL_QUAL', default: 2, severity: 'critical' },
        { rule: 'no_objection_handling', label: 'No Objection Handling', points: DEDUCT.no_objection_handling, env: 'DEDUCT_NO_OBJECTION', default: 2, severity: 'critical' },
        { rule: 'untailored_pitch', label: 'Untailored Pitch', points: DEDUCT.untailored_pitch, env: 'DEDUCT_UNTAILORED_PITCH', default: 1, severity: 'warning' },
      ],
      note: 'Adjust these in Render (Environment tab) using the listed env var names, then re-score to apply. Lower = more forgiving.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/calls/:id/override', async (req, res) => {
  try {
    const r = await q('SELECT * FROM score_overrides WHERE call_id=? ORDER BY id DESC LIMIT 1', [req.params.id]);
    res.json({ override: r.rows[0] || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Calibration summary: all overrides joined to their calls, with the bot-vs-Sam delta.
// This is the data that drives rubric tuning — where Sam consistently disagrees.
router.get('/calibration', async (req, res) => {
  try {
    const r = await q(
      `SELECT o.call_id, o.override_score, o.original_score, o.reason, o.override_by, o.created_at,
              c.rep_name, c.role, c.client_name
       FROM score_overrides o LEFT JOIN calls c ON c.id = o.call_id
       ORDER BY o.id DESC LIMIT 200`);
    const rows = r.rows.map(x => ({
      ...x,
      delta: (Number(x.override_score) - Number(x.original_score))
    }));
    const withDelta = rows.filter(x => isFinite(x.delta));
    const avgDelta = withDelta.length ? withDelta.reduce((s, x) => s + x.delta, 0) / withDelta.length : 0;
    res.json({
      count: rows.length,
      avg_delta: Math.round(avgDelta * 10) / 10,  // + = Sam scores higher than bot on average
      overrides: rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Bulk Re-score ──────────────────────────────────────────
// Tags calls as REQC so the worker re-processes them with current rubric.
// Old scores are auto-archived into score_history by the worker before re-scoring.
router.post('/calls/rescore-all', async (req, res) => {
  try {
    const r = await q("UPDATE calls SET status='REQC', error='Queued for re-score (bulk)', retry_count=0 WHERE status='SCORED'");
    const affected = r.rowsAffected || r.changes || 0;
    res.json({ ok: true, queued: affected, message: `${affected} calls queued for re-score` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/calls/rescore-recent', async (req, res) => {
  try {
    const days = Number(req.body?.days || 30);
    if (days < 1 || days > 365) return res.status(400).json({ error: 'days must be 1-365' });
    const r = await q("UPDATE calls SET status='REQC', error='Queued for re-score (recent)', retry_count=0 WHERE status='SCORED' AND received_at::timestamp >= (NOW() - (? || ' days')::interval)", [String(days)]);
    const affected = r.rowsAffected || r.changes || 0;
    res.json({ ok: true, queued: affected, days, message: `${affected} calls from last ${days} days queued for re-score` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/calls/rescore-selected', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Provide ids array' });
    let queued = 0;
    for (const id of ids) {
      const r = await q("UPDATE calls SET status='REQC', error='Queued for re-score (selected)', retry_count=0 WHERE id=? AND status='SCORED'", [id]);
      if (r.rowsAffected || r.changes) queued++;
    }
    res.json({ ok: true, queued });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/rescore-estimate', async (req, res) => {
  try {
    const scope = String(req.query.scope || 'all');
    const days = Number(req.query.days || 30);
    let sql, params = [];
    if (scope === 'recent') {
      sql = "SELECT COUNT(*) as count FROM calls WHERE status='SCORED' AND received_at::timestamp >= (NOW() - (? || ' days')::interval)";
      params = [`-${days} days`];
    } else {
      sql = "SELECT COUNT(*) as count FROM calls WHERE status='SCORED'";
    }
    const r = await q(sql, params);
    const count = Number(r.rows[0]?.count || 0);
    // Claude Haiku estimated cost: ~$0.006 per scoring call (input + output)
    const estCost = count * 0.006;
    res.json({ count, estimatedCost: estCost.toFixed(3) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Score History (v1 vs v2 comparison) ────────────────────
router.get('/calls/:id/history', async (req, res) => {
  try {
    const r = await q('SELECT * FROM score_history WHERE call_id=? ORDER BY snapshot_at DESC', [req.params.id]);
    const history = r.rows.map(h => {
      try { h.category_scores = JSON.parse(h.category_scores); } catch(e) { h.category_scores = null; }
      try { h.pass_fail = JSON.parse(h.pass_fail); } catch(e) { h.pass_fail = null; }
      try { h.strengths = JSON.parse(h.strengths); } catch(e) { h.strengths = []; }
      try { h.improvements = JSON.parse(h.improvements); } catch(e) { h.improvements = []; }
      return h;
    });
    res.json({ history });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/rubric-comparison', async (req, res) => {
  try {
    // Compare average scores between rubric versions
    const currentAvg = await q("SELECT rubric_version, COUNT(*) as count, AVG(overall_score_adj) as avg_score, AVG(CASE WHEN category_scores IS NOT NULL THEN (category_scores::jsonb->>'discovery')::numeric END) as avg_discovery, AVG(CASE WHEN category_scores IS NOT NULL THEN (category_scores::jsonb->>'qualification')::numeric END) as avg_qual, AVG(CASE WHEN category_scores IS NOT NULL THEN (category_scores::jsonb->>'pitch')::numeric END) as avg_pitch FROM calls WHERE status='SCORED' GROUP BY rubric_version");

    // Also pull historical snapshots grouped by rubric version
    const histAvg = await q("SELECT rubric_version, COUNT(*) as count, AVG(overall_score_adj) as avg_score FROM score_history GROUP BY rubric_version");

    // Direct per-call comparisons: where we have both v1 snapshot and current v2 score
    const comparisons = await q(`
      SELECT c.id, c.rep_name, c.client_name, c.received_at,
             c.overall_score_adj as current_score, c.rubric_version as current_version,
             h.overall_score_adj as previous_score, h.rubric_version as previous_version,
             (c.overall_score_adj - h.overall_score_adj) as delta
      FROM calls c
      INNER JOIN score_history h ON h.call_id = c.id
      WHERE c.status='SCORED' AND c.rubric_version != h.rubric_version
      ORDER BY c.received_at DESC LIMIT 100
    `);

    res.json({
      current: currentAvg.rows,
      historical: histAvg.rows,
      perCallComparisons: comparisons.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Rescue False Voicemails ────────────────────────────────
// Finds calls flagged as voicemail that are obviously real conversations
// (duration >5 min OR multi-speaker transcript with 10+ turns)
router.get('/false-voicemails', async (req, res) => {
  try {
    const r = await q("SELECT id,received_at,rep_name,client_name,call_duration_sec,transcript_chars,transcript,source FROM calls WHERE status='SKIP_VOICEMAIL' ORDER BY received_at DESC LIMIT 200");
    const suspects = [];
    for (const c of r.rows) {
      const dur = Number(c.call_duration_sec) || 0;
      const txChars = Number(c.transcript_chars) || 0;
      let isFalsePositive = false;
      let reason = '';
      if (dur > 300) { isFalsePositive = true; reason = `Duration ${Math.floor(dur/60)}m > 5min`; }
      else if (txChars > 500 && c.transcript) {
        const lines = String(c.transcript).split('\n').filter(l => l.trim());
        const speakers = new Set();
        lines.forEach(l => { const m = l.match(/\]\s*([^:]+):/); if (m) speakers.add(m[1].trim().toLowerCase()); });
        if (speakers.size >= 2 && lines.length >= 10) {
          isFalsePositive = true;
          reason = `Multi-speaker conversation (${speakers.size} speakers, ${lines.length} turns)`;
        }
      }
      if (isFalsePositive) suspects.push({ id: Number(c.id), received_at: c.received_at, rep: c.rep_name, client: c.client_name, duration: dur, transcript_chars: txChars, reason });
    }
    res.json({ suspects, total: suspects.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/calls/rescue-false-voicemails', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Provide ids array' });
    let rescued = 0;
    for (const id of ids) {
      const r = await q("UPDATE calls SET status='NEW', error='Rescued from false voicemail flag' WHERE id=? AND status='SKIP_VOICEMAIL' AND transcript_chars>120", [id]);
      if (r.rowsAffected || r.changes) rescued++;
    }
    res.json({ ok: true, rescued });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rescue mis-classified Non-Sales calls back into the scoring queue.
// Only pulls calls that are currently in a skip status AND have a real transcript.
// force=true  → skip re-classification and score directly (use when you KNOW it's a
//               real sales call the classifier got wrong, e.g. a 45-min "follow up").
// force=false → send back through classification (safe default).
// SKIP_NOT_ROSTERED is intentionally NOT rescuable here — those are handled by the roster.
router.post('/calls/rescue-nonsales', express.json(), async (req, res) => {
  try {
    const { ids, force } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Provide ids array' });
    const RESCUABLE = "('SKIP_FOLLOWUP','SKIP_RESCHEDULE','SKIP_WRONG_NUMBER','SKIP_INTERNAL','SKIP_SHORT')";
    // force-scored calls carry the FORCE_SCORE_RESCUED marker the worker looks for;
    // non-forced ones go back to NEW with a plain note and get re-classified.
    const note = force ? 'FORCE_SCORE_RESCUED' : 'Rescued from Non-Sales (re-classifying)';
    let rescued = 0, skipped = 0;
    for (const id of ids) {
      const r = await q(
        `UPDATE calls SET status='NEW', error=?, retry_count=0 WHERE id=? AND status IN ${RESCUABLE} AND transcript IS NOT NULL AND LENGTH(transcript) > 120`,
        [note, id]);
      if (r.rowsAffected || r.changes) rescued++; else skipped++;
    }
    res.json({ ok: true, rescued, skipped, forced: !!force });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Transcript Search ──────────────────────────────────────
router.get('/search-calls', async (req, res) => {
  try {
    const { q: query, rep, role, limit = 50 } = req.query;
    if (!query || query.trim().length < 2) return res.status(400).json({ error: 'Query must be at least 2 characters' });
    const term = `%${query.trim()}%`;
    let w = "(transcript LIKE ? OR quick_summary LIKE ? OR coaching_notes LIKE ? OR client_name LIKE ?)", p = [term, term, term, term];
    if (rep) { w += ' AND rep_name=?'; p.push(rep); }
    if (role) { w += ' AND role=?'; p.push(role); }
    const r = await q(`SELECT id,received_at,source,rep_name,role,client_name,call_duration_sec,overall_score_adj,quick_summary,status,flagged FROM calls WHERE ${w} AND status='SCORED' ORDER BY received_at DESC LIMIT ?`, [...p, Number(limit)]);
    const cnt = await q(`SELECT COUNT(*) as c FROM calls WHERE ${w} AND status='SCORED'`, p);
    res.json({ calls: r.rows, total: Number(cnt.rows[0].c), query: query.trim() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Records (voicemails, reschedules, follow-ups, etc.) ────
router.get('/records', async (req, res) => {
  try {
    const { type, rep, period, from, to, limit = 200, offset = 0 } = req.query;
    let w = "status IN ('SKIP_VOICEMAIL','SKIP_SHORT','SKIP_RESCHEDULE','SKIP_FOLLOWUP','SKIP_WRONG_NUMBER','SKIP_INTERNAL','SKIP_NOT_ROSTERED')", p = [];
    if (type && type !== 'ALL') { w = 'status=?'; p.push(type); }
    if (rep) { w += ' AND rep_name=?'; p.push(rep); }
    // Date filter: an explicit from/to range wins; otherwise use the period toggle.
    // No period at all = "All" (no date filter). Period was previously ignored here entirely,
    // which meant the Non-Sales date toggle did nothing.
    if (from || to) {
      if (from) { w += ' AND received_at >= ?'; p.push(from); }
      if (to) { w += ' AND received_at <= ?'; p.push(to + ' 23:59:59'); }
    } else {
      if (period === 'day') w += " AND received_at::timestamp >= CURRENT_DATE";
      if (period === 'yesterday') w += " AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '1 day') AND received_at::timestamp < CURRENT_DATE";
      if (period === 'week') w += " AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '7 days')";
      if (period === 'month') w += " AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '30 days')";
    }

    const r = await q(`SELECT id,received_at,source,rep_name,role,client_name,call_url,audio_url,call_duration_sec,quick_summary,status,error FROM calls WHERE ${w} ORDER BY received_at DESC LIMIT ? OFFSET ?`, [...p, Number(limit), Number(offset)]);
    const cnt = await q(`SELECT COUNT(*) as c FROM calls WHERE ${w}`, p);

    // Breakdown by type
    const breakdown = await q("SELECT status, COUNT(*) as count FROM calls WHERE status IN ('SKIP_VOICEMAIL','SKIP_SHORT','SKIP_RESCHEDULE','SKIP_FOLLOWUP','SKIP_WRONG_NUMBER','SKIP_INTERNAL','SKIP_NOT_ROSTERED') GROUP BY status");

    res.json({ records: r.rows, total: Number(cnt.rows[0].c), breakdown: breakdown.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Analytics ───────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  try {
    // NOTE: no default period — an absent period means "All" (no date filter).
    // Defaulting to 'week' here silently turned the "All" toggle into 7 days.
    const { period, role, from, to } = req.query;
    let df = '', rf = '', p = [];
    if (from) { df = 'AND received_at >= ?'; p.push(from); if (to) { df += ' AND received_at <= ?'; p.push(to + ' 23:59:59'); } }
    else if (to) { df = 'AND received_at <= ?'; p.push(to + ' 23:59:59'); }
    else {
      if (period === 'day') df = "AND received_at::timestamp >= CURRENT_DATE";
      if (period === 'yesterday') df = "AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '1 day') AND received_at::timestamp < CURRENT_DATE";
      if (period === 'week') df = "AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '7 days')";
      if (period === 'month') df = "AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '30 days')";
    }
    if (role) { rf = 'AND role=?'; p.push(role); }

    const stats = await q(`SELECT COUNT(*) as total_calls, SUM(CASE WHEN status='SCORED' THEN 1 ELSE 0 END) as scored, SUM(CASE WHEN flagged=1 THEN 1 ELSE 0 END) as flagged, SUM(CASE WHEN status IN ('NEW','REQC','WAIT_RETRY_FULL') THEN 1 ELSE 0 END) as queued, SUM(CASE WHEN status='ERROR' THEN 1 ELSE 0 END) as errors, SUM(CASE WHEN status='WAIT_TRANSCRIPT' THEN 1 ELSE 0 END) as missing_transcripts, ROUND(AVG(CASE WHEN status='SCORED' THEN overall_score_adj END)::numeric,1) as avg_score, ROUND(AVG(CASE WHEN status='SCORED' THEN call_duration_sec END)::numeric,0) as avg_duration, ROUND(AVG(CASE WHEN status='SCORED' THEN agent_talk_pct END)::numeric,1) as avg_agent_talk, ROUND(AVG(CASE WHEN status='SCORED' THEN contact_talk_pct END)::numeric,1) as avg_contact_talk FROM calls WHERE rep_name != 'Unknown Setter' ${EXCL_TAGGED} ${df} ${rf}`, p);

    const repStats = await q(`SELECT rep_name, role, COUNT(*) as call_count, ROUND(AVG(overall_score_adj)::numeric,1) as avg_score, ROUND(AVG(call_duration_sec)::numeric,0) as avg_duration, ROUND(AVG(agent_talk_pct)::numeric,1) as avg_agent_talk, SUM(CASE WHEN flagged=1 THEN 1 ELSE 0 END) as flagged_count FROM calls WHERE status='SCORED' AND rep_name != 'Unknown Setter' ${EXCL_TAGGED} ${df} ${rf} GROUP BY rep_name, role ORDER BY avg_score DESC`, p);

    const catAvgs = await q(`SELECT rep_name, category_scores FROM calls WHERE status='SCORED' AND category_scores IS NOT NULL ${df} ${rf}`, p);
    const repCats = {};
    for (const row of catAvgs.rows) {
      let cs; try { cs = typeof row.category_scores === 'string' ? JSON.parse(row.category_scores) : row.category_scores; } catch(e) { continue; }
      if (!cs) continue;
      if (!repCats[row.rep_name]) repCats[row.rep_name] = { discovery:[], qualification:[], pitch:[], objections:[], close_next_step:[] };
      for (const cat of ['discovery','qualification','pitch','objections','close_next_step']) { if (cs[cat] != null) repCats[row.rep_name][cat].push(Number(cs[cat])); }
    }
    const categoryAvgs = {};
    for (const [rep, cats] of Object.entries(repCats)) {
      categoryAvgs[rep] = {};
      for (const [cat, vals] of Object.entries(cats)) { categoryAvgs[rep][cat] = vals.length ? +(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(1) : null; }
    }
    res.json({ stats: stats.rows[0], repStats: repStats.rows, categoryAvgs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/analytics/trends', async (req, res) => {
  try {
    const { period = 'daily', days = 30, role } = req.query;
    let rf = '', p = []; if (role) { rf = 'AND role=?'; p.push(role); }
    const groupBy = period === 'weekly' ? 'weekstart' : "received_at::date";
    const trends = await q(`SELECT ${groupBy} as period_date, COUNT(*) as total_calls, SUM(CASE WHEN status='SCORED' THEN 1 ELSE 0 END) as scored, ROUND(AVG(CASE WHEN status='SCORED' THEN overall_score_adj END)::numeric,1) as avg_score, ROUND(AVG(CASE WHEN status='SCORED' THEN call_duration_sec END)::numeric,0) as avg_duration, SUM(CASE WHEN flagged=1 THEN 1 ELSE 0 END) as flagged FROM calls WHERE rep_name != 'Unknown Setter' ${EXCL_TAGGED} AND ${periodClause} ${rf} GROUP BY ${groupBy} ORDER BY period_date ASC`, p);
    const repTrends = await q(`SELECT ${groupBy} as period_date, rep_name, COUNT(*) as calls, ROUND(AVG(overall_score_adj)::numeric,1) as avg_score FROM calls WHERE status='SCORED' AND rep_name != 'Unknown Setter' ${EXCL_TAGGED} AND ${periodClause} ${rf} GROUP BY ${groupBy}, rep_name ORDER BY period_date ASC`, p);
    res.json({ trends: trends.rows, repTrends: repTrends.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/analytics/distribution', async (req, res) => {
  try {
    const { period, from, to, role } = req.query;
    let df = '', rf = '', p = [];
    if (from) { df = "AND received_at >= ?"; p.push(from); if (to) { df += " AND received_at <= ?"; p.push(to + ' 23:59:59'); } }
    else {
      if (period === 'day') df = "AND received_at::timestamp >= CURRENT_DATE";
      if (period === 'yesterday') df = "AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '1 day') AND received_at::timestamp < CURRENT_DATE";
      if (period === 'week') df = "AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '7 days')";
      if (period === 'month') df = "AND received_at::timestamp >= (CURRENT_DATE - INTERVAL '30 days')";
    }
    if (role) { rf = 'AND role=?'; p.push(role); }
    const dist = await q(`SELECT CAST(overall_score_adj AS INTEGER) as score_bucket, COUNT(*) as count FROM calls WHERE status='SCORED' AND rep_name != 'Unknown Setter' ${EXCL_TAGGED} ${df} ${rf} GROUP BY score_bucket ORDER BY score_bucket`, p);
    res.json({ distribution: dist.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Rescue calls stuck at MAX_RETRY. The worker's batch query skips anything with
// retry_count >= MAX_RETRY, so such calls are invisible to Process/Retry AND to a
// force re-score — they need their counter reset first. This does that.
router.post('/queue/reset-retries', express.json(), async (req, res) => {
  try {
    const ids = req.body?.ids;
    let r;
    if (Array.isArray(ids) && ids.length) {
      let n = 0;
      for (const id of ids) {
        const x = await q("UPDATE calls SET retry_count=0, status='NEW', error='' WHERE id=? AND status IN ('WAIT_RETRY_FULL','ERROR')", [id]);
        if (x.rowCount) n++;
      }
      return res.json({ ok: true, reset: n });
    }
    // No ids = reset every stuck call
    r = await q("UPDATE calls SET retry_count=0, status='NEW', error='' WHERE status IN ('WAIT_RETRY_FULL','ERROR') AND retry_count >= 5");
    res.json({ ok: true, reset: r.rowCount || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Queue ───────────────────────────────────────────────────
router.get('/queue/status', async (req, res) => {
  try {
    const dk = new Date().toISOString().slice(0, 10);
    const daily = await q('SELECT * FROM daily_counters WHERE date_key=?', [dk]);
    const queue = await q("SELECT status, COUNT(*) as count FROM calls WHERE status NOT IN ('SCORED','SKIP_SHORT','SKIP_VOICEMAIL','SKIP_RESCHEDULE','SKIP_FOLLOWUP','SKIP_WRONG_NUMBER','SKIP_INTERNAL','SKIP_NOT_ROSTERED','STITCHED') GROUP BY status");
    const scored = await q("SELECT COUNT(*) as c FROM calls WHERE status='SCORED' AND processed_at::date = CURRENT_DATE");
    const d = daily.rows[0] || { full_qc_used: 0, est_cost_usd: 0 };
    d.scored_today = Number(scored.rows[0]?.c || 0);
    res.json({ daily: d, queue: queue.rows, engine: process.env.AI_ENGINE || 'gemini' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/queue/process', async (req, res) => {
  try { res.json(await processQueue(parseInt(req.query.max || '5'))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/queue/retry-all', async (req, res) => {
  try {
    // Only retry genuinely-failed calls. WAIT_TRANSCRIPT is a legitimate waiting
    // state (transcript hasn't arrived yet) — retrying it forces a NO_TRANSCRIPT error.
    // NO_TRANSCRIPT (transcript never came after the sweep) is included so a manual
    // retry can re-attempt once a transcript may finally be available.
    const r = await q("UPDATE calls SET status='NEW', error='', retry_count=0 WHERE status IN ('ERROR','WAIT_RETRY_FULL','NO_TRANSCRIPT')");
    res.json({ retriedCount: r.rowsAffected });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manually pull recent calls from Aloware/Fathom APIs (backfill for missed webhooks).
// Safe: runs fetched calls through the same dedup-protected ingestCall path.
// If credentials are missing or an API fails, it reports that and changes nothing.
router.post('/queue/pull', express.json(), async (req, res) => {
  try {
    const { pullCalls } = require('../services/pullService');
    const sources = (req.body && req.body.sources) || ['aloware', 'fathom'];
    const limit = (req.body && req.body.limit) || 25;
    const result = await pullCalls({ sources, limit });
    res.json(result);
  } catch (err) {
    // Never let this crash — always return a clean error.
    res.status(200).json({ ok: false, error: err.message, results: [] });
  }
});

// ─── Call Stitching ──────────────────────────────────────────
// Log of every merge that has happened — so you can see what was stitched, when, and by whom.
router.get('/stitch/log', async (req, res) => {
  try {
    const r = await q(
      `SELECT s.id AS survivor_id, s.rep_name, s.client_name, s.received_at,
              s.call_duration_sec, s.overall_score_adj, s.stitched_from_ids,
              h.id AS hidden_id, h.call_duration_sec AS hidden_duration,
              h.received_at AS hidden_received_at
       FROM calls s
       LEFT JOIN calls h ON h.stitched_into_id = s.id
       WHERE s.stitch_status = 'MERGED'
       ORDER BY s.received_at DESC LIMIT 100`);
    res.json({ merges: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Scan for cut-off call pairs (same rep+client, close in time, transcript cues).
// Returns auto-mergeable + suggested pairs. Does not merge.
router.get('/stitch/detect', async (req, res) => {
  try {
    const { detectStitches } = require('../services/stitchService');
    const all = await detectStitches();
    res.json({
      auto: all.filter(x => x.decision === 'auto'),
      suggested: all.filter(x => x.decision === 'suggest'),
      checked: all.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Merge a specific pair (approve a suggestion, or confirm an auto).
router.post('/stitch/merge', express.json(), async (req, res) => {
  try {
    const { mergeCalls } = require('../services/stitchService');
    const { first_id, second_id, merged_by } = req.body || {};
    if (!first_id || !second_id) return res.status(400).json({ error: 'first_id and second_id required' });
    const r = await mergeCalls(first_id, second_id, merged_by || 'Sam');
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Undo a merge (reversibility).
router.post('/stitch/unmerge', express.json(), async (req, res) => {
  try {
    const { unmergeCalls } = require('../services/stitchService');
    const { survivor_id } = req.body || {};
    if (!survivor_id) return res.status(400).json({ error: 'survivor_id required' });
    const r = await unmergeCalls(survivor_id);
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Manually merge two calls the user picks (escape hatch for pairs auto-detect missed).
// Auto-orders by time (earlier = survivor) so the transcript stitches in the right order.
// Warns (doesn't block) if rep/client differ — the user chose them deliberately.
router.post('/stitch/manual-merge', express.json(), async (req, res) => {
  try {
    const { mergeCalls } = require('../services/stitchService');
    const { id_a, id_b } = req.body || {};
    if (!id_a || !id_b || id_a === id_b) return res.status(400).json({ error: 'Pick two different calls.' });
    const rows = (await q('SELECT id, rep_name, client_name, received_at, status, stitch_status FROM calls WHERE id IN (?,?)', [id_a, id_b])).rows;
    if (rows.length < 2) return res.status(404).json({ error: 'One or both calls not found.' });
    const [a, b] = rows[0].id === id_a ? [rows[0], rows[1]] : [rows[1], rows[0]];
    for (const c of [a, b]) {
      if (c.stitch_status === 'MERGED' || c.stitch_status === 'STITCHED') return res.status(400).json({ error: `Call #${c.id} is already stitched.` });
      if (c.status !== 'SCORED') return res.status(400).json({ error: `Call #${c.id} isn't scored — only scored calls can be merged.` });
    }
    // earlier call is the survivor
    const ta = new Date((a.received_at || '').replace(' ', 'T') + 'Z').getTime();
    const tb = new Date((b.received_at || '').replace(' ', 'T') + 'Z').getTime();
    const [first, second] = ta <= tb ? [a, b] : [b, a];
    const r = await mergeCalls(first.id, second.id, 'Sam (manual)');
    res.json({ ...r, warning: (a.rep_name !== b.rep_name || (a.client_name||'').toLowerCase() !== (b.client_name||'').toLowerCase()) ? 'Note: these calls have different rep/client names.' : null });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post('/stitch/auto-merge', async (req, res) => {
  try {
    const { detectStitches, mergeCalls } = require('../services/stitchService');
    const all = await detectStitches();
    const autos = all.filter(x => x.decision === 'auto');
    const merged = [];
    for (const p of autos) {
      try { await mergeCalls(p.first_id, p.second_id, 'auto'); merged.push({ first: p.first_id, second: p.second_id }); }
      catch (e) { /* skip already-stitched or errors */ }
    }
    res.json({ ok: true, auto_merged: merged.length, merged });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════
// CALL OUTCOME TAGGING
// A tag records WHAT happened (the lead's state). excludes_from_average
// records the CONSEQUENCE. A SUGGESTED tag changes nothing — only a human
// CONFIRM removes a call from an average. The call always stays attributed
// to the rep and fully visible.
// ═══════════════════════════════════════════════════════════════

router.get('/tags', async (req, res) => {
  try {
    const r = await q('SELECT * FROM call_tags WHERE active=true ORDER BY sort_order, label');
    res.json({ tags: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/calls/:id/tags', async (req, res) => {
  try {
    const r = await q(
      `SELECT a.*, t.label, t.tag_group, t.excludes_from_average, t.color, t.description
       FROM call_tag_assignments a JOIN call_tags t ON t.key=a.tag_key
       WHERE a.call_id=? ORDER BY t.sort_order`, [req.params.id]);
    res.json({ tags: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Apply/confirm a tag — the ONLY thing that can change an average.
// One outcome per call: confirming an A/B tag replaces any other confirmed A/B tag.
// Group C (routing/cross-sell) is additive — a call can be DISQUALIFIED for BNB
// Turnkey AND a great BNB Lending lead. That's a win, not a failure.
router.post('/calls/:id/tag', express.json(), async (req, res) => {
  try {
    const { tag, reason, by } = req.body || {};
    const callId = req.params.id;
    if (!tag) return res.status(400).json({ error: 'tag is required' });
    const t = (await q('SELECT * FROM call_tags WHERE key=? AND active=true', [tag])).rows[0];
    if (!t) return res.status(400).json({ error: `Unknown tag "${tag}"` });
    const ts = new Date().toISOString().replace('T',' ').slice(0,19);
    const who = by || 'Sam';
    if (t.tag_group === 'A_NOT_CLOSEABLE' || t.tag_group === 'B_REAL_ATTEMPT') {
      await q(
        `DELETE FROM call_tag_assignments
         WHERE call_id=? AND tag_key <> ?
           AND tag_key IN (SELECT key FROM call_tags WHERE tag_group IN ('A_NOT_CLOSEABLE','B_REAL_ATTEMPT'))`,
        [callId, tag]);
    }
    await q(
      `INSERT INTO call_tag_assignments (call_id, tag_key, status, reason, suggested_by, confirmed_by, created_at, confirmed_at)
       VALUES (?,?,'CONFIRMED',?,?,?,?,?)
       ON CONFLICT (call_id, tag_key) DO UPDATE SET status='CONFIRMED',
         reason=COALESCE(EXCLUDED.reason, call_tag_assignments.reason),
         confirmed_by=EXCLUDED.confirmed_by, confirmed_at=EXCLUDED.confirmed_at`,
      [callId, tag, reason || '', who, who, ts, ts]);
    res.json({ ok: true, tag, excludes_from_average: t.excludes_from_average });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/calls/:id/untag', express.json(), async (req, res) => {
  try {
    const { tag } = req.body || {};
    if (tag) await q('DELETE FROM call_tag_assignments WHERE call_id=? AND tag_key=?', [req.params.id, tag]);
    else await q('DELETE FROM call_tag_assignments WHERE call_id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Dismiss a suggestion — call stays scored. The DISMISSED row also stops the bot
// re-suggesting the same tag on a future re-score (ON CONFLICT DO NOTHING).
router.post('/calls/:id/dismiss-tag', express.json(), async (req, res) => {
  try {
    const { tag } = req.body || {};
    if (!tag) return res.status(400).json({ error: 'tag is required' });
    await q("UPDATE call_tag_assignments SET status='DISMISSED' WHERE call_id=? AND tag_key=?", [req.params.id, tag]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Review queue: pending suggestions, worst-scored first (most unfairly penalised).
// ── REFERRALS / CROSS-SELL ────────────────────────────────────────
// Every call carrying a cross-sell (Group C) tag, grouped by Rise brand.
// This is the PAYOFF for cross-sell detection: a "lost" BNB Turnkey call is
// often a won lead for a sister company — but only if someone can SEE it.
router.get('/referrals', async (req, res) => {
  try {
    const status = req.query.status === 'suggested' ? 'SUGGESTED' : 'CONFIRMED';
    const brand = req.query.brand;
    let w = `a.status = ? AND t.tag_group = 'C_ROUTING'`;
    const p = [status];
    if (brand) { w += ' AND t.key = ?'; p.push(brand); }

    const rows = (await q(
      `SELECT a.call_id, a.tag_key, a.reason, a.status, a.created_at,
              t.label AS brand, t.color,
              c.rep_name, c.client_name, c.role, c.overall_score_adj, c.received_at,
              c.aloware_contact_id, c.quick_summary,
              (SELECT t2.label FROM call_tag_assignments a2 JOIN call_tags t2 ON t2.key=a2.tag_key
               WHERE a2.call_id=c.id AND a2.status='CONFIRMED'
                 AND t2.tag_group IN ('A_NOT_CLOSEABLE','B_REAL_ATTEMPT') LIMIT 1) AS outcome
       FROM call_tag_assignments a
       JOIN call_tags t ON t.key = a.tag_key
       JOIN calls c ON c.id = a.call_id
       WHERE ${w}
       ORDER BY c.received_at DESC LIMIT 300`, p)).rows;

    const counts = (await q(
      `SELECT t.key, t.label, t.color, COUNT(*) AS n
       FROM call_tag_assignments a JOIN call_tags t ON t.key=a.tag_key
       WHERE a.status='CONFIRMED' AND t.tag_group='C_ROUTING'
       GROUP BY t.key,t.label,t.color ORDER BY n DESC`)).rows;

    const pending = (await q(
      `SELECT COUNT(*) AS n FROM call_tag_assignments a JOIN call_tags t ON t.key=a.tag_key
       WHERE a.status='SUGGESTED' AND t.tag_group='C_ROUTING'`)).rows[0];

    res.json({ referrals: rows, by_brand: counts, pending_review: Number(pending?.n || 0), total: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── GOLDEN MOMENTS LIBRARY ────────────────────────────────────────
// Derive who spoke a golden-moment quote when the AI didn't tag it: match the
// quote back to its transcript line and read that line's speaker label.
// Aloware setter transcripts use unambiguous AGENT/CONTACT labels (never scrambled);
// Fathom uses names/phones. On diarization-degraded calls a NAMED/phone label can be
// swapped, so we don't trust those (AGENT/CONTACT stays reliable) and return null,
// leaving it to the AI re-look. Never guesses — no match means no badge.
function inferMomentSpeaker(quote, transcript, repName, quality) {
  if (!quote || !transcript) return null;
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const probe = norm(quote).slice(0, 40);
  if (probe.length < 8) return null;
  const repFirst = norm((repName || '').split(/\s+/)[0]);
  for (const ln of String(transcript).split('\n')) {
    const m = ln.match(/^\s*(?:\[[^\]]*\]\s*)?([^:]{1,40}):\s*(.*)$/);
    if (!m) continue;
    if (!norm(m[2] || '').includes(probe)) continue;
    const label = m[1].trim();
    const lab = label.toLowerCase();
    if (/^agent\b/.test(lab) || lab === 'rep' || lab === 'salesperson') return 'rep';
    if (/^contact\b/.test(lab) || lab === 'customer' || lab === 'prospect' || lab === 'client') return 'lead';
    // Named / phone-number label: unreliable on scrambled dial-in calls.
    if (quality === 'degraded') return null;
    if (repFirst && norm(label).includes(repFirst)) return 'rep';
    return 'lead';
  }
  return null; // quote not locatable — leave unbadged rather than guess
}

// The bot already extracts golden moments (quote + timestamp + why it matters)
// on EVERY scored call — and until now we threw them all away.
// This surfaces them as a searchable, filterable coaching library.
//
// A moment is identified by (call_id, moment_index) — we expand the JSON at
// read time rather than denormalising, so a re-score can't orphan a pin.
router.get('/golden-moments', async (req, res) => {
  try {
    const { rep, search, pinned, minScore } = req.query;
    const limit = Math.min(Number(req.query.limit) || 200, 500);

    let w = `c.status='SCORED' AND c.golden_moments IS NOT NULL
             AND c.golden_moments <> '[]' AND c.golden_moments <> ''
             AND json_typeof(c.golden_moments::json) = 'array'
             AND c.rep_name <> 'Unknown Setter'`;
    const p = [];
    if (rep) { w += ' AND c.rep_name = ?'; p.push(rep); }
    if (minScore) { w += ' AND c.overall_score_adj >= ?'; p.push(Number(minScore)); }

    const rows = (await q(
      `SELECT c.id AS call_id, c.rep_name, c.role, c.client_name, c.overall_score_adj,
              c.received_at, c.golden_moments, c.aloware_contact_id, c.aloware_call_id,
              c.transcript, c.transcript_quality
       FROM calls c WHERE ${w}
       ORDER BY c.overall_score_adj DESC NULLS LAST, c.received_at DESC
       LIMIT ?`, [...p, limit])).rows;

    const pins = (await q('SELECT call_id, moment_index, category, note, pinned_by FROM golden_moment_pins')).rows;
    const pinKey = (a, b) => `${a}:${b}`;
    const pinMap = {};
    pins.forEach(x => { pinMap[pinKey(x.call_id, x.moment_index)] = x; });

    // Flatten every call's moments into individual, addressable entries.
    const moments = [];
    for (const c of rows) {
      let arr = c.golden_moments;
      try { if (typeof arr === 'string') arr = JSON.parse(arr); } catch (e) { arr = null; }
      if (!Array.isArray(arr)) continue;
      arr.forEach((m, i) => {
        if (!m || !m.quote) return;
        const pin = pinMap[pinKey(c.call_id, i)];
        let sp = (m.speaker || '').toLowerCase() === 'lead' ? 'lead' : (m.speaker ? 'rep' : null);
        if (!sp) sp = inferMomentSpeaker(m.quote, c.transcript, c.rep_name, c.transcript_quality);
        moments.push({
          call_id: c.call_id, moment_index: i,
          quote: m.quote, timestamp: m.timestamp || '', why: m.why_it_matters || m.why || '',
          speaker: sp,
          rep_name: c.rep_name, role: c.role, client_name: c.client_name,
          score: c.overall_score_adj, received_at: c.received_at,
          aloware_contact_id: c.aloware_contact_id, aloware_call_id: c.aloware_call_id,
          pinned: !!pin, category: pin?.category || null, pin_note: pin?.note || null,
        });
      });
    }

    // How many moments each call has (for the "see all N on this call" drill-in).
    const callTotals = {};
    moments.forEach(m => { callTotals[m.call_id] = (callTotals[m.call_id] || 0) + 1; });
    moments.forEach(m => { m.call_moment_total = callTotals[m.call_id]; });

    // Free-text search across the quote AND the explanation (searches the FULL library).
    let out = moments;
    if (search) {
      const s = String(search).toLowerCase();
      out = out.filter(m => (m.quote + ' ' + m.why).toLowerCase().includes(s));
    }
    if (pinned === 'true') out = out.filter(m => m.pinned);

    // Per-call cap for the browse view: at most 2 REP moments per call, or 1 LEAD
    // moment if the call has no rep moment. Pinned moments always survive the cap.
    // Skipped when searching, filtering to pinned, or when full=true (drill-in).
    const doCap = !search && pinned !== 'true' && req.query.full !== 'true';
    if (doCap) {
      const byCall = {};
      out.forEach(m => { (byCall[m.call_id] = byCall[m.call_id] || []).push(m); });
      const capped = [];
      for (const cid of Object.keys(byCall)) {
        const ms = byCall[cid];
        const pinnedMs = ms.filter(m => m.pinned);
        const rest = ms.filter(m => !m.pinned);
        const reps = rest.filter(m => m.speaker === 'rep');
        const leads = rest.filter(m => m.speaker === 'lead');
        const unknown = rest.filter(m => !m.speaker);
        let pick;
        if (reps.length) pick = reps.slice(0, 2);
        else if (leads.length) pick = leads.slice(0, 1);
        else pick = unknown.slice(0, 1);   // pre-backfill calls with no speaker yet
        capped.push(...pinnedMs, ...pick.filter(m => !pinnedMs.includes(m)));
      }
      out = capped;
    }

    // Pinned first — Sam's canonical exemplars lead.
    out.sort((a, b) => (b.pinned - a.pinned) || (Number(b.score) - Number(a.score)));

    const byRep = {};
    moments.forEach(m => { byRep[m.rep_name] = (byRep[m.rep_name] || 0) + 1; });

    res.json({
      moments: out,
      total: out.length,
      total_library: moments.length,
      pinned_count: moments.filter(m => m.pinned).length,
      by_rep: Object.entries(byRep).map(([rep_name, n]) => ({ rep_name, n })).sort((a, b) => b.n - a.n),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pin a moment as a canonical exemplar (Sam's quality gate — the bot's
// "golden" isn't always golden, so a human decides what becomes canon).
router.post('/golden-moments/pin', express.json(), async (req, res) => {
  try {
    const { call_id, moment_index, category, note, by } = req.body || {};
    if (call_id == null || moment_index == null) return res.status(400).json({ error: 'call_id and moment_index required' });
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await q(
      `INSERT INTO golden_moment_pins (call_id, moment_index, category, note, pinned_by, created_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT (call_id, moment_index) DO UPDATE SET
         category=EXCLUDED.category, note=EXCLUDED.note, pinned_by=EXCLUDED.pinned_by`,
      [call_id, moment_index, category || null, note || null, by || 'Sam', ts]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/golden-moments/unpin', express.json(), async (req, res) => {
  try {
    const { call_id, moment_index } = req.body || {};
    await q('DELETE FROM golden_moment_pins WHERE call_id=? AND moment_index=?', [call_id, moment_index]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Transcript hygiene diagnostics ──────────────────────────────
// Top-level paths (NOT under /calls/:id) so they never collide with the
// greedy /calls/:id catch-all. Answers "is a weird transcript us or the source?"
const { analyzeTranscriptHygiene } = require('../services/transcriptHygiene');

// Run the analyzer live on one call and return the full breakdown.
router.get('/diagnostics/transcript/:id', async (req, res) => {
  try {
    const r = await q('SELECT id, rep_name, client_name, source, call_duration_sec, agent_talk_pct, transcript FROM calls WHERE id=?', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const c = r.rows[0];
    const analysis = analyzeTranscriptHygiene(c.transcript, { source: c.source });
    res.json({
      call_id: c.id, rep_name: c.rep_name, client_name: c.client_name, source: c.source,
      duration_sec: c.call_duration_sec, agent_talk_pct: c.agent_talk_pct,
      verdict: analysis.grade === 'clean'
        ? 'Transcript looks clean — the source diarization is reliable here.'
        : `Source-side diarization problem (${analysis.grade}). This is the recording source, not the dashboard — the artifacts are in the stored transcript itself.`,
      ...analysis,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Scan scored calls, grade each, and (optionally) backfill the quality columns.
// GET /diagnostics/transcript-scan            → report only
// GET /diagnostics/transcript-scan?write=true → also persist grades
router.get('/diagnostics/transcript-scan', async (req, res) => {
  try {
    const write = req.query.write === 'true';
    const rows = (await q(
      `SELECT id, source, transcript FROM calls
       WHERE status='SCORED' AND transcript IS NOT NULL AND LENGTH(transcript) > 0`)).rows;
    const summary = { total: rows.length, clean: 0, minor: 0, degraded: 0, written: 0 };
    const degraded = [];
    for (const c of rows) {
      const a = analyzeTranscriptHygiene(c.transcript, { source: c.source });
      summary[a.grade] = (summary[a.grade] || 0) + 1;
      if (a.grade === 'degraded') degraded.push({ call_id: c.id, source: c.source, score: a.score, flags: a.flags.map(f => f.code) });
      if (write) {
        await q('UPDATE calls SET transcript_quality=?,transcript_quality_score=?,transcript_quality_flags=? WHERE id=?',
          [a.grade, a.score, JSON.stringify(a.flags || []), c.id]);
        summary.written++;
      }
    }
    degraded.sort((x, y) => x.score - y.score);
    res.json({ summary, degraded_calls: degraded });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Re-look at moments ──────────────────────────────────────────
// Re-extract golden + tough moments from the transcript WITHOUT re-scoring.
// Never changes averages (respects "only a human confirm changes an average").
// Two segments in the path → no collision with the greedy GET /calls/:id.

// Single call — used by the "re-look at moments" button on a call.
router.post('/calls/:id/relook-moments', express.json(), async (req, res) => {
  try {
    const { reExtractMoments } = require('../workers/qcWorker');
    const r = await reExtractMoments(req.params.id);
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// How many scored calls still need a re-look (missing speaker attribution or
// tough moments never extracted). Drives the progress UI.
router.get('/golden-moments/relook-status', async (req, res) => {
  try {
    const r = (await q(
      `SELECT
         COUNT(*) FILTER (WHERE golden_moments IS NOT NULL AND golden_moments <> '[]' AND golden_moments <> '') AS with_golden,
         COUNT(*) FILTER (WHERE (golden_moments IS NOT NULL AND golden_moments <> '[]' AND golden_moments <> '' AND golden_moments::text NOT ILIKE '%"speaker"%')
                             OR tough_moments IS NULL) AS need_relook
       FROM calls
       WHERE status='SCORED' AND transcript IS NOT NULL AND LENGTH(transcript) > 0
         AND rep_name <> 'Unknown Setter'`)).rows[0];
    res.json({ with_golden: Number(r.with_golden || 0), need_relook: Number(r.need_relook || 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Batch backfill — processes up to `limit` calls per request (default 8) so it
// never hits Render's request timeout, and reports how many remain. The client
// calls this repeatedly until remaining hits 0, showing progress.
router.post('/golden-moments/relook-all', express.json(), async (req, res) => {
  try {
    const { reExtractMoments } = require('../workers/qcWorker');
    const limit = Math.min(Number(req.body?.limit) || 8, 15);
    const scope = req.body?.scope === 'all' ? 'all' : 'missing';
    const cond = scope === 'all'
      ? `1=1`
      : `((golden_moments IS NOT NULL AND golden_moments <> '[]' AND golden_moments <> '' AND golden_moments::text NOT ILIKE '%"speaker"%') OR tough_moments IS NULL)`;
    const rows = (await q(
      `SELECT id FROM calls
       WHERE status='SCORED' AND transcript IS NOT NULL AND LENGTH(transcript) > 0
         AND rep_name <> 'Unknown Setter' AND ${cond}
       ORDER BY received_at DESC LIMIT ?`, [limit])).rows;

    const results = [];
    for (const row of rows) {
      try { results.push(await reExtractMoments(row.id)); }
      catch (e) { results.push({ callId: row.id, error: e.message }); }
    }

    // Count what still needs a re-look after this batch.
    const remaining = Number((await q(
      `SELECT COUNT(*) AS n FROM calls
       WHERE status='SCORED' AND transcript IS NOT NULL AND LENGTH(transcript) > 0
         AND rep_name <> 'Unknown Setter' AND ${cond}`)).rows[0].n || 0);

    res.json({ processed: results.length, remaining, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Slack ───────────────────────────────────────────────────────
// Post the daily digest to Slack on demand (for setup verification). force=true
// posts even when the window has no calls, so you can confirm the wiring works.
router.post('/slack/test-digest', express.json(), async (req, res) => {
  try {
    const { sendDailyDigest } = require('../services/slackService');
    const r = await sendDailyDigest({ preset: (req.body && req.body.preset) || 'yesterday', force: true });
    res.json(r);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.get('/slack/status', (req, res) => {
  try { const { slackStatus } = require('../services/slackService'); res.json(slackStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/tags/suggestions', async (req, res) => {
  try {
    const r = await q(
      `SELECT a.id, a.call_id, a.tag_key, a.reason, a.created_at,
              t.label, t.tag_group, t.excludes_from_average, t.color,
              c.rep_name, c.client_name, c.role, c.overall_score_adj, c.call_duration_sec, c.quick_summary
       FROM call_tag_assignments a
       JOIN call_tags t ON t.key = a.tag_key
       JOIN calls c ON c.id = a.call_id
       WHERE a.status='SUGGESTED'
       ORDER BY t.excludes_from_average DESC, c.overall_score_adj ASC NULLS LAST, a.id DESC
       LIMIT 200`);
    res.json({ suggestions: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// A rep's outcome mix + both averages (Scored vs All Calls).
// Rich self-insight for a rep: recurring strengths, recurring pain points,
// their best and worst call, and their most common deductions.
// This is what turns "here's your score" into "here's what to work on".
router.get('/reps/:id/insights', async (req, res) => {
  try {
    const rep = (await q('SELECT name FROM rep_roster WHERE id=?', [req.params.id])).rows[0];
    if (!rep) return res.status(404).json({ error: 'Rep not found' });
    const name = rep.name;

    const rows = (await q(
      `SELECT id, client_name, overall_score_adj, strengths, improvements, pass_fail, received_at, quick_summary
       FROM calls WHERE status='SCORED' AND rep_name=? ${EXCL_TAGGED}
       ORDER BY received_at DESC LIMIT 60`, [name])).rows;

    const tally = (field) => {
      const counts = {};
      rows.forEach(r => {
        let arr = r[field];
        try { if (typeof arr === 'string') arr = JSON.parse(arr); } catch (e) { arr = null; }
        (Array.isArray(arr) ? arr : []).forEach(x => {
          const k = String(x || '').trim();
          if (k) counts[k] = (counts[k] || 0) + 1;
        });
      });
      return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([text, count]) => ({ text, count }));
    };

    // Most common deductions (the concrete, fixable failures)
    const ded = {};
    rows.forEach(r => {
      let pf = r.pass_fail;
      try { if (typeof pf === 'string') pf = JSON.parse(pf); } catch (e) { pf = null; }
      (pf?.deductions || []).forEach(d => {
        const k = d.label || d.rule;
        if (k) ded[k] = (ded[k] || 0) + 1;
      });
    });
    const topDeductions = Object.entries(ded).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([label, count]) => ({ label, count }));

    const scored = rows.filter(r => r.overall_score_adj != null);
    const best = scored.length ? scored.reduce((a, b) => (Number(b.overall_score_adj) > Number(a.overall_score_adj) ? b : a)) : null;
    const worst = scored.length ? scored.reduce((a, b) => (Number(b.overall_score_adj) < Number(a.overall_score_adj) ? b : a)) : null;

    const lite = (c) => c ? { id: c.id, client_name: c.client_name, score: c.overall_score_adj, summary: c.quick_summary, received_at: c.received_at } : null;

    res.json({
      rep: name,
      based_on: rows.length,
      strengths: tally('strengths'),
      pain_points: tally('improvements'),
      top_deductions: topDeductions,
      best_call: lite(best),
      worst_call: lite(worst),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/reps/:id/outcomes', async (req, res) => {
  try {
    const rep = (await q('SELECT name FROM rep_roster WHERE id=?', [req.params.id])).rows[0];
    if (!rep) return res.status(404).json({ error: 'Rep not found' });
    const name = rep.name;
    const both = (await q(
      `SELECT
         ROUND(AVG(overall_score_adj) FILTER (WHERE ${SCORED_UNTAGGED})::numeric,1) AS scored_avg,
         COUNT(*) FILTER (WHERE ${SCORED_UNTAGGED}) AS scored_count,
         ROUND(AVG(overall_score_adj) FILTER (WHERE status='SCORED')::numeric,1) AS all_avg,
         COUNT(*) FILTER (WHERE status='SCORED') AS all_count
       FROM calls WHERE rep_name=?`, [name])).rows[0];
    const mix = (await q(
      `SELECT t.key, t.label, t.color, t.tag_group, t.excludes_from_average, COUNT(*) AS n
       FROM call_tag_assignments a JOIN call_tags t ON t.key=a.tag_key
       JOIN calls c ON c.id=a.call_id
       WHERE a.status='CONFIRMED' AND c.rep_name=?
       GROUP BY t.key,t.label,t.color,t.tag_group,t.excludes_from_average
       ORDER BY t.sort_order`, [name])).rows;
    res.json({ rep: name, ...both, mix });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── BACKFILL ──────────────────────────────────────────────────────
// Scan already-SCORED calls that have no tag yet, and ask the model whether they
// were really a DQ / not-ready / nurture / info-seeker. Writes SUGGESTED only —
// nothing is auto-applied. Sam decides call-by-call in the review queue.
// Worst-scored first: a call scored 0-3 that's really a nurture is the most
// unfairly penalised, so those are the ones worth Sam's attention first.
router.post('/tags/backfill-scan', express.json(), async (req, res) => {
  try {
    const { callAIJson } = require('../services/ai');
    const { saveTagSuggestions } = require('../workers/qcWorker');
    const limit = Math.min(Number(req.body?.limit) || 15, 40);

    const rows = (await q(
      `SELECT c.id, c.rep_name, c.role, c.client_name, c.overall_score_adj, c.transcript
       FROM calls c
       WHERE c.status='SCORED' AND c.transcript IS NOT NULL AND LENGTH(c.transcript) > 500
         AND NOT EXISTS (SELECT 1 FROM call_tag_assignments a WHERE a.call_id = c.id)
       ORDER BY c.overall_score_adj ASC NULLS LAST, c.id DESC
       LIMIT ?`, [limit])).rows;

    const ts = new Date().toISOString().replace('T',' ').slice(0,19);
    let scanned = 0, tagged = 0;
    const results = [];

    for (const c of rows) {
      const t = String(c.transcript || '').slice(0, 50000);
      const prompt = `You are auditing a completed sales call for BNB Turnkey (turnkey short-term-rental investment, part of The Rise Collective).

The call was scored ${c.overall_score_adj}/10 on the ${c.role} rubric. Your job is NOT to re-score it. Your job is to determine WHY it ended the way it did — was it the REP's execution, or was the LEAD simply not closeable?

THE TEST: "Could a great rep have advanced this lead TODAY?"
- NO, the lead had a real STATED blocker -> tag it. The rep judged correctly.
- YES, but this rep didn't -> "NONE". That's a performance issue and the score already reflects it.

OUTCOME TAGS (lead couldn't be closed — rep judged correctly):
- DISQUALIFIED: hard blocker — insufficient capital, wrong profile, cannot proceed, not a real investor.
- NOT_READY: real, interested, plausible fit, but CANNOT act now for a CONCRETE STATED reason (capital tied up, mid-transaction, awaiting liquidity). Parked near-term.
- LONG_TERM_NURTURE: same but LONG/indefinite horizon (locked in for years, needs a major life/financial change).
- INFO_SEEKER: only wanted information. Never a buyer. No investment intent or capital discussion.

OUTCOME TAGS (a real attempt happened — still the rep's performance):
- SHORT_TERM_NURTURE: real pitch, lead is close, near-term follow-up.
- REDZONE_HOT: lead is HOT, close imminent, strong buying signals.
- HARD_NO: rep pitched a viable, present lead and they firmly declined.

CRITICAL RULES:
1. A WEAK CALL IS NEVER A DISQUALIFICATION. Skipped discovery / generic pitch / folded on an objection with a viable lead = "NONE".
2. The blocker must be CONCRETE and STATED BY THE LEAD. "Seemed lukewarm" is NOT a blocker. "I just sold my company and I'm locked in four years" IS.
3. WHEN IN DOUBT RETURN "NONE". Better to score a borderline call than let a weak call escape scoring.

CROSS-SELL (Rise Collective sister brands):
⚠️ GOVERNING RULE: only tag when the lead needs something BNB TURNKEY DOES NOT ALREADY PROVIDE.
BNB Turnkey ALREADY includes: tax benefits (cost seg, depreciation, income offset — this is a HEADLINE selling point), property sourcing, financing (BNB Lending in-house), explaining how STR investing works, and full management (Home Team).

DO NOT TAG these — they are NORMAL BNB Turnkey conversation:
✗ "I want the tax write-offs / depreciation / cost seg" -> that IS the pitch. NOT Surge Tax.
✗ "My tax bill is huge, I need to offset income" -> that is WHY they're buying an STR. NOT Surge Tax.
✗ "Walk me through how this works" -> normal discovery. NOT Investor Academy.
✗ "I want to buy in Phoenix/Florida" -> BNB Turnkey sources properties. NOT Realty.
✗ "What are the financing options?" -> BNB Lending is in-house. NOT a cross-sell.

ONLY tag when the need sits OUTSIDE the turnkey package:
- SURGE_TAX_LEAD: needs tax/accounting help BEYOND the STR — business/entity tax strategy, ongoing CPA relationship, a complex tax situation the STR won't solve.
- INVESTOR_ACADEMY_LEAD: explicitly wants to LEARN AND DIY INSTEAD of buying turnkey.
- BNB_LENDING_LEAD: financing is a DISTINCT standalone need (lending outside a turnkey purchase).
- HOME_TEAM_MGMT_LEAD: ALREADY OWNS STR property and wants MANAGEMENT ONLY — not buying turnkey.
- HOTEL_TURNKEY_LEAD: boutique hotel / larger commercial asset, not single-family STR.
- REALTY_LEAD: traditional brokerage for a NON-STR purchase (primary residence, long-term rental).

TEST: "Does BNB Turnkey already include this?" If YES -> do not tag. When in doubt, return empty.
A false cross-sell lead wastes another team's time and erodes trust in the whole signal.

Return ONLY JSON:
{"outcome_tag":"...|NONE","outcome_tag_reason":"1 sentence citing the specific stated blocker","cross_sell_tags":[],"cross_sell_reason":""}

TRANSCRIPT:
${t}`;

      try {
        const { result } = await callAIJson(prompt, { maxTokens: 400 });
        scanned++;
        const out = String(result?.outcome_tag || 'NONE').toUpperCase();
        const xs = Array.isArray(result?.cross_sell_tags) ? result.cross_sell_tags : [];
        if (out !== 'NONE' || xs.length) {
          const r = await saveTagSuggestions(c.id, result, ts);
          if (r.suggested) tagged++;
          results.push({ call_id: c.id, rep: c.rep_name, client: c.client_name,
            score: c.overall_score_adj, outcome_tag: out, reason: result?.outcome_tag_reason, cross_sell: xs });
        }
      } catch (e) {
        console.warn(`[Backfill] #${c.id} failed: ${e.message}`);
      }
    }
    res.json({ ok: true, scanned, tagged, remaining_untagged: rows.length === limit ? 'more available — run again' : 0, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/reps', async (req, res) => {
  try { res.json((await q('SELECT * FROM rep_roster WHERE active=1 ORDER BY role,name')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// List ALL reps including inactive (for the roster admin table)
router.get('/reps/all', async (req, res) => {
  try { res.json((await q('SELECT * FROM rep_roster ORDER BY active DESC, role, name')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Suggest the next free Fathom src_tag for a new closer (fathom-closers-N).
// Removes the guesswork of picking a unique tag.
router.get('/reps/next-src-tag', async (req, res) => {
  try {
    const role = req.query.role || 'Closer';
    if (role !== 'Closer') return res.json({ src_tag: 'aloware-setters', note: 'Setters share the Aloware webhook tag.' });
    const rows = (await q("SELECT src_tag FROM rep_roster WHERE src_tag LIKE 'fathom-closers-%'")).rows;
    let max = 0;
    for (const r of rows) {
      const m = String(r.src_tag || '').match(/fathom-closers-(\d+)/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    res.json({ src_tag: `fathom-closers-${max + 1}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Who's dialing through but NOT yet in the roster (the onboarding queue).
// Groups SKIP_NOT_ROSTERED calls by the identifier captured in their error text.
router.get('/reps/unrostered', async (req, res) => {
  try {
    const rows = (await q(
      `SELECT rep_name, src_tag, base_source, error, COUNT(*) AS parked_calls, MAX(received_at) AS last_seen
       FROM calls WHERE status='SKIP_NOT_ROSTERED'
       GROUP BY rep_name, src_tag, base_source, error
       ORDER BY parked_calls DESC`)).rows;
    // Pull the identifier (e.g. "aloware-user-112769") out of the error text for convenience.
    const out = rows.map(r => {
      const m = String(r.error || '').match(/\(([^)]+)\)/);
      const ref = m ? m[1] : null;
      const uid = ref && ref.startsWith('aloware-user-') ? ref.replace('aloware-user-', '') : null;
      return {
        detected_ref: ref, aloware_user_id: uid,
        base_source: r.base_source, src_tag: r.src_tag,
        parked_calls: Number(r.parked_calls), last_seen: r.last_seen,
        suggested_role: r.base_source === 'Aloware' ? 'Setter' : 'Closer',
      };
    });
    res.json({ unrostered: out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// A single rep's progress: trend over time, category averages, recent calls.
// Powers the rep-facing "My Progress" view.
router.get('/reps/:id/progress', async (req, res) => {
  try {
    const days = Number(req.query.days) || 30;
    const rep = (await q('SELECT * FROM rep_roster WHERE id=?', [req.params.id])).rows[0];
    if (!rep) return res.status(404).json({ error: 'Rep not found.' });
    const name = rep.name;

    // Weekly trend (avg adjusted score per week)
    const trend = await q(
      `SELECT weekstart AS period, COUNT(*) AS calls, ROUND(AVG(overall_score_adj)::numeric,1) AS avg_score
       FROM calls WHERE status='SCORED' AND rep_name=? ${EXCL_TAGGED}
         AND received_at::timestamp >= (CURRENT_DATE - (? || ' days')::interval)
       GROUP BY weekstart ORDER BY weekstart ASC`, [name, days]);

    // Overall stats + category averages (category_scores is JSON)
    const stats = (await q(
      `SELECT COUNT(*) AS scored, ROUND(AVG(overall_score_adj)::numeric,1) AS avg_adj,
              ROUND(AVG(overall_score)::numeric,1) AS avg_raw, ROUND(AVG(agent_talk_pct)::numeric,0) AS avg_talk
       FROM calls WHERE status='SCORED' AND rep_name=? ${EXCL_TAGGED}`, [name])).rows[0];

    // Category averages — pull from JSON in app code (portable across the 5 cats)
    const scored = (await q(
      `SELECT category_scores FROM calls WHERE status='SCORED' AND rep_name=? AND category_scores IS NOT NULL ${EXCL_TAGGED}`, [name])).rows;
    const catTotals = {}, catCounts = {};
    scored.forEach(r => {
      let cs = r.category_scores; try { if (typeof cs === 'string') cs = JSON.parse(cs); } catch(e){ cs = null; }
      if (cs) for (const k of Object.keys(cs)) { const v = Number(cs[k]); if (isFinite(v)) { catTotals[k]=(catTotals[k]||0)+v; catCounts[k]=(catCounts[k]||0)+1; } }
    });
    const categories = Object.keys(catTotals).map(k => ({ category: k, avg: Math.round(catTotals[k]/catCounts[k]*10)/10 }));

    // Recent calls
    const recent = (await q(
      `SELECT id, client_name, overall_score_adj, received_at
       FROM calls WHERE status='SCORED' AND rep_name=? ORDER BY received_at DESC LIMIT 10`, [name])).rows;

    res.json({ rep: { id: rep.id, name, role: rep.role, color: rep.color }, stats, trend: trend.rows, categories, recent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

//  - Closer: needs a UNIQUE src_tag (maps to a dedicated Fathom webhook). aloware_user_id ignored.
//  - Setter: src_tag defaults to 'aloware-setters'; needs a UNIQUE aloware_user_id.
router.post('/reps', express.json(), async (req, res) => {
  try {
    const b = req.body || {};
    const name = (b.name || '').trim();
    const role = b.role;
    const team = (b.team || '').trim() || (role === 'Setter' ? 'Turnkey - Setters' : 'Turnkey - Closers');
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!['Setter', 'Closer', 'Both'].includes(role)) return res.status(400).json({ error: 'Role must be Setter, Closer, or Both.' });

    let src_tag = (b.src_tag || '').trim();
    let aloware_user_id = (b.aloware_user_id || '').trim() || null;
    const color = (b.color || '').trim() || pickColor();

    if (role === 'Closer') {
      if (!src_tag) return res.status(400).json({ error: 'Closers need a unique src_tag (e.g. fathom-closers-3). Call /reps/next-src-tag for a suggestion.' });
      const dup = await q('SELECT id,name FROM rep_roster WHERE src_tag=?', [src_tag]);
      if (dup.rows.length) return res.status(409).json({ error: `src_tag "${src_tag}" already belongs to ${dup.rows[0].name}. Pick another.` });
      aloware_user_id = null; // not used for closers
    } else {
      // Setter (or Both): share the Aloware tag, distinguished by user_id
      if (!src_tag) src_tag = 'aloware-setters';
      if (!aloware_user_id) return res.status(400).json({ error: 'Setters need their Aloware user_id (found in Aloware under the user profile / API).' });
      const dup = await q('SELECT id,name FROM rep_roster WHERE aloware_user_id=?', [aloware_user_id]);
      if (dup.rows.length) return res.status(409).json({ error: `Aloware user_id "${aloware_user_id}" already belongs to ${dup.rows[0].name}.` });
    }

    const ins = await q(
      'INSERT INTO rep_roster (name, role, team, src_tag, aloware_user_id, color, active) VALUES (?,?,?,?,?,?,1)',
      [name, role, team, src_tag, aloware_user_id, color]);

    const created = (await q('SELECT * FROM rep_roster WHERE id=?', [ins.lastInsertRowid])).rows[0];
    // For closers, hand back the exact webhook URL to paste into Fathom.
    let webhook_url = null;
    if (role === 'Closer') {
      const base = process.env.PUBLIC_BASE_URL || 'https://bnb-turnkey-qc.onrender.com';
      webhook_url = `${base}/api/webhook?src=${src_tag}&key=<WEBHOOK_SECRET_KEY>`;
    }
    res.json({ ok: true, rep: created, webhook_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edit a rep (fix typo, change team/color, update user_id). Same uniqueness guards.
router.patch('/reps/:id', express.json(), async (req, res) => {
  try {
    const id = req.params.id;
    const cur = (await q('SELECT * FROM rep_roster WHERE id=?', [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'Rep not found.' });
    const b = req.body || {};
    const name = b.name != null ? String(b.name).trim() : cur.name;
    const role = b.role != null ? b.role : cur.role;
    const team = b.team != null ? String(b.team).trim() : cur.team;
    const color = b.color != null ? String(b.color).trim() : cur.color;
    let src_tag = b.src_tag != null ? String(b.src_tag).trim() : cur.src_tag;
    let aloware_user_id = b.aloware_user_id != null ? String(b.aloware_user_id).trim() : cur.aloware_user_id;

    if (role === 'Closer') {
      if (src_tag && src_tag !== cur.src_tag) {
        const dup = await q('SELECT id FROM rep_roster WHERE src_tag=? AND id<>?', [src_tag, id]);
        if (dup.rows.length) return res.status(409).json({ error: `src_tag "${src_tag}" already in use.` });
      }
    } else if (aloware_user_id && aloware_user_id !== cur.aloware_user_id) {
      const dup = await q('SELECT id FROM rep_roster WHERE aloware_user_id=? AND id<>?', [aloware_user_id, id]);
      if (dup.rows.length) return res.status(409).json({ error: `Aloware user_id "${aloware_user_id}" already in use.` });
    }

    await q('UPDATE rep_roster SET name=?, role=?, team=?, src_tag=?, aloware_user_id=?, color=? WHERE id=?',
      [name, role, team, src_tag, aloware_user_id || null, color, id]);
    res.json({ ok: true, rep: (await q('SELECT * FROM rep_roster WHERE id=?', [id])).rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deactivate / reactivate (never hard-delete — preserves historical call attribution).
router.post('/reps/:id/deactivate', async (req, res) => {
  try {
    const r = await q('UPDATE rep_roster SET active=0 WHERE id=?', [req.params.id]);
    res.json({ ok: true, changed: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.post('/reps/:id/reactivate', async (req, res) => {
  try {
    const r = await q('UPDATE rep_roster SET active=1 WHERE id=?', [req.params.id]);
    res.json({ ok: true, changed: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function pickColor() {
  const palette = ['#6366f1','#8b5cf6','#10b981','#f59e0b','#0ea5e9','#ec4899','#14b8a6','#f43f5e','#a855f7','#22c55e'];
  return palette[Math.floor(Math.random() * palette.length)];
}


router.get('/debug/webhooks', async (req, res) => {
  try { res.json((await q('SELECT id, received_at, src_tag, base_source, raw_payload FROM webhook_debug ORDER BY id DESC LIMIT 10')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Health (detailed) ──────────────────────────────────────
router.get('/health', async (req, res) => {
  try {
    const h = await q(`SELECT COUNT(*) as total,
      SUM(CASE WHEN status='SCORED' THEN 1 ELSE 0 END) as scored,
      SUM(CASE WHEN status='ERROR' THEN 1 ELSE 0 END) as errors,
      SUM(CASE WHEN status='WAIT_TRANSCRIPT' THEN 1 ELSE 0 END) as missing,
      SUM(CASE WHEN status='NO_TRANSCRIPT' THEN 1 ELSE 0 END) as stuck_no_transcript,
      SUM(CASE WHEN status='SKIP_VOICEMAIL' THEN 1 ELSE 0 END) as voicemails,
      SUM(CASE WHEN status IN ('SKIP_RESCHEDULE','SKIP_FOLLOWUP','SKIP_WRONG_NUMBER','SKIP_INTERNAL','SKIP_NOT_ROSTERED') THEN 1 ELSE 0 END) as classified_skipped,
      SUM(CASE WHEN status='SKIP_SHORT' THEN 1 ELSE 0 END) as too_short,
      SUM(CASE WHEN status IN ('NEW','REQC','WAIT_RETRY_FULL') THEN 1 ELSE 0 END) as in_queue,
      SUM(CASE WHEN status='WAIT_RETRY_FULL' THEN 1 ELSE 0 END) as retrying FROM calls`);

    // Recent errors
    const recentErrors = await q("SELECT id, rep_name, client_name, error, received_at FROM calls WHERE status='ERROR' ORDER BY received_at DESC LIMIT 5");

    // Daily processing stats (last 7 days)
    const dailyStats = await q("SELECT date_key, full_qc_used, est_cost_usd FROM daily_counters ORDER BY date_key DESC LIMIT 7");

    // Total cost
    const totalCost = await q("SELECT SUM(est_cost_usd) as total FROM daily_counters");

    // Webhook health monitor — last webhook per source
    const webhookHealth = await q("SELECT base_source, MAX(received_at) as last_received, COUNT(*) as total_received FROM webhook_debug GROUP BY base_source");

    // PER-REP webhook health — when was each rep's last call pulled + 24h volume
    const repHealthStart = Date.now();
    const repHealth = await q(`SELECT r.name AS rep_name, r.role, r.team,
        MAX(c.received_at) AS last_call,
        SUM(CASE WHEN c.received_at::timestamp >= (NOW() - INTERVAL '24 hours') THEN 1 ELSE 0 END) AS calls_24h,
        SUM(CASE WHEN c.received_at::timestamp >= (NOW() - INTERVAL '7 days') THEN 1 ELSE 0 END) AS calls_7d,
        COUNT(c.id) AS calls_total
      FROM rep_roster r
      LEFT JOIN calls c ON c.rep_name = r.name
      WHERE r.active = 1
      GROUP BY r.name, r.role, r.team
      ORDER BY r.role, r.name`);
    // dbLatencyMs: how long that real query took = a live DB-reachability signal
    const dbLatencyMs = Date.now() - repHealthStart;

    // Flag reps who've gone quiet (no call in 24h) — the "did their webhook stop?" signal
    const repAlerts = [];
    const nowMs = Date.now();
    for (const rh of repHealth.rows) {
      const hrs = rh.last_call ? (nowMs - new Date(rh.last_call + 'Z').getTime()) / 3.6e6 : null;
      rh.hours_since = hrs == null ? null : Math.round(hrs * 10) / 10;
      rh.calls_24h = Number(rh.calls_24h) || 0;
      rh.calls_7d = Number(rh.calls_7d) || 0;
      rh.calls_total = Number(rh.calls_total) || 0;
      // status: green (call in 24h) / amber (1-3 days) / red (>3 days or never)
      if (rh.calls_total === 0) rh.status = 'none';
      else if (hrs == null || hrs > 72) rh.status = 'stale';
      else if (hrs > 24) rh.status = 'quiet';
      else rh.status = 'active';
      if (rh.status === 'stale' || rh.status === 'quiet') {
        repAlerts.push({ rep: rh.rep_name, role: rh.role, lastCall: rh.last_call, hoursSince: rh.hours_since, status: rh.status });
      }
    }

    // Today's cost vs budget (budget from env, 0 = unlimited)
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayRow = await q("SELECT full_qc_used, est_cost_usd FROM daily_counters WHERE date_key=?", [todayKey]);
    const dailyBudget = Number(process.env.DAILY_BUDGET_USD || 0);

    // Last successful score (freshness signal — is scoring actually happening?)
    const lastScored = await q("SELECT MAX(processed_at) AS last FROM calls WHERE status='SCORED'");

    // Source-silence alerts: warn if a source goes quiet, with severity.
    // Expected sources so we can flag one that has sent NOTHING at all.
    const EXPECTED_SOURCES = ['Aloware', 'Fathom'];
    const seen = {};
    webhookHealth.rows.forEach(w => { seen[w.base_source] = w.last_received; });
    const webhookAlerts = [];
    const nowT = Date.now();
    const hr = new Date().getUTCHours();
    // Rough business-hours window (13:00–01:00 UTC ≈ 8am–8pm ET). Silence during
    // business hours is more alarming than overnight.
    const businessHours = hr >= 13 || hr <= 1;

    for (const src of EXPECTED_SOURCES) {
      const last = seen[src];
      if (!last) {
        webhookAlerts.push({ source: src, severity: 'warning', hoursSince: null, message: `${src} has not sent any webhooks yet` });
        continue;
      }
      const hoursSince = (nowT - new Date(last + 'Z').getTime()) / 3.6e6;
      if (hoursSince > 48) {
        webhookAlerts.push({ source: src, severity: 'critical', lastReceived: last, hoursSince: Math.round(hoursSince), message: `${src} silent for ${Math.round(hoursSince)}h` });
      } else if (hoursSince > 24) {
        webhookAlerts.push({ source: src, severity: 'warning', lastReceived: last, hoursSince: Math.round(hoursSince), message: `${src} silent for ${Math.round(hoursSince)}h` });
      } else if (hoursSince > 4 && businessHours) {
        webhookAlerts.push({ source: src, severity: 'info', lastReceived: last, hoursSince: Math.round(hoursSince), message: `${src} quiet ${Math.round(hoursSince)}h during business hours` });
      }
    }

    const r = h.rows[0];
    const total = Number(r.total) || 1;
    const issues = (Number(r.missing) || 0) + (Number(r.errors) || 0);
    res.json({
      healthScore: Math.round(((total - issues) / total) * 100),
      total: Number(r.total),
      scored: Number(r.scored),
      errors: Number(r.errors),
      missing: Number(r.missing),
      stuckNoTranscript: Number(r.stuck_no_transcript),
      voicemails: Number(r.voicemails),
      classified_skipped: Number(r.classified_skipped),
      too_short: Number(r.too_short),
      in_queue: Number(r.in_queue),
      retrying: Number(r.retrying),
      recentErrors: recentErrors.rows,
      dailyStats: dailyStats.rows,
      totalCost: Number(totalCost.rows[0]?.total || 0),
      engine: process.env.AI_ENGINE || 'gemini',
      webhookHealth: webhookHealth.rows,
      webhookAlerts,
      repHealth: repHealth.rows,
      repAlerts,
      dbLatencyMs,
      lastScoredAt: lastScored.rows[0]?.last || null,
      today: {
        date: todayKey,
        scored: Number(todayRow.rows[0]?.full_qc_used || 0),
        cost: Number(todayRow.rows[0]?.est_cost_usd || 0),
        budget: dailyBudget,
      },
      serverTime: new Date().toISOString(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Resources: training manuals (served as structured HTML) ──
const TRAINING_MANUALS = require('../services/resources');
router.get('/resources', (req, res) => {
  // list = lightweight (no html bodies); full = with content
  if (req.query.full === '1') return res.json({ manuals: TRAINING_MANUALS });
  res.json({ manuals: TRAINING_MANUALS.map(({ html, ...meta }) => meta) });
});
router.get('/resources/:id', (req, res) => {
  const m = TRAINING_MANUALS.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'Manual not found' });
  res.json(m);
});

// ─── Rubric: the live scoring rubric (for the Rubric tab) ──
router.get('/rubric', async (req, res) => {
  try {
    const version = req.query.version
      ? Number(req.query.version)
      : (await q('SELECT MAX(version) AS v FROM rubric_items')).rows[0]?.v || 1;
    const items = await q('SELECT * FROM rubric_items WHERE version=? ORDER BY role, weight DESC', [version]);
    const versions = await q('SELECT DISTINCT version FROM rubric_items ORDER BY version');
    res.json({ version, versions: versions.rows.map(r => r.version), items: items.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Report: structured data for per-rep cards, weekly digest, trends ──
router.get('/report', async (req, res) => {
  try {
    const days = Number(req.query.days || 7);
    const role = req.query.role; // optional Closer|Setter
    const rep = req.query.rep;    // optional single rep
    const from = req.query.from;  // optional explicit range (YYYY-MM-DD)
    const to = req.query.to;
    const preset = req.query.preset; // 'today' | 'yesterday'

    const roleFilter = role ? ' AND role=?' : '';
    const repFilter = rep ? ' AND rep_name=?' : '';
    const baseArgs = [];
    if (role) baseArgs.push(role);
    if (rep) baseArgs.push(rep);

    // Window: an explicit from/to range or a named preset (today / yesterday) wins;
    // otherwise fall back to the rolling N-day window. Today/Yesterday boundaries are
    // pinned to US Eastern (America/New_York) — received_at is stored as UTC wall-clock.
    const ET_DATE = `(received_at::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'America/New_York')::date`;
    const ET_TODAY = `(NOW() AT TIME ZONE 'America/New_York')::date`;
    let periodClause, prevClause, useRange = false;
    if (preset === 'today') {
      periodClause = `${ET_DATE} = ${ET_TODAY}`;
      prevClause = `${ET_DATE} = ${ET_TODAY} - 1`;
      useRange = true;
    } else if (preset === 'yesterday') {
      periodClause = `${ET_DATE} = ${ET_TODAY} - 1`;
      prevClause = `${ET_DATE} = ${ET_TODAY} - 2`;
      useRange = true;
    } else if (from || to) {
      const f = from || '1970-01-01';
      const t = (to || '2999-12-31') + ' 23:59:59';
      periodClause = `received_at >= '${f}' AND received_at <= '${t}'`;
      prevClause = `1=0`; // no meaningful "previous" for an arbitrary range
      useRange = true;
    } else {
      // `days` is Number()-validated above, so inlining is injection-safe. Parameterising the
      // interval (`(? || ' days')::interval`) made the arg count depend on the mode, and any
      // query that passed the wrong arg list threw — 500ing the entire report.
      const d = Math.max(1, Math.min(365, Number(days) || 7));
      periodClause = `received_at::timestamp >= (NOW() - INTERVAL '${d} days')`;
      prevClause = `received_at::timestamp >= (NOW() - INTERVAL '${d * 2} days') AND received_at::timestamp < (NOW() - INTERVAL '${d} days')`;
    }
    // Every window clause is now literal — no placeholders — so ALL queries take the same
    // args (just role/rep filters). One arg list, impossible to mismatch.
    const PA = [...baseArgs];
    const PV = [...baseArgs];

    // Per-rep summary for THIS period
    const perRep = await q(
      `SELECT rep_name, role,
         COUNT(*) FILTER (WHERE status='SCORED') AS scored,
         ROUND(AVG(overall_score_adj) FILTER (WHERE ${SCORED_UNTAGGED})::numeric,1) AS avg_adj,
         ROUND(AVG(overall_score) FILTER (WHERE ${SCORED_UNTAGGED})::numeric,1) AS avg_raw,
         COUNT(*) FILTER (WHERE status='SKIP_VOICEMAIL') AS voicemails,
         COUNT(*) AS total_calls,
         ROUND(AVG(agent_talk_pct) FILTER (WHERE ${SCORED_UNTAGGED})::numeric,0) AS avg_talk
       FROM calls WHERE ${periodClause}${roleFilter}${repFilter} AND rep_name != 'Unknown Setter'
       GROUP BY rep_name, role ORDER BY avg_adj DESC NULLS LAST`,
      PA);

    // Previous period avg per rep (for trend arrows)
    const prevRep = await q(
      `SELECT rep_name, ROUND(AVG(overall_score_adj) FILTER (WHERE ${SCORED_UNTAGGED})::numeric,1) AS prev_avg
       FROM calls WHERE ${prevClause}${roleFilter}${repFilter}
       GROUP BY rep_name`,
      PV);
    const prevMap = Object.fromEntries(prevRep.rows.map(r => [r.rep_name, r.prev_avg]));

    // Per-rep category averages (parse JSON in JS)
    const scoredCalls = await q(
      `SELECT rep_name, category_scores, pass_fail, improvements
       FROM calls WHERE status='SCORED' AND ${periodClause}${roleFilter}${repFilter}`,
      PA);

    const catByRep = {}, dedByRep = {}, impByRep = {};
    for (const c of scoredCalls.rows) {
      const r = c.rep_name;
      try {
        const cs = JSON.parse(c.category_scores || '{}');
        catByRep[r] = catByRep[r] || {};
        for (const k of Object.keys(cs)) {
          catByRep[r][k] = catByRep[r][k] || [];
          if (cs[k] != null) catByRep[r][k].push(Number(cs[k]));
        }
      } catch {}
      try {
        const pf = JSON.parse(c.pass_fail || '{}');
        (pf.deductions || []).forEach(d => {
          dedByRep[r] = dedByRep[r] || {};
          dedByRep[r][d.label] = (dedByRep[r][d.label] || 0) + 1;
        });
      } catch {}
      try {
        const imps = JSON.parse(c.improvements || '[]');
        (imps || []).forEach(i => { impByRep[r] = impByRep[r] || {}; impByRep[r][i] = (impByRep[r][i] || 0) + 1; });
      } catch {}
    }
    const avgCat = {};
    for (const r of Object.keys(catByRep)) {
      avgCat[r] = {};
      for (const k of Object.keys(catByRep[r])) {
        const a = catByRep[r][k];
        avgCat[r][k] = a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null;
      }
    }

    // Daily trend (team-wide, for the trend chart)
    const trend = await q(
      `SELECT received_at::date AS day,
         COUNT(*) FILTER (WHERE status='SCORED') AS scored,
         ROUND(AVG(overall_score_adj) FILTER (WHERE ${SCORED_UNTAGGED})::numeric,1) AS avg_adj
       FROM calls WHERE ${periodClause}${roleFilter}${repFilter}
       GROUP BY received_at::date ORDER BY day`,
      PA);

    // Team totals
    const team = await q(
      `SELECT COUNT(*) FILTER (WHERE status='SCORED') AS scored,
         ROUND(AVG(overall_score_adj) FILTER (WHERE ${SCORED_UNTAGGED})::numeric,1) AS avg_adj,
         COUNT(*) FILTER (WHERE status='SKIP_VOICEMAIL') AS voicemails,
         COUNT(*) AS total
       FROM calls WHERE ${periodClause}${roleFilter}${repFilter}`,
      PA);

    // Assemble per-rep cards with trend + top deduction + top improvement
    const repCards = perRep.rows.map(r => {
      const prev = prevMap[r.rep_name];
      const delta = (r.avg_adj != null && prev != null) ? Math.round((r.avg_adj - prev) * 10) / 10 : null;
      const topDed = dedByRep[r.rep_name] ? Object.entries(dedByRep[r.rep_name]).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
      const topImp = impByRep[r.rep_name] ? Object.entries(impByRep[r.rep_name]).sort((a, b) => b[1] - a[1]).slice(0, 3) : [];
      return {
        rep_name: r.rep_name, role: r.role,
        scored: Number(r.scored) || 0, avg_adj: r.avg_adj, avg_raw: r.avg_raw,
        avg_talk: r.avg_talk, voicemails: Number(r.voicemails) || 0, total_calls: Number(r.total_calls) || 0,
        prev_avg: prev ?? null, delta,
        categories: avgCat[r.rep_name] || {},
        top_deductions: topDed.map(([label, count]) => ({ label, count })),
        top_improvements: topImp.map(([text, count]) => ({ text, count })),
      };
    });

    // ── Extra digest data ──────────────────────────────────────
    // Best & worst scored call in the window (for the digest highlight)
    const bestWorst = await q(
      `SELECT id, rep_name, client_name, overall_score_adj, quick_summary
       FROM calls WHERE status='SCORED' AND rep_name != 'Unknown Setter'
         AND ${periodClause} ${roleFilter}${repFilter}
       ORDER BY overall_score_adj DESC NULLS LAST LIMIT 1`, baseArgs);
    const worst = await q(
      `SELECT id, rep_name, client_name, overall_score_adj, quick_summary
       FROM calls WHERE status='SCORED' AND rep_name != 'Unknown Setter'
         AND ${periodClause} ${roleFilter}${repFilter}
       ORDER BY overall_score_adj ASC NULLS LAST LIMIT 1`, baseArgs);

    // Non-sales breakdown in the window (what got skipped and why)
    const nonSales = await q(
      `SELECT status, COUNT(*) AS n FROM calls
       WHERE status LIKE 'SKIP_%'
         AND ${periodClause}
       GROUP BY status ORDER BY n DESC`);

    // Team-wide category averages + most common deductions
    const teamCats = await q(
      `SELECT category_scores FROM calls
       WHERE status='SCORED' AND rep_name != 'Unknown Setter' AND category_scores IS NOT NULL
         AND ${periodClause} ${roleFilter}${repFilter}`, PA);
    const catTot = {}, catCnt = {};
    teamCats.rows.forEach(r => {
      let cs = r.category_scores; try { if (typeof cs === 'string') cs = JSON.parse(cs); } catch (e) { cs = null; }
      if (cs) for (const k of Object.keys(cs)) { const v = Number(cs[k]); if (isFinite(v)) { catTot[k]=(catTot[k]||0)+v; catCnt[k]=(catCnt[k]||0)+1; } }
    });
    const teamCategories = Object.keys(catTot).map(k => ({ category: k, avg: Math.round(catTot[k]/catCnt[k]*10)/10 }))
      .sort((a,b) => a.avg - b.avg); // weakest first — that's the coaching focus

    // ── Sam's daily digest: setters best+toughest, closers best+toughest ──
    // Always team-wide across BOTH roles (ignores any role/rep filter), same window
    // and exclusions as the rest of the report. "Toughest" blends a low score with
    // tough-moment load — the call that most needs coaching. Never re-scores.
    const digestRows = (await q(
      `SELECT id, rep_name, role, client_name, overall_score_adj, received_at,
              golden_moments, tough_moments, improvements, coaching_notes,
              category_scores, aloware_contact_id, aloware_call_id
       FROM calls
       WHERE status='SCORED' AND rep_name != 'Unknown Setter' ${EXCL_TAGGED}
         AND ${periodClause}`)).rows;

    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const base = process.env.PUBLIC_BASE_URL || `${proto}://${req.get('host')}`;
    const parseArr = (v) => { if (Array.isArray(v)) return v; try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
    const toughnessOf = (c) => {
      const s = Number(c.overall_score_adj);
      const tc = parseArr(c.tough_moments).length;
      return (10 - (isFinite(s) ? s : 5)) + tc * 1.5;   // low score + tough moments = tougher
    };
    // When the AI hasn't extracted tough moments yet, explain the toughness from
    // data the call already has: its top improvement theme, then its weakest category.
    const lowestCat = (v) => {
      let obj = v; try { if (typeof obj === 'string') obj = JSON.parse(obj); } catch { obj = null; }
      if (!obj || typeof obj !== 'object') return '';
      let lk = null, lv = Infinity;
      for (const [k, val] of Object.entries(obj)) { const n = Number(val); if (isFinite(n) && n < lv) { lv = n; lk = k; } }
      return lk ? `Weakest area: ${lk} (${lv}/10)` : '';
    };
    const whyTough = (c) => {
      const imp = parseArr(c.improvements);
      if (imp.length) return String(imp[0]);
      const lc = lowestCat(c.category_scores);
      if (lc) return lc;
      const cn = (c.coaching_notes || '').trim();
      if (cn) return cn.split(/(?<=[.!?])\s/)[0].slice(0, 240);
      return 'Lowest-scoring call in this window — worth a listen.';
    };
    const liteCall = (c) => c ? {
      id: c.id, rep_name: c.rep_name, role: c.role, client_name: c.client_name,
      score: c.overall_score_adj, received_at: c.received_at,
      link: `${base}/#/calls/${c.id}`,
      toughness: Math.round(toughnessOf(c) * 10) / 10,
      tough_count: parseArr(c.tough_moments).length,
      why_tough_fallback: whyTough(c),
      golden: parseArr(c.golden_moments).filter(m => m && m.quote).slice(0, 1),
      tough: parseArr(c.tough_moments).filter(m => m && m.quote).slice(0, 2),
      aloware_contact_id: c.aloware_contact_id, aloware_call_id: c.aloware_call_id,
    } : null;
    const bestOf = (list) => list.length ? list.reduce((a, b) => Number(b.overall_score_adj) > Number(a.overall_score_adj) ? b : a) : null;
    const toughestOf = (list) => list.length ? list.reduce((a, b) => {
      const tb = toughnessOf(b), ta = toughnessOf(a);
      if (tb > ta) return b;
      if (tb === ta && Number(b.overall_score_adj) < Number(a.overall_score_adj)) return b;
      return a;
    }) : null;
    const setters = digestRows.filter(c => c.role === 'Setter');
    const closers = digestRows.filter(c => c.role === 'Closer');
    const samDigest = {
      setters: { best: liteCall(bestOf(setters)), toughest: liteCall(toughestOf(setters)), count: setters.length },
      closers: { best: liteCall(bestOf(closers)), toughest: liteCall(toughestOf(closers)), count: closers.length },
    };

    const windowLabel = preset === 'today' ? 'Today (ET)' : preset === 'yesterday' ? 'Yesterday (ET)'
      : (from || to) ? `${from || '…'} → ${to || '…'}` : `Last ${days} days`;

    // Slack copy-paste block (mrkdwn: *bold*, <url|text>). Server-built so it's consistent.
    const slackLine = (label, c) => {
      if (!c) return `${label}: _no calls_`;
      const head = `${label}: *${c.rep_name}* → ${c.client_name || '?'} · *${c.score ?? '—'}/10*${label.includes('Toughest') && c.tough_count ? ` (${c.tough_count} tough)` : ''}`;
      let detail = '';
      if (label.includes('Best')) {
        detail = c.golden[0] ? `\n   🟢 "${c.golden[0].quote}"` : '';
      } else if (c.tough[0]) {
        detail = `\n   🔴 ${c.tough[0].why_it_was_tough || 'tough moment'}${c.tough[0].what_to_do_instead ? ' → ' + c.tough[0].what_to_do_instead : ''}`;
      } else if (c.why_tough_fallback) {
        detail = `\n   🔴 ${c.why_tough_fallback}`;
      }
      const link = c.link ? `\n   <${c.link}|open call →>` : '';
      return head + detail + link;
    };
    const samDigestSlack = [
      `📊 *Daily QC Digest — ${windowLabel}*`,
      ``,
      `🎧 *SETTERS* (${setters.length} scored)`,
      `🏆 ${slackLine('Best', samDigest.setters.best)}`,
      `💪 ${slackLine('Toughest', samDigest.setters.toughest)}`,
      ``,
      `📞 *CLOSERS* (${closers.length} scored)`,
      `🏆 ${slackLine('Best', samDigest.closers.best)}`,
      `💪 ${slackLine('Toughest', samDigest.closers.toughest)}`,
    ].join('\n');

    res.json({
      generated: new Date().toISOString(),
      period_days: days,
      role: role || 'all',
      rep: rep || null,
      window_label: windowLabel,
      team: team.rows[0],
      reps: repCards,
      trend: trend.rows,
      best_call: bestWorst.rows[0] || null,
      worst_call: worst.rows[0] || null,
      non_sales: nonSales.rows,
      team_categories: teamCategories,
      sam_digest: samDigest,
      sam_digest_slack: samDigestSlack,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Call comments: team notes/opinions on calls ──
router.get('/calls/:id/comments', async (req, res) => {
  try {
    const r = await q('SELECT * FROM call_comments WHERE call_id=? ORDER BY created_at ASC', [req.params.id]);
    res.json({ comments: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/calls/:id/comments', express.json(), async (req, res) => {
  try {
    const { author, author_role, body, comment_type } = req.body || {};
    if (!author || !body) return res.status(400).json({ error: 'author and body required' });
    const ins = await q('INSERT INTO call_comments (call_id, author, author_role, body, comment_type) VALUES (?,?,?,?,?)',
      [req.params.id, author, author_role || '', body, comment_type || 'note']);
    res.json({ ok: true, id: ins.lastInsertRowid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/comments/:id', async (req, res) => {
  try { await q('DELETE FROM call_comments WHERE id=?', [req.params.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

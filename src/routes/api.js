const express = require('express');
const router = express.Router();
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
    if (hideVm === 'true') w += " AND status NOT IN ('SKIP_VOICEMAIL','SKIP_SHORT','SKIP_RESCHEDULE','SKIP_FOLLOWUP','SKIP_WRONG_NUMBER','SKIP_INTERNAL')";
    if (status && status !== 'ALL') { w += ' AND status=?'; p.push(status); }
    if (rep) { w += ' AND rep_name=?'; p.push(rep); }
    if (role) { w += ' AND role=?'; p.push(role); }
    if (flagged === 'true') w += ' AND flagged=1';
    if (from) { w += ' AND received_at >= ?'; p.push(from); }
    if (to) { w += ' AND received_at <= ?'; p.push(to + ' 23:59:59'); }
    if (!from && !to) {
      if (period === 'day') w += " AND received_at >= date('now')";
      if (period === 'week') w += " AND received_at >= date('now','-7 days')";
      if (period === 'month') w += " AND received_at >= date('now','-30 days')";
    }
    const r = await q(`SELECT id,received_at,source,rep_name,rep_id,role,team,client_name,call_url,audio_url,call_duration_sec,agent_talk_pct,contact_talk_pct,overall_score,overall_score_adj,score_adjust_notes,category_scores,pass_fail,quick_summary,strengths,improvements,next_step_text,coaching_notes,golden_moments,status,flagged,error,retry_count,weekstart,processed_at FROM calls WHERE ${w} ORDER BY received_at DESC LIMIT ? OFFSET ?`, [...p, Number(limit), Number(offset)]);
    const cnt = await q(`SELECT COUNT(*) as c FROM calls WHERE ${w}`, p);
    res.json({ calls: r.rows.map(parseJ), total: Number(cnt.rows[0].c) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/calls/:id', async (req, res) => {
  try {
    const r = await q('SELECT * FROM calls WHERE id=?', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(parseJ(r.rows[0]));
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
      where += ` AND received_at >= datetime('now','-${Number(days)} days')`;
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
      where += ` AND received_at >= datetime('now','-${Number(days)} days')`;
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

router.post('/calls/:id/override', async (req, res) => {
  try {
    const { override_score, reason, override_by = 'Sam' } = req.body;
    const c = await q('SELECT overall_score_adj FROM calls WHERE id=?', [req.params.id]);
    if (!c.rows.length) return res.status(404).json({ error: 'Not found' });
    const now = new Date().toISOString().replace('T',' ').slice(0,19);
    await q('INSERT INTO score_overrides (call_id,override_by,original_score,override_score,reason,created_at) VALUES (?,?,?,?,?,?)',
      [req.params.id, override_by, c.rows[0].overall_score_adj, override_score, reason, now]);
    res.json({ ok: true });
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
    const r = await q("UPDATE calls SET status='REQC', error='Queued for re-score (recent)', retry_count=0 WHERE status='SCORED' AND received_at >= datetime('now', ?)", [`-${days} days`]);
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
      sql = "SELECT COUNT(*) as count FROM calls WHERE status='SCORED' AND received_at >= datetime('now', ?)";
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
    const currentAvg = await q("SELECT rubric_version, COUNT(*) as count, AVG(overall_score_adj) as avg_score, AVG(CASE WHEN category_scores IS NOT NULL THEN json_extract(category_scores, '$.discovery') END) as avg_discovery, AVG(CASE WHEN category_scores IS NOT NULL THEN json_extract(category_scores, '$.qualification') END) as avg_qual, AVG(CASE WHEN category_scores IS NOT NULL THEN json_extract(category_scores, '$.pitch') END) as avg_pitch FROM calls WHERE status='SCORED' GROUP BY rubric_version");

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
    const { type, rep, from, to, limit = 200, offset = 0 } = req.query;
    let w = "status IN ('SKIP_VOICEMAIL','SKIP_SHORT','SKIP_RESCHEDULE','SKIP_FOLLOWUP','SKIP_WRONG_NUMBER','SKIP_INTERNAL')", p = [];
    if (type && type !== 'ALL') { w = 'status=?'; p.push(type); }
    if (rep) { w += ' AND rep_name=?'; p.push(rep); }
    if (from) { w += ' AND received_at >= ?'; p.push(from); }
    if (to) { w += ' AND received_at <= ?'; p.push(to + ' 23:59:59'); }

    const r = await q(`SELECT id,received_at,source,rep_name,role,client_name,call_url,audio_url,call_duration_sec,quick_summary,status,error FROM calls WHERE ${w} ORDER BY received_at DESC LIMIT ? OFFSET ?`, [...p, Number(limit), Number(offset)]);
    const cnt = await q(`SELECT COUNT(*) as c FROM calls WHERE ${w}`, p);

    // Breakdown by type
    const breakdown = await q("SELECT status, COUNT(*) as count FROM calls WHERE status IN ('SKIP_VOICEMAIL','SKIP_SHORT','SKIP_RESCHEDULE','SKIP_FOLLOWUP','SKIP_WRONG_NUMBER','SKIP_INTERNAL') GROUP BY status");

    res.json({ records: r.rows, total: Number(cnt.rows[0].c), breakdown: breakdown.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Analytics ───────────────────────────────────────────────
router.get('/analytics', async (req, res) => {
  try {
    const { period = 'week', role, from, to } = req.query;
    let df = '', rf = '', p = [];
    if (from) { df = 'AND received_at >= ?'; p.push(from); if (to) { df += ' AND received_at <= ?'; p.push(to + ' 23:59:59'); } }
    else if (to) { df = 'AND received_at <= ?'; p.push(to + ' 23:59:59'); }
    else { if (period === 'day') df = "AND received_at >= date('now')"; if (period === 'week') df = "AND received_at >= date('now','-7 days')"; if (period === 'month') df = "AND received_at >= date('now','-30 days')"; }
    if (role) { rf = 'AND role=?'; p.push(role); }

    const stats = await q(`SELECT COUNT(*) as total_calls, SUM(CASE WHEN status='SCORED' THEN 1 ELSE 0 END) as scored, SUM(CASE WHEN flagged=1 THEN 1 ELSE 0 END) as flagged, SUM(CASE WHEN status IN ('NEW','REQC','WAIT_RETRY_FULL') THEN 1 ELSE 0 END) as queued, SUM(CASE WHEN status='ERROR' THEN 1 ELSE 0 END) as errors, SUM(CASE WHEN status='WAIT_TRANSCRIPT' THEN 1 ELSE 0 END) as missing_transcripts, ROUND(AVG(CASE WHEN status='SCORED' THEN overall_score_adj END),1) as avg_score, ROUND(AVG(CASE WHEN status='SCORED' THEN call_duration_sec END),0) as avg_duration, ROUND(AVG(CASE WHEN status='SCORED' THEN agent_talk_pct END),1) as avg_agent_talk, ROUND(AVG(CASE WHEN status='SCORED' THEN contact_talk_pct END),1) as avg_contact_talk FROM calls WHERE 1=1 ${df} ${rf}`, p);

    const repStats = await q(`SELECT rep_name, role, COUNT(*) as call_count, ROUND(AVG(overall_score_adj),1) as avg_score, ROUND(AVG(call_duration_sec),0) as avg_duration, ROUND(AVG(agent_talk_pct),1) as avg_agent_talk, SUM(CASE WHEN flagged=1 THEN 1 ELSE 0 END) as flagged_count FROM calls WHERE status='SCORED' ${df} ${rf} GROUP BY rep_name, role ORDER BY avg_score DESC`, p);

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
    const groupBy = period === 'weekly' ? 'weekstart' : "date(received_at)";
    const trends = await q(`SELECT ${groupBy} as period_date, COUNT(*) as total_calls, SUM(CASE WHEN status='SCORED' THEN 1 ELSE 0 END) as scored, ROUND(AVG(CASE WHEN status='SCORED' THEN overall_score_adj END),1) as avg_score, ROUND(AVG(CASE WHEN status='SCORED' THEN call_duration_sec END),0) as avg_duration, SUM(CASE WHEN flagged=1 THEN 1 ELSE 0 END) as flagged FROM calls WHERE received_at >= date('now','-${Number(days)} days') ${rf} GROUP BY ${groupBy} ORDER BY period_date ASC`, p);
    const repTrends = await q(`SELECT ${groupBy} as period_date, rep_name, COUNT(*) as calls, ROUND(AVG(overall_score_adj),1) as avg_score FROM calls WHERE status='SCORED' AND received_at >= date('now','-${Number(days)} days') ${rf} GROUP BY ${groupBy}, rep_name ORDER BY period_date ASC`, p);
    res.json({ trends: trends.rows, repTrends: repTrends.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/analytics/distribution', async (req, res) => {
  try {
    const { period, from, to, role } = req.query;
    let df = '', rf = '', p = [];
    if (from) { df = "AND received_at >= ?"; p.push(from); if (to) { df += " AND received_at <= ?"; p.push(to + ' 23:59:59'); } }
    else { if (period === 'day') df = "AND received_at >= date('now')"; if (period === 'week') df = "AND received_at >= date('now','-7 days')"; if (period === 'month') df = "AND received_at >= date('now','-30 days')"; }
    if (role) { rf = 'AND role=?'; p.push(role); }
    const dist = await q(`SELECT CAST(overall_score_adj AS INTEGER) as score_bucket, COUNT(*) as count FROM calls WHERE status='SCORED' ${df} ${rf} GROUP BY score_bucket ORDER BY score_bucket`, p);
    res.json({ distribution: dist.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Queue ───────────────────────────────────────────────────
router.get('/queue/status', async (req, res) => {
  try {
    const dk = new Date().toISOString().slice(0, 10);
    const daily = await q('SELECT * FROM daily_counters WHERE date_key=?', [dk]);
    const queue = await q("SELECT status, COUNT(*) as count FROM calls WHERE status NOT IN ('SCORED','SKIP_SHORT','SKIP_VOICEMAIL','SKIP_RESCHEDULE','SKIP_FOLLOWUP','SKIP_WRONG_NUMBER','SKIP_INTERNAL') GROUP BY status");
    const scored = await q("SELECT COUNT(*) as c FROM calls WHERE status='SCORED' AND date(processed_at)=date('now')");
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
    const r = await q("UPDATE calls SET status='NEW', error='', retry_count=0 WHERE status IN ('ERROR','WAIT_RETRY_FULL','WAIT_TRANSCRIPT')");
    res.json({ retriedCount: r.rowsAffected });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Reps ────────────────────────────────────────────────────
router.get('/reps', async (req, res) => {
  try { res.json((await q('SELECT * FROM rep_roster WHERE active=1 ORDER BY role,name')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

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
      SUM(CASE WHEN status='SKIP_VOICEMAIL' THEN 1 ELSE 0 END) as voicemails,
      SUM(CASE WHEN status IN ('SKIP_RESCHEDULE','SKIP_FOLLOWUP','SKIP_WRONG_NUMBER','SKIP_INTERNAL') THEN 1 ELSE 0 END) as classified_skipped,
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
    // Check for stale sources (no webhook in 24h during business hours)
    const webhookAlerts = [];
    for (const wh of webhookHealth.rows) {
      if (wh.last_received) {
        const lastTime = new Date(wh.last_received + 'Z');
        const hoursSince = (Date.now() - lastTime.getTime()) / (1000 * 60 * 60);
        if (hoursSince > 24) {
          webhookAlerts.push({ source: wh.base_source, lastReceived: wh.last_received, hoursSince: Math.round(hoursSince) });
        }
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
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

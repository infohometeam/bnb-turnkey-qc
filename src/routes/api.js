const express = require('express');
const router = express.Router();
const { getDb } = require('../../migrations/run');
const { ingestCall } = require('../services/ingestion');
const { processQueue } = require('../workers/qcWorker');

// ─── Webhook ─────────────────────────────────────────────────
router.post('/webhook', express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  try {
    const key = req.query.key || '';
    const expected = process.env.WEBHOOK_SECRET_KEY || '';
    if (!expected || key !== expected) return res.status(401).json({ error: 'Unauthorized' });

    const srcTag = req.query.src || '';
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const result = ingestCall(raw, srcTag);

    if (result.duplicate) return res.json({ status: 'duplicate_skipped', callId: result.callId });
    res.json({ status: 'ok', callId: result.callId, qcStatus: result.status });
  } catch (err) {
    console.error('[Webhook]', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/webhook/health', (req, res) => {
  res.json({ status: 'ok', message: 'BNB Turnkey QC webhook is live', engine: process.env.AI_ENGINE || 'gemini' });
});

// ─── Calls ───────────────────────────────────────────────────
router.get('/calls', (req, res) => {
  try {
    const db = getDb();
    const { status, rep, role, period, flagged, limit = 100, offset = 0 } = req.query;
    let where = ['1=1'], params = [];

    if (status && status !== 'ALL') { where.push('status=?'); params.push(status); }
    if (rep) { where.push('rep_name=?'); params.push(rep); }
    if (role) { where.push('role=?'); params.push(role); }
    if (flagged === 'true') where.push('flagged=1');
    if (period === 'day') where.push("received_at >= date('now')");
    if (period === 'week') where.push("received_at >= date('now','-7 days')");
    if (period === 'month') where.push("received_at >= date('now','-30 days')");

    const w = where.join(' AND ');
    const calls = db.prepare(`SELECT id,received_at,source,rep_name,rep_id,role,team,client_name,call_url,audio_url,
      call_duration_sec,agent_talk_pct,contact_talk_pct,overall_score,overall_score_adj,score_adjust_notes,
      category_scores,pass_fail,quick_summary,strengths,improvements,next_step_text,coaching_notes,golden_moments,
      status,flagged,error,retry_count,weekstart,processed_at FROM calls WHERE ${w} ORDER BY received_at DESC LIMIT ? OFFSET ?`)
      .all(...params, Number(limit), Number(offset));

    const total = db.prepare(`SELECT COUNT(*) as c FROM calls WHERE ${w}`).get(...params).c;

    // Parse JSON fields
    calls.forEach(c => {
      try { c.category_scores = JSON.parse(c.category_scores); } catch(e) { c.category_scores = null; }
      try { c.pass_fail = JSON.parse(c.pass_fail); } catch(e) { c.pass_fail = null; }
      try { c.strengths = JSON.parse(c.strengths); } catch(e) { c.strengths = []; }
      try { c.improvements = JSON.parse(c.improvements); } catch(e) { c.improvements = []; }
      try { c.golden_moments = JSON.parse(c.golden_moments); } catch(e) { c.golden_moments = []; }
      c.flagged = !!c.flagged;
    });

    db.close();
    res.json({ calls, total });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/calls/:id', (req, res) => {
  try {
    const db = getDb();
    const call = db.prepare('SELECT * FROM calls WHERE id=?').get(req.params.id);
    db.close();
    if (!call) return res.status(404).json({ error: 'Not found' });
    try { call.category_scores = JSON.parse(call.category_scores); } catch(e) {}
    try { call.pass_fail = JSON.parse(call.pass_fail); } catch(e) {}
    try { call.strengths = JSON.parse(call.strengths); } catch(e) { call.strengths = []; }
    try { call.improvements = JSON.parse(call.improvements); } catch(e) { call.improvements = []; }
    try { call.golden_moments = JSON.parse(call.golden_moments); } catch(e) { call.golden_moments = []; }
    call.flagged = !!call.flagged;
    res.json(call);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/calls/:id/reqc', (req, res) => {
  try {
    const db = getDb();
    db.prepare("UPDATE calls SET status='REQC', error='', retry_count=0 WHERE id=?").run(req.params.id);
    db.close();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/calls/:id/override', (req, res) => {
  try {
    const db = getDb();
    const { override_score, reason, override_by = 'Sam' } = req.body;
    const call = db.prepare('SELECT overall_score_adj FROM calls WHERE id=?').get(req.params.id);
    if (!call) { db.close(); return res.status(404).json({ error: 'Not found' }); }
    db.prepare('INSERT INTO score_overrides (call_id,override_by,original_score,override_score,reason) VALUES (?,?,?,?,?)')
      .run(req.params.id, override_by, call.overall_score_adj, override_score, reason);
    db.close();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Analytics ───────────────────────────────────────────────
router.get('/analytics', (req, res) => {
  try {
    const db = getDb();
    const { period = 'week', role } = req.query;
    let df = '', rf = '', params = [];
    if (period === 'day') df = "AND received_at >= date('now')";
    if (period === 'week') df = "AND received_at >= date('now','-7 days')";
    if (period === 'month') df = "AND received_at >= date('now','-30 days')";
    if (role) { rf = 'AND role=?'; params.push(role); }

    const stats = db.prepare(`SELECT COUNT(*) as total_calls,
      SUM(CASE WHEN status='SCORED' THEN 1 ELSE 0 END) as scored,
      SUM(CASE WHEN flagged=1 THEN 1 ELSE 0 END) as flagged,
      SUM(CASE WHEN status IN ('NEW','REQC','WAIT_RETRY_FULL') THEN 1 ELSE 0 END) as queued,
      SUM(CASE WHEN status='ERROR' THEN 1 ELSE 0 END) as errors,
      SUM(CASE WHEN status='WAIT_TRANSCRIPT' THEN 1 ELSE 0 END) as missing_transcripts,
      ROUND(AVG(CASE WHEN status='SCORED' THEN overall_score_adj END),1) as avg_score,
      ROUND(AVG(CASE WHEN status='SCORED' THEN call_duration_sec END),0) as avg_duration,
      ROUND(AVG(CASE WHEN status='SCORED' THEN agent_talk_pct END),1) as avg_agent_talk,
      ROUND(AVG(CASE WHEN status='SCORED' THEN contact_talk_pct END),1) as avg_contact_talk
      FROM calls WHERE 1=1 ${df} ${rf}`).get(...params);

    const repStats = db.prepare(`SELECT rep_name, role, COUNT(*) as call_count,
      ROUND(AVG(overall_score_adj),1) as avg_score,
      ROUND(AVG(call_duration_sec),0) as avg_duration,
      ROUND(AVG(agent_talk_pct),1) as avg_agent_talk,
      SUM(CASE WHEN flagged=1 THEN 1 ELSE 0 END) as flagged_count
      FROM calls WHERE status='SCORED' ${df} ${rf} GROUP BY rep_name, role ORDER BY avg_score DESC`).all(...params);

    db.close();
    res.json({ stats, repStats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Queue ───────────────────────────────────────────────────
router.get('/queue/status', (req, res) => {
  try {
    const db = getDb();
    const dk = new Date().toISOString().slice(0, 10);
    const daily = db.prepare('SELECT * FROM daily_counters WHERE date_key=?').get(dk) || { full_qc_used: 0, est_cost_usd: 0 };
    const queue = db.prepare("SELECT status, COUNT(*) as count FROM calls WHERE status NOT IN ('SCORED','SKIP_SHORT','SKIP_VOICEMAIL') GROUP BY status").all();
    db.close();
    res.json({ daily, queue, engine: process.env.AI_ENGINE || 'gemini' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/queue/process', async (req, res) => {
  try {
    const max = parseInt(req.query.max || '3');
    const result = await processQueue(max);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/queue/retry-all', (req, res) => {
  try {
    const db = getDb();
    const r = db.prepare("UPDATE calls SET status='NEW', error='', retry_count=0 WHERE status IN ('ERROR','WAIT_RETRY_FULL','WAIT_TRANSCRIPT')").run();
    db.close();
    res.json({ retriedCount: r.changes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Reps ────────────────────────────────────────────────────
router.get('/reps', (req, res) => {
  try {
    const db = getDb();
    const reps = db.prepare('SELECT * FROM rep_roster WHERE active=1 ORDER BY role,name').all();
    db.close();
    res.json(reps);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Health ──────────────────────────────────────────────────
router.get('/health', (req, res) => {
  try {
    const db = getDb();
    const h = db.prepare(`SELECT COUNT(*) as total,
      SUM(CASE WHEN status='WAIT_TRANSCRIPT' THEN 1 ELSE 0 END) as missing,
      SUM(CASE WHEN status='ERROR' THEN 1 ELSE 0 END) as errors,
      SUM(CASE WHEN status='SCORED' THEN 1 ELSE 0 END) as scored
      FROM calls`).get();
    db.close();
    const total = h.total || 1;
    const issues = (h.missing || 0) + (h.errors || 0);
    res.json({ healthScore: Math.round(((total - issues) / total) * 100), ...h });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

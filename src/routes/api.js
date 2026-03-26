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

router.get('/calls', async (req, res) => {
  try {
    const { status, rep, role, period, flagged, limit = 100, offset = 0 } = req.query;
    let w = '1=1', p = [];
    if (status && status !== 'ALL') { w += ' AND status=?'; p.push(status); }
    if (rep) { w += ' AND rep_name=?'; p.push(rep); }
    if (role) { w += ' AND role=?'; p.push(role); }
    if (flagged === 'true') w += ' AND flagged=1';
    if (period === 'day') w += " AND received_at >= date('now')";
    if (period === 'week') w += " AND received_at >= date('now','-7 days')";
    if (period === 'month') w += " AND received_at >= date('now','-30 days')";
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

router.post('/calls/:id/reqc', async (req, res) => {
  try { await q("UPDATE calls SET status='REQC', error='', retry_count=0 WHERE id=?", [req.params.id]); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

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

router.get('/analytics', async (req, res) => {
  try {
    const { period = 'week', role } = req.query;
    let df = '', rf = '', p = [];
    if (period === 'day') df = "AND received_at >= date('now')";
    if (period === 'week') df = "AND received_at >= date('now','-7 days')";
    if (period === 'month') df = "AND received_at >= date('now','-30 days')";
    if (role) { rf = 'AND role=?'; p.push(role); }
    const stats = await q(`SELECT COUNT(*) as total_calls, SUM(CASE WHEN status='SCORED' THEN 1 ELSE 0 END) as scored, SUM(CASE WHEN flagged=1 THEN 1 ELSE 0 END) as flagged, SUM(CASE WHEN status IN ('NEW','REQC','WAIT_RETRY_FULL') THEN 1 ELSE 0 END) as queued, SUM(CASE WHEN status='ERROR' THEN 1 ELSE 0 END) as errors, SUM(CASE WHEN status='WAIT_TRANSCRIPT' THEN 1 ELSE 0 END) as missing_transcripts, ROUND(AVG(CASE WHEN status='SCORED' THEN overall_score_adj END),1) as avg_score, ROUND(AVG(CASE WHEN status='SCORED' THEN call_duration_sec END),0) as avg_duration, ROUND(AVG(CASE WHEN status='SCORED' THEN agent_talk_pct END),1) as avg_agent_talk, ROUND(AVG(CASE WHEN status='SCORED' THEN contact_talk_pct END),1) as avg_contact_talk FROM calls WHERE 1=1 ${df} ${rf}`, p);
    const repStats = await q(`SELECT rep_name, role, COUNT(*) as call_count, ROUND(AVG(overall_score_adj),1) as avg_score, ROUND(AVG(call_duration_sec),0) as avg_duration, ROUND(AVG(agent_talk_pct),1) as avg_agent_talk, SUM(CASE WHEN flagged=1 THEN 1 ELSE 0 END) as flagged_count FROM calls WHERE status='SCORED' ${df} ${rf} GROUP BY rep_name, role ORDER BY avg_score DESC`, p);
    res.json({ stats: stats.rows[0], repStats: repStats.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/queue/status', async (req, res) => {
  try {
    const dk = new Date().toISOString().slice(0, 10);
    const daily = await q('SELECT * FROM daily_counters WHERE date_key=?', [dk]);
    const queue = await q("SELECT status, COUNT(*) as count FROM calls WHERE status NOT IN ('SCORED','SKIP_SHORT','SKIP_VOICEMAIL') GROUP BY status");
    res.json({ daily: daily.rows[0] || { full_qc_used: 0, est_cost_usd: 0 }, queue: queue.rows, engine: process.env.AI_ENGINE || 'gemini' });
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

router.get('/reps', async (req, res) => {
  try { res.json((await q('SELECT * FROM rep_roster WHERE active=1 ORDER BY role,name')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/debug/webhooks', async (req, res) => {
  try { res.json((await q('SELECT id, received_at, src_tag, base_source, raw_payload FROM webhook_debug ORDER BY id DESC LIMIT 10')).rows); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/health', async (req, res) => {
  try {
    const h = await q("SELECT COUNT(*) as total, SUM(CASE WHEN status='WAIT_TRANSCRIPT' THEN 1 ELSE 0 END) as missing, SUM(CASE WHEN status='ERROR' THEN 1 ELSE 0 END) as errors, SUM(CASE WHEN status='SCORED' THEN 1 ELSE 0 END) as scored FROM calls");
    const r = h.rows[0]; const total = r.total || 1; const issues = (r.missing || 0) + (r.errors || 0);
    res.json({ healthScore: Math.round(((total - issues) / total) * 100), ...r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

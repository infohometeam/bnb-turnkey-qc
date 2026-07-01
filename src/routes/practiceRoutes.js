// ═══════════════════════════════════════════════════════════════
// Practice Routes — Stage 2 Trainer
// Endpoints for scenarios + live practice sessions.
// Mounted at /api/practice and /api/scenarios in index.js.
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const router = express.Router();
const { q } = require('../../migrations/run');
const { callConversation } = require('../services/ai');
const { buildProspectPrompt } = require('../services/prospect');
const { scorePracticeSession } = require('../workers/practiceScoring');

function now() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
const MAX_TURNS = 50;        // hard cap (mirrors call discipline + bounds cost)
const MAX_MINUTES = 25;

// ─── SCENARIOS ───────────────────────────────────────────────

// List active scenarios (optionally filter by role)
router.get('/scenarios', async (req, res) => {
  try {
    const role = req.query.role;
    let sql = 'SELECT * FROM scenarios WHERE active=1';
    const args = [];
    if (role && role !== 'ALL') { sql += ' AND (target_role=? OR target_role=?)'; args.push(role, 'Both'); }
    sql += ' ORDER BY difficulty_tier, title';
    const r = await q(sql, args);
    res.json({ scenarios: r.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get one scenario
router.get('/scenarios/:id', async (req, res) => {
  try {
    const r = await q('SELECT * FROM scenarios WHERE id=?', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Scenario not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Author a scenario (Sam/admin)
router.post('/scenarios', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.id || !b.title || !b.type) return res.status(400).json({ error: 'id, title, type required' });
    await q(`INSERT INTO scenarios (id,title,type,target_role,target_categories,target_beliefs,
      difficulty_tier,persona_json,situation_json,hidden_truth_json,layered_objections_json,
      scoring_focus_json,source_call_id,author,version,active)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, target_role=EXCLUDED.target_role,
        target_categories=EXCLUDED.target_categories, target_beliefs=EXCLUDED.target_beliefs,
        difficulty_tier=EXCLUDED.difficulty_tier, persona_json=EXCLUDED.persona_json,
        situation_json=EXCLUDED.situation_json, hidden_truth_json=EXCLUDED.hidden_truth_json,
        layered_objections_json=EXCLUDED.layered_objections_json, scoring_focus_json=EXCLUDED.scoring_focus_json,
        version=scenarios.version+1`,
      [b.id, b.title, b.type, b.target_role || 'Both',
       js(b.target_categories), js(b.target_beliefs), b.difficulty_tier || 3,
       js(b.persona), js(b.situation), js(b.hidden_truth), js(b.layered_objections),
       js(b.scoring_focus), b.source_call_id || null, b.author || 'Sam', 1]);
    res.json({ ok: true, id: b.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PRACTICE SESSIONS ───────────────────────────────────────

// Start a session: creates the row, returns scenario + opening
router.post('/start', express.json(), async (req, res) => {
  try {
    const { rep_name, scenario_id, difficulty_overrides } = req.body || {};
    if (!rep_name || !scenario_id) return res.status(400).json({ error: 'rep_name and scenario_id required' });
    const sc = await q('SELECT * FROM scenarios WHERE id=?', [scenario_id]);
    if (!sc.rows.length) return res.status(404).json({ error: 'Scenario not found' });
    const ts = now();
    const ins = await q(`INSERT INTO practice_sessions (rep_name,scenario_id,difficulty_overrides_json,
      messages_json,started_at,status) VALUES (?,?,?,?,?,'in_progress')`,
      [rep_name, scenario_id, js(difficulty_overrides), '[]', ts]);
    res.json({ ok: true, session_id: ins.lastInsertRowid, scenario: sc.rows[0], started_at: ts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send a rep turn -> get the prospect's reply (stays in character)
router.post('/:id/message', express.json(), async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    const sr = await q('SELECT * FROM practice_sessions WHERE id=?', [req.params.id]);
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sr.rows[0];
    if (session.status !== 'in_progress') return res.status(400).json({ error: 'Session already ended' });

    const sc = await q('SELECT * FROM scenarios WHERE id=?', [session.scenario_id]);
    const scenario = sc.rows[0];
    let msgs = safeArr(session.messages_json);

    // Hard caps
    const repTurns = msgs.filter(m => m.role === 'rep').length;
    if (repTurns >= MAX_TURNS) return res.json({ ended: true, reason: 'turn_cap', prospect: null });
    const elapsedMin = session.started_at ? (Date.now() - new Date(session.started_at).getTime()) / 60000 : 0;

    // Append rep turn
    msgs.push({ role: 'rep', text, ts: clock(session.started_at) });

    // Build conversation for Claude: prior turns mapped to user/assistant
    const convo = msgs.map(m => ({ role: m.role === 'rep' ? 'user' : 'assistant', content: m.text }));
    const systemPrompt = buildProspectPrompt(scenario, safeObj(session.difficulty_overrides_json));

    const { text: reply } = await callConversation(systemPrompt, convo, { maxTokens: 400 });
    msgs.push({ role: 'prospect', text: reply, ts: clock(session.started_at) });

    await q('UPDATE practice_sessions SET messages_json=? WHERE id=?', [JSON.stringify(msgs), session.id]);

    const hitCap = elapsedMin >= MAX_MINUTES;
    res.json({ ok: true, prospect: reply, turn: repTurns + 1, ended: hitCap, reason: hitCap ? 'time_cap' : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// End a session -> score it immediately (rep is waiting for the scorecard)
router.post('/:id/end', express.json(), async (req, res) => {
  try {
    const sr = await q('SELECT * FROM practice_sessions WHERE id=?', [req.params.id]);
    if (!sr.rows.length) return res.status(404).json({ error: 'Session not found' });
    const session = sr.rows[0];
    if (session.status === 'scored') {
      return res.json({ ok: true, already: true, session });
    }
    const ts = now();
    await q('UPDATE practice_sessions SET ended_at=? WHERE id=?', [ts, session.id]);
    session.ended_at = ts;

    const sc = await q('SELECT * FROM scenarios WHERE id=?', [session.scenario_id]);
    const scenario = sc.rows[0];
    const rubric = await q('SELECT * FROM rubric_items WHERE version=(SELECT MAX(version) FROM rubric_items) AND role=?',
      [scenario.target_role === 'Both' ? 'Closer' : scenario.target_role]);

    const result = await scorePracticeSession(session, scenario, rubric.rows);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── List ElevenLabs voices (so the team can choose one) ──
// MUST be before GET /:id (else "voices" is treated as a session id).
router.get('/voices', async (req, res) => {
  try {
    const key = req.headers['x-eleven-key'] || process.env.ELEVENLABS_API_KEY;
    if (!key) return res.json({ voices: [], configured: false });
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
    if (!r.ok) return res.status(502).json({ error: 'Could not fetch voices (check key)', voices: [] });
    const data = await r.json();
    const voices = (data.voices || []).map(v => ({ id: v.voice_id, name: v.name, labels: v.labels || {} }));
    res.json({ voices, configured: true });
  } catch (e) { res.status(500).json({ error: e.message, voices: [] }); }
});

// Get a session (with parsed scoring)
router.get('/:id', async (req, res) => {
  try {
    const r = await q('SELECT * FROM practice_sessions WHERE id=?', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Session not found' });
    res.json(parseSession(r.rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List sessions (optionally by rep) — for practice history + closed-loop charts
router.get('/', async (req, res) => {
  try {
    const rep = req.query.rep;
    let sql = 'SELECT * FROM practice_sessions';
    const args = [];
    if (rep && rep !== 'ALL') { sql += ' WHERE rep_name=?'; args.push(rep); }
    sql += ' ORDER BY id DESC LIMIT 100';
    const r = await q(sql, args);
    res.json({ sessions: r.rows.map(parseSession) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── helpers ─────────────────────────────────────────────────
function js(v) { return v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v)); }
function safeArr(v) { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }
function safeObj(v) { try { const o = JSON.parse(v); return o && typeof o === 'object' ? o : {}; } catch { return {}; } }
function clock(startedAt) {
  if (!startedAt) return '00:00';
  const s = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
function parseSession(s) {
  if (!s) return s;
  for (const k of ['category_scores', 'pass_fail', 'strengths', 'improvements', 'golden_moments', 'messages_json']) {
    try { s[k] = JSON.parse(s[k]); } catch { /* leave as-is */ }
  }
  return s;
}

// ─── Text-to-speech proxy (ElevenLabs) — gives the prospect a voice ──
// Keeps the API key server-side. Returns audio/mpeg the browser can play.
router.post('/tts', express.json(), async (req, res) => {
  try {
    const { text, voiceId } = req.body || {};
    if (!text) return res.status(400).json({ error: 'text required' });
    const key = req.headers['x-eleven-key'] || process.env.ELEVENLABS_API_KEY;
    if (!key) return res.status(503).json({ error: 'TTS not configured (missing ELEVENLABS_API_KEY)' });
    const vid = voiceId || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // default voice
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_turbo_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!r.ok) { const t = await r.text(); return res.status(502).json({ error: `TTS failed: ${t.slice(0, 200)}` }); }
    const buf = Buffer.from(await r.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

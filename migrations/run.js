// ═══════════════════════════════════════════════════════════════
// Database layer — Postgres (Supabase) via node-postgres (pg)
// Converted from Turso/libSQL. Public interface unchanged:
//   q(sql, args) -> { rows, lastInsertRowid }
//   migrate()    -> ensures schema exists (safe no-op if already built)
//   getClient()  -> the pg Pool
//
// KEY COMPAT SHIMS (so callers don't change):
//  1. `?` placeholders are auto-translated to `$1,$2,...`
//  2. INSERT statements auto-get `RETURNING id`, and the new id is
//     exposed as `res.lastInsertRowid` (matches old libSQL behavior)
//  3. pg already returns { rows: [...] }, matching libSQL result shape
// ═══════════════════════════════════════════════════════════════

const { Pool } = require('pg');
let _pool = null;

function getClient() {
  if (_pool) return _pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('MISSING_DATABASE_URL — set your Supabase Postgres connection string in env');
  }
  console.log('[DB] Connecting to Supabase (Postgres)');
  _pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  });
  _pool.on('error', (err) => console.error('[DB] idle client error:', err.message));
  return _pool;
}

// ─── Placeholder translator: `?` → `$1, $2, ...` ────────────────
function translatePlaceholders(sql) {
  let out = '';
  let n = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      if (inString && sql[i + 1] === "'") { out += "''"; i++; continue; }
      inString = !inString;
      out += ch;
    } else if (ch === '?' && !inString) {
      out += '$' + (++n);
    } else {
      out += ch;
    }
  }
  return out;
}

function isInsert(sql) { return /^\s*insert\s/i.test(sql); }
function alreadyReturning(sql) { return /returning\s/i.test(sql); }
// Upserts (ON CONFLICT) may take the UPDATE path and shouldn't force RETURNING id.
function hasOnConflict(sql) { return /on\s+conflict/i.test(sql); }
// Tables without an `id` column (PK is something else). daily_counters PK = date_key.
function insertsIntoIdlessTable(sql) { return /^\s*insert\s+into\s+daily_counters\b/i.test(sql); }

// ─── The universal query function (unchanged signature) ─────────
async function q(sql, args = []) {
  const pool = getClient();
  let text = translatePlaceholders(sql);

  let wantsId = false;
  if (isInsert(text) && !alreadyReturning(text) && !hasOnConflict(text) && !insertsIntoIdlessTable(text)) {
    text = text + ' RETURNING id';
    wantsId = true;
  }

  const res = await pool.query(text, args);
  let lastInsertRowid;
  if (wantsId && res.rows && res.rows.length) {
    lastInsertRowid = res.rows[0].id;
  }
  return { rows: res.rows || [], rowCount: res.rowCount, lastInsertRowid };
}

// ─── Schema (Postgres). Safe to run repeatedly. ────────────────
async function migrate() {
  const stmts = [
    `CREATE TABLE IF NOT EXISTS rep_roster (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name text NOT NULL, role text NOT NULL, team text NOT NULL,
      src_tag text, aloware_user_id text,
      color text DEFAULT '#6366f1', active integer DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS rubric_items (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      version integer DEFAULT 1, role text NOT NULL, category text NOT NULL,
      weight integer DEFAULT 20, good text NOT NULL, bad text NOT NULL,
      score_10 text, score_5 text, score_1 text)`,
    `CREATE TABLE IF NOT EXISTS calls (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      received_at text, source text, base_source text, src_tag text,
      rep_name text, rep_id integer, role text, team text, client_name text,
      call_url text, audio_url text, external_call_key text UNIQUE,
      transcript text, transcript_chars integer DEFAULT 0, transcript_slice text,
      call_duration_sec integer, agent_talk_pct real, contact_talk_pct real,
      overall_score real, overall_score_adj real, score_adjust_notes text,
      category_scores text, pass_fail text, coaching_notes text, quick_summary text,
      strengths text, improvements text, next_step_text text, golden_moments text,
      status text DEFAULT 'NEW', flagged integer DEFAULT 0, error text DEFAULT '',
      retry_count integer DEFAULT 0, queued_at text, last_tried_at text,
      processed_at text, model_used text, rubric_version integer DEFAULT 1,
      weekstart text, created_at text)`,
    `CREATE TABLE IF NOT EXISTS webhook_debug (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      received_at text, src_tag text, base_source text, raw_payload text)`,
    `CREATE TABLE IF NOT EXISTS daily_counters (
      date_key text PRIMARY KEY, full_qc_used integer DEFAULT 0,
      est_cost_usd real DEFAULT 0, updated_at text)`,
    `CREATE TABLE IF NOT EXISTS score_overrides (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      call_id integer, override_by text DEFAULT 'Sam',
      original_score real, override_score real, reason text, created_at text)`,
    `CREATE TABLE IF NOT EXISTS score_history (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      call_id integer NOT NULL, snapshot_at text NOT NULL, rubric_version integer NOT NULL,
      overall_score real, overall_score_adj real, category_scores text, pass_fail text,
      score_adjust_notes text, quick_summary text, coaching_notes text,
      strengths text, improvements text, model_used text,
      CONSTRAINT fk_score_history_call_id_calls_id_fk
        FOREIGN KEY (call_id) REFERENCES calls(id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status)`,
    `CREATE INDEX IF NOT EXISTS idx_calls_rep ON calls(rep_name)`,
    `CREATE INDEX IF NOT EXISTS idx_calls_received ON calls(received_at)`,
    `CREATE INDEX IF NOT EXISTS idx_calls_extkey ON calls(external_call_key)`,
    `CREATE INDEX IF NOT EXISTS idx_score_history_version ON score_history(rubric_version)`,
    `CREATE INDEX IF NOT EXISTS idx_score_history_call ON score_history(call_id)`,
    // Call stitching: link cut-off calls that were merged into one.
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS stitched_into_id integer`,
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS stitched_from_ids text`,
    `ALTER TABLE calls ADD COLUMN IF NOT EXISTS stitch_status text`,
    `CREATE INDEX IF NOT EXISTS idx_calls_stitch ON calls(stitch_status)`,
  ];
  for (const sql of stmts) await q(sql);

  const rr = await q('SELECT COUNT(*)::int AS c FROM rep_roster');
  if (rr.rows[0].c === 0) {
    const reps = [
      ['Matt','Closer','Turnkey - Closers','fathom-closers-1',null,'#6366f1'],
      ['Kevin','Closer','Turnkey - Closers','fathom-closers-2',null,'#8b5cf6'],
      ['Andrew Cluney','Setter','Turnkey - Setters','aloware-setters','95724','#10b981'],
      ['Steven Arnita','Setter','Turnkey - Setters','aloware-setters','111657','#f59e0b'],
      ['Anurag Shriv','Setter','Turnkey - Setters','aloware-setters','112769','#0ea5e9'],
    ];
    for (const [n,r,t,s,aid,cl] of reps) {
      await q('INSERT INTO rep_roster (name,role,team,src_tag,aloware_user_id,color) VALUES (?,?,?,?,?,?)', [n,r,t,s,aid,cl]);
    }
  }

  const rc = await q('SELECT COUNT(*)::int AS c FROM rubric_items');
  if (rc.rows[0].c === 0) {
    const items = [
      [1,'Setter','discovery',20,'Client speaks 35%+ and rep asks about investment goals, timeline, markets, STR experience, budget before pitching','Rep talks 70%+, monologues, pitches within first 2 minutes','Rep opens with curiosity about portfolio, STR interest, timeline, cost seg experience, target returns. Client speaks 40%+.','Asks budget/timeline but skips goals or experience. Client 25-35%.','Pitches within 90 seconds. No investor questions. Client barely speaks.'],
      [1,'Setter','qualification',30,'Confirms investor fit: income, timeline, budget $300K-$800K+, understands passive model','No fit checks; assumes budget/fit','Confirms income, timeline, budget, hands-off model via Home Team. Disqualifies poor fits.','Confirms budget but not timeline. Assumes fit.','No qualification. Books closer for anyone.'],
      [1,'Setter','pitch',15,'Sets expectations for closer call: three-phase process, Home Team management','Overpromises, vague, tries to close','Overview of 3 phases. Sets realistic expectations. Mentions 300+ properties.','Mentions BNB Turnkey but vague about closer agenda.','Says nothing about expectations OR overpromises.'],
      [1,'Setter','objections',15,'Handles pushback calmly with proof points','Dismisses, argues, panics','Acknowledges, normalizes, provides evidence re: rates/cost seg.','Generic responses. Flustered by hard questions.','Ignores or dismisses. Gets defensive.'],
      [1,'Setter','close_next_step',20,'Books closer call: date/time, prep instructions, calendar invite','No firm next step','Specific date/time, who theyll speak with, what to prepare, invite in 5 min.','Books but no prep instructions or vague timing.','Ends with well be in touch. No date or action.'],
      [1,'Closer','discovery',20,'Deep discovery referencing setter notes: goals, pain, finances, timeline, markets','Surface-level, no setter reference, jumps to pitch','References setter call then goes deeper. Client speaks 40-60%.','Some discovery but doesnt build on setter call. Checklist feel.','Skips discovery. 20-min pitch. Client <20% talk.'],
      [1,'Closer','qualification',20,'Validates budget, financing, timeline, full scope including fees','Assumes fit from setter notes','Reconfirms budget, financing method, total investment scope, fee structure.','Confirms budget but not total scope or fees.','No qualification. Wrong property size. Surprise costs.'],
      [1,'Closer','pitch',25,'Full three-phase walkthrough tailored to goals, social proof','Confusing/incomplete','All 3 phases customized. Market data, timeline, projections. 300+ properties. Relevant proof.','Generic process explanation. Missing details. Scripted.','Fumbles. Conflicting info. Investor confused.'],
      [1,'Closer','objections',15,'Addresses concerns with clarity, empathy, data','Avoids, dismissive, crumbles','Acknowledges, validates, data response. Handles 2-3 objections composedly.','Handles easy ones. Vague on hard questions.','Ignores. Says trust me. Gets defensive.'],
      [1,'Closer','close_next_step',20,'Clear commitment with date, assumptive close','No commitment, vague follow-up','Asks for commitment with specific date. Creates urgency.','Suggests steps but no commitment ask.','Let me know what you think. No date. No urgency.'],
    ];
    for (const [v,r,cat,w,g,b,s10,s5,s1] of items) {
      await q('INSERT INTO rubric_items (version,role,category,weight,good,bad,score_10,score_5,score_1) VALUES (?,?,?,?,?,?,?,?,?)', [v,r,cat,w,g,b,s10,s5,s1]);
    }
  }
  console.log('[DB] Migration complete ✓ (Postgres)');
}

module.exports = { q, migrate, getClient };
if (require.main === module) migrate().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

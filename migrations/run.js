const { createClient } = require('@libsql/client');
let _client = null;

function getClient() {
  if (_client) return _client;
  if (process.env.TURSO_URL) {
    console.log('[DB] Connecting to Turso (persistent)');
    _client = createClient({ url: process.env.TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  } else {
    console.log('[DB] Using local SQLite (ephemeral)');
    const path = require('path'), fs = require('fs');
    const dir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _client = createClient({ url: 'file:' + path.join(dir, 'qc.db') });
  }
  return _client;
}

async function q(sql, args = []) { return getClient().execute({ sql, args }); }

async function migrate() {
  const c = getClient();
  const stmts = [
    "CREATE TABLE IF NOT EXISTS rep_roster (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, role TEXT NOT NULL, team TEXT NOT NULL, src_tag TEXT UNIQUE, color TEXT DEFAULT '#6366f1', active INTEGER DEFAULT 1)",
    "CREATE TABLE IF NOT EXISTS rubric_items (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER DEFAULT 1, role TEXT NOT NULL, category TEXT NOT NULL, weight INTEGER DEFAULT 20, good TEXT NOT NULL, bad TEXT NOT NULL, score_10 TEXT, score_5 TEXT, score_1 TEXT)",
    "CREATE TABLE IF NOT EXISTS calls (id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT, source TEXT, base_source TEXT, src_tag TEXT, rep_name TEXT, rep_id INTEGER, role TEXT, team TEXT, client_name TEXT, call_url TEXT, audio_url TEXT, external_call_key TEXT UNIQUE, transcript TEXT, transcript_chars INTEGER DEFAULT 0, transcript_slice TEXT, call_duration_sec INTEGER, agent_talk_pct REAL, contact_talk_pct REAL, overall_score REAL, overall_score_adj REAL, score_adjust_notes TEXT, category_scores TEXT, pass_fail TEXT, coaching_notes TEXT, quick_summary TEXT, strengths TEXT, improvements TEXT, next_step_text TEXT, golden_moments TEXT, status TEXT DEFAULT 'NEW', flagged INTEGER DEFAULT 0, error TEXT DEFAULT '', retry_count INTEGER DEFAULT 0, queued_at TEXT, last_tried_at TEXT, processed_at TEXT, model_used TEXT, rubric_version INTEGER DEFAULT 1, weekstart TEXT, created_at TEXT)",
    "CREATE TABLE IF NOT EXISTS webhook_debug (id INTEGER PRIMARY KEY AUTOINCREMENT, received_at TEXT, src_tag TEXT, base_source TEXT, raw_payload TEXT)",
    "CREATE TABLE IF NOT EXISTS daily_counters (date_key TEXT PRIMARY KEY, full_qc_used INTEGER DEFAULT 0, est_cost_usd REAL DEFAULT 0, updated_at TEXT)",
    "CREATE TABLE IF NOT EXISTS score_overrides (id INTEGER PRIMARY KEY AUTOINCREMENT, call_id INTEGER, override_by TEXT DEFAULT 'Sam', original_score REAL, override_score REAL, reason TEXT, created_at TEXT)",
    "CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status)",
    "CREATE INDEX IF NOT EXISTS idx_calls_rep ON calls(rep_name)",
    "CREATE INDEX IF NOT EXISTS idx_calls_received ON calls(received_at)",
    "CREATE INDEX IF NOT EXISTS idx_calls_extkey ON calls(external_call_key)",
  ];
  for (const sql of stmts) await c.execute(sql);

  // Seed reps
  for (const [n,r,t,s,cl] of [['Matt','Closer','Turnkey - Closers','fathom-closers-1','#6366f1'],['Kevin','Closer','Turnkey - Closers','fathom-closers-2','#8b5cf6'],['Andrew','Setter','Turnkey - Setters','aloware-setters','#06b6d4'],['Steven','Setter','Turnkey - Setters','aloware-setters-2','#10b981'],['Anurag','Setter','Turnkey - Setters','aloware-setters-3','#f59e0b']]) {
    await c.execute({ sql: 'INSERT OR IGNORE INTO rep_roster (name,role,team,src_tag,color) VALUES (?,?,?,?,?)', args: [n,r,t,s,cl] });
  }

  // Seed rubric
  const rc = await c.execute('SELECT COUNT(*) as c FROM rubric_items');
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
      await c.execute({ sql: 'INSERT INTO rubric_items (version,role,category,weight,good,bad,score_10,score_5,score_1) VALUES (?,?,?,?,?,?,?,?,?)', args: [v,r,cat,w,g,b,s10,s5,s1] });
    }
  }
  console.log('[DB] Migration complete ✓');
}

module.exports = { q, migrate, getClient };
if (require.main === module) migrate().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

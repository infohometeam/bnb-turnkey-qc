const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'qc.db');

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function migrate() {
  ensureDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS rep_roster (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('Setter','Closer')),
      team TEXT NOT NULL,
      src_tag TEXT UNIQUE,
      color TEXT DEFAULT '#6366f1',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS rubric_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER DEFAULT 1,
      role TEXT NOT NULL,
      category TEXT NOT NULL,
      weight INTEGER DEFAULT 20,
      good TEXT NOT NULL,
      bad TEXT NOT NULL,
      score_10 TEXT,
      score_5 TEXT,
      score_1 TEXT
    );

    CREATE TABLE IF NOT EXISTS gold_examples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      example_type TEXT,
      notes TEXT,
      transcript_excerpt TEXT,
      target_score REAL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT DEFAULT (datetime('now')),
      source TEXT,
      base_source TEXT,
      src_tag TEXT,
      rep_name TEXT,
      rep_id INTEGER REFERENCES rep_roster(id),
      role TEXT,
      team TEXT,
      client_name TEXT,
      call_url TEXT,
      audio_url TEXT,
      external_call_key TEXT UNIQUE,
      transcript TEXT,
      transcript_chars INTEGER DEFAULT 0,
      transcript_slice TEXT,
      call_duration_sec INTEGER,
      agent_talk_pct REAL,
      contact_talk_pct REAL,
      overall_score REAL,
      overall_score_adj REAL,
      score_adjust_notes TEXT,
      category_scores TEXT,
      pass_fail TEXT,
      coaching_notes TEXT,
      quick_summary TEXT,
      strengths TEXT,
      improvements TEXT,
      next_step_text TEXT,
      golden_moments TEXT,
      status TEXT DEFAULT 'NEW',
      flagged INTEGER DEFAULT 0,
      error TEXT DEFAULT '',
      retry_count INTEGER DEFAULT 0,
      queued_at TEXT,
      last_tried_at TEXT,
      processed_at TEXT,
      model_used TEXT,
      rubric_version INTEGER DEFAULT 1,
      weekstart TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS webhook_debug (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT DEFAULT (datetime('now')),
      src_tag TEXT,
      base_source TEXT,
      raw_payload TEXT,
      processed INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS daily_counters (
      date_key TEXT PRIMARY KEY,
      full_qc_used INTEGER DEFAULT 0,
      est_cost_usd REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS score_overrides (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      call_id INTEGER REFERENCES calls(id),
      override_by TEXT DEFAULT 'Sam',
      original_score REAL,
      override_score REAL,
      reason TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_calls_status ON calls(status);
    CREATE INDEX IF NOT EXISTS idx_calls_rep ON calls(rep_name);
    CREATE INDEX IF NOT EXISTS idx_calls_received ON calls(received_at);
    CREATE INDEX IF NOT EXISTS idx_calls_extkey ON calls(external_call_key);
    CREATE INDEX IF NOT EXISTS idx_calls_flagged ON calls(flagged);
  `);

  // Seed reps (Closers on Fathom, Setters on shared Aloware)
  const insertRep = db.prepare('INSERT OR IGNORE INTO rep_roster (name,role,team,src_tag,color) VALUES (?,?,?,?,?)');
  insertRep.run('Matt','Closer','Turnkey - Closers','fathom-closers-1','#6366f1');
  insertRep.run('Kevin','Closer','Turnkey - Closers','fathom-closers-2','#8b5cf6');
  insertRep.run('Andrew','Setter','Turnkey - Setters','aloware-setters','#06b6d4');
  insertRep.run('Steven','Setter','Turnkey - Setters','aloware-setters-2','#10b981');
  insertRep.run('Anurag','Setter','Turnkey - Setters','aloware-setters-3','#f59e0b');

  // Seed rubric v1
  const hasRubric = db.prepare('SELECT COUNT(*) as c FROM rubric_items').get();
  if (hasRubric.c === 0) {
    const ins = db.prepare('INSERT INTO rubric_items (version,role,category,weight,good,bad,score_10,score_5,score_1) VALUES (?,?,?,?,?,?,?,?,?)');

    // ── SETTER RUBRIC ──
    ins.run(1,'Setter','discovery',20,
      'Client speaks 35%+ and rep asks about investment goals, timeline, markets, STR experience, budget before pitching',
      'Rep talks 70%+, monologues, pitches BNB Turnkey within first 2 minutes',
      'Rep opens with curiosity — asks about current portfolio, what drew them to STRs, timeline, cost segregation experience, target returns. Client speaks 40%+ during discovery.',
      'Rep asks about budget and timeline but skips goals, market preferences, or experience. Client speaks 25-35%.',
      'Rep pitches within 90 seconds. No questions about investor background. Client barely speaks.');

    ins.run(1,'Setter','qualification',30,
      'Confirms investor fit: income/accreditation, realistic timeline, budget aligns with $300K-$800K+ STR range, understands passive model',
      'No fit checks; assumes budget/fit without asking',
      'Explicitly confirms income level, timeline, budget range, understanding of hands-off model managed by Home Team. Disqualifies poor fits respectfully.',
      'Confirms budget but not timeline or experience. Assumes fit without explicit confirmation.',
      'No qualification. Books closer call for anyone regardless of fit.');

    ins.run(1,'Setter','pitch',15,
      'Sets clear expectations for closer call: three-phase BNB Turnkey process, Home Team management, what investor can expect',
      'Overpromises returns, vague about next steps, tries to close instead of booking closer',
      'Concise overview of three phases (sourcing, design/build, management by Home Team). Sets realistic expectations. Mentions 300+ properties under management.',
      'Mentions BNB Turnkey but vague about closer call agenda. Generic rather than tailored.',
      'Says nothing about what to expect OR massively overpromises. Wrong expectations set.');

    ins.run(1,'Setter','objections',15,
      'Handles pushback about cost, timing, risk calmly with relevant proof points',
      'Dismisses concerns, argues, panics, offers unauthorized promises',
      'Acknowledges concern, normalizes it, provides evidence. Example: addresses rate concerns with cost segregation benefits.',
      'Addresses easy objections but struggles with harder questions. Generic reassurances.',
      'Ignores or dismisses objections. Gets defensive. Makes promises they cannot keep.');

    ins.run(1,'Setter','close_next_step',20,
      'Books closer call with specific date/time, tells investor what to prepare, sends calendar invite',
      'Ends without firm next step or books vague follow-up',
      'Books specific call: date, time, who theyll speak with (Matt/Kevin). Tells them what to prepare. Calendar invite within 5 minutes.',
      'Books call but no prep instructions. Or vague: someone will reach out this week.',
      'Call ends with well be in touch. No date, no action items, no calendar invite.');

    // ── CLOSER RUBRIC ──
    ins.run(1,'Closer','discovery',20,
      'Deep discovery: goals, pain points, finances, timeline, market preferences, STR experience. References setter call notes.',
      'Surface-level only, doesnt build on setter intel, jumps to pitch',
      'References setter call, then goes deeper on portfolio goals, target returns, hands-on preference, 1031/cost seg experience, decision factors. Client speaks 40-60% during discovery.',
      'Some discovery but doesnt build on setter call. Covers budget/timeline but misses motivations. Feels like a checklist.',
      'Skips discovery or asks one question then launches into 20-minute pitch. Client speaks less than 20% in first half.');

    ins.run(1,'Closer','qualification',20,
      'Validates budget ($300K-$800K+), financing readiness, timeline, full investment scope including closing costs and management fees',
      'Assumes fit from setter notes without reconfirming; doesnt discuss full financial picture',
      'Reconfirms and deepens: budget accuracy, financing method (conventional vs BNB Lending), total investment scope (property + closing + furnishing + reserves), management fee structure.',
      'Confirms property budget but not total scope. Doesnt mention fees until asked. Over-relies on setter notes.',
      'No qualification. Pitches wrong-sized property. Doesnt confirm financing. Prospect blindsided by costs.');

    ins.run(1,'Closer','pitch',25,
      'Full three-phase walkthrough tailored to investors goals. Covers sourcing (market data), design/build (timeline), management (Home Team, booking projections). Uses social proof.',
      'Confusing/incomplete pitch, investor unclear about what they get and costs',
      'Walks through all three phases customized to investor. Covers market data, timeline, revenue projections. Mentions Home Team manages 300+ luxury properties. Social proof relevant to situation.',
      'Explains process generically. Misses key details like timeline, fees, or how projections work. Feels scripted.',
      'Fumbles explanation. Conflicting info on costs/timeline. Investor leaves confused about what BNB Turnkey does.');

    ins.run(1,'Closer','objections',15,
      'Addresses market, financing, competition, timeline, returns, fees concerns with clarity, empathy, and data',
      'Avoids objections, dismissive, crumbles under pressure',
      'Acknowledges, validates, responds with data. Example: addresses rate concerns with cost seg specifics for their tax bracket. Handles 2-3 objections without losing composure.',
      'Handles easy objections, struggles with harder ones. Vague reassurances instead of data. Handles 1 well, deflects others.',
      'Ignores objections, says trust me, gets defensive on fees/returns. Investor feels unheard.');

    ins.run(1,'Closer','close_next_step',20,
      'Clear commitment: signed agreement, deposit, or concrete step with date. Uses assumptive or alternative close.',
      'Call ends without commitment or vague follow-up',
      'Asks for commitment: send agreement now or review by specific date. Sets decision timeline regardless of answer. Creates appropriate urgency.',
      'Suggests next steps but doesnt ask for commitment. Ill send info with no follow-up date. Or follow-up call without decision tie.',
      'Call ends with let me know what you think. No commitment ask. No date. No urgency.');
  }

  db.close();
  console.log('Database migrated successfully at', DB_PATH);
}

function getDb() {
  ensureDir();
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

module.exports = { migrate, getDb, DB_PATH };

// Run directly
if (require.main === module) migrate();

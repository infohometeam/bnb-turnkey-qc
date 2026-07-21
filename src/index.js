require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cron = require('node-cron');
const path = require('path');

const apiRoutes = require('./routes/api');
const { processQueue, unpauseDailyRows, sweepStuckTranscripts } = require('./workers/qcWorker');
const { migrate } = require('../migrations/run');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(morgan('short'));
app.use(express.json({ limit: '5mb' }));

app.use('/api', apiRoutes);
app.use('/api/practice', require('./routes/practiceRoutes'));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok', service: 'BNB Turnkey QC', company: 'The Rise Collective',
    engine: process.env.AI_ENGINE || 'gemini', version: '1.1.0',
    db: process.env.DATABASE_URL ? 'supabase (postgres)' : 'NOT CONFIGURED',
    uptime: Math.round(process.uptime()), timestamp: new Date().toISOString(),
  });
});

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Process queue every 2 minutes
cron.schedule('*/2 * * * *', async () => {
  try { const r = await processQueue(3); if (r.processed > 0) console.log(`[Cron] ${r.processed}/${r.total} scored`); }
  catch (e) { console.error('[Cron]', e.message); }
});

// Daily reset at midnight
cron.schedule('0 0 * * *', async () => { try { await unpauseDailyRows(); } catch(e) {} });

// Hourly: flag transcripts that never arrived (prevents silent WAIT_TRANSCRIPT pile-up)
cron.schedule('15 * * * *', async () => {
  try { const r = await sweepStuckTranscripts(4); if (r.swept > 0) console.log(`[Cron] Flagged ${r.swept} stuck transcript(s)`); }
  catch (e) { console.error('[Cron sweep]', e.message); }
});

// Morning: post yesterday's QC digest to Slack at 8:00 AM US Eastern (DST-aware).
// Skips silently if yesterday had no scored calls, so we never spam an empty post.
cron.schedule('0 8 * * *', async () => {
  try {
    const { sendDailyDigest } = require('./services/slackService');
    const r = await sendDailyDigest({ preset: 'yesterday' });
    if (r.posted) console.log(`[Slack] Daily digest posted (${r.calls} calls, ${r.window})`);
    else console.log(`[Slack] Digest not posted: ${r.reason}`);
  } catch (e) { console.error('[Slack cron]', e.message); }
}, { timezone: 'America/New_York' });

// Morning: post yesterday's bot-usage summary to the activity channel at 8:30 AM ET.
// Skips silently if there was no activity (never posts an empty summary).
cron.schedule('30 8 * * *', async () => {
  try {
    const { sendUsageSummary } = require('./services/slackService');
    const r = await sendUsageSummary({ preset: 'yesterday' });
    if (r.posted) console.log(`[Slack] Usage summary posted (${r.opens} opens, ${r.visitors} visitors)`);
    else console.log(`[Slack] Usage summary not posted: ${r.reason}`);
  } catch (e) { console.error('[Slack usage cron]', e.message); }
}, { timezone: 'America/New_York' });

// Start: migrate then listen
async function start() {
  try {
    await migrate();
    // Load any custom deduction weights before scoring begins.
    try {
      const { loadDeductWeights } = require('./workers/qcWorker');
      const w = await loadDeductWeights();
      console.log('[Deduct] weights:', JSON.stringify(w));
    } catch (e) { console.error('[Deduct] load failed, using defaults:', e.message); }
    app.listen(PORT, () => {
      console.log('');
      console.log('  ╔═════════════════════════════════════════════════╗');
      console.log('  ║   BNB Turnkey QC — The Rise Collective          ║');
      console.log(`  ║   Port: ${PORT} | Engine: ${(process.env.AI_ENGINE||'gemini').toUpperCase().padEnd(23)}║`);
      console.log(`  ║   DB: ${process.env.DATABASE_URL ? 'Supabase (Postgres)' : 'NOT CONFIGURED'}`.padEnd(52) + '║');
      console.log('  ╚═════════════════════════════════════════════════╝');
      console.log(`\n  Dashboard: http://localhost:${PORT}`);
      console.log(`  Health:    http://localhost:${PORT}/health\n`);
    });
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

start();
module.exports = app;

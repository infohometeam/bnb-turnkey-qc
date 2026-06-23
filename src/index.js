require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const cron = require('node-cron');
const path = require('path');

const apiRoutes = require('./routes/api');
const { processQueue, unpauseDailyRows } = require('./workers/qcWorker');
const { migrate } = require('../migrations/run');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(morgan('short'));
app.use(express.json({ limit: '5mb' }));

app.use('/api', apiRoutes);

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

// Start: migrate then listen
async function start() {
  try {
    await migrate();
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

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

// Auto-migrate on start
migrate();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors());
app.use(morgan('short'));
app.use(express.json({ limit: '5mb' }));

// API
app.use('/api', apiRoutes);

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok', service: 'BNB Turnkey QC', company: 'The Rise Collective',
    engine: process.env.AI_ENGINE || 'gemini', version: '1.0.0',
    uptime: Math.round(process.uptime()), timestamp: new Date().toISOString(),
  });
});

// Serve frontend (React build or static HTML)
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// Cron: process queue every 2 minutes
cron.schedule('*/2 * * * *', async () => {
  try {
    const r = await processQueue(3);
    if (r.processed > 0) console.log(`[Cron] Processed ${r.processed}/${r.total}`);
  } catch (e) { console.error('[Cron]', e.message); }
});

// Cron: daily reset at midnight
cron.schedule('0 0 * * *', () => { try { unpauseDailyRows(); } catch(e) {} });

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔═════════════════════════════════════════════════╗');
  console.log('  ║   BNB Turnkey QC — The Rise Collective          ║');
  console.log(`  ║   Port: ${PORT} | Engine: ${(process.env.AI_ENGINE||'gemini').toUpperCase().padEnd(23)}║`);
  console.log('  ║   Zero-Cost Edition                             ║');
  console.log('  ╚═════════════════════════════════════════════════╝');
  console.log(`\n  Dashboard: http://localhost:${PORT}`);
  console.log(`  Webhook:   http://localhost:${PORT}/api/webhook?src=xxx&key=xxx`);
  console.log(`  Health:    http://localhost:${PORT}/health\n`);
});

module.exports = app;

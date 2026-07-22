// Admin login — the only auth surface. See src/services/auth.js for the design
// note on why this is deliberately NOT the full multi-user system.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { sign, verify, tokenFromReq, TTL_MS } = require('../services/auth');

router.post('/login', express.json(), (req, res) => {
  try {
    const { password } = req.body || {};
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) return res.status(500).json({ error: 'ADMIN_PASSWORD not configured on the server.' });
    const a = Buffer.from(String(password || ''));
    const b = Buffer.from(expected);
    // Timing-safe comparison — buffers must be equal length first, or
    // timingSafeEqual itself throws instead of just returning false.
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!match) return res.status(401).json({ error: 'Incorrect password.' });
    const exp = Date.now() + TTL_MS;
    const token = sign({ role: 'admin', exp });
    res.json({ ok: true, token, expires_at: new Date(exp).toISOString() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lets the frontend check whether a stored token is still valid (e.g. on page
// load) without needing to hit a mutating endpoint just to find out.
router.get('/status', (req, res) => {
  const data = verify(tokenFromReq(req));
  res.json({ admin: !!data });
});

module.exports = router;

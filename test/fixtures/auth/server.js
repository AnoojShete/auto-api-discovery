const express = require('express');

const app = express();
app.use(express.json());

const SESSIONS = new Map();

function getSessionId(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/session=([^;]+)/);
  return match ? match[1] : null;
}

app.post('/login', (req, res) => {
  const username = req.body?.username || 'user';
  const token = `sess_${Date.now()}`;
  SESSIONS.set(token, { username });
  res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly`);
  res.json({ ok: true, username });
});

app.get('/me', (req, res) => {
  const sessionId = getSessionId(req);
  if (!sessionId || !SESSIONS.has(sessionId)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  res.json({ username: SESSIONS.get(sessionId).username });
});

app.post('/logout', (req, res) => {
  const sessionId = getSessionId(req);
  if (sessionId) SESSIONS.delete(sessionId);
  res.setHeader('Set-Cookie', 'session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

const port = Number(process.env.PORT || 4003);
app.listen(port, () => {
  console.log(`[auth] listening on http://localhost:${port}`);
});

const express = require('express');

const app = express();
app.use(express.json());

let users = [
  { id: 1, name: 'Ada' },
  { id: 2, name: 'Grace' },
];

app.get('/users', (req, res) => {
  res.json({ data: users });
});

app.get('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = users.find(u => u.id === id);
  if (!user) return res.status(404).json({ error: 'not_found' });
  res.json(user);
});

app.post('/users', (req, res) => {
  const nextId = users.length ? Math.max(...users.map(u => u.id)) + 1 : 1;
  const user = { id: nextId, name: req.body?.name || 'User' };
  users.push(user);
  res.status(201).json(user);
});

app.put('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  const index = users.findIndex(u => u.id === id);
  if (index === -1) return res.status(404).json({ error: 'not_found' });
  users[index] = { ...users[index], name: req.body?.name || users[index].name };
  res.json(users[index]);
});

app.delete('/users/:id', (req, res) => {
  const id = Number(req.params.id);
  users = users.filter(u => u.id !== id);
  res.status(204).send();
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`[rest] listening on http://localhost:${port}`);
});

const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token ? auth.verifyToken(token) : null;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = userId;
  next();
}

function taskRowToObj(row) {
  return {
    id: row.id,
    text: row.text,
    dueDate: row.due_date || '',
    courseId: row.course_id || '',
    category: row.category || '',
    done: !!row.done,
    parentId: row.parent_id || '',
  };
}

app.post('/api/auth/register', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const result = auth.register(email, password);
    res.json({ user: { id: result.id, email: result.email }, token: result.token });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const result = auth.login(email, password);
    res.json({ user: { id: result.id, email: result.email }, token: result.token });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

app.get('/api/courses', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT id, name, description FROM courses WHERE user_id = ?').all(req.userId);
  res.json(rows);
});

app.post('/api/courses', authMiddleware, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = auth.genId();
  db.prepare('INSERT INTO courses (id, user_id, name, description) VALUES (?, ?, ?, ?)').run(id, req.userId, name, description || '');
  res.json({ id, name, description: description || '' });
});

app.put('/api/courses/:id', authMiddleware, (req, res) => {
  const { name, description } = req.body;
  const r = db.prepare('UPDATE courses SET name = ?, description = ? WHERE id = ? AND user_id = ?').run(name || '', description || '', req.params.id, req.userId);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

app.delete('/api/courses/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM courses WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  db.prepare('UPDATE tasks SET course_id = ? WHERE course_id = ? AND user_id = ?').run('', req.params.id, req.userId);
  res.json({ ok: true });
});

app.get('/api/tags', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT id, name, color FROM tags WHERE user_id = ?').all(req.userId);
  res.json(rows);
});

app.post('/api/tags', authMiddleware, (req, res) => {
  const { name, color } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const existing = db.prepare('SELECT id FROM tags WHERE user_id = ? AND LOWER(name) = LOWER(?)').get(req.userId, name);
  if (existing) return res.status(400).json({ error: 'Tag already exists' });
  const id = auth.genId();
  db.prepare('INSERT INTO tags (id, user_id, name, color) VALUES (?, ?, ?, ?)').run(id, req.userId, name, color || '#4a90d9');
  res.json({ id, name, color: color || '#4a90d9' });
});

app.put('/api/tags/:id', authMiddleware, (req, res) => {
  const { name, color } = req.body;
  const old = db.prepare('SELECT name FROM tags WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!old) return res.status(404).json({ error: 'Not found' });
  if (name !== undefined) db.prepare('UPDATE tags SET name = ? WHERE id = ? AND user_id = ?').run(name, req.params.id, req.userId);
  if (color !== undefined) db.prepare('UPDATE tags SET color = ? WHERE id = ? AND user_id = ?').run(color, req.params.id, req.userId);
  if (name !== undefined && name !== old.name) db.prepare('UPDATE tasks SET category = ? WHERE category = ? AND user_id = ?').run(name, old.name, req.userId);
  res.json({ ok: true });
});

app.delete('/api/tags/:id', authMiddleware, (req, res) => {
  const tag = db.prepare('SELECT name FROM tags WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (tag) {
    db.prepare('DELETE FROM tags WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
    db.prepare('UPDATE tasks SET category = ? WHERE category = ? AND user_id = ?').run('', tag.name, req.userId);
  }
  res.json({ ok: true });
});

app.get('/api/tasks', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT id, text, due_date, course_id, category, done, parent_id FROM tasks WHERE user_id = ?').all(req.userId);
  res.json(rows.map(taskRowToObj));
});

app.get('/api/data', authMiddleware, (req, res) => {
  const courses = db.prepare('SELECT id, name, description FROM courses WHERE user_id = ?').all(req.userId);
  const tags = db.prepare('SELECT id, name, color FROM tags WHERE user_id = ?').all(req.userId);
  const taskRows = db.prepare('SELECT id, text, due_date, course_id, category, done, parent_id FROM tasks WHERE user_id = ?').all(req.userId);
  const tasks = taskRows.map(taskRowToObj);
  res.json({ courses, tags, tasks });
});

app.post('/api/tasks', authMiddleware, (req, res) => {
  const { text, dueDate, courseId, category, done, parentId } = req.body;
  if (!text) return res.status(400).json({ error: 'Text required' });
  const id = auth.genId();
  db.prepare('INSERT INTO tasks (id, user_id, text, due_date, course_id, category, done, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, req.userId, text, dueDate || null, courseId || '', category || '', done ? 1 : 0, parentId || null
  );
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  res.json(taskRowToObj(row));
});

app.put('/api/tasks/:id', authMiddleware, (req, res) => {
  const { text, dueDate, courseId, category, done, parentId } = req.body;
  const r = db.prepare('UPDATE tasks SET text = COALESCE(?, text), due_date = ?, course_id = COALESCE(?, course_id), category = COALESCE(?, category), done = COALESCE(?, done), parent_id = ? WHERE id = ? AND user_id = ?').run(
    text || undefined, dueDate || null, courseId ?? undefined, category ?? undefined, done !== undefined ? (done ? 1 : 0) : undefined, parentId || null, req.params.id, req.userId
  );
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  res.json(taskRowToObj(row));
});

app.delete('/api/tasks/:id', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  db.prepare('DELETE FROM tasks WHERE parent_id = ? AND user_id = ?').run(req.params.id, req.userId);
  res.json({ ok: true });
});

app.post('/api/sync', authMiddleware, (req, res) => {
  const { courses: cs, tags: ts, tasks: tks } = req.body;
  if (!Array.isArray(cs) || !Array.isArray(ts) || !Array.isArray(tks)) {
    return res.status(400).json({ error: 'courses, tags, tasks arrays required' });
  }
  const uid = req.userId;
  db.transaction(() => {
    db.prepare('DELETE FROM courses WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM tags WHERE user_id = ?').run(uid);
    db.prepare('DELETE FROM tasks WHERE user_id = ?').run(uid);
    for (const c of cs) {
      db.prepare('INSERT INTO courses (id, user_id, name, description) VALUES (?, ?, ?, ?)').run(c.id, uid, c.name, c.description || '');
    }
    for (const t of ts) {
      db.prepare('INSERT INTO tags (id, user_id, name, color) VALUES (?, ?, ?, ?)').run(t.id, uid, t.name, t.color || '#4a90d9');
    }
    for (const t of tks) {
      db.prepare('INSERT INTO tasks (id, user_id, text, due_date, course_id, category, done, parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        t.id, uid, t.text, t.dueDate || null, t.courseId || '', t.category || '', t.done ? 1 : 0, t.parentId || null
      );
    }
  })();
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, '..')));

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

app.listen(PORT, () => {
  console.log(`To-Do List API running at http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop');
});

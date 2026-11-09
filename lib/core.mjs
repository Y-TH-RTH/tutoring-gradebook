// Gradebook core: all API routes and grade math.
// Storage-agnostic: works with Netlify Blobs (netlify/functions/api.mjs) or local files (local-server.mjs).
//
// A `store` must provide:
//   loadState()                 -> { state, version }   (state is null if nothing saved yet)
//   saveState(state, version)   -> true if saved, false if someone else saved first
//   getSession(userId, token)   -> { userId, expiresAt } | null
//   setSession(userId, token, session)
//   deleteSession(userId, token)
//   deleteUserSessions(userId)
//   getAttempts(key) / setAttempts(key, value)   (login throttling)
import crypto from 'node:crypto';

const SESSION_DAYS = 30;

// ---------- small helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = (msg) => { throw new HttpError(404, msg); };
function str(v, name, max = 120) {
  if (typeof v !== 'string' || !v.trim()) bad(`${name} is required`);
  if (v.trim().length > max) bad(`${name} is too long`);
  return v.trim();
}
function num(v, name, { min = 0, allowNull = false } = {}) {
  if ((v === null || v === undefined || v === '') && allowNull) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) bad(`${name} must be a number`);
  if (n < min) bad(`${name} cannot be below ${min}`);
  return Math.round(n * 100) / 100;
}
const intId = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) bad('Bad id'); return n; };
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const sortKey = (a) => a.due_date || a.createdAt || '';
const byDateDesc = (a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : b.id - a.id);
const now = () => new Date().toISOString();

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function checkPw(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(pw, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return ref.length === test.length && crypto.timingSafeEqual(test, ref);
}

function emptyState() {
  return { nextId: 1, settings: { correctionsInAverage: true }, users: [], classes: [], enrollments: [], assignments: [], grades: [] };
}

// ---------- grade math ----------
// Assignment % = A / T. Class average = sum(A) / sum(T) over graded assignments.
// Test correction points (C) are kept separate; when the setting is on they are added to A for averages.
function stats(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  return { count: s.length, mean, median, high: s[s.length - 1], low: s[0], stdev: sd };
}

// Query helpers bound to one state object.
function model(st) {
  const user = (id) => st.users.find((u) => u.id === id);
  const cls = (id) => st.classes.find((c) => c.id === id);
  const asg = (id) => st.assignments.find((a) => a.id === id);
  const enrolled = (classId, studentId) => st.enrollments.some((e) => e.classId === classId && e.studentId === studentId);
  const grade = (aId, cId, sId) => st.grades.find((g) => g.assignmentId === aId && g.classId === cId && g.studentId === sId);
  const classAssignments = (classId) => st.assignments.filter((a) => a.classIds.includes(classId)).sort(byDateDesc);
  const roster = (classId) => st.enrollments.filter((e) => e.classId === classId).map((e) => user(e.studentId)).filter(Boolean).sort(byName);

  function studentClassAverage(studentId, classId) {
    let n = 0, A = 0, C = 0, T = 0;
    for (const a of classAssignments(classId)) {
      const g = grade(a.id, classId, studentId);
      if (!g) continue;
      n++; A += g.acquired; C += g.corrections; T += a.total;
    }
    const earned = A + (st.settings.correctionsInAverage ? C : 0);
    return { graded: n, earned, original: A, corrections: C, total: T, percent: T ? earned / T : null, originalPercent: T ? A / T : null };
  }

  function studentClassDetail(studentId, classId) {
    const c = cls(classId), u = user(studentId);
    if (!c || !u || !enrolled(classId, studentId)) notFound('Class not found');
    const assignments = classAssignments(classId).map((a) => {
      const g = grade(a.id, classId, studentId);
      return { id: a.id, title: a.title, category: a.category, total: a.total, due_date: a.due_date, acquired: g ? g.acquired : null, corrections: g ? g.corrections : null };
    });
    return { id: c.id, name: c.name, studentName: u.name, assignments, average: studentClassAverage(studentId, classId), correctionsInAverage: st.settings.correctionsInAverage };
  }

  return { user, cls, asg, enrolled, grade, classAssignments, roster, studentClassAverage, studentClassDetail };
}

// ---------- routes ----------
// Each route: [method, pattern, role|null|'public', handler(ctx) ]
// ctx = { st, m, body, params, user, store, req, setCookie, mutate() }
const routes = [];
const route = (method, pattern, role, fn) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, role, fn });
};

// --- auth ---
route('GET', '/api/setup-needed', 'public', ({ st }) => ({ needed: !st.users.some((u) => u.role === 'admin') }));

route('POST', '/api/setup', 'public', async (ctx) => {
  const { st, body } = ctx;
  if (st.users.some((u) => u.role === 'admin')) throw new HttpError(403, 'Setup already done');
  const name = str(body.name, 'Name'), username = str(body.username, 'Username', 40);
  const pw = str(body.password, 'Password', 200);
  if (pw.length < 8) bad('Password must be at least 8 characters');
  const id = st.nextId++;
  st.users.push({ id, username, name, role: 'admin', pwHash: hashPw(pw), createdAt: now() });
  ctx.mutate();
  ctx.afterSave = () => ctx.startSession(id);
  return { ok: true };
});

route('POST', '/api/login', 'public', async (ctx) => {
  const { st, body, store } = ctx;
  const username = String(body.username || '').trim();
  const key = username.toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 60) || '_';
  const att = (await store.getAttempts(key)) || { n: 0, until: 0 };
  if (att.until > Date.now()) throw new HttpError(429, 'Too many attempts. Try again in a minute.');
  const u = st.users.find((x) => x.username.toLowerCase() === username.toLowerCase());
  if (!u || !checkPw(String(body.password || ''), u.pwHash)) {
    const n = att.n + 1;
    await store.setAttempts(key, n >= 8 ? { n: 0, until: Date.now() + 60000 } : { n, until: 0 });
    throw new HttpError(401, 'Wrong username or password');
  }
  if (att.n) await store.setAttempts(key, { n: 0, until: 0 });
  await ctx.startSession(u.id);
  return { role: u.role };
});

route('POST', '/api/logout', null, async (ctx) => {
  if (ctx.session) await ctx.store.deleteSession(ctx.session.userId, ctx.session.token);
  ctx.clearCookie();
  return { ok: true };
});

route('GET', '/api/me', 'any', ({ user }) => ({ id: user.id, name: user.name, username: user.username, role: user.role }));

route('POST', '/api/me/password', 'any', async (ctx) => {
  const { st, body, user } = ctx;
  const u = st.users.find((x) => x.id === user.id);
  if (!checkPw(String(body.current || ''), u.pwHash)) bad('Current password is wrong');
  const pw = str(body.password, 'New password', 200);
  if (pw.length < 6) bad('Password must be at least 6 characters');
  u.pwHash = hashPw(pw);
  ctx.mutate();
  ctx.afterSave = async () => { await ctx.store.deleteUserSessions(u.id); await ctx.startSession(u.id); };
  return { ok: true };
});

// --- admin: overview & settings ---
route('GET', '/api/admin/overview', 'admin', ({ st, m }) => {
  const classes = [...st.classes].sort(byName).map((c) => {
    const r = m.roster(c.id);
    const pcts = r.map((s) => m.studentClassAverage(s.id, c.id).percent).filter((p) => p !== null);
    return {
      id: c.id, name: c.name, students: r.length, assignments: m.classAssignments(c.id).length,
      average: pcts.length ? pcts.reduce((a, b) => a + b, 0) / pcts.length : null,
    };
  });
  const students = st.users.filter((u) => u.role === 'student').sort(byName).map((u) => ({
    id: u.id, name: u.name, username: u.username,
    classIds: st.enrollments.filter((e) => e.studentId === u.id).map((e) => e.classId),
  }));
  const assignments = [...st.assignments].sort(byDateDesc).map((a) => ({
    id: a.id, title: a.title, category: a.category, total: a.total, due_date: a.due_date, classIds: a.classIds,
    gradedCount: st.grades.filter((g) => g.assignmentId === a.id && a.classIds.includes(g.classId) && m.enrolled(g.classId, g.studentId)).length,
  }));
  return { classes, students, assignments, settings: { correctionsInAverage: st.settings.correctionsInAverage } };
});

route('PUT', '/api/admin/settings', 'admin', (ctx) => {
  ctx.st.settings.correctionsInAverage = !!ctx.body.correctionsInAverage;
  ctx.mutate();
  return { ok: true };
});

// --- admin: classes ---
route('POST', '/api/admin/classes', 'admin', (ctx) => {
  const id = ctx.st.nextId++;
  ctx.st.classes.push({ id, name: str(ctx.body.name, 'Class name'), createdAt: now() });
  ctx.mutate();
  return { id };
});
route('PATCH', '/api/admin/classes/:id', 'admin', (ctx) => {
  const c = ctx.m.cls(intId(ctx.params.id)) || notFound('Class not found');
  c.name = str(ctx.body.name, 'Class name');
  ctx.mutate();
  return { ok: true };
});
route('DELETE', '/api/admin/classes/:id', 'admin', (ctx) => {
  const id = intId(ctx.params.id), st = ctx.st;
  st.classes = st.classes.filter((c) => c.id !== id);
  st.enrollments = st.enrollments.filter((e) => e.classId !== id);
  st.grades = st.grades.filter((g) => g.classId !== id);
  st.assignments.forEach((a) => (a.classIds = a.classIds.filter((c) => c !== id)));
  // remove assignments that no longer belong to any class
  const orphan = new Set(st.assignments.filter((a) => !a.classIds.length).map((a) => a.id));
  st.assignments = st.assignments.filter((a) => !orphan.has(a.id));
  st.grades = st.grades.filter((g) => !orphan.has(g.assignmentId));
  ctx.mutate();
  return { ok: true };
});
route('GET', '/api/admin/classes/:id', 'admin', ({ m, params }) => {
  const id = intId(params.id);
  const c = m.cls(id) || notFound('Class not found');
  const roster = m.roster(id).map((s) => ({ id: s.id, name: s.name, username: s.username, average: m.studentClassAverage(s.id, id) }));
  const assignments = m.classAssignments(id).map((a) => {
    const vals = roster.map((s) => m.grade(a.id, id, s.id)).filter(Boolean).map((g) => g.acquired / a.total);
    return { id: a.id, title: a.title, category: a.category, total: a.total, due_date: a.due_date, stats: stats(vals) };
  });
  return { id: c.id, name: c.name, roster, assignments };
});
route('POST', '/api/admin/classes/:id/students', 'admin', (ctx) => {
  const cid = intId(ctx.params.id), st = ctx.st;
  if (!ctx.m.cls(cid)) notFound('Class not found');
  const ids = (Array.isArray(ctx.body.studentIds) ? ctx.body.studentIds : [ctx.body.studentId]).map(intId);
  for (const sid of ids) {
    if (ctx.m.user(sid)?.role !== 'student') bad('Unknown student');
    if (!ctx.m.enrolled(cid, sid)) st.enrollments.push({ classId: cid, studentId: sid });
  }
  ctx.mutate();
  return { ok: true };
});
route('GET', '/api/admin/classes/:id/students/:sid', 'admin', ({ m, params }) => m.studentClassDetail(intId(params.sid), intId(params.id)));
route('DELETE', '/api/admin/classes/:id/students/:sid', 'admin', (ctx) => {
  // Grades are kept, so re-adding the student restores their history.
  const cid = intId(ctx.params.id), sid = intId(ctx.params.sid);
  ctx.st.enrollments = ctx.st.enrollments.filter((e) => !(e.classId === cid && e.studentId === sid));
  ctx.mutate();
  return { ok: true };
});

// --- admin: students ---
route('POST', '/api/admin/students', 'admin', (ctx) => {
  const { st, body } = ctx;
  const name = str(body.name, 'Name'), username = str(body.username, 'Username', 40);
  if (!/^[A-Za-z0-9._-]+$/.test(username)) bad('Username can use letters, numbers, dot, dash and underscore only');
  const pw = str(body.password, 'Password', 200);
  if (pw.length < 6) bad('Password must be at least 6 characters');
  if (st.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) bad('That username is taken');
  const id = st.nextId++;
  st.users.push({ id, username, name, role: 'student', pwHash: hashPw(pw), createdAt: now() });
  const classIds = Array.isArray(body.classIds) ? [...new Set(body.classIds.map(intId))] : [];
  classIds.filter((c) => ctx.m.cls(c)).forEach((c) => st.enrollments.push({ classId: c, studentId: id }));
  ctx.mutate();
  return { id };
});
route('PATCH', '/api/admin/students/:id', 'admin', (ctx) => {
  const id = intId(ctx.params.id), u = ctx.m.user(id);
  if (!u || u.role !== 'student') notFound('Student not found');
  if (ctx.body.name !== undefined) u.name = str(ctx.body.name, 'Name');
  if (ctx.body.password !== undefined) {
    const pw = str(ctx.body.password, 'Password', 200);
    if (pw.length < 6) bad('Password must be at least 6 characters');
    u.pwHash = hashPw(pw);
    ctx.afterSave = () => ctx.store.deleteUserSessions(id);
  }
  ctx.mutate();
  return { ok: true };
});
route('DELETE', '/api/admin/students/:id', 'admin', (ctx) => {
  const id = intId(ctx.params.id), st = ctx.st;
  if (ctx.m.user(id)?.role !== 'student') notFound('Student not found');
  st.users = st.users.filter((u) => u.id !== id);
  st.enrollments = st.enrollments.filter((e) => e.studentId !== id);
  st.grades = st.grades.filter((g) => g.studentId !== id);
  ctx.mutate();
  ctx.afterSave = () => ctx.store.deleteUserSessions(id);
  return { ok: true };
});

// --- admin: assignments ---
function readAssignment(body, m) {
  const title = str(body.title, 'Title', 160);
  const category = body.category === 'Test' ? 'Test' : body.category === 'Worksheet' ? 'Worksheet' : bad('Category must be Test or Worksheet');
  const total = num(body.total, 'Total points (T)', { min: 0.01 });
  const due = typeof body.due_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.due_date) ? body.due_date : null;
  const classIds = Array.isArray(body.classIds) ? [...new Set(body.classIds.map(intId))].filter((c) => m.cls(c)) : [];
  if (!classIds.length) bad('Pick at least one class');
  return { title, category, total, due_date: due, classIds };
}
route('POST', '/api/admin/assignments', 'admin', (ctx) => {
  const a = readAssignment(ctx.body, ctx.m);
  const id = ctx.st.nextId++;
  ctx.st.assignments.push({ id, ...a, createdAt: now() });
  ctx.mutate();
  return { id };
});
route('PATCH', '/api/admin/assignments/:id', 'admin', (ctx) => {
  const id = intId(ctx.params.id), st = ctx.st;
  const old = ctx.m.asg(id) || notFound('Assignment not found');
  const a = readAssignment(ctx.body, ctx.m);
  if (st.grades.some((g) => g.assignmentId === id && g.acquired + g.corrections > a.total)) {
    bad('Some existing scores are higher than the new total. Fix those scores first.');
  }
  Object.assign(old, a);
  st.grades = st.grades.filter((g) => g.assignmentId !== id || a.classIds.includes(g.classId));
  if (a.category !== 'Test') st.grades.forEach((g) => { if (g.assignmentId === id) g.corrections = 0; });
  ctx.mutate();
  return { ok: true };
});
route('DELETE', '/api/admin/assignments/:id', 'admin', (ctx) => {
  const id = intId(ctx.params.id);
  ctx.st.assignments = ctx.st.assignments.filter((a) => a.id !== id);
  ctx.st.grades = ctx.st.grades.filter((g) => g.assignmentId !== id);
  ctx.mutate();
  return { ok: true };
});
route('GET', '/api/admin/assignments/:id', 'admin', ({ m, params, st }) => {
  const id = intId(params.id);
  const a = m.asg(id) || notFound('Assignment not found');
  const classes = a.classIds.map((cid) => m.cls(cid)).filter(Boolean).sort(byName).map((c) => {
    const students = m.roster(c.id).map((s) => {
      const g = m.grade(id, c.id, s.id);
      return { id: s.id, name: s.name, acquired: g ? g.acquired : null, corrections: g ? g.corrections : null };
    });
    const graded = students.filter((s) => s.acquired !== null);
    return {
      id: c.id, name: c.name, students,
      stats: stats(graded.map((s) => s.acquired / a.total)),
      statsWithCorrections: a.category === 'Test' ? stats(graded.map((s) => (s.acquired + s.corrections) / a.total)) : null,
      correctionsSubmitted: graded.filter((s) => s.corrections > 0).length,
    };
  });
  return { id: a.id, title: a.title, category: a.category, total: a.total, due_date: a.due_date, classes };
});
route('PUT', '/api/admin/assignments/:id/grades', 'admin', (ctx) => {
  const id = intId(ctx.params.id), classId = intId(ctx.body.classId), st = ctx.st, m = ctx.m;
  const a = m.asg(id) || notFound('Assignment not found');
  if (!a.classIds.includes(classId)) bad('Assignment is not in that class');
  const rows = Array.isArray(ctx.body.grades) ? ctx.body.grades : bad('No grades sent');
  // Validate everything first so a bad row saves nothing.
  const updates = rows.map((r) => {
    const sid = intId(r.studentId);
    if (!m.enrolled(classId, sid)) bad('Student is not in this class');
    const name = m.user(sid).name;
    const A = num(r.acquired, `Score for ${name}`, { allowNull: true });
    if (A === null) return { sid, A: null };
    const C = a.category === 'Test' ? (num(r.corrections, `Corrections for ${name}`, { allowNull: true }) || 0) : 0;
    if (A > a.total) bad(`${name}: score ${A} is more than the total of ${a.total}`);
    if (A + C > a.total) bad(`${name}: score plus corrections (${A + C}) is more than the total of ${a.total}`);
    return { sid, A, C };
  });
  for (const u of updates) {
    st.grades = st.grades.filter((g) => !(g.assignmentId === id && g.classId === classId && g.studentId === u.sid));
    if (u.A !== null) st.grades.push({ assignmentId: id, classId, studentId: u.sid, acquired: u.A, corrections: u.C, updatedAt: now() });
  }
  ctx.mutate();
  return { ok: true };
});

// --- student ---
route('GET', '/api/student/classes', 'student', ({ st, m, user }) => {
  const classes = st.enrollments.filter((e) => e.studentId === user.id).map((e) => m.cls(e.classId)).filter(Boolean).sort(byName)
    .map((c) => ({ id: c.id, name: c.name, average: m.studentClassAverage(user.id, c.id) }));
  return { classes, correctionsInAverage: st.settings.correctionsInAverage };
});
route('GET', '/api/student/classes/:id', 'student', ({ m, params, user }) => m.studentClassDetail(user.id, intId(params.id)));

// ---------- request handler ----------
function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

const json = (status, data, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

export async function handle(req, store) {
  const url = new URL(req.url);
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  if (!r) return json(404, { error: 'Not found' });
  const params = {};
  const match = url.pathname.match(r.re);
  r.keys.forEach((k, i) => (params[k] = decodeURIComponent(match[i + 1])));

  // Protect JSON writes from cross-site form posts.
  if (req.method !== 'GET' && !(req.headers.get('content-type') || '').includes('application/json') && req.method !== 'DELETE' && url.pathname !== '/api/logout') {
    return json(415, { error: 'Expected JSON' });
  }

  let body = {};
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    try { const t = await req.text(); body = t ? JSON.parse(t) : {}; } catch { return json(400, { error: 'Bad request body' }); }
    if (!body || typeof body !== 'object') body = {};
  }

  const secure = url.protocol === 'https:' ? '; Secure' : '';
  const cookies = [];
  const ctxBase = {
    params, body, store, req,
    startSession: async (userId) => {
      const token = crypto.randomBytes(32).toString('hex');
      await store.setSession(userId, token, { userId, expiresAt: Date.now() + SESSION_DAYS * 864e5 });
      cookies.push(`gb_session=${userId}.${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    },
    clearCookie: () => cookies.push(`gb_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`),
  };

  // Retry the whole request if another save landed between our read and write.
  for (let attempt = 0; attempt < 5; attempt++) {
    const { state, version } = await store.loadState();
    const st = state || emptyState();
    const m = model(st);
    let changed = false;
    const ctx = { ...ctxBase, st, m, mutate: () => (changed = true), afterSave: null, session: null, user: null };

    // who is calling?
    const raw = parseCookies(req.headers.get('cookie')).gb_session;
    if (raw && raw.includes('.')) {
      const [uidStr, token] = raw.split('.');
      const uid = Number(uidStr);
      const sess = Number.isInteger(uid) && /^[a-f0-9]{64}$/.test(token) ? await store.getSession(uid, token) : null;
      if (sess && sess.expiresAt > Date.now() && m.user(uid)) {
        ctx.session = { userId: uid, token };
        const u = m.user(uid);
        ctx.user = { id: u.id, name: u.name, username: u.username, role: u.role };
      } else if (sess) await store.deleteSession(uid, token);
    }

    try {
      if (r.role !== 'public' && r.role !== null) {
        if (!ctx.user) throw new HttpError(401, 'Please log in');
        if (r.role !== 'any' && ctx.user.role !== r.role) throw new HttpError(403, 'Not allowed');
      }
      const result = await r.fn(ctx);
      if (changed) {
        const ok = await store.saveState(st, version);
        if (!ok) { cookies.length = 0; continue; } // someone else saved first: redo on fresh data
      }
      if (ctx.afterSave) await ctx.afterSave();
      const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      cookies.forEach((c) => headers.append('Set-Cookie', c));
      return new Response(JSON.stringify(result), { status: 200, headers });
    } catch (e) {
      if (e instanceof HttpError) {
        const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        cookies.forEach((c) => headers.append('Set-Cookie', c));
        return new Response(JSON.stringify({ error: e.message }), { status: e.status, headers });
      }
      console.error(e);
      return json(500, { error: 'Something went wrong on the server' });
    }
  }
  return json(503, { error: 'The server is busy. Please try again.' });
}

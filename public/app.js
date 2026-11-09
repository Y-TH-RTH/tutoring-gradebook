'use strict';
/* Gradebook front end — plain JavaScript, no build step. */

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n === null || n === undefined ? '—' : String(Math.round(n * 100) / 100));
const pct = (p) => (p === null || p === undefined ? '—' : (Math.round(p * 1000) / 10).toFixed(1) + '%');
const gcls = (p) => (p === null || p === undefined ? 'g-none' : p >= 0.85 ? 'g-good' : p >= 0.7 ? 'g-ok' : 'g-low');
const dateStr = (d) => (d ? new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const badge = (cat) => `<span class="badge ${esc(cat)}">${esc(cat)}</span>`;

let me = null;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/me/password')) { me = null; showLogin(); throw new Error('Please log in'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 2600);
}

function openModal(html, { narrow = false } = {}) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal ${narrow ? 'narrow' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
  const backdrop = root.firstElementChild;
  const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  $$('[data-close]', backdrop).forEach((b) => b.addEventListener('click', close));
  const first = $('input, select, button:not(.modal-close)', backdrop);
  if (first) first.focus();
  return { el: backdrop, close };
}
const modalHead = (title, sub = '') => `
  <div class="modal-head"><div><h2>${title}</h2>${sub ? `<div class="muted small" style="margin-top:.25rem">${sub}</div>` : ''}</div>
  <button class="modal-close" data-close aria-label="Close">×</button></div>`;

function confirmBox(text, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const m = openModal(`${modalHead('Are you sure?')}<div class="modal-body"><p style="margin-top:0">${text}</p>
      <div class="row" style="justify-content:flex-end"><button class="secondary" data-no>Cancel</button><button class="danger" data-yes>${esc(okLabel)}</button></div></div>`, { narrow: true });
    $('[data-no]', m.el).onclick = () => { m.close(); resolve(false); };
    $('[data-yes]', m.el).onclick = () => { m.close(); resolve(true); };
    $('.modal-close', m.el).addEventListener('click', () => resolve(false));
  });
}

// Run an async action from a form/button, showing errors in a target element or a toast.
async function act(fn, errEl, btn) {
  if (errEl) errEl.textContent = '';
  if (btn) btn.disabled = true;
  try { return await fn(); }
  catch (e) { if (errEl) errEl.textContent = e.message; else toast(e.message, true); }
  finally { if (btn) btn.disabled = false; }
}

// ---------- auth screens ----------
async function boot() {
  try { me = await api('GET', '/api/me'); }
  catch { me = null; }
  if (!me) return showLogin();
  if (!boot.listening) { window.addEventListener('hashchange', route); boot.listening = true; }
  route();
}

async function showLogin() {
  const app = $('#app');
  $('#modal-root').innerHTML = '';
  let setup = false;
  try { setup = (await api('GET', '/api/setup-needed')).needed; } catch { /* ignore */ }
  if (setup) {
    app.innerHTML = `<div class="auth"><form class="card" id="f">
      <h1>Welcome</h1><p class="muted">Create your admin (tutor) account to get started.</p>
      <div class="field"><label for="n">Your name</label><input id="n" required autocomplete="name"></div>
      <div class="field"><label for="u">Username</label><input id="u" required autocomplete="username"></div>
      <div class="field"><label for="p">Password (8+ characters)</label><input id="p" type="password" required minlength="8" autocomplete="new-password"></div>
      <button>Create admin account</button><div class="error" id="err"></div></form></div>`;
    $('#f').onsubmit = (e) => { e.preventDefault(); act(async () => {
      await api('POST', '/api/setup', { name: $('#n').value, username: $('#u').value, password: $('#p').value });
      boot();
    }, $('#err'), $('#f button')); };
    return;
  }
  app.innerHTML = `<div class="auth"><form class="card" id="f">
    <h1>Gradebook</h1><p class="muted">Log in to see your grades.</p>
    <div class="field"><label for="u">Username</label><input id="u" required autocomplete="username" autocapitalize="none"></div>
    <div class="field"><label for="p">Password</label><input id="p" type="password" required autocomplete="current-password"></div>
    <button>Log in</button><div class="error" id="err"></div></form></div>`;
  $('#u').focus();
  $('#f').onsubmit = (e) => { e.preventDefault(); act(async () => {
    await api('POST', '/api/login', { username: $('#u').value, password: $('#p').value });
    location.hash = '';
    boot();
  }, $('#err'), $('#f button')); };
}

async function logout() { await api('POST', '/api/logout').catch(() => {}); me = null; location.hash = ''; showLogin(); }

function changePasswordModal() {
  const m = openModal(`${modalHead('Change password')}<form class="modal-body" id="pwf">
    <div class="field"><label for="cur">Current password</label><input id="cur" type="password" required autocomplete="current-password"></div>
    <div class="field"><label for="np">New password</label><input id="np" type="password" required minlength="6" autocomplete="new-password"></div>
    <div class="row" style="justify-content:flex-end"><button type="button" class="secondary" data-close>Cancel</button><button>Save</button></div>
    <div class="error" id="pwerr"></div></form>`, { narrow: true });
  $('[data-close]', m.el).onclick = m.close;
  $('#pwf').onsubmit = (e) => { e.preventDefault(); act(async () => {
    await api('POST', '/api/me/password', { current: $('#cur').value, password: $('#np').value });
    m.close(); toast('Password changed');
  }, $('#pwerr'), $('#pwf button:last-of-type')); };
}

function shell(navItems, active) {
  $('#app').innerHTML = `
    <header class="topbar"><div class="inner">
      <div class="logo">Gradebook</div>
      <nav>${navItems.map(([href, label]) => `<a href="${href}" class="${active === href ? 'active' : ''}">${label}</a>`).join('')}</nav>
      <div class="who"><span>${esc(me.name)}</span><button class="sm" id="pwbtn">Password</button><button class="sm" id="logout">Log out</button></div>
    </div></header><main id="main"><div class="loading">Loading…</div></main>`;
  $('#logout').onclick = logout;
  $('#pwbtn').onclick = changePasswordModal;
  return $('#main');
}

function route() {
  if (!me) return;
  $('#modal-root').innerHTML = '';
  if (me.role === 'student') return studentHome();
  const [view, id] = (location.hash.slice(1) || 'classes').split('-');
  const nav = [['#classes', 'Classes'], ['#students', 'Students'], ['#assignments', 'Assignments'], ['#settings', 'Settings']];
  const activeMap = { classes: '#classes', class: '#classes', students: '#students', assignments: '#assignments', assignment: '#assignments', settings: '#settings' };
  const main = shell(nav, activeMap[view] || '#classes');
  const views = { classes: adminClasses, class: adminClass, students: adminStudents, assignments: adminAssignments, assignment: adminAssignment, settings: adminSettings };
  (views[view] || adminClasses)(main, id && Number(id)).catch((e) => { main.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; });
}

// ---------- shared: grade history view (used by students and by admin preview) ----------
function gradeHistoryHtml(d) {
  const av = d.average;
  const graded = d.assignments.filter((a) => a.acquired !== null);
  const pending = d.assignments.length - graded.length;
  const items = d.assignments.map((a) => {
    const done = a.acquired !== null;
    const p = done ? a.acquired / a.total : null;
    let corr = '';
    if (a.category === 'Test' && done) {
      if (a.corrections > 0) {
        const withC = (a.acquired + a.corrections) / a.total;
        corr = `<div class="correction"><span>✎ Corrections: <b>+${fmt(a.corrections)}</b> pts earned back</span>
          <span>With corrections: <b>${fmt(a.acquired + a.corrections)}/${fmt(a.total)}</b> (${pct(withC)})</span></div>`;
      } else {
        corr = `<div class="muted small" style="margin-top:.35rem">No correction points yet.</div>`;
      }
    }
    return `<li class="grade-item"><div class="top">
        <div><div class="title">${esc(a.title)}</div><div class="row small muted" style="margin-top:.2rem">${badge(a.category)}${a.due_date ? `<span>${dateStr(a.due_date)}</span>` : ''}</div></div>
        <div class="score ${gcls(p)}">${done ? `${pct(p)}<span class="pts">${fmt(a.acquired)}/${fmt(a.total)}</span>` : '<span class="g-none" style="font-weight:500">Not graded yet</span>'}</div>
      </div>${corr}</li>`;
  }).join('');
  const hasCorr = av.corrections > 0;
  return `
    <div class="summary-bar">
      <div>Class average<br><b class="${gcls(av.percent)}">${pct(av.percent)}</b></div>
      <div>Points<br><b>${fmt(av.earned)} / ${fmt(av.total)}</b></div>
      ${hasCorr ? `<div>${d.correctionsInAverage ? 'Before corrections' : 'With corrections'}<br><b>${d.correctionsInAverage ? pct(av.originalPercent) : pct((av.original + av.corrections) / av.total)}</b></div>` : ''}
      <div>Graded<br><b>${graded.length}</b>${pending ? ` <span class="muted">(${pending} pending)</span>` : ''}</div>
    </div>
    ${hasCorr ? `<p class="muted small" style="margin-top:-.4rem">Test correction points are shown separately on each test so you can see which tests had the most to fix. ${d.correctionsInAverage ? 'They are included in your class average.' : 'They are not included in your class average.'}</p>` : ''}
    ${d.assignments.length ? `<ul class="grade-list">${items}</ul>` : '<div class="empty">No assignments yet.</div>'}`;
}

// ---------- student ----------
async function studentHome() {
  const main = shell([], '');
  const d = await api('GET', '/api/student/classes');
  main.innerHTML = `<div class="page-head"><div><h1>Hi, ${esc(me.name.split(' ')[0])}</h1>
    <div class="muted" style="margin-top:.3rem">Your average in each class. Tap a class to see every assignment.</div></div></div>
    ${d.classes.length ? `<div class="grid">${d.classes.map((c) => `
      <button class="card click-card class-card" data-id="${c.id}">
        <div class="name">${esc(c.name)}</div>
        <div class="big ${gcls(c.average.percent)}">${pct(c.average.percent)}</div>
        <div class="meta">${c.average.graded ? `${fmt(c.average.earned)} / ${fmt(c.average.total)} points · ${c.average.graded} graded` : 'No grades yet'}</div>
      </button>`).join('')}</div>` : '<div class="card empty">You are not enrolled in any classes yet.</div>'}`;
  $$('.class-card', main).forEach((b) => (b.onclick = () => studentClassModal(Number(b.dataset.id))));
}

async function studentClassModal(classId) {
  const d = await act(() => api('GET', `/api/student/classes/${classId}`));
  if (!d) return;
  openModal(`${modalHead(esc(d.name), 'All your grades in this class')}<div class="modal-body">${gradeHistoryHtml(d)}</div>`);
}

// ---------- admin: classes ----------
async function adminClasses(main) {
  const o = await api('GET', '/api/admin/overview');
  main.innerHTML = `<div class="page-head"><div><h1>Classes</h1><div class="muted" style="margin-top:.3rem">${o.classes.length} classes · ${o.students.length} students</div></div>
    <form class="row" id="addc"><input id="cname" placeholder="New class name" required style="width:220px"><button>Add class</button></form></div>
    ${o.classes.length ? `<div class="grid">${o.classes.map((c) => `
      <a class="card click-card class-card" href="#class-${c.id}" style="text-decoration:none">
        <div class="name">${esc(c.name)}</div>
        <div class="big ${gcls(c.average)}">${pct(c.average)}</div>
        <div class="meta">Class average · ${c.students} student${c.students === 1 ? '' : 's'} · ${c.assignments} assignment${c.assignments === 1 ? '' : 's'}</div>
      </a>`).join('')}</div>` : '<div class="card empty">No classes yet. Add your first class above.</div>'}`;
  $('#addc').onsubmit = (e) => { e.preventDefault(); act(async () => {
    const r = await api('POST', '/api/admin/classes', { name: $('#cname').value });
    toast('Class added'); location.hash = `#class-${r.id}`;
  }, null, $('#addc button')); };
}

async function adminClass(main, id) {
  const [c, o] = await Promise.all([api('GET', `/api/admin/classes/${id}`), api('GET', '/api/admin/overview')]);
  const notIn = o.students.filter((s) => !c.roster.some((r) => r.id === s.id));
  main.innerHTML = `<div class="page-head"><div><div class="crumb"><a href="#classes">← Classes</a></div><h1>${esc(c.name)}</h1></div>
    <div class="row"><button class="secondary" id="ren">Rename</button><button class="danger" id="del">Delete class</button></div></div>
    <div class="card"><div class="card-head"><h3>Students (${c.roster.length})</h3>
      <div class="row">${notIn.length ? `<select id="addsel" style="width:auto;min-width:200px"><option value="">Add a student…</option>${notIn.map((s) => `<option value="${s.id}">${esc(s.name)} (${esc(s.username)})</option>`).join('')}</select><button class="sm" id="addbtn">Add</button>` : ''}
      <button class="secondary sm" id="newstu">+ New student</button></div></div>
      ${c.roster.length ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th class="num">Graded</th><th class="num">Points (A / T)</th><th class="num">Average</th><th></th></tr></thead><tbody>
      ${c.roster.map((s) => `<tr class="clickable" data-sid="${s.id}"><td><b>${esc(s.name)}</b> <span class="muted small">${esc(s.username)}</span></td>
        <td class="num">${s.average.graded}</td><td class="num">${fmt(s.average.earned)} / ${fmt(s.average.total)}</td>
        <td class="num ${gcls(s.average.percent)}"><b>${pct(s.average.percent)}</b></td>
        <td class="num"><button class="link red sm" data-rm="${s.id}">Remove</button></td></tr>`).join('')}
      </tbody></table></div><p class="muted small" style="margin:.6rem 0 0">Click a student to see their grade history exactly as they see it.</p>` : '<div class="empty">No students in this class yet.</div>'}
    </div>
    <div class="card"><div class="card-head"><h3>Assignments (${c.assignments.length})</h3><a class="btn sm" href="#assignments" style="text-decoration:none">+ New assignment</a></div>
      ${c.assignments.length ? `<div class="table-wrap"><table><thead><tr><th>Assignment</th><th>Type</th><th class="num">T</th><th class="num">Graded</th><th class="num">Mean</th><th class="num">Median</th><th class="num">High</th><th class="num">Low</th></tr></thead><tbody>
      ${c.assignments.map((a) => `<tr class="clickable" data-aid="${a.id}"><td><b>${esc(a.title)}</b><div class="muted small">${dateStr(a.due_date)}</div></td><td>${badge(a.category)}</td><td class="num">${fmt(a.total)}</td>
        <td class="num">${a.stats ? a.stats.count : 0}/${c.roster.length}</td>
        <td class="num ${gcls(a.stats?.mean)}">${pct(a.stats?.mean)}</td><td class="num">${pct(a.stats?.median)}</td><td class="num">${pct(a.stats?.high)}</td><td class="num">${pct(a.stats?.low)}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No assignments for this class yet.</div>'}
    </div>`;

  $('#ren').onclick = () => {
    const m = openModal(`${modalHead('Rename class')}<form class="modal-body" id="rf"><div class="field"><label for="rn">Class name</label><input id="rn" value="${esc(c.name)}" required></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="secondary" data-close>Cancel</button><button>Save</button></div><div class="error" id="rerr"></div></form>`, { narrow: true });
    $('[data-close]', m.el).onclick = m.close;
    $('#rf').onsubmit = (e) => { e.preventDefault(); act(async () => { await api('PATCH', `/api/admin/classes/${id}`, { name: $('#rn').value }); m.close(); route(); }, $('#rerr')); };
  };
  $('#del').onclick = async () => {
    if (!(await confirmBox(`Delete <b>${esc(c.name)}</b>? All grades recorded for this class will be removed. Students' accounts are kept.`, 'Delete class'))) return;
    act(async () => { await api('DELETE', `/api/admin/classes/${id}`); toast('Class deleted'); location.hash = '#classes'; });
  };
  const addBtn = $('#addbtn');
  if (addBtn) addBtn.onclick = () => { const sid = $('#addsel').value; if (!sid) return; act(async () => { await api('POST', `/api/admin/classes/${id}/students`, { studentId: Number(sid) }); toast('Student added'); route(); }, null, addBtn); };
  $('#newstu').onclick = () => newStudentModal(o.classes, [id]);
  $$('[data-rm]', main).forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const s = c.roster.find((r) => r.id === Number(b.dataset.rm));
    if (!(await confirmBox(`Remove <b>${esc(s.name)}</b> from ${esc(c.name)}? Their grades are kept and come back if you add them again.`, 'Remove'))) return;
    act(async () => { await api('DELETE', `/api/admin/classes/${id}/students/${s.id}`); toast('Student removed'); route(); });
  }));
  $$('tr[data-sid]', main).forEach((tr) => (tr.onclick = async () => {
    const d = await act(() => api('GET', `/api/admin/classes/${id}/students/${tr.dataset.sid}`));
    if (d) openModal(`${modalHead(esc(d.studentName), `${esc(d.name)} — what the student sees`)}<div class="modal-body">${gradeHistoryHtml(d)}</div>`);
  }));
  $$('tr[data-aid]', main).forEach((tr) => (tr.onclick = () => (location.hash = `#assignment-${tr.dataset.aid}`)));
}

// ---------- admin: students ----------
function newStudentModal(classes, preselect = []) {
  const m = openModal(`${modalHead('Add a student')}<form class="modal-body" id="sf">
    <div class="field"><label for="sn">Full name</label><input id="sn" required></div>
    <div class="fields"><div class="field"><label for="su">Username</label><input id="su" required autocapitalize="none" autocomplete="off"></div>
    <div class="field"><label for="sp">Password (6+ chars)</label><input id="sp" required minlength="6" autocomplete="off"></div></div>
    ${classes.length ? `<div class="field"><label>Classes</label><div class="checks">${classes.map((c) => `<label><input type="checkbox" value="${c.id}" ${preselect.includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('')}</div></div>` : ''}
    <p class="muted small">Give the student their username and password so they can log in. They can change the password later.</p>
    <div class="row" style="justify-content:flex-end"><button type="button" class="secondary" data-close>Cancel</button><button>Add student</button></div>
    <div class="error" id="serr"></div></form>`);
  $('[data-close]', m.el).onclick = m.close;
  $('#sn').addEventListener('input', () => {
    const u = $('#su');
    if (!u.dataset.touched) u.value = $('#sn').value.trim().toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '');
  });
  $('#su').addEventListener('input', () => ($('#su').dataset.touched = '1'));
  $('#sf').onsubmit = (e) => { e.preventDefault(); act(async () => {
    await api('POST', '/api/admin/students', {
      name: $('#sn').value, username: $('#su').value, password: $('#sp').value,
      classIds: $$('.checks input:checked', m.el).map((i) => Number(i.value)),
    });
    m.close(); toast('Student added'); route();
  }, $('#serr'), $('#sf button:last-of-type')); };
}

async function adminStudents(main) {
  const o = await api('GET', '/api/admin/overview');
  const cname = Object.fromEntries(o.classes.map((c) => [c.id, c.name]));
  main.innerHTML = `<div class="page-head"><div><h1>Students</h1><div class="muted" style="margin-top:.3rem">${o.students.length} student accounts</div></div><button id="add">+ Add student</button></div>
    <div class="card">${o.students.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Username</th><th>Classes</th><th></th></tr></thead><tbody>
      ${o.students.map((s) => `<tr><td><b>${esc(s.name)}</b></td><td>${esc(s.username)}</td>
        <td>${s.classIds.length ? s.classIds.map((id) => `<span class="chip">${esc(cname[id])}</span>`).join('') : '<span class="muted small">None</span>'}</td>
        <td class="num"><button class="link sm" data-cls="${s.id}">Classes</button><button class="link sm" data-pw="${s.id}">Reset password</button><button class="link red sm" data-del="${s.id}">Delete</button></td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">No students yet. Click “Add student” to create a login for one.</div>'}</div>`;
  $('#add').onclick = () => newStudentModal(o.classes);
  const find = (id) => o.students.find((s) => s.id === Number(id));

  $$('[data-cls]', main).forEach((b) => (b.onclick = () => {
    const s = find(b.dataset.cls);
    const m = openModal(`${modalHead(`Classes for ${esc(s.name)}`)}<div class="modal-body">
      ${o.classes.length ? `<div class="checks" style="margin-bottom:1rem">${o.classes.map((c) => `<label><input type="checkbox" value="${c.id}" ${s.classIds.includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('')}</div>` : '<p class="muted">Create a class first.</p>'}
      <div class="row" style="justify-content:flex-end"><button class="secondary" data-close>Cancel</button><button id="savec">Save</button></div><div class="error" id="cerr"></div></div>`, { narrow: true });
    $('#savec').onclick = () => act(async () => {
      const want = $$('.checks input', m.el).filter((i) => i.checked).map((i) => Number(i.value));
      for (const c of want.filter((c) => !s.classIds.includes(c))) await api('POST', `/api/admin/classes/${c}/students`, { studentId: s.id });
      for (const c of s.classIds.filter((c) => !want.includes(c))) await api('DELETE', `/api/admin/classes/${c}/students/${s.id}`);
      m.close(); toast('Classes updated'); route();
    }, $('#cerr'), $('#savec'));
  }));
  $$('[data-pw]', main).forEach((b) => (b.onclick = () => {
    const s = find(b.dataset.pw);
    const m = openModal(`${modalHead(`Reset password for ${esc(s.name)}`)}<form class="modal-body" id="pf">
      <div class="field"><label for="np">New password (6+ chars)</label><input id="np" required minlength="6" autocomplete="off"></div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="secondary" data-close>Cancel</button><button>Set password</button></div><div class="error" id="perr"></div></form>`, { narrow: true });
    $('[data-close]', m.el).onclick = m.close;
    $('#pf').onsubmit = (e) => { e.preventDefault(); act(async () => { await api('PATCH', `/api/admin/students/${s.id}`, { password: $('#np').value }); m.close(); toast('Password reset'); }, $('#perr')); };
  }));
  $$('[data-del]', main).forEach((b) => (b.onclick = async () => {
    const s = find(b.dataset.del);
    if (!(await confirmBox(`Delete <b>${esc(s.name)}</b>'s account and all of their grades? This can't be undone. (To just take them out of a class, use “Classes” instead.)`, 'Delete student'))) return;
    act(async () => { await api('DELETE', `/api/admin/students/${s.id}`); toast('Student deleted'); route(); });
  }));
}

// ---------- admin: assignments ----------
function assignmentForm(classes, a = null) {
  const today = new Date().toISOString().slice(0, 10);
  return `
    <div class="field"><label for="at">Title</label><input id="at" required value="${esc(a?.title || '')}" placeholder="e.g. Unit 3 Test — Fractions"></div>
    <div class="fields">
      <div class="field"><label>Category</label><div class="seg">
        <label><input type="radio" name="cat" value="Test" ${a?.category === 'Test' ? 'checked' : ''}>Test</label>
        <label><input type="radio" name="cat" value="Worksheet" ${!a || a.category === 'Worksheet' ? 'checked' : ''}>Worksheet</label></div></div>
      <div class="field"><label for="atot">Total points (T)</label><input id="atot" type="number" min="0.01" step="any" required value="${a ? fmt(a.total) : ''}"></div>
      <div class="field"><label for="ad">Date</label><input id="ad" type="date" value="${esc(a ? a.due_date || '' : today)}"></div>
    </div>
    <div class="field"><label>Classes</label>${classes.length ? `<div class="checks">${classes.map((c) => `<label><input type="checkbox" name="cls" value="${c.id}" ${a?.classIds?.includes(c.id) ? 'checked' : ''}>${esc(c.name)}</label>`).join('')}</div>` : '<div class="muted small">Create a class first.</div>'}</div>`;
}
const readAssignmentForm = (root) => ({
  title: $('#at', root).value,
  category: $('input[name=cat]:checked', root).value,
  total: $('#atot', root).value,
  due_date: $('#ad', root).value,
  classIds: $$('input[name=cls]:checked', root).map((i) => Number(i.value)),
});

async function adminAssignments(main) {
  const o = await api('GET', '/api/admin/overview');
  const cname = Object.fromEntries(o.classes.map((c) => [c.id, c.name]));
  const filter = sessionStorage.getItem('gb_filter') || '';
  const list = o.assignments.filter((a) => !filter || a.classIds.includes(Number(filter)));
  main.innerHTML = `<div class="page-head"><div><h1>Assignments</h1></div></div>
    <form class="card" id="af"><h3>New assignment</h3>${assignmentForm(o.classes)}
      <div class="row"><button>Create &amp; enter grades</button><span class="error" id="aerr" style="margin:0"></span></div></form>
    <div class="card"><div class="card-head"><h3>All assignments</h3>
      <select id="filt" style="width:auto"><option value="">All classes</option>${o.classes.map((c) => `<option value="${c.id}" ${String(c.id) === filter ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
      ${list.length ? `<div class="table-wrap"><table><thead><tr><th>Assignment</th><th>Type</th><th>Classes</th><th class="num">T</th><th class="num">Grades entered</th></tr></thead><tbody>
      ${list.map((a) => `<tr class="clickable" data-aid="${a.id}"><td><b>${esc(a.title)}</b><div class="muted small">${dateStr(a.due_date)}</div></td><td>${badge(a.category)}</td>
        <td>${a.classIds.map((id) => `<span class="chip">${esc(cname[id])}</span>`).join('')}</td><td class="num">${fmt(a.total)}</td><td class="num">${a.gradedCount}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">No assignments yet.</div>'}</div>`;
  $('#filt').onchange = (e) => { sessionStorage.setItem('gb_filter', e.target.value); route(); };
  $('#af').onsubmit = (e) => { e.preventDefault(); act(async () => {
    const r = await api('POST', '/api/admin/assignments', readAssignmentForm($('#af')));
    toast('Assignment created'); location.hash = `#assignment-${r.id}`;
  }, $('#aerr'), $('#af button')); };
  $$('tr[data-aid]', main).forEach((tr) => (tr.onclick = () => (location.hash = `#assignment-${tr.dataset.aid}`)));
}

function statsHtml(s, label, extraCls = '') {
  if (!s) return `<div class="stats"><div class="stat ${extraCls}"><div class="k">${label}</div><div class="v g-none">No grades yet</div></div></div>`;
  return `<div class="stats">
    <div class="stat ${extraCls}"><div class="k">${label} mean</div><div class="v ${gcls(s.mean)}">${pct(s.mean)}</div></div>
    <div class="stat ${extraCls}"><div class="k">Median</div><div class="v">${pct(s.median)}</div></div>
    <div class="stat ${extraCls}"><div class="k">High</div><div class="v">${pct(s.high)}</div></div>
    <div class="stat ${extraCls}"><div class="k">Low</div><div class="v">${pct(s.low)}</div></div>
    <div class="stat ${extraCls}"><div class="k">Std dev</div><div class="v">${(Math.round(s.stdev * 1000) / 10).toFixed(1)} pts</div></div>
  </div>`;
}
function distHtml(values) {
  const bands = [['90+', 0.9, 2], ['80s', 0.8, 0.9], ['70s', 0.7, 0.8], ['60s', 0.6, 0.7], ['<60', -1, 0.6]];
  const counts = bands.map(([, lo, hi]) => values.filter((v) => v >= lo && v < hi).length);
  const max = Math.max(1, ...counts);
  return `<div class="dist" aria-label="Score distribution">${bands.map(([l], i) => `<div class="bar"><span class="n">${counts[i]}</span><div class="fill" style="height:${(counts[i] / max) * 60}px"></div><span>${l}</span></div>`).join('')}</div>`;
}

async function adminAssignment(main, id) {
  const [a, o] = await Promise.all([api('GET', `/api/admin/assignments/${id}`), api('GET', '/api/admin/overview')]);
  const isTest = a.category === 'Test';
  const full = o.assignments.find((x) => x.id === id);
  main.innerHTML = `<div class="page-head"><div><div class="crumb"><a href="#assignments">← Assignments</a></div>
      <h1>${esc(a.title)}</h1><div class="row muted" style="margin-top:.4rem">${badge(a.category)}<span>Total points (T): <b>${fmt(a.total)}</b></span>${a.due_date ? `<span>· ${dateStr(a.due_date)}</span>` : ''}</div></div>
    <div class="row"><button class="secondary" id="edit">Edit</button><button class="danger" id="del">Delete</button></div></div>
    ${a.classes.map((c) => {
      const graded = c.students.filter((s) => s.acquired !== null);
      return `<form class="card" data-class="${c.id}">
      <div class="card-head"><h3>${esc(c.name)}</h3><span class="muted small">${graded.length} of ${c.students.length} graded${isTest ? ` · ${c.correctionsSubmitted} with corrections` : ''}</span></div>
      ${statsHtml(c.stats, isTest ? 'Original' : 'Class')}
      ${isTest && c.correctionsSubmitted ? statsHtml(c.statsWithCorrections, 'With corrections', 'corr') : ''}
      ${graded.length ? distHtml(graded.map((s) => s.acquired / a.total)) : ''}
      ${c.students.length ? `<div class="table-wrap"><table><thead><tr><th>Student</th><th class="num">Score (A)</th>${isTest ? '<th class="num">Correction pts</th>' : ''}<th class="num">Grade</th>${isTest ? '<th class="num">With corrections</th>' : ''}</tr></thead><tbody>
        ${c.students.map((s) => `<tr data-sid="${s.id}"><td>${esc(s.name)}</td>
          <td class="num"><input type="number" step="any" min="0" max="${a.total}" class="inA" value="${s.acquired ?? ''}" placeholder="—" aria-label="Score for ${esc(s.name)}"> <span class="muted small">/ ${fmt(a.total)}</span></td>
          ${isTest ? `<td class="num"><input type="number" step="any" min="0" class="inC" value="${s.corrections ? s.corrections : ''}" placeholder="0" aria-label="Correction points for ${esc(s.name)}"></td>` : ''}
          <td class="num outP"></td>${isTest ? '<td class="num outC"></td>' : ''}</tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:.8rem"><button>Save grades</button><span class="muted small">Leave a score blank if it isn't graded yet. Enter moves to the next student.</span></div>
      <div class="error"></div>` : `<div class="empty">No students in this class. <a href="#class-${c.id}">Add some</a>.</div>`}
    </form>`; }).join('')}
    ${!a.classes.length ? '<div class="card empty">This assignment is not in any class. Click Edit to add it to one.</div>' : ''}`;

  // live % preview & keyboard flow
  const refreshRow = (tr) => {
    const A = $('.inA', tr).value === '' ? null : Number($('.inA', tr).value);
    const C = isTest && $('.inC', tr).value !== '' ? Number($('.inC', tr).value) : 0;
    const p = A === null ? null : A / a.total;
    const outP = $('.outP', tr);
    outP.className = `num outP ${gcls(p)}`;
    outP.innerHTML = A === null ? '<span class="g-none">—</span>' : `<b>${pct(p)}</b>`;
    if (isTest) {
      const oc = $('.outC', tr);
      oc.innerHTML = A === null || !C ? '<span class="g-none">—</span>' : `<span style="color:var(--corr)">${pct((A + C) / a.total)}</span>`;
    }
  };
  $$('form[data-class]', main).forEach((form) => {
    $$('tr[data-sid]', form).forEach(refreshRow);
    form.addEventListener('input', (e) => { const tr = e.target.closest('tr'); if (tr) refreshRow(tr); });
    form.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
      e.preventDefault();
      const col = e.target.classList.contains('inC') ? '.inC' : '.inA';
      const next = e.target.closest('tr').nextElementSibling;
      if (next) $(col, next).focus(); else form.requestSubmit();
    });
    form.onsubmit = (e) => { e.preventDefault(); act(async () => {
      const grades = $$('tr[data-sid]', form).map((tr) => ({
        studentId: Number(tr.dataset.sid),
        acquired: $('.inA', tr).value === '' ? null : $('.inA', tr).value,
        corrections: isTest ? $('.inC', tr).value : 0,
      }));
      await api('PUT', `/api/admin/assignments/${id}/grades`, { classId: Number(form.dataset.class), grades });
      toast('Grades saved'); route();
    }, $('.error', form), $('button', form)); };
  });

  $('#edit').onclick = () => {
    const m = openModal(`${modalHead('Edit assignment')}<form class="modal-body" id="ef">${assignmentForm(o.classes, { ...a, classIds: full.classIds })}
      <p class="muted small">Unticking a class removes the grades entered for it.</p>
      <div class="row" style="justify-content:flex-end"><button type="button" class="secondary" data-close>Cancel</button><button>Save</button></div><div class="error" id="eerr"></div></form>`);
    $('[data-close]', m.el).onclick = m.close;
    $('#ef').onsubmit = (e) => { e.preventDefault(); act(async () => {
      await api('PATCH', `/api/admin/assignments/${id}`, readAssignmentForm($('#ef')));
      m.close(); toast('Assignment updated'); route();
    }, $('#eerr'), $('#ef button:last-of-type')); };
  };
  $('#del').onclick = async () => {
    if (!(await confirmBox(`Delete <b>${esc(a.title)}</b> and every grade entered for it?`, 'Delete assignment'))) return;
    act(async () => { await api('DELETE', `/api/admin/assignments/${id}`); toast('Assignment deleted'); location.hash = '#assignments'; });
  };
}

// ---------- admin: settings ----------
async function adminSettings(main) {
  const o = await api('GET', '/api/admin/overview');
  main.innerHTML = `<div class="page-head"><h1>Settings</h1></div>
    <div class="card"><h3>Test correction points</h3>
      <p class="muted" style="margin-top:0">Correction points are always shown separately from the original test score. Choose whether they also count toward class averages.</p>
      <div class="checks"><label><input type="checkbox" id="cin" ${o.settings.correctionsInAverage ? 'checked' : ''}> Include correction points in class averages</label></div>
      <p class="muted small">On: average = Σ(A + corrections) ÷ ΣT. Off: average = ΣA ÷ ΣT.</p></div>
    <div class="card"><h3>How grades are calculated</h3>
      <p style="margin:0">Each assignment's grade is <b>A ÷ T</b> (acquired ÷ total). A student's class average is <b>the sum of all A ÷ the sum of all T</b> across graded assignments in that class — so a 100-point test counts more than a 10-point worksheet, and nothing is weighted beyond that. Assignments with no score entered yet are left out.</p></div>`;
  $('#cin').onchange = (e) => act(async () => { await api('PUT', '/api/admin/settings', { correctionsInAverage: e.target.checked }); toast('Saved'); });
}

boot();

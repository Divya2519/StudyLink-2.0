const databaseKey = 'student-lms-db-v1';
const sessionKey = 'student-lms-active-user';
const themeKey = 'studylink-theme-v2';
const weekdays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
function preferredTheme() { const saved = localStorage.getItem(themeKey); return ['light','dark'].includes(saved) ? saved : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
function applyTheme(theme) { document.documentElement.dataset.theme = theme; localStorage.setItem(themeKey,theme); }
applyTheme(preferredTheme());
const emptyDatabase = {
  users: [],
  classes: [],
  assignments: [],
  submissions: [],
  announcements: [],
  resources: [],
  timetables: [],
};
const state = {
  route: getRoute(),
  authMode: 'login',
  authError: '',
  database: loadDatabase(),
  activeUserId: localStorage.getItem(sessionKey),
};
function loadDatabase() {
  try {
    return { ...structuredClone(emptyDatabase), ...(JSON.parse(localStorage.getItem(databaseKey)) || {}) };
  } catch {
    return structuredClone(emptyDatabase);
  }
}
function saveDatabase() {
  localStorage.setItem(databaseKey, JSON.stringify(state.database));
}
// Assignment and resource attachments are stored as Blobs in IndexedDB. Existing announcement files remain untouched.
const attachmentDbName = 'studylink-announcement-files-v1';
const attachmentStoreName = 'files';
const allowedAttachmentExtensions = /\.(pdf|doc|docx)$/i;
const maxAttachmentSize = 15 * 1024 * 1024; // 15 MB per file
function openAttachmentDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(attachmentDbName, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(attachmentStoreName)) {
        db.createObjectStore(attachmentStoreName, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function saveAttachment(file, ownerId) {
  const db = await openAttachmentDb();
  try {
    const id = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(attachmentStoreName, 'readwrite');
      tx.objectStore(attachmentStoreName).put({ id, ownerId, name: file.name, type: file.type, blob: file });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return { id, name: file.name, type: file.type, size: file.size };
  } finally { db.close(); }
}
async function getAttachment(id) {
  const db = await openAttachmentDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(attachmentStoreName, 'readonly');
      const request = tx.objectStore(attachmentStoreName).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
async function deleteAttachments(ids) {
  if (!ids.length) return;
  const db = await openAttachmentDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(attachmentStoreName, 'readwrite');
      const store = tx.objectStore(attachmentStoreName);
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
function safeWebLink(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}
function renderFileActions(item) {
  const files = (item.attachments || []).map((file) => `
    <button type="button" class="file-action" data-open-attachment="${escapeHtml(file.id)}" title="Download ${escapeHtml(file.name)}">
      <span class="file-action-name">${escapeHtml(file.name)}</span><span class="file-action-label">Download</span>
    </button>`).join('');
  const url = safeWebLink(item.link || '');
  return files || url ? `<div class="file-actions">${files}${url ? `<a class="file-action" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><span class="file-action-name">Reference link</span><span class="file-action-label">Open ↗</span></a>` : ''}</div>` : '';
}
function validateFiles(files) {
  for (const file of files) {
    if (!allowedAttachmentExtensions.test(file.name)) throw new Error('Only PDF, DOC and DOCX files are supported.');
    if (file.size > maxAttachmentSize) throw new Error(`${file.name} exceeds the 15 MB limit.`);
  }
}
async function createWithFiles(collection, item, files, button) {
  const attachments = [];
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = 'Saving...';
  try {
    for (const file of files) attachments.push(await saveAttachment(file, item.id));
    item.attachments = attachments;
    state.database[collection].unshift(item);
    try { saveDatabase(); } catch (error) { state.database[collection].shift(); throw error; }
    render();
  } catch (error) {
    console.error('File save failed:', error);
    try { await deleteAttachments(attachments.map((file) => file.id)); } catch (cleanupError) { console.error(cleanupError); }
    alert('Could not save the item: ' + (error.message || 'Check browser storage permissions and free space.'));
    button.disabled = false;
    button.textContent = previous;
  }
}
function getRoute() {
  return window.location.hash.replace('#', '') || '/dashboard';
}
function navigate(route) {
  window.location.hash = route;
}
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function formatDate(value) {
  if (!value) return 'No date';
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
function getUser() {
  return state.database.users.find((user) => user.id === state.activeUserId) || null;
}
function getMyClasses() {
  const user = getUser();
  if (!user) return [];
  if (user.role === 'teacher') {
    return state.database.classes.filter((item) => item.teacherId === user.id);
  }
  return state.database.classes.filter((item) => item.studentIds.includes(user.id));
}
function getClassName(classId) {
  return state.database.classes.find((item) => item.id === classId)?.name || 'Unknown class';
}
function getTeacherName(teacherId) {
  return state.database.users.find((user) => user.id === teacherId)?.name || 'Teacher';
}
function classOptions() {
  return getMyClasses()
    .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
    .join('');
}
function renderNavLink(route, label) {
  return `<a href="#${route}" class="${state.route === route ? 'active' : ''}">${label}</a>`;
}
function renderLayout(page) {
  const user = getUser();
  return `
    <div class="app-shell">
      <aside class="sidebar" aria-label="Main navigation">
        <div class="brand">
          <div class="brand-icon">SL</div>
          <div>
            <strong>StudyLink</strong>
            <span>${escapeHtml(user.name)} · ${escapeHtml(user.role)}</span>
          </div>
        </div>
        <nav class="nav-links">
          ${renderNavLink('/dashboard', 'Dashboard')}
          ${renderNavLink('/classes', 'Classes')}
          ${renderNavLink('/assignments', 'Assignments')}
          ${renderNavLink('/grades', 'Grades')}
          ${renderNavLink('/announcements', 'Announcements')}
          ${renderNavLink('/resources', 'Resources')}
          ${renderNavLink('/timetable', 'Timetable')}
          ${renderNavLink('/contact', 'Contact')}
        </nav>
        <div class="sidebar-footer"><button class="logout-button" type="button" id="logout-button">Log out</button></div>
      </aside>
      <main class="content"><header class="topbar"><div class="topbar-location">STUDYLINK <span>/</span> ${escapeHtml(state.route.replace("/", "") || "dashboard")}</div><button class="theme-toggle" id="theme-toggle" type="button">${document.documentElement.dataset.theme === "dark" ? "☀ Light mode" : "☾ Dark mode"}</button></header>${page}</main>
    </div>
  `;
}
function renderAuth() {
  const isRegister = state.authMode === 'register';
  return `
    <main class="auth-page"><button class="theme-toggle auth-theme-toggle" id="theme-toggle" type="button">${document.documentElement.dataset.theme === "dark" ? "☀ Light mode" : "☾ Dark mode"}</button>
      <section class="auth-panel">
        <div class="page-heading compact">
          <span class="eyebrow">Student learning management system</span>
          <h1>${isRegister ? 'Create an LMS account.' : 'Welcome back.'}</h1>
          <p>${isRegister ? 'Register as a teacher or student to start managing classes.' : 'Log in to continue your learning workspace.'}</p>
        </div>
        <form class="auth-form" id="auth-form">
          ${isRegister ? '<label>Name<input name="name" placeholder="Full name" autocomplete="name" /></label>' : ''}
          <label>Email<input name="email" type="email" placeholder="name@example.com" autocomplete="email" /></label>
          <label>Password<input name="password" type="password" placeholder="Password" autocomplete="${isRegister ? 'new-password' : 'current-password'}" /></label>
          ${isRegister ? '<label>Role<select name="role"><option value="student">Student</option><option value="teacher">Teacher</option></select></label>' : ''}
          ${state.authError ? `<p class="form-error">${escapeHtml(state.authError)}</p>` : ''}
          <button type="submit">${isRegister ? 'Create account' : 'Log in'}</button>
        </form>
        <button class="text-button" type="button" id="switch-auth">
          ${isRegister ? 'Already have an account? Log in' : 'New here? Create an account'}
        </button>
      </section>
    </main>
  `;
}
function renderDashboard() {
  const user = getUser();
  const classes = getMyClasses();
  const classIds = classes.map((item) => item.id);
  const assignments = state.database.assignments.filter((item) => classIds.includes(item.classId));
  const announcements = state.database.announcements.filter((item) => classIds.includes(item.classId));
  const submissions = state.database.submissions.filter((item) =>
    user.role === 'teacher'
      ? assignments.some((assignment) => assignment.id === item.assignmentId)
      : item.studentId === user.id,
  );
  const pending = assignments.filter(
    (assignment) =>
      user.role === 'student' &&
      !state.database.submissions.some(
        (submission) => submission.assignmentId === assignment.id && submission.studentId === user.id,
      ),
  );
  return `
    <section class="page">
      <div class="page-heading compact">
        <span class="eyebrow">Dashboard</span>
        <h1>${user.role === 'teacher' ? 'Manage your classroom.' : 'Track your learning.'}</h1>
        <p>${user.role === 'teacher' ? 'Create classes, post assignments, and grade submissions.' : 'Join classes, submit work, and view grades.'}</p>
      </div>
      <div class="stats-grid">
        ${renderStatCard('Classes', classes.length)}
        ${renderStatCard('Assignments', assignments.length)}
        ${renderStatCard(user.role === 'teacher' ? 'Submissions' : 'Pending work', user.role === 'teacher' ? submissions.length : pending.length)}
        ${renderStatCard('Announcements', announcements.length)}
      </div>
      ${renderTodayClasses()}
      <div class="dashboard-grid">
        <section class="focus-panel stacked">
          <span class="eyebrow">Recent assignments</span>
          ${assignments.length ? assignments.slice(0, 4).map(renderMiniAssignment).join('') : renderEmptyText('No assignments yet.')}
        </section>
        <section class="focus-panel stacked">
          <span class="eyebrow">Announcements</span>
          ${announcements.length ? announcements.slice(0, 4).map(renderMiniAnnouncement).join('') : renderEmptyText('No announcements yet.')}
        </section>
      </div>
    </section>
  `;
}
function renderStatCard(label, value) {
  return `<article class="stat-card"><span>${label}</span><strong>${escapeHtml(value)}</strong></article>`;
}
function renderMiniAssignment(assignment) {
  return `<article class="mini-card"><strong>${escapeHtml(assignment.title)}</strong><span>${escapeHtml(getClassName(assignment.classId))} · Due ${formatDate(assignment.dueDate)}</span></article>`;
}
function renderMiniAnnouncement(item) {
  return `<article class="mini-card"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(getClassName(item.classId))}</span></article>`;
}
function renderEmptyText(text) {
  return `<p class="muted-text">${escapeHtml(text)}</p>`;
}
function renderClasses() {
  const user = getUser();
  const classes = getMyClasses();
  return `
    <section class="page">
      <div class="page-heading compact">
        <span class="eyebrow">Classes</span>
        <h1>${user.role === 'teacher' ? 'Create and manage classes.' : 'Join your classes.'}</h1>
      </div>
      <div class="notes-layout">
        ${
          user.role === 'teacher'
            ? `<form class="note-form" id="class-form"><label>Class name<input name="name" placeholder="Grade 10 Science" /></label><label>Section<input name="section" placeholder="A / Morning batch" /></label><button type="submit">Create class</button></form>`
            : `<form class="note-form" id="join-class-form"><label>Class code<input name="code" placeholder="Enter teacher class code" /></label><button type="submit">Join class</button></form>`
        }
        <div class="notes-panel"><div class="note-list">${classes.length ? classes.map(renderClassCard).join('') : '<div class="empty-state"><p>No classes yet.</p></div>'}</div></div>
      </div>
    </section>
  `;
}
function renderClassCard(item) {
  return `
    <article class="note-card">
      <div class="note-card-header">
        <div><span>${escapeHtml(item.section || 'No section')} · ${escapeHtml(getTeacherName(item.teacherId))}</span><h2>${escapeHtml(item.name)}</h2></div>
        ${getUser().role === 'teacher' ? `<button class="icon-button" type="button" data-delete-class="${escapeHtml(item.id)}" title="Delete class">X</button>` : ''}
      </div>
      <p>Class code: <strong>${escapeHtml(item.code)}</strong></p>
      <p>${item.studentIds.length} students enrolled</p>
    </article>
  `;
}
function renderAssignments() {
  const user = getUser();
  const classes = getMyClasses();
  const classIds = classes.map((item) => item.id);
  const assignments = state.database.assignments.filter((item) => classIds.includes(item.classId));
  return `
    <section class="page">
      <div class="page-heading compact"><span class="eyebrow">Assignments</span><h1>${user.role === 'teacher' ? 'Post assignments and review work.' : 'Submit your assignments.'}</h1></div>
      <div class="notes-layout">
        ${user.role === 'teacher'
          ? `<form class="note-form" id="assignment-form">
              <label>Class<select name="classId">${classOptions()}</select></label>
              <label>Title<input name="title" placeholder="Chapter 4 worksheet" required /></label>
              <label>Description<textarea name="description" rows="4" placeholder="Instructions for students"></textarea></label>
              <label>Due date<input name="dueDate" type="date" value="${today()}" /></label>
              <label>Points<input name="points" type="number" min="1" value="100" /></label>
              <label>Reference link (optional)<input name="link" type="url" placeholder="https\://example.com" /></label>
              <label>Attach files<input name="attachments" type="file" accept=".pdf,.doc,.docx" multiple /></label>
              <small class="upload-hint">PDF, DOC or DOCX · Up to 15 MB per file</small>
              <button type="submit">Post assignment</button>
            </form>`
          : '<div class="note-form"><p>Select an assignment and submit your answer from the list.</p></div>'}
        <div class="notes-panel"><div class="note-list">${assignments.length ? assignments.map(renderAssignmentCard).join('') : '<div class="empty-state"><p>No assignments yet.</p></div>'}</div></div>
      </div>
    </section>`;
}
function renderAssignmentCard(assignment) {
  const user = getUser();
  const submissions = state.database.submissions.filter((item) => item.assignmentId === assignment.id);
  const mySubmission = submissions.find((item) => item.studentId === user.id);
  return `
    <article class="note-card">
      <div class="note-card-header">
        <div><span>${escapeHtml(getClassName(assignment.classId))} · ${assignment.points} points</span><h2>${escapeHtml(assignment.title)}</h2></div>
        ${user.role === 'teacher' ? `<button class="icon-button" type="button" data-delete-assignment="${escapeHtml(assignment.id)}" title="Delete assignment">X</button>` : ''}
      </div>
      <p>${escapeHtml(assignment.description || 'No description added.')}</p>
      <small class="priority priority-medium">Due ${formatDate(assignment.dueDate)}</small>
      ${renderFileActions(assignment)}
      ${
        user.role === 'student'
          ? `<form class="inline-form" data-submit-assignment="${escapeHtml(assignment.id)}"><textarea name="answer" rows="3" placeholder="Write your submission here">${escapeHtml(mySubmission?.answer || '')}</textarea><button type="submit">${mySubmission ? 'Update submission' : 'Submit work'}</button></form>`
          : `<div class="submission-list"><strong>${submissions.length} submissions</strong>${submissions.length ? submissions.map(renderSubmissionForTeacher).join('') : '<p>No student submissions yet.</p>'}</div>`
      }
    </article>
  `;
}
function renderSubmissionForTeacher(submission) {
  const student = state.database.users.find((user) => user.id === submission.studentId);
  return `
    <form class="mini-card grade-form" data-grade-submission="${escapeHtml(submission.id)}">
      <strong>${escapeHtml(student?.name || 'Student')}</strong>
      <span>${escapeHtml(submission.answer)}</span>
      <label>Grade<input name="grade" type="number" min="0" value="${escapeHtml(submission.grade || '')}" /></label>
      <label>Feedback<input name="feedback" value="${escapeHtml(submission.feedback || '')}" placeholder="Feedback" /></label>
      <button type="submit">Save grade</button>
    </form>
  `;
}
function renderGrades() {
  const user = getUser();
  const classes = getMyClasses();
  const classIds = classes.map((item) => item.id);
  const assignments = state.database.assignments.filter((item) => classIds.includes(item.classId));
  const submissions =
    user.role === 'teacher'
      ? state.database.submissions.filter((item) => assignments.some((assignment) => assignment.id === item.assignmentId))
      : state.database.submissions.filter((item) => item.studentId === user.id);
  return `<section class="page"><div class="page-heading compact"><span class="eyebrow">Grades</span><h1>${user.role === 'teacher' ? 'Review graded submissions.' : 'View your marks.'}</h1></div><div class="note-list">${submissions.length ? submissions.map(renderGradeCard).join('') : '<div class="empty-state"><p>No grades yet.</p></div>'}</div></section>`;
}
function renderGradeCard(submission) {
  const assignment = state.database.assignments.find((item) => item.id === submission.assignmentId);
  const student = state.database.users.find((user) => user.id === submission.studentId);
  return `<article class="note-card"><span>${escapeHtml(getClassName(assignment?.classId))} · ${escapeHtml(student?.name || 'Student')}</span><h2>${escapeHtml(assignment?.title || 'Assignment')}</h2><p>Grade: <strong>${escapeHtml(submission.grade || 'Not graded yet')}</strong> / ${escapeHtml(assignment?.points || 100)}</p><p>Feedback: ${escapeHtml(submission.feedback || 'No feedback yet.')}</p></article>`;
}
function renderAnnouncements() {
  const user = getUser();
  const classes = getMyClasses();
  const classIds = classes.map((item) => item.id);
  const announcements = state.database.announcements.filter((item) => classIds.includes(item.classId));
  return `
    <section class="page">
      <div class="page-heading compact"><span class="eyebrow">Announcements</span><h1>Class updates and reminders.</h1></div>
      <div class="notes-layout">
        ${user.role === 'teacher' ? `<form class="note-form" id="announcement-form"><label>Class<select name="classId">${classOptions()}</select></label><label>Title<input name="title" placeholder="Exam schedule" /></label><label>Message<textarea name="message" rows="5" placeholder="Announcement details"></textarea></label><button type="submit">Post announcement</button></form>` : '<div class="note-form"><p>Your teachers announcements appear here.</p></div>'}
        <div class="notes-panel"><div class="note-list">${announcements.length ? announcements.map(renderAnnouncementCard).join('') : '<div class="empty-state"><p>No announcements yet.</p></div>'}</div></div>
      </div>
    </section>`;
}
function renderAnnouncementCard(item) {
  return `<article class="note-card"><div class="note-card-header"><div><span>${escapeHtml(getClassName(item.classId))} · ${formatDate(item.createdAt)}</span><h2>${escapeHtml(item.title)}</h2></div>${getUser().role === 'teacher' ? `<button class="icon-button" type="button" data-delete-announcement="${escapeHtml(item.id)}" title="Delete announcement">X</button>` : ''}</div><p>${escapeHtml(item.message)}</p></article>`;
}
function renderResources() {
  const user = getUser();
  const classes = getMyClasses();
  const classIds = classes.map((item) => item.id);
  const resources = state.database.resources.filter((item) => classIds.includes(item.classId));
  return `
    <section class="page">
      <div class="page-heading compact"><span class="eyebrow">Resources</span><h1>Study material and useful links.</h1></div>
      <div class="notes-layout">
        ${user.role === 'teacher' ? `<form class="note-form" id="resource-form">
          <label>Class<select name="classId">${classOptions()}</select></label>
          <label>Title<input name="title" placeholder="Chapter notes" required /></label>
          <label>Type<select name="type"><option>PDF</option><option>Video</option><option>Link</option><option>Document</option></select></label>
          <label>Reference link (optional)<input name="link" type="url" placeholder="https\://example.com" /></label>
          <label>Attach files<input name="attachments" type="file" accept=".pdf,.doc,.docx" multiple /></label>
          <small class="upload-hint">PDF, DOC or DOCX · Up to 15 MB per file</small>
          <button type="submit">Add resource</button>
        </form>` : '<div class="note-form"><p>Resources shared by teachers appear here.</p></div>'}
        <div class="notes-panel"><div class="note-list">${resources.length ? resources.map(renderResourceCard).join('') : '<div class="empty-state"><p>No resources yet.</p></div>'}</div></div>
      </div>
    </section>`;
}
function renderResourceCard(item) {
  return `<article class="note-card"><div class="note-card-header"><div><span>${escapeHtml(getClassName(item.classId))} · ${escapeHtml(item.type)}</span><h2>${escapeHtml(item.title)}</h2></div>${getUser().role === 'teacher' ? `<button class="icon-button" type="button" data-delete-resource="${escapeHtml(item.id)}" title="Delete resource">X</button>` : ''}</div>${renderFileActions(item) || '<p>No files or links added.</p>'}</article>`;
}
function renderContact() {
  return `<section class="page"><div class="page-heading compact"><span class="eyebrow">Contact</span><h1>Need help?</h1><p>Send a message to your teacher, school, or support team.</p></div><form class="contact-form"><label>Name<input placeholder="Your name" /></label><label>Email<input type="email" placeholder="name@example.com" /></label><label>Message<textarea rows="6" placeholder="Write your message"></textarea></label><button type="button">Send message</button></form></section>`;
}
function render() {
  state.route = getRoute();
  if (!getUser()) {
    document.getElementById('root').innerHTML = renderAuth();
    bindThemeToggle();
    bindAuthEvents();
    return;
  }
  const pages = {
    '/dashboard': renderDashboard,
    '/classes': renderClasses,
    '/assignments': renderAssignments,
    '/grades': renderGrades,
    '/announcements': renderAnnouncements,
    '/resources': renderResources,
    '/timetable': renderTimetable,
    '/contact': renderContact,
  };
  document.getElementById('root').innerHTML = renderLayout((pages[state.route] || renderDashboard)());
  bindEvents();
}
function bindAuthEvents() {
  document.getElementById('switch-auth')?.addEventListener('click', () => {
    state.authError = '';
    state.authMode = state.authMode === 'login' ? 'register' : 'login';
    render();
  });
  document.getElementById('auth-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') || '').trim().toLowerCase();
    const password = String(data.get('password') || '').trim();
    const name = String(data.get('name') || '').trim();
    const role = String(data.get('role') || 'student');
    if (!email || !password || (state.authMode === 'register' && !name)) {
      state.authError = 'Please fill in all required fields.';
      render();
      return;
    }
    if (state.authMode === 'register') {
      if (state.database.users.some((user) => user.email === email)) {
        state.authError = 'An account already exists with this email.';
        render();
        return;
      }
      const user = { id: crypto.randomUUID(), name, email, password, role };
      state.database.users.push(user);
      state.activeUserId = user.id;
      localStorage.setItem(sessionKey, user.id);
      saveDatabase();
      navigate('/dashboard');
      render();
      return;
    }
    const user = state.database.users.find((account) => account.email === email && account.password === password);
    if (!user) {
      state.authError = 'Email or password is incorrect.';
      render();
      return;
    }
    state.activeUserId = user.id;
    localStorage.setItem(sessionKey, user.id);
    navigate('/dashboard');
    render();
  });
}
function bindEvents() {
  document.getElementById('logout-button')?.addEventListener('click', () => {
    state.activeUserId = '';
    localStorage.removeItem(sessionKey);
    state.authMode = 'login';
    navigate('/dashboard');
    render();
  });
  bindThemeToggle();
  bindTimetableEvents();
  bindClassForms();
  bindAssignmentForms();
  bindAnnouncementForm();
  bindResourceForm();
  bindDeleteButtons();
  bindAttachmentButtons();
}
function bindClassForms() {
  document.getElementById('class-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const name = String(data.get('name') || '').trim();
    if (!name) return;
    state.database.classes.unshift({
      id: crypto.randomUUID(),
      name,
      section: String(data.get('section') || '').trim(),
      teacherId: getUser().id,
      studentIds: [],
      code: Math.random().toString(36).slice(2, 8).toUpperCase(),
    });
    saveDatabase();
    render();
  });
  document.getElementById('join-class-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') || '').trim().toUpperCase();
    const classItem = state.database.classes.find((item) => item.code === code);
    if (!classItem) return;
    if (!classItem.studentIds.includes(getUser().id)) classItem.studentIds.push(getUser().id);
    saveDatabase();
    render();
  });
}
function bindAssignmentForms() {
  document.getElementById('assignment-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const title = String(data.get('title') || '').trim();
    const classId = String(data.get('classId') || '');
    if (!title || !classId) { alert('Choose a class and enter a title.'); return; }
    const linkText = String(data.get('link') || '').trim();
    const link = linkText ? safeWebLink(linkText) : '';
    if (linkText && !link) { alert('Enter a valid http\:// or https\:// link.'); return; }
    const files = Array.from(form.querySelector('[name="attachments"]').files || []);
    try { validateFiles(files); } catch (error) { alert(error.message); return; }
    await createWithFiles('assignments', {
      id: crypto.randomUUID(), classId, title,
      description: String(data.get('description') || '').trim(),
      dueDate: String(data.get('dueDate') || today()),
      points: Number(data.get('points') || 100), link,
    }, files, form.querySelector('button[type="submit"]'));
  });
  document.querySelectorAll('[data-submit-assignment]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const assignmentId = form.dataset.submitAssignment;
      const answer = String(new FormData(form).get('answer') || '').trim();
      if (!answer) return;
      const existing = state.database.submissions.find(
        (item) => item.assignmentId === assignmentId && item.studentId === getUser().id,
      );
      if (existing) {
        existing.answer = answer;
        existing.submittedAt = today();
      } else {
        state.database.submissions.unshift({
          id: crypto.randomUUID(),
          assignmentId,
          studentId: getUser().id,
          answer,
          submittedAt: today(),
          grade: '',
          feedback: '',
        });
      }
      saveDatabase();
      render();
    });
  });
  document.querySelectorAll('[data-grade-submission]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const submission = state.database.submissions.find((item) => item.id === form.dataset.gradeSubmission);
      if (!submission) return;
      const data = new FormData(form);
      submission.grade = String(data.get('grade') || '').trim();
      submission.feedback = String(data.get('feedback') || '').trim();
      saveDatabase();
      render();
    });
  });
}
function bindAnnouncementForm() {
  document.getElementById('announcement-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get('title') || '').trim();
    const classId = String(data.get('classId') || '');
    if (!title || !classId) return;
    state.database.announcements.unshift({
      id: crypto.randomUUID(), classId, title,
      message: String(data.get('message') || '').trim(), createdAt: today(),
    });
    saveDatabase();
    render();
  });
}
function bindAttachmentButtons() {
  document.querySelectorAll('[data-open-attachment]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        const file = await getAttachment(button.dataset.openAttachment);
        if (!file) { alert('Attachment not found in this browser.'); return; }
        const url = URL.createObjectURL(file.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (error) {
        console.error(error);
        alert('Could not open this attachment.');
      }
    });
  });
}
function bindResourceForm() {
  document.getElementById('resource-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const title = String(data.get('title') || '').trim();
    const classId = String(data.get('classId') || '');
    if (!title || !classId) { alert('Choose a class and enter a title.'); return; }
    const linkText = String(data.get('link') || '').trim();
    const link = linkText ? safeWebLink(linkText) : '';
    if (linkText && !link) { alert('Enter a valid http\:// or https\:// link.'); return; }
    const files = Array.from(form.querySelector('[name="attachments"]').files || []);
    try { validateFiles(files); } catch (error) { alert(error.message); return; }
    if (!link && !files.length) { alert('Add a file or a reference link.'); return; }
    await createWithFiles('resources', {
      id: crypto.randomUUID(), classId, title,
      type: String(data.get('type') || 'Link'), link,
    }, files, form.querySelector('button[type="submit"]'));
  });
}
function bindDeleteButtons() {
  const deleteById = (collection, id) => {
    state.database[collection] = state.database[collection].filter((item) => item.id !== id);
  };
  document.querySelectorAll('[data-delete-class]').forEach((button) => {
    button.addEventListener('click', () => {
      deleteById('classes', button.dataset.deleteClass);
      const removedAssignments = state.database.assignments.filter((item) => item.classId === button.dataset.deleteClass);
      state.database.assignments = state.database.assignments.filter((item) => item.classId !== button.dataset.deleteClass);
      deleteAttachments(removedAssignments.flatMap((item) => (item.attachments || []).map((file) => file.id))).catch(console.error);
      const removedAnnouncements = state.database.announcements.filter((item) => item.classId === button.dataset.deleteClass);
      state.database.announcements = state.database.announcements.filter((item) => item.classId !== button.dataset.deleteClass);
      deleteAttachments(removedAnnouncements.flatMap((item) => (item.attachments || []).map((file) => file.id))).catch(console.error);
      const removedResources = state.database.resources.filter((item) => item.classId === button.dataset.deleteClass);
      state.database.resources = state.database.resources.filter((item) => item.classId !== button.dataset.deleteClass);
      deleteAttachments(removedResources.flatMap((item) => (item.attachments || []).map((file) => file.id))).catch(console.error);
      saveDatabase();
      render();
    });
  });
  document.querySelectorAll('[data-delete-assignment]').forEach((button) => {
    button.addEventListener('click', () => {
      const assignment = state.database.assignments.find((item) => item.id === button.dataset.deleteAssignment);
      deleteById('assignments', button.dataset.deleteAssignment);
      deleteAttachments((assignment?.attachments || []).map((file) => file.id)).catch(console.error);
      state.database.submissions = state.database.submissions.filter((item) => item.assignmentId !== button.dataset.deleteAssignment);
      saveDatabase();
      render();
    });
  });
  document.querySelectorAll('[data-delete-announcement]').forEach((button) => {
    button.addEventListener('click', () => {
      const announcement = state.database.announcements.find((item) => item.id === button.dataset.deleteAnnouncement);
      deleteById('announcements', button.dataset.deleteAnnouncement);
      saveDatabase();
      deleteAttachments((announcement?.attachments || []).map((file) => file.id)).catch(console.error);
      render();
    });
  });
  document.querySelectorAll('[data-delete-resource]').forEach((button) => {
    button.addEventListener('click', () => {
      const resource = state.database.resources.find((item) => item.id === button.dataset.deleteResource);
      deleteById('resources', button.dataset.deleteResource);
      deleteAttachments((resource?.attachments || []).map((file) => file.id)).catch(console.error);
      saveDatabase();
      render();
    });
  });
}

function bindThemeToggle() {
  document.getElementById('theme-toggle')?.addEventListener('click', () => {
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    render();
  });
}
function timeToMinutes(time) { const [h,m] = time.split(':').map(Number); return h * 60 + m; }
function prettyTime(time) { return new Date(`2000-01-01T${time}:00`).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'}); }
function getTimetableEntries() {
  const ids = new Set(getMyClasses().map(c => c.id));
  return (state.database.timetables || []).filter(e => ids.has(e.classId));
}
function renderTodayClasses() {
  const day = new Date().toLocaleDateString('en-US',{weekday:'long'});
  const entries = getTimetableEntries().filter(e => e.day === day).sort((a,b)=>a.startTime.localeCompare(b.startTime));
  const now = new Date(); const minutes = now.getHours()*60 + now.getMinutes();
  return `<section class="focus-panel stacked today-panel"><div class="section-header"><div><span class="eyebrow">Your schedule</span><h2>Today's classes</h2></div><a class="subtle-link" href="#/timetable">View timetable →</a></div><div class="today-list">${entries.length ? entries.map(e=>`<div class="today-item"><div class="time-chip">${prettyTime(e.startTime)}</div><div><strong>${escapeHtml(e.subject)}</strong><span>${escapeHtml(getClassName(e.classId))} · ${escapeHtml(e.room || 'Room not specified')}</span></div><span class="status-pill">${minutes >= timeToMinutes(e.endTime) ? 'Completed' : minutes >= timeToMinutes(e.startTime) ? 'Ongoing' : 'Upcoming'}</span></div>`).join('') : '<p class="muted-text">No classes scheduled for today.</p>'}</div></section>`;
}
function renderTimetable() {
  const user = getUser();
  const classes = getMyClasses();
  const entries = getTimetableEntries();
  const form = user.role === 'teacher' ? `<form class="note-form" id="timetable-form"><div class="form-title">Add a class session</div><input type="hidden" name="entryId" value=""><label>Class<select name="classId" required>${classOptions()}</select></label><label>Subject<input name="subject" required maxlength="100" placeholder="e.g. Database Management"></label><label>Day<select name="day">${weekdays.map(d=>`<option>${d}</option>`).join('')}</select></label><div class="form-two"><label>Start time<input name="startTime" type="time" value="09:00" required></label><label>End time<input name="endTime" type="time" value="10:00" required></label></div><label>Room / location<input name="room" maxlength="80" placeholder="e.g. Lab 204"></label><button type="submit" id="save-timetable">Add session</button><button class="secondary-button" id="cancel-timetable-edit" type="button" hidden>Cancel editing</button><small class="upload-hint">Sessions repeat every week, Monday to Saturday.</small></form>` : `<div class="note-form"><div class="form-title">Your weekly schedule</div><p>View sessions published by your teachers. Timetable editing is available to teachers only.</p></div>`;
  return `<section class="page timetable-page"><div class="page-heading compact"><span class="eyebrow">Weekly planner</span><h1>Class timetable.</h1><p>Your academic week, organised in one place.</p></div><div class="timetable-layout">${form}<div class="timetable-main"><div class="notes-panel timetable-panel"><div class="section-header"><div><span class="eyebrow">Monday to Saturday</span><h2>Weekly schedule</h2></div><label class="timetable-filter">Class<select id="timetable-class-filter"><option value="all">All classes</option>${classes.map(c=>`<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}</option>`).join('')}</select></label></div><div class="week-grid">${weekdays.map(day=>`<section class="day-column"><div class="day-label">${day}</div><div class="day-items">${entries.filter(e=>e.day===day).sort((a,b)=>a.startTime.localeCompare(b.startTime)).map(e=>`<article class="schedule-card" data-class-id="${escapeHtml(e.classId)}"><span class="schedule-time">${prettyTime(e.startTime)} – ${prettyTime(e.endTime)}</span><strong>${escapeHtml(e.subject)}</strong><span class="schedule-meta">${escapeHtml(getClassName(e.classId))}</span><span class="schedule-meta">${escapeHtml(e.room || 'Room not specified')}</span>${user.role==='teacher' ? `<div class="schedule-actions"><button type="button" data-edit-timetable="${escapeHtml(e.id)}">Edit</button><button type="button" data-delete-timetable="${escapeHtml(e.id)}">Delete</button></div>` : ''}</article>`).join('') || '<p class="day-empty">No sessions</p>'}</div></section>`).join('')}</div></div></div></div></section>`;
}
function bindTimetableEvents() {
  document.getElementById('timetable-form')?.addEventListener('submit', event => {
    event.preventDefault();
    if (getUser().role !== 'teacher') return;
    const form = event.currentTarget, data = new FormData(form);
    const id = String(data.get('entryId') || '');
    const classId = String(data.get('classId') || '');
    const subject = String(data.get('subject') || '').trim();
    const day = String(data.get('day') || '');
    const startTime = String(data.get('startTime') || '');
    const endTime = String(data.get('endTime') || '');
    const room = String(data.get('room') || '').trim();
    if (!getMyClasses().some(c=>c.id===classId) || !subject || !weekdays.includes(day) || !startTime || !endTime) { alert('Please complete all required fields.'); return; }
    if (timeToMinutes(startTime) >= timeToMinutes(endTime)) { alert('End time must be later than start time.'); return; }
    const conflict = (state.database.timetables || []).some(e => e.id !== id && e.classId === classId && e.day === day && timeToMinutes(startTime) < timeToMinutes(e.endTime) && timeToMinutes(endTime) > timeToMinutes(e.startTime));
    if (conflict) { alert('This class already has a session during that time.'); return; }
    const entry = {id:id || crypto.randomUUID(),classId,subject,day,startTime,endTime,room};
    if (id) { const index = state.database.timetables.findIndex(e=>e.id===id); if(index<0) return; state.database.timetables[index]=entry; }
    else state.database.timetables.push(entry);
    saveDatabase(); render();
  });
  document.getElementById('timetable-class-filter')?.addEventListener('change', event => {
    document.querySelectorAll('.schedule-card').forEach(card => card.hidden = event.target.value !== 'all' && card.dataset.classId !== event.target.value);
  });
  document.querySelectorAll('[data-edit-timetable]').forEach(button=>button.addEventListener('click',()=>{
    if(getUser().role!=='teacher') return;
    const e = state.database.timetables.find(x=>x.id===button.dataset.editTimetable); if(!e) return;
    const form = document.getElementById('timetable-form'); if(!form) return;
    for(const key of ['classId','subject','day','startTime','endTime','room']) form.elements[key].value=e[key]||'';
    form.elements.entryId.value=e.id;
    document.getElementById('save-timetable').textContent='Save changes';
    document.getElementById('cancel-timetable-edit').hidden=false;
    form.scrollIntoView({behavior:'smooth',block:'center'});
  }));
  document.getElementById('cancel-timetable-edit')?.addEventListener('click',()=>render());
  document.querySelectorAll('[data-delete-timetable]').forEach(button=>button.addEventListener('click',()=>{
    if(getUser().role!=='teacher' || !confirm('Delete this timetable session?')) return;
    state.database.timetables=state.database.timetables.filter(e=>e.id!==button.dataset.deleteTimetable);
    saveDatabase();render();
  }));
}

window.addEventListener('hashchange', render);
if (!window.location.hash) {
  navigate('/dashboard');
}
render();
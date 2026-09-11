import './style.css';

const app = document.querySelector('#app');
const key = 'kampus-yoklama-admin-v1';
let auth = JSON.parse(localStorage.getItem(key) || 'null');
const safe = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' }[char]));
const api = (url, options = {}) => fetch(url, { ...options, headers: { 'content-type':'application/json', ...(auth?.token ? { authorization:`Bearer ${auth.token}` } : {}) } });
const notice = (message, ok = true) => `<div class="result ${ok ? 'yes' : 'no'}" style="display:block;margin-top:12px">${safe(message)}</div>`;
let reportFilters = { from: '', to: '', instructorId: '', category: '' };
const reportQuery = () => new URLSearchParams(Object.entries(reportFilters).filter(([, value]) => value)).toString();
const shortDateTime = value => new Intl.DateTimeFormat('tr-TR',{dateStyle:'short',timeStyle:'short'}).format(new Date(value));

function reportControls() {
  return `<section class="card" style="margin-top:24px"><div class="section-head"><div><p class="eyebrow">YÖNETİM RAPORLARI</p><h2>İşlem günlüğü ve istatistik filtreleri</h2></div><button class="ghost" id="report-today">Bugün</button></div><div style="display:grid;grid-template-columns:1fr 1fr 1.2fr 1.2fr auto auto;gap:12px;align-items:end"><label>Başlangıç tarihi<input id="report-from" type="date" value="${safe(reportFilters.from)}"></label><label>Bitiş tarihi<input id="report-to" type="date" value="${safe(reportFilters.to)}"></label><label>Öğretim elemanı<select id="report-instructor"><option value="">Tüm hocalar</option></select></label><label>İşlem türü<select id="report-category"><option value="">Tüm işlemler</option><option value="authentication">Girişler</option><option value="attendance">Yoklama</option><option value="account">Hesap işlemleri</option><option value="administration">Yönetim işlemleri</option></select></label><button class="primary" id="apply-reports">Uygula</button><button class="ghost" id="clear-reports">Temizle</button></div></section>`;
}

function reportPanels() {
  return `<section class="card" style="margin-top:24px"><div class="section-head"><div><p class="eyebrow">İSTATİSTİKLER</p><h2>Seçili dönem özeti</h2></div><span class="pill" id="report-period">Tüm zamanlar</span></div><div class="grid stats" id="statistics-cards" style="margin-bottom:28px"></div><div style="overflow:auto"><table style="width:100%;border-collapse:collapse;text-align:left"><thead><tr><th style="padding:12px;border-bottom:1px solid #ddd">Tarih</th><th style="padding:12px;border-bottom:1px solid #ddd">Benzersiz giriş</th><th style="padding:12px;border-bottom:1px solid #ddd">Yoklama alınan ders</th><th style="padding:12px;border-bottom:1px solid #ddd">Yoklama kaydı</th><th style="padding:12px;border-bottom:1px solid #ddd">Benzersiz öğrenci</th></tr></thead><tbody id="daily-statistics"><tr><td colspan="5" style="padding:18px;color:#777">İstatistikler yükleniyor…</td></tr></tbody></table></div></section><section class="card" style="margin-top:24px"><div class="section-head"><div><p class="eyebrow">DENETİM GÜNLÜĞÜ</p><h2>Kim, ne zaman, ne yaptı?</h2></div><span class="pill" id="audit-count">—</span></div><div style="overflow:auto"><table style="width:100%;border-collapse:collapse;text-align:left"><thead><tr><th style="padding:12px;border-bottom:1px solid #ddd">Tarih / saat</th><th style="padding:12px;border-bottom:1px solid #ddd">Kullanıcı</th><th style="padding:12px;border-bottom:1px solid #ddd">İşlem</th><th style="padding:12px;border-bottom:1px solid #ddd">Ayrıntı</th></tr></thead><tbody id="audit-entries"><tr><td colspan="4" style="padding:18px;color:#777">Kayıtlar yükleniyor…</td></tr></tbody></table></div></section>`;
}

async function loadReports() {
  const query = reportQuery();
  const [auditResponse, statsResponse] = await Promise.all([api(`/api/admin/audit?${query}`), api(`/api/admin/statistics?${query}`)]);
  const auditData = await auditResponse.json().catch(() => ({})); const statsData = await statsResponse.json().catch(() => ({}));
  if (!auditResponse.ok || !statsResponse.ok) return;
  const instructor = document.querySelector('#report-instructor');
  if (instructor) { instructor.innerHTML = `<option value="">Tüm hocalar</option>${auditData.instructors.map(item => `<option value="${safe(item.id)}" ${item.id === reportFilters.instructorId ? 'selected' : ''}>${safe(item.name)} · ${safe(item.id)}</option>`).join('')}`; }
  const category = document.querySelector('#report-category'); if (category) category.value = reportFilters.category;
  const period = [reportFilters.from, reportFilters.to].filter(Boolean).join(' – ') || 'Tüm zamanlar'; const periodLabel = document.querySelector('#report-period'); if (periodLabel) periodLabel.textContent = period;
  const stats = statsData.statistics;
  const cards = document.querySelector('#statistics-cards'); if (cards) cards.innerHTML = [
    ['Benzersiz giriş', stats.uniqueInstructorLogins, 'Seçili tarihte benzersiz ağdan giriş'],
    ['Yoklama alınan ders', stats.attendanceLessons, 'Aynı ders saati bir kez sayılır'],
    ['Toplam yoklama', stats.attendanceCheckins, 'Seçili tarihte QR ile alınan kayıt'],
    ['Benzersiz öğrenci', stats.uniqueStudentsLifetime, `${stats.uniqueStudents} seçili tarihte · tüm zamanlar`],
    ['Genel katılım oranı', `%${Math.round(stats.averageParticipationRate * 100)}`, `${stats.coursesWithAttendance} ders oturumunun ortalaması`],
    ['Açılan QR oturumu', stats.qrSessionsOpened, 'Seçili tarihte'],
  ].map(([label, value, detail]) => `<article><small>${safe(label)}</small><strong>${safe(value)}</strong><span>${safe(detail)}</span></article>`).join('');
  const daily = document.querySelector('#daily-statistics'); if (daily) daily.innerHTML = stats.daily.length ? stats.daily.map(row => `<tr><td style="padding:13px;border-bottom:1px solid #eee">${safe(row.date)}</td><td style="padding:13px;border-bottom:1px solid #eee">${row.uniqueInstructorLogins}</td><td style="padding:13px;border-bottom:1px solid #eee">${row.attendanceLessons}</td><td style="padding:13px;border-bottom:1px solid #eee">${row.attendanceCheckins}</td><td style="padding:13px;border-bottom:1px solid #eee">${row.uniqueStudents}</td></tr>`).join('') : '<tr><td colspan="5" style="padding:18px;color:#777">Seçili filtrelerde kayıt yok.</td></tr>';
  const audit = document.querySelector('#audit-entries'); if (audit) audit.innerHTML = auditData.entries.length ? auditData.entries.map(item => `<tr><td style="padding:13px;border-bottom:1px solid #eee;white-space:nowrap">${safe(shortDateTime(item.at))}</td><td style="padding:13px;border-bottom:1px solid #eee"><b>${safe(item.actorName || 'Sistem')}</b><small>${safe(item.actorId || item.actorType || '—')}</small></td><td style="padding:13px;border-bottom:1px solid #eee">${safe(item.type)}</td><td style="padding:13px;border-bottom:1px solid #eee">${safe(item.detail)}</td></tr>`).join('') : '<tr><td colspan="4" style="padding:18px;color:#777">Seçili filtrelerde kayıt yok.</td></tr>';
  const count = document.querySelector('#audit-count'); if (count) count.textContent = `${auditData.entries.length} kayıt`;
}

function login() {
  app.innerHTML = `<main><section class="card" style="max-width:540px;margin:12vh auto;padding:54px 69px"><p class="eyebrow">KAMPÜS YOKLAMA · YÖNETİCİ GİRİŞİ</p><h1>Akademik takvim.</h1><p style="margin:13px 0 27px;color:var(--muted);line-height:1.5;font-size:14px">Yönetici kullanıcı adı ve şifresiyle giriş yapın.</p><label>Kullanıcı adı<input id="username" autocomplete="username" placeholder="Kullanıcı adınız"></label><label>Şifre<input id="password" type="password" autocomplete="current-password" placeholder="Şifreniz"></label><button class="primary" id="login" style="width:100%;margin-top:14px">Yönetici olarak giriş yap</button><div id="login-result"></div><p style="margin:22px 0 0"><a href="/" class="ghost">← Öğretim elemanı girişine dön</a></p></section></main>`;
  document.querySelector('#login').onclick = async () => {
    const out = document.querySelector('#login-result');
    const response = await fetch('/api/admin/login', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ username:document.querySelector('#username').value.trim(), password:document.querySelector('#password').value }) });
    const data = await response.json();
    if (!response.ok) return out.innerHTML = notice(data.error || 'Giriş yapılamadı', false);
    auth = { token:data.token, admin:data.admin, mustChangePassword:Boolean(data.passwordChangeRequired) }; localStorage.setItem(key, JSON.stringify(auth));
    auth.mustChangePassword ? passwordSetup() : load();
  };
}

function passwordSetup() {
  app.innerHTML = `<main><section class="card" style="max-width:540px;margin:12vh auto;padding:54px 69px"><p class="eyebrow">İLK YÖNETİCİ GİRİŞİ</p><h1>Yeni şifre belirleyin.</h1><p style="color:var(--muted);line-height:1.55">Devam etmek için en az 10 karakterden oluşan; harf, rakam ve özel karakter içeren bir şifre belirleyin.</p><label>Yeni şifre<input id="new-password" type="password" autocomplete="new-password"></label><button class="primary" id="save-password" style="width:100%;margin-top:14px">Şifreyi kaydet</button><div id="password-result"></div></section></main>`;
  document.querySelector('#save-password').onclick = async () => {
    const out = document.querySelector('#password-result');
    const response = await api('/api/admin/password', { method:'POST', body:JSON.stringify({ newPassword:document.querySelector('#new-password').value }) });
    const data = await response.json(); if (!response.ok) return out.innerHTML = notice(data.error, false);
    auth.mustChangePassword = false; auth.admin.passwordIsDefault = false; localStorage.setItem(key, JSON.stringify(auth)); load();
  };
}

async function load() {
  const response = await api('/api/admin/overview');
  if (response.status === 403 && auth?.mustChangePassword) return passwordSetup();
  if (!response.ok) { localStorage.removeItem(key); auth = null; return login(); }
  render(await response.json());
}

function calendarForm(calendar) {
  const years = ['2025-2026', '2026-2027', '2027-2028', '2028-2029'];
  const selectedSeason = calendar?.season || '2026-2027'; const selectedSemester = Number(calendar?.semester || 1);
  return `<section class="card" style="margin-top:24px"><div class="section-head"><div><p class="eyebrow">AKADEMİK TAKVİM</p><h2>Dönem haftalarını tanımla</h2></div><span class="pill">Yönetici yetkisi</span></div><p style="color:var(--muted);line-height:1.55;max-width:850px">Güz ve baharda 16 takvim haftası hesaplanır: 8. hafta vize, 16. hafta final olarak görünür ve QR yoklamasına kapalıdır. Yaz döneminde 7 hafta hesaplanır. Ders yapılmayan veya telafi edilen günlerde öğretmen aynı haftayı sonradan seçip yoklamayı o haftaya işleyebilir.</p><div style="display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:12px;align-items:end;margin-top:18px"><label>Akademik yıl<select id="calendar-season">${years.map(year => `<option ${year === selectedSeason ? 'selected' : ''}>${year}</option>`).join('')}</select></label><label>Dönem<select id="calendar-semester"><option value="1" ${selectedSemester === 1 ? 'selected' : ''}>Güz</option><option value="2" ${selectedSemester === 2 ? 'selected' : ''}>Bahar</option><option value="3" ${selectedSemester === 3 ? 'selected' : ''}>Yaz</option></select></label><label>1. akademik hafta başlangıcı (Pazartesi)<input id="calendar-start" type="date" value="${safe(calendar?.weekOneStart || '')}"></label><button class="primary" id="save-calendar">Takvimi etkinleştir</button></div><div id="calendar-result"></div>${calendar ? `<div class="note" style="margin-top:18px"><b>Etkin takvim:</b> ${safe(calendar.season)} · ${{1:'Güz',2:'Bahar',3:'Yaz'}[calendar.semester]} · ${calendar.weekCount} takvim haftası / ${calendar.attendanceWeekCount} yoklama haftası</div>` : '<div class="note" style="margin-top:18px">Henüz etkin bir akademik takvim yok. Öğretmenlerin QR yoklaması açabilmesi için dönem başlangıcını kaydedin.</div>'}</section>`;
}

function render(data) {
  const activeCalendar = data.calendars.find(calendar => calendar.active);
  app.innerHTML = `<main style="max-width:1220px"><header><div><p class="eyebrow">KAMPÜS YOKLAMA · YÖNETİCİ</p><h1>Akademik Takvim Merkezi</h1></div><div><span class="status"><span></span>${safe(auth.admin.name)}</span><button class="ghost" id="logout" style="margin-left:15px">Çıkış yap</button></div></header><section class="grid stats"><article><small>Öğretim elemanı</small><strong>${data.stats.instructors}</strong><span>Sistemde tanımlı</span></article><article><small>Atanmış ders</small><strong>${data.stats.courses}</strong><span>OİS’ten çekilen</span></article><article><small>Canlı yoklama</small><strong>${data.stats.activeSessions}</strong><span>${data.stats.checkins} toplam kayıt</span></article></section>${calendarForm(activeCalendar)}${reportControls()}${reportPanels()}</main>`;
  document.querySelector('#logout').onclick = () => { localStorage.removeItem(key); auth = null; login(); };
  document.querySelector('#save-calendar').onclick = async () => {
    const season = document.querySelector('#calendar-season').value, semester = document.querySelector('#calendar-semester').value, start = document.querySelector('#calendar-start').value, out = document.querySelector('#calendar-result');
    const response = await api(`/api/admin/calendars/${encodeURIComponent(season)}/${semester}`, { method:'PUT', body:JSON.stringify({ weekOneStart:start }) });
    const data = await response.json(); if (!response.ok) return out.innerHTML = notice(data.error || 'Takvim kaydedilemedi.', false);
    out.innerHTML = notice('Akademik takvim etkinleştirildi. OİS dersleri sonraki sorguda bu tarihlerle hesaplanacak.'); load();
  };
  document.querySelector('#apply-reports').onclick = () => { reportFilters = { from: document.querySelector('#report-from').value, to: document.querySelector('#report-to').value, instructorId: document.querySelector('#report-instructor').value, category: document.querySelector('#report-category').value }; loadReports(); };
  document.querySelector('#clear-reports').onclick = () => { reportFilters = { from: '', to: '', instructorId: '', category: '' }; render(data); };
  document.querySelector('#report-today').onclick = () => { const today = new Date().toISOString().slice(0, 10); reportFilters = { ...reportFilters, from: today, to: today }; render(data); };
  loadReports();
}

auth ? (auth.mustChangePassword ? passwordSetup() : load()) : login();

import express from 'express';
import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL('./data/', import.meta.url));
const DIST_DIR = fileURLToPath(new URL('./dist/', import.meta.url));
const DATABASE_URL = process.env.DATABASE_URL || '';
const { Pool } = pg;
let database = null;
const OIS_ENVIRONMENT = process.env.OBS_ENVIRONMENT === 'production' ? 'production' : 'test';
const OIS_ENVIRONMENT_LABEL = OIS_ENVIRONMENT === 'production' ? 'Canlı OİS' : 'OİS test';
// Sadece yerel testte, OİS test sunucusunun yanlış alan adlı sertifikası için geçici istisna.
// Üretim ortamında bu değer ne olursa olsun TLS doğrulaması kapatılamaz.
const OIS_TEST_TLS_BYPASS = OIS_ENVIRONMENT === 'test' && process.env.OBS_TEST_INSECURE_TLS === 'true';
// Bu tanım yalnızca OİS yöneticisinin verdiği kontrollü QR testi içindir.
// Canlı ders sorgusunu veya canlı gönderimi etkilemez; yayına alınmadan kaldırılmalıdır.
const CONTROLLED_TEST_INSTRUCTOR_ID = '2500002318';
const CONTROLLED_TEST_SEASON = '2025-2026';
const CONTROLLED_TEST_SEMESTER = 3;
const CONTROLLED_TEST_COURSE_ID = 27063;
const CONTROLLED_TEST_API_BASE = process.env.OBS_TEST_API_BASE || 'https://oistest.mudanya.edu.tr/api/crm';
const ACTIVE_ACADEMIC_YEAR = process.env.ACTIVE_ACADEMIC_YEAR || '2026-2027';
const ACTIVE_ACADEMIC_SEMESTER = Number(process.env.ACTIVE_ACADEMIC_SEMESTER || '1');
const QR_TTL = 25_000;
const CHECKIN_TICKET_TTL = 90_000;
const CLASS_TTL = 4 * 60 * 60_000;
const MAX_QR_OPENS = 5;
const TV_PAIR_TTL = 60_000;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const id = () => crypto.randomUUID();
const secret = () => crypto.randomBytes(32).toString('base64url');
const isoDate = value => value.toISOString().slice(0, 10);

function buildMeetings() {
  const start = new Date(Date.UTC(2026, 5, 15));
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index * 7);
    const dateValue = isoDate(date);
    // OİS yöneticisinin 13.07.2026 için paylaştığı test eşlemesi korunur.
    const knownOisTest = dateValue === '2026-07-13';
    return {
      id: `legacy:${index + 1}:${dateValue}:TEORI`,
      week: index + 1,
      date: dateValue,
      type: 'TEORI',
      absenceHours: knownOisTest ? 2 : 3,
      apiWeek: knownOisTest ? '1' : String(index + 1),
      absentField: 'saat',
      presentField: 'Usaat',
    };
  });
}

function buildControlledTestMeetings() {
  const start = new Date(Date.UTC(2026, 5, 15));
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(start.getUTCDate() + index * 7);
    return {
      id: `controlled-test:${index + 1}:salı:08:00`, week: index + 1, date: isoDate(date),
      day: 'Salı', startTime: '08:00', endTime: '14:00', type: 'TEORI',
      absenceHours: 6, apiWeek: String(index + 1), absentField: 'saat', presentField: 'Usaat',
    };
  });
}

function normalizedProgramMeetings(result, course) {
  const normalizedKey = key => String(key).toLocaleLowerCase('tr-TR').replace(/[^a-z0-9ğüşöçı]/g, '');
  const findValue = (row, keys) => Object.entries(row).find(([key, value]) => keys.includes(normalizedKey(key)) && value !== null && value !== undefined)?.[1];
  const asIsoDate = value => {
    const text = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
    const match = text.match(/^(\d{2})[./-](\d{2})[./-](\d{4})$/);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : null;
  };
  const rows = [];
  const visit = (value, depth = 0) => {
    if (depth > 8 || value === null || value === undefined) return;
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    if (typeof value !== 'object') return;
    const week = Number(findValue(value, ['hafta', 'week', 'haftano', 'haftasira']));
    const date = asIsoDate(findValue(value, ['tarih', 'date', 'ders_tarihi', 'derstarihi']));
    if (Number.isInteger(week) && week > 0 && date) rows.push({ row: value, week, date });
    Object.values(value).forEach(item => visit(item, depth + 1));
  };
  visit(result);
  const unique = [...new Map(rows.map(({ row, week, date }, index) => {
    const type = meetingType(findValue(row, ['tur', 'ders_turu', 'dersturu', 'oturum_turu', 'type', 'islenis', 'lab']));
    const startTime = findValue(row, ['baslangic_saat', 'baslangicsaat', 'start_time', 'starttime', 'start']);
    return [`${week}:${date}:${type}:${startTime || index}`, { row, week, date, type, startTime, index }];
  })).values()].sort((a, b) => a.week - b.week || a.date.localeCompare(b.date) || String(a.startTime || '').localeCompare(String(b.startTime || '')));
  return unique.map(({ row, week, date, type, startTime, index }) => {
    const endTime = findValue(row, ['bitis_saat', 'bitissaat', 'end_time', 'endtime', 'end']);
    const hours = lessonHours(startTime, endTime) || Number(findValue(row, ['saat', 'ders_saati', 'derssaati', 'teorik', 'teoriksaat', 'uygulama', 'pratik', 'lab'])) || Number(course.theoreticalHours) || 3;
    return { id: `ois:${week}:${date}:${type}:${startTime || index}`, week, date, type, startTime: startTime || null, endTime: endTime || null, absenceHours: hours, apiWeek: String(week), absentField: 'saat', presentField: 'Usaat' };
  });
}

function describeOisJsonShape(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return typeof value;
  if (Array.isArray(value)) return { arrayLength: value.length, item: value.length ? describeOisJsonShape(value[0], depth + 1) : 'empty' };
  if (typeof value !== 'object') return typeof value;
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, child]) => [key, describeOisJsonShape(child, depth + 1)]));
}

async function attachOisMeetings(instructorId, course) {
  if (isControlledTestCourse(course)) return course;
  try {
    const program = await readOisCourseProgram(instructorId, course);
    const meetings = normalizedProgramMeetings(program.result, course);
    if (meetings.length) return { ...course, meetings, meetingSource: 'ois' };
    const calculatedMeetings = calculatedCalendarMeetings(program.result, course);
    if (calculatedMeetings.length) return { ...course, meetings: calculatedMeetings, meetingSource: 'academic-calendar' };
    console.warn(`[OİS] Hafta planı yanıtında kullanılabilir hafta/tarih alanı yok · ${course.code} · şema: ${JSON.stringify(describeOisJsonShape(program.result))}`);
  } catch (error) {
    console.warn(`[OİS] Hafta planı okunamadı · ${course.code} · ${error.message}`);
  }
  const calculatedMeetings = calculatedCalendarMeetings(null, course);
  if (calculatedMeetings.length) return { ...course, meetings: calculatedMeetings, meetingSource: 'academic-calendar' };
  return { ...course, meetings: [], meetingSource: 'unavailable', scheduleError: 'OİS haftalık ders planı okunamadı. Hafta/tarih verisi gelmeden yoklama açılamaz.' };
}

const testCourse = {
  id: 27063, code: 'PSK 301', title: 'Fizyolojik Psikoloji',
  academicYear: '2025-2026', semester: 3, term: '2025–2026 · 3. Dönem',
  section: '1', program: 'Psikoloji Programı', theoreticalHours: 3,
  practicalHours: 0, laboratoryHours: 0, meetings: buildMeetings(),
};

function controlledTestCourseFor(instructorId, season, semester) {
  if (String(instructorId) !== CONTROLLED_TEST_INSTRUCTOR_ID || String(season) !== CONTROLLED_TEST_SEASON || Number(semester) !== CONTROLLED_TEST_SEMESTER) return null;
  return {
    id: CONTROLLED_TEST_COURSE_ID, code: 'PSK 301', title: 'Fizyolojik Psikoloji',
    academicYear: CONTROLLED_TEST_SEASON, semester: CONTROLLED_TEST_SEMESTER,
    term: `${CONTROLLED_TEST_SEASON} · Yaz`, section: '1', program: 'Psikoloji Programı',
    theoreticalHours: 6, practicalHours: 0, laboratoryHours: 0,
    oisInstructorId: CONTROLLED_TEST_INSTRUCTOR_ID, integrationTarget: 'test-sandbox',
    meetings: buildControlledTestMeetings(), meetingSource: 'controlled-test',
  };
}

const ACADEMIC_CALENDAR_STORE_PATH = path.join(DATA_DIR, 'academic-calendars.json');
function readAcademicCalendarStore() { try { return JSON.parse(fs.readFileSync(ACADEMIC_CALENDAR_STORE_PATH, 'utf8')); } catch { return {}; } }
const academicCalendars = readAcademicCalendarStore();
function calendarKey(season, semester) { return `${season}:${Number(semester)}`; }
function getAcademicCalendar(course) { return academicCalendars[calendarKey(course.academicYear, course.semester)] || null; }
function saveAcademicCalendars() { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ACADEMIC_CALENDAR_STORE_PATH, `${JSON.stringify(academicCalendars, null, 2)}\n`, { mode: 0o600 }); saveDatabaseState('academic-calendars', academicCalendars); }
function isConfiguredActiveTerm(course) { const calendar = getAcademicCalendar(course); return calendar ? calendar.active === true : course.academicYear === ACTIVE_ACADEMIC_YEAR && Number(course.semester) === ACTIVE_ACADEMIC_SEMESTER; }
function calendarDayOffset(value) { return ({ pazartesi: 0, salı: 1, sali: 1, çarşamba: 2, carsamba: 2, perşembe: 3, persembe: 3, cuma: 4, cumartesi: 5, pazar: 6, '1':0, '2':1, '3':2, '4':3, '5':4, '6':5, '7':6 })[String(value || '').trim().toLocaleLowerCase('tr-TR')] ?? null; }
function normalizedOisKey(key) { return String(key).toLocaleLowerCase('tr-TR').replace(/[^a-z0-9ğüşöçı]/g, ''); }
function directProgramValue(row, keys) { return Object.entries(row || {}).find(([key, value]) => keys.includes(normalizedOisKey(key)) && value !== null && value !== undefined && value !== '')?.[1]; }
function meetingType(value) { return /uyg|pratik|lab/.test(String(value || '').toLocaleLowerCase('tr-TR')) ? 'UYGULAMA' : 'TEORI'; }
function meetingTypeLabel(type) { return type === 'UYGULAMA' ? 'Uygulama' : 'Teori'; }
// OİS uses one absence column for the whole selected session. Teori is "saat";
// uygulama/pratik/lab is "Usaat". Attendance status changes only its value.
function attendanceHoursField(type) { return type === 'UYGULAMA' ? 'Usaat' : 'saat'; }
function findProgramValue(value, keys, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(item => findProgramValue(item, keys, depth + 1)).find(item => item !== undefined);
  if (typeof value !== 'object') return undefined;
  const entry = Object.entries(value).find(([key, item]) => keys.includes(normalizedOisKey(key)) && item !== null && item !== undefined && item !== '');
  if (entry) return entry[1];
  return Object.values(value).map(item => findProgramValue(item, keys, depth + 1)).find(item => item !== undefined);
}
function lessonHours(start, end) {
  const parse = value => { const match = String(value || '').match(/^(\d{1,2}):(\d{2})/); return match ? Number(match[1]) * 60 + Number(match[2]) : null; };
  const minutes = parse(end) - parse(start); return Number.isFinite(minutes) && minutes > 0 ? Math.ceil(minutes / 60) : null;
}
function programScheduleRows(value, rows = [], depth = 0) {
  if (depth > 8 || value === null || value === undefined) return rows;
  if (Array.isArray(value)) { value.forEach(item => programScheduleRows(item, rows, depth + 1)); return rows; }
  if (typeof value !== 'object') return rows;
  if (directProgramValue(value, ['gun', 'dersgunu', 'haftaningunu', 'weekday']) !== undefined) rows.push(value);
  Object.values(value).forEach(item => programScheduleRows(item, rows, depth + 1));
  return rows;
}
function calculatedCalendarMeetings(programResult, course) {
  const calendar = getAcademicCalendar(course); if (!calendar) return [];
  const start = new Date(`${calendar.weekOneStart}T00:00:00.000Z`); if (Number.isNaN(start.getTime())) return [];
  const source = programResult || course.raw || {};
  const seen = new Set();
  const slots = programScheduleRows(source).map(row => {
    const day = directProgramValue(row, ['gun', 'dersgunu', 'haftaningunu', 'weekday']);
    const offset = calendarDayOffset(day); if (offset === null) return null;
    const startTime = directProgramValue(row, ['baslangicsaat', 'starttime', 'start']);
    const endTime = directProgramValue(row, ['bitissaat', 'endtime', 'end']);
    const type = meetingType(directProgramValue(row, ['islenis', 'dersturu', 'tur', 'type', 'lab']));
    const hours = lessonHours(startTime, endTime) || Number(directProgramValue(row, ['teorik', 'uygulama', 'pratik', 'lab', 'derssaati', 'saat'])) || (type === 'UYGULAMA' ? Number(course.practicalHours) : Number(course.theoreticalHours)) || 1;
    const key = `${offset}:${type}:${startTime || ''}:${endTime || ''}:${hours}`;
    if (seen.has(key)) return null; seen.add(key);
    return { offset, day: String(day), startTime: startTime || null, endTime: endTime || null, type, hours, key };
  }).filter(Boolean);
  return slots.flatMap(slot => Array.from({ length: calendar.weekCount }, (_, index) => {
    // Hafta tarihi tüm dersler için takvimdeki pazartesidir. OİS'in ders günü,
    // yalnızca aynı haftadaki farklı teori/uygulama oturumlarını ayırt eder.
    const week = index + 1, date = new Date(start); date.setUTCDate(start.getUTCDate() + index * 7);
    return { id: `calendar:${week}:${slot.key}`, week, date: isoDate(date), day: slot.day, startTime: slot.startTime, endTime: slot.endTime, type: slot.type, absenceHours: slot.hours, apiWeek: String(week), absentField: 'saat', presentField: 'Usaat', isExamWeek: calendar.examWeeks.includes(week) };
  })).sort((a, b) => a.week - b.week || a.date.localeCompare(b.date) || String(a.startTime || '').localeCompare(String(b.startTime || '')));
}

// Hoca kodu OİS sorgularındaki kimliktir. İlk şifre yalnızca ilk giriş için hoca
// kodunun son dört hanesidir; değiştirilen şifrelerin özetleri yerelde saklanır.
const ACCOUNT_STORE_PATH = path.join(DATA_DIR, 'instructor-passwords.json');
function readAccountStore() {
  try { return JSON.parse(fs.readFileSync(ACCOUNT_STORE_PATH, 'utf8')); }
  catch { return {}; }
}
const accountStore = readAccountStore();
const instructors = {};
function getOrCreateInstructor(instructorId) {
  const saved = accountStore[instructorId];
  if (!instructors[instructorId]) instructors[instructorId] = {
    id: instructorId,
    name: saved?.name || 'Öğretim elemanı',
    passwordHash: saved?.passwordHash || hash(instructorId.slice(-4)),
    passwordIsDefault: !saved?.passwordHash,
    courses: instructorId === '2430042177' ? [testCourse] : [],
  };
  return instructors[instructorId];
}
function saveInstructorPassword(instructor) {
  accountStore[instructor.id] = { ...accountStore[instructor.id], name: instructor.name, passwordHash: instructor.passwordHash, passwordChangedAt: new Date().toISOString() };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNT_STORE_PATH, `${JSON.stringify(accountStore, null, 2)}\n`, { mode: 0o600 });
  saveDatabaseState('instructor-passwords', accountStore);
}
function saveInstructorProfile(instructor) {
  accountStore[instructor.id] = { ...accountStore[instructor.id], name: instructor.name };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCOUNT_STORE_PATH, `${JSON.stringify(accountStore, null, 2)}\n`, { mode: 0o600 });
  saveDatabaseState('instructor-passwords', accountStore);
}
const courseStudents = {
  27063: [{ no: '230201007', name: 'Hasan Bora Durmaz' }, { no: '240201508', name: 'Mine Mısırlılar' }],
};
const ADMIN_STORE_PATH = path.join(DATA_DIR, 'admin-passwords.json');
function readAdminStore() { try { return JSON.parse(fs.readFileSync(ADMIN_STORE_PATH, 'utf8')); } catch { return {}; } }
const adminStore = readAdminStore();
const admins = { yonetici: { username: 'yonetici', name: 'Sistem Yöneticisi', passwordHash: hash('Admin123!'), passwordIsDefault: true }, ...Object.fromEntries(Object.entries(adminStore).map(([username, record]) => [username, { username, name: record.name, passwordHash: record.passwordHash, passwordIsDefault: Boolean(record.passwordIsDefault) }])) };
function saveAdminPassword(admin) { adminStore[admin.username] = { name: admin.name, passwordHash: admin.passwordHash, passwordIsDefault: admin.passwordIsDefault, passwordChangedAt: new Date().toISOString() }; fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ADMIN_STORE_PATH, `${JSON.stringify(adminStore, null, 2)}\n`, { mode: 0o600 }); saveDatabaseState('admin-passwords', adminStore); }
const ATTENDANCE_HISTORY_STORE_PATH = path.join(DATA_DIR, 'attendance-history.json');
function readAttendanceHistoryStore() { try { return JSON.parse(fs.readFileSync(ATTENDANCE_HISTORY_STORE_PATH, 'utf8')); } catch { return {}; } }
const attendanceHistory = readAttendanceHistoryStore();
function saveAttendanceHistory() { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(ATTENDANCE_HISTORY_STORE_PATH, `${JSON.stringify(attendanceHistory, null, 2)}\n`, { mode: 0o600 }); saveDatabaseState('attendance-history', attendanceHistory); }
function attendanceHistoryKey(instructorId, course, meeting) { return `${instructorId}:${course.id}:${meeting.id}`; }
function attendanceRecord(instructorId, course, meeting) {
  const key = attendanceHistoryKey(instructorId, course, meeting);
  const record = attendanceHistory[key] || { opens: 0, present: [], lastSentAt: null };
  attendanceHistory[key] = record;
  return { key, record };
}
const AUDIT_STORE_PATH = path.join(DATA_DIR, 'audit-log.json');
function readAuditStore() { try { const value = JSON.parse(fs.readFileSync(AUDIT_STORE_PATH, 'utf8')); return Array.isArray(value) ? value : []; } catch { return []; } }
const audit = readAuditStore();
function saveAudit() { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(AUDIT_STORE_PATH, `${JSON.stringify(audit.slice(0, 20_000), null, 2)}\n`, { mode: 0o600 }); saveDatabaseState('audit-log', audit.slice(0, 20_000)); }
function saveDatabaseState(key, value) {
  if (!database) return;
  database.query(
    'INSERT INTO app_state (state_key, state_value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (state_key) DO UPDATE SET state_value = EXCLUDED.state_value, updated_at = NOW()',
    [key, JSON.stringify(value)],
  ).catch(error => console.error(`[Veritabanı] ${key} kaydı yazılamadı: ${error.message}`));
}
async function initializeDatabase() {
  if (!DATABASE_URL) return;
  database = new Pool({ connectionString: DATABASE_URL, max: 4 });
  await database.query('CREATE TABLE IF NOT EXISTS app_state (state_key TEXT PRIMARY KEY, state_value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const { rows } = await database.query('SELECT state_key, state_value FROM app_state');
  const stateByKey = new Map(rows.map(row => [row.state_key, row.state_value]));
  const assignObject = (target, source) => { if (source && typeof source === 'object' && !Array.isArray(source)) Object.assign(target, source); };
  assignObject(academicCalendars, stateByKey.get('academic-calendars'));
  assignObject(accountStore, stateByKey.get('instructor-passwords'));
  assignObject(adminStore, stateByKey.get('admin-passwords'));
  assignObject(attendanceHistory, stateByKey.get('attendance-history'));
  const savedAudit = stateByKey.get('audit-log');
  if (Array.isArray(savedAudit)) audit.splice(0, audit.length, ...savedAudit.slice(0, 20_000));
  Object.entries(adminStore).forEach(([username, record]) => {
    admins[username] = { username, name: record.name, passwordHash: record.passwordHash, passwordIsDefault: Boolean(record.passwordIsDefault) };
  });
  console.log('[Veritabanı] Kalıcı uygulama kayıtları PostgreSQL’den yüklendi.');
}
function requestNetworkId(req) { const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim(); return hash(forwarded || req.ip || req.socket?.remoteAddress || 'unknown'); }
function auditContext(req, actorType, actorId, actorName) { return { actorType, actorId: String(actorId || ''), actorName: actorName || null, networkId: requestNetworkId(req) }; }
function event(type, detail, context = {}) { audit.unshift({ id: id(), at: new Date().toISOString(), type, detail, category: context.category || 'system', actorType: context.actorType || 'system', actorId: context.actorId || null, actorName: context.actorName || null, networkId: context.networkId || null, metrics: context.metrics || null }); if (audit.length > 20_000) audit.length = 20_000; saveAudit(); }
const sessions = new Map(), tokens = new Map(), adminTokens = new Map(), checkinTickets = new Map(), tvPairings = new Map(), tvDisplayTokens = new Map();

function tokenAuth(req, res, next) { const instructorId = tokens.get(req.headers.authorization?.replace('Bearer ', '')); if (!instructorId) return res.status(401).json({ error: 'Oturum doğrulaması gerekli' }); req.instructorId = instructorId; next(); }
function auth(req, res, next) { tokenAuth(req, res, () => { if (instructors[req.instructorId]?.passwordIsDefault) return res.status(403).json({ error: 'Devam etmek için önce yeni bir şifre belirleyin.' }); next(); }); }
function adminTokenAuth(req, res, next) { const username = adminTokens.get(req.headers.authorization?.replace('Bearer ', '')); if (!username) return res.status(401).json({ error: 'Yönetici oturumu gerekli' }); req.adminUsername = username; next(); }
function adminAuth(req, res, next) { adminTokenAuth(req, res, () => { if (admins[req.adminUsername]?.passwordIsDefault) return res.status(403).json({ error: 'Devam etmek için önce yönetici şifrenizi değiştirin.' }); next(); }); }
function getCourse(instructorId, courseId) { return instructors[instructorId]?.courses.find(course => course.id === Number(courseId)); }
function isControlledTestCourse(course) {
  // Eski bellekte kalmış ya da canlı ders listesinden gelmiş aynı test dersi de
  // yanlışlıkla canlıya yazılmamalı: bu beşli eşleşme her zaman OİS test hedefidir.
  return course?.integrationTarget === 'test-sandbox' || (
    Number(course?.id) === CONTROLLED_TEST_COURSE_ID &&
    String(course?.academicYear) === CONTROLLED_TEST_SEASON &&
    Number(course?.semester) === CONTROLLED_TEST_SEMESTER &&
    String(course?.section) === '1' &&
    String(course?.oisInstructorId) === CONTROLLED_TEST_INSTRUCTOR_ID
  );
}
function courseIsEditable(course) { return isControlledTestCourse(course) || isConfiguredActiveTerm(course); }
function getSession(req, res) { const session = sessions.get(req.params.id); if (!session) { res.status(404).json({ error: 'Oturum bulunamadı' }); return null; } if (req.instructorId && session.instructorId !== req.instructorId) { res.status(403).json({ error: 'Bu oturuma erişim yetkiniz yok' }); return null; } return session; }
function issue(session) { const raw = secret(); session.challenge = { hash: hash(raw), raw, expiresAt: Date.now() + QR_TTL }; return { challenge: raw, expiresAt: session.challenge.expiresAt }; }
function activeTvPairing(pairing) { return pairing && pairing.expiresAt >= Date.now() && pairing.status !== 'ENDED'; }
function findTvPairingByCode(code) { return [...tvPairings.values()].find(pairing => pairing.code === code && activeTvPairing(pairing)); }
function publicTvPairing(pairing) { return { id: pairing.id, status: pairing.status, code: pairing.code, expiresAt: pairing.expiresAt, courseId: pairing.courseId, meetingId: pairing.meetingId, meetingDate: pairing.meetingDate, week: pairing.week }; }
function tvAuth(req, res, next) {
  const displayToken = String(req.headers['x-tv-display-token'] || '');
  const tokenRecord = tvDisplayTokens.get(displayToken);
  const pairing = tokenRecord && tvPairings.get(tokenRecord.pairingId);
  if (!tokenRecord || !pairing || tokenRecord.expiresAt < Date.now()) return res.status(401).json({ error: 'TV bağlantısı geçersiz veya süresi dolmuş.' });
  req.tvDisplayToken = displayToken; req.tvPairing = pairing; next();
}
function validChallenge(session, challenge) { return Boolean(session && session.state === 'CLASS_OPEN' && session.qrOpen && Date.now() <= session.closesAt && session.challenge && session.challenge.expiresAt >= Date.now() && hash(String(challenge || '')) === session.challenge.hash); }
function publicCourse(course) { return { ...course, meetings: course.meetings.map(meeting => ({ ...meeting })) }; }
function findCourseMeeting(course, input) {
  const candidates = course.meetings.filter(item => item.week === Number(input.week) && item.date === input.meetingDate);
  if (input.meetingId) return candidates.find(item => item.id === String(input.meetingId)) || null;
  return candidates.length === 1 ? candidates[0] : null;
}
function createAttendanceSession(instructorId, input, actor = {}) {
  const course = getCourse(instructorId, input.courseId);
  if (!course) return { error: 'Bu ders size atanmış değil', status: 403 };
  if (!courseIsEditable(course)) return { error: 'Bu ders geçmiş veya aktif olmayan döneme ait. Geçmiş derslerde QR yoklaması açılamaz.', status: 403 };
  const meeting = findCourseMeeting(course, input);
  if (!meeting) return { error: 'Seçilen oturum bu dersin OİS planında bulunamadı. Aynı haftada birden fazla ders varsa teori veya uygulamayı seçin.', status: 400 };
  if (meeting.isExamWeek) return { error: 'Bu hafta sınav haftasıdır; QR yoklaması açılamaz.', status: 403 };
  const { key, record } = attendanceRecord(instructorId, course, meeting);
  if (record.opens >= MAX_QR_OPENS) return { error: `Bu ders saati için en fazla ${MAX_QR_OPENS} yoklama oturumu açılabilir`, status: 409 };
  let session = [...sessions.values()].find(item => item.instructorId === instructorId && item.course.id === course.id && item.meetingId === meeting.id && item.state === 'CLASS_OPEN');
  record.opens += 1; saveAttendanceHistory();
  if (!session) {
    const previouslyDelivered = (record.present || []).map(student => ({ no: String(student.no), name: student.name, checkedAt: student.checkedAt, deliveredAt: record.lastSentAt }));
    const attendanceField = attendanceHoursField(meeting.type);
    session = { id: id(), instructorId, course, meetingId: meeting.id, week: meeting.week, apiWeek: meeting.apiWeek, meetingDate: meeting.date, meetingType: meeting.type, absenceHours: meeting.absenceHours, absentField: attendanceField, presentField: attendanceField, openedAt: Date.now(), closesAt: Date.now() + CLASS_TTL, state: 'CLASS_OPEN', present: previouslyDelivered, previouslyDelivered: new Set(previouslyDelivered.map(student => student.no)), historyKey: key };
    sessions.set(session.id, session);
  }
  session.qrOpen = true; session.openNumber = record.opens;
  const qr = issue(session); event('QR yoklaması açıldı', `${course.code} · hafta ${session.week} · ${session.openNumber}/${MAX_QR_OPENS}`, { ...actor, category: 'attendance', metrics: { courseId: course.id, courseCode: course.code, meetingId: meeting.id, week: session.week, opening: session.openNumber } });
  return { status: session.openNumber === 1 ? 201 : 200, data: { id: session.id, course: publicCourse(course), meetingId: session.meetingId, week: session.week, apiWeek: session.apiWeek, meetingDate: session.meetingDate, meetingType: session.meetingType, absenceHours: session.absenceHours, absentField: session.absentField, presentField: session.presentField, closesAt: session.closesAt, present: session.present, previouslyDeliveredCount: session.previouslyDelivered?.size || 0, qrOpen: true, openNumber: session.openNumber, maxOpens: MAX_QR_OPENS, opensRemaining: MAX_QR_OPENS - session.openNumber, ...qr } };
}
function attendancePayload(session) {
  const present = new Set(session.present.map(student => student.no));
  const attendanceField = attendanceHoursField(session.meetingType);
  return { method: 'yoklama', ders: [{ ders_id: session.course.id, tarih: session.meetingDate, kullanici_id: session.course.oisInstructorId || session.instructorId, section: session.course.section, hafta: String(session.apiWeek ?? session.week) }], ogrenciler_saat: (courseStudents[session.course.id] || []).map(student => ({ ogrenci_no: student.no, [attendanceField]: present.has(student.no) ? '0' : String(session.absenceHours) })) };
}
function attendanceDeliverySummary(session, sent) {
  const present = new Set(session.present.map(student => String(student.no)));
  const roster = courseStudents[session.course.id] || [];
  const students = roster.map(student => ({ no: student.no, name: student.name, attended: present.has(String(student.no)), deliveryStatus: sent ? 'Gönderildi' : 'Hazırlandı' }));
  return { total: students.length, sent: sent ? students.length : 0, attended: students.filter(student => student.attended).length, absent: students.filter(student => !student.attended).length, students };
}
function courseParticipation(instructorId, course) {
  const delivered = (course.meetings || [])
    .map(meeting => {
      const key = attendanceHistoryKey(instructorId, course, meeting);
      const record = attendanceHistory[key];
      const auditTotal = audit.find(item => item.metrics?.attendanceKey === key && Number.isFinite(Number(item.metrics?.total)))?.metrics?.total;
      return { meeting, record, enrolled: Number(record?.enrolled ?? auditTotal ?? (courseStudents[course.id] || []).length) };
    })
    .filter(({ record }) => Boolean(record?.lastSentAt));
  const attendedTotal = delivered.reduce((total, { record }) => total + (record.present || []).length, 0);
  const possibleTotal = delivered.reduce((total, { enrolled }) => total + enrolled, 0);
  const deliveredWeeks = [...new Set(delivered.map(({ meeting }) => Number(meeting.week)).filter(Number.isFinite))];
  const attendanceMeetings = (course.meetings || []).filter(meeting => !meeting.isExamWeek);
  return {
    courseId: course.id,
    section: course.section,
    code: course.code,
    title: course.title,
    sentSessions: delivered.length,
    completedWeeks: deliveredWeeks.length,
    lastCompletedWeek: deliveredWeeks.length ? Math.max(...deliveredWeeks) : null,
    plannedWeeks: new Set(attendanceMeetings.map(meeting => meeting.week)).size,
    attendedTotal,
    possibleTotal,
    participationRate: possibleTotal ? attendedTotal / possibleTotal : null,
  };
}
function oisReadTarget(course = null) {
  if (isControlledTestCourse(course)) return { environment: 'test', label: 'OİS test', base: CONTROLLED_TEST_API_BASE, useTestTls: process.env.OBS_TEST_INSECURE_TLS === 'true' };
  return { environment: OIS_ENVIRONMENT, label: OIS_ENVIRONMENT_LABEL, base: process.env.OBS_READ_API_BASE || process.env.OBS_API_BASE, useTestTls: OIS_TEST_TLS_BYPASS };
}
function oisWriteTarget(course = null) {
  if (isControlledTestCourse(course)) return { environment: 'test', label: 'OİS test', base: CONTROLLED_TEST_API_BASE, useTestTls: process.env.OBS_TEST_INSECURE_TLS === 'true' };
  return { environment: OIS_ENVIRONMENT, label: OIS_ENVIRONMENT_LABEL, base: process.env.OBS_API_BASE, useTestTls: OIS_TEST_TLS_BYPASS };
}
function fetchOisTestWithTemporaryTlsException(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { rejectUnauthorized: false, timeout: 15_000 }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode || 0, ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 300), text: async () => body }));
    });
    request.on('timeout', () => request.destroy(new Error('OİS test bağlantısı zaman aşımına uğradı')));
    request.on('error', reject);
  });
}
async function sendToOis(payload, course) {
  const target = oisWriteTarget(course);
  if (process.env.OBS_LIVE_WRITE !== 'true') return { sent: false, mode: 'dry-run', environment: target.environment, environmentLabel: target.label, endpoint: target.base || null, message: `${target.label} yazımı kapalı; gönderim paketi hazırlandı.` };
  const base = target.base, username = process.env.OBS_API_USERNAME, password = process.env.OBS_API_PASSWORD;
  if (!base || !username || !password) throw new Error('OİS canlı yazımı için sunucu ortam değişkenleri eksik.');
  const url = new URL(base);
  url.searchParams.set('api_username', username); url.searchParams.set('api_password', password); url.searchParams.set('method', payload.method); url.searchParams.set('ders', JSON.stringify(payload.ders)); url.searchParams.set('ogrenciler_saat', JSON.stringify(payload.ogrenciler_saat));
  const debug = { environment: target.environment, environmentLabel: target.label, endpoint: `${url.origin}${url.pathname}`, httpMethod: 'GET', transport: target.useTestTls ? 'OİS test geçici TLS istisnası' : 'Standart TLS doğrulaması', parameters: { method: payload.method, ders: payload.ders, ogrenciler_saat: payload.ogrenciler_saat }, httpStatus: null, response: null };
  let response;
  try { response = target.useTestTls ? await fetchOisTestWithTemporaryTlsException(url) : await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15_000) }); }
  catch (cause) {
    const networkCause = cause.cause || cause;
    const reason = [networkCause.code, networkCause.message].filter(Boolean).join(': ') || cause.message;
    const error = new Error(`${target.label} bağlantısı kurulamadı: ${reason}`);
    debug.networkError = { code: networkCause.code || null, message: networkCause.message || cause.message };
    debug.response = reason;
    console.error(`[OİS] ${target.label} bağlantı hatası · ${JSON.stringify(debug)}`);
    error.oisDebug = debug; throw error;
  }
  const body = await response.text();
  debug.httpStatus = response.status; debug.response = body.slice(0, 1_000);
  if (!response.ok) { const error = new Error(`OİS ${response.status}: ${body.slice(0, 200)}`); error.oisDebug = debug; throw error; }
  let result;
  try { result = JSON.parse(body); } catch { result = null; }
  console.log(`[OİS] Gönderim yanıtı · HTTP ${response.status} · ${body.slice(0, 300).replace(/\s+/g, ' ')}`);
  console.log(`[OİS] Şifresiz istek özeti · ${JSON.stringify(debug)}`);
  if (result?.err) { const error = new Error(`OİS reddetti: ${result.msg || 'Bilinmeyen hata'}`); error.oisDebug = debug; throw error; }
  return {
    sent: true,
    verified: false,
    mode: target.environment,
    environment: target.environment,
    environmentLabel: target.label,
    endpoint: `${url.origin}${url.pathname}`,
    response: result?.msg || body.slice(0, 500),
    verificationNote: 'OİS API isteği kabul etti. Bu kayıt önce OİS Günlük Yoklama Listesi’nde görünür; haftalık rapora OİS gün sonu aktarımından sonra yansır. Uygulama, haftalık raporu doğrulayacak bir OİS okuma API’sine sahip değildir.',
  };
}
async function readOisCourseProgram(instructorId, course) {
  const target = oisReadTarget(course);
  const base = target.base;
  const username = process.env.OBS_API_USERNAME, password = process.env.OBS_API_PASSWORD;
  if (!base || !username || !password) throw new Error('OİS program okuma ayarları eksik.');
  const url = new URL(base);
  url.searchParams.set('api_username', username); url.searchParams.set('api_password', password);
  url.searchParams.set('method', 'hocadersprogrami'); url.searchParams.set('sezon', course.academicYear);
  url.searchParams.set('donem', String(course.semester)); url.searchParams.set('kullanici_id', course.oisInstructorId || instructorId);
  url.searchParams.set('section', course.section); url.searchParams.set('ders_id', String(course.id));
  const debug = { environment: target.environment, environmentLabel: target.label, endpoint: `${url.origin}${url.pathname}`, httpMethod: 'GET', method: 'hocadersprogrami', parameters: { sezon: course.academicYear, donem: String(course.semester), kullanici_id: instructorId, section: course.section, ders_id: String(course.id) }, httpStatus: null, response: null };
  let response;
  try { response = target.useTestTls ? await fetchOisTestWithTemporaryTlsException(url) : await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15_000) }); }
  catch (cause) { const networkCause = cause.cause || cause; debug.networkError = { code: networkCause.code || null, message: networkCause.message || cause.message }; debug.response = debug.networkError.message; const error = new Error(`OİS ders programı okunamadı: ${debug.response}`); error.oisDebug = debug; throw error; }
  const body = await response.text(); debug.httpStatus = response.status; debug.response = body.slice(0, 12_000);
  if (!response.ok) { const error = new Error(`OİS program API ${response.status} döndü.`); error.oisDebug = debug; throw error; }
  let result; try { result = JSON.parse(body); } catch { result = body; }
  if (result?.err) { const error = new Error(`OİS program API reddetti: ${result.msg || 'Bilinmeyen hata'}`); error.oisDebug = debug; throw error; }
  console.log(`[OİS] Ders programı okundu · ${JSON.stringify({ ...debug, response: typeof result === 'string' ? result.slice(0, 500) : 'JSON yanıtı' })}`);
  return { debug, result };
}
async function readOisAssignedCourses(instructorId, season, semester) {
  const base = process.env.OBS_READ_API_BASE || process.env.OBS_API_BASE;
  const url = new URL(base);
  url.searchParams.set('api_username', process.env.OBS_API_USERNAME || ''); url.searchParams.set('api_password', process.env.OBS_API_PASSWORD || '');
  url.searchParams.set('method', 'hocaders'); url.searchParams.set('sezon', season); url.searchParams.set('donem', String(semester)); url.searchParams.set('hoca_kodu', instructorId);
  let response;
  try { response = OIS_TEST_TLS_BYPASS ? await fetchOisTestWithTemporaryTlsException(url) : await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15_000) }); } catch (cause) { throw new Error(`OİS ders listesi okunamadı: ${(cause.cause || cause).message}`); }
  const body = await response.text(); if (!response.ok) throw new Error(`OİS ders listesi HTTP ${response.status} döndü.`);
  let result; try { result = JSON.parse(body); } catch { throw new Error('OİS ders listesi JSON yanıtı vermedi.'); }
  if (result?.err) throw new Error(`OİS ders listesi reddetti: ${result.msg || 'Bilinmeyen hata'}`);
  const rows = Array.isArray(result) ? result : result.data || result.dersler || result.result || [];
  const list = Array.isArray(rows) ? rows : [];
  const first = list[0] || {};
  const normalizeKey = key => String(key).toLocaleLowerCase('tr-TR').replace(/[^a-z0-9ğüşöçı]/g, '');
  const nameKeys = ['hocaadi', 'hocaadisoyadi', 'ogretimelemaniadi', 'ogretimelemaniadisoyadi', 'ogretimelemani', 'ogretimuyesiadi', 'ogretimuyesi', 'akademisyenadi', 'adsoyad', 'kullaniciadi'];
  const nameEntry = Object.entries(first).find(([key, value]) => nameKeys.includes(normalizeKey(key)) && typeof value === 'string' && /[A-Za-zÇĞİÖŞÜçğıöşü]/.test(value));
  const instructorName = nameEntry?.[1]?.trim() || null;
  const instructorPhoto = first.hoca_foto ?? first.hoca_fotograf ?? first.foto_url ?? first.fotograf_url ?? first.photo_url ?? null;
  const courses = list.map(row => ({ id: Number(row.ders_id ?? row.id), code: row.ders_kodu ?? row.ders_kod ?? row.code ?? '—', title: row.ders_adi ?? row.ders_ad ?? row.title ?? 'İsimsiz ders', section: String(row.section ?? row.sube ?? '1'), academicYear: season, semester: Number(semester), term: `${season} · ${{ 1:'Güz', 2:'Bahar', 3:'Yaz' }[Number(semester)] || semester}`, raw: row }));
  return { courses, instructorName, instructorPhoto, raw: result };
}
async function readOisStudents(course) {
  const target = oisReadTarget(course);
  const base = new URL(target.base);
  const url = new URL('/api/dersogrenciliste', base.origin);
  url.searchParams.set('api_username', process.env.OBS_API_USERNAME || ''); url.searchParams.set('api_password', process.env.OBS_API_PASSWORD || '');
  url.searchParams.set('sezon', course.academicYear); url.searchParams.set('donem', String(course.semester)); url.searchParams.set('ders_kodu', course.code); url.searchParams.set('section', course.section);
  const response = target.useTestTls ? await fetchOisTestWithTemporaryTlsException(url) : await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15_000) }); const body = await response.text();
  if (!response.ok) throw new Error(`OİS öğrenci listesi HTTP ${response.status} döndü.`);
  let result; try { result = JSON.parse(body); } catch { throw new Error('OİS öğrenci listesi JSON yanıtı vermedi.'); }
  if (result?.err) throw new Error(`OİS öğrenci listesi reddetti: ${result.msg || 'Bilinmeyen hata'}`);
  const rows = Array.isArray(result) ? result : result.data || result.ogrenciler || result.result || [];
  return (Array.isArray(rows) ? rows : []).map(row => {
    const firstName = row.ad ?? row.adi ?? row.ogrenci_ad ?? row.ogrenci_adi ?? row.adı ?? row.first_name;
    const lastName = row.soyad ?? row.soyadi ?? row.ogrenci_soyad ?? row.ogrenci_soyadi ?? row.soyadı ?? row.last_name;
    return { no: String(row.ogrenci_no ?? row.ogrenci_numarasi ?? row.no ?? row.student_no), name: [firstName, lastName].filter(Boolean).join(' ') || row.ad_soyad || row.adi_soyadi || row.ogrenci_ad_soyad || row.ogrenci_adi_soyadi || row.name || 'Öğrenci' };
  });
}

app.post('/api/auth/login', (req, res) => {
  const instructorId = String(req.body.instructorId || '').trim();
  if (!/^\d{6,20}$/.test(instructorId)) return res.status(400).json({ error: 'Geçerli hoca kodunuzu girin.' });
  const instructor = getOrCreateInstructor(instructorId);
  if (instructor.passwordHash !== hash(String(req.body.password || ''))) return res.status(401).json({ error: 'Hoca kodu veya şifre hatalı' });
  const token = secret(); tokens.set(token, instructor.id);
  event('Öğretim elemanı girişi', 'Yoklama merkezine giriş yapıldı', { ...auditContext(req, 'instructor', instructor.id, instructor.name), category: 'authentication' });
  res.json({ token, passwordChangeRequired: instructor.passwordIsDefault, instructor: { id: instructor.id, name: instructor.name, passwordIsDefault: instructor.passwordIsDefault }, courses: instructor.courses.map(publicCourse) });
});
app.post('/api/auth/password', tokenAuth, (req, res) => {
  const value = String(req.body.newPassword || '');
  if (value.length < 10 || !/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(value) || !/\d/.test(value)) return res.status(400).json({ error: 'Yeni şifre en az 10 karakter olmalı; en az bir harf ve bir rakam içermeli.' });
  const instructor = instructors[req.instructorId];
  instructor.passwordHash = hash(value); instructor.passwordIsDefault = false; saveInstructorPassword(instructor);
  event('Öğretim elemanı şifresi oluşturuldu', instructor.id, { ...auditContext(req, 'instructor', instructor.id, instructor.name), category: 'account' });
  res.json({ ok: true, instructor: { id: instructor.id, name: instructor.name, passwordIsDefault: false } });
});
app.get('/api/instructors/me/profile', auth, async (req, res) => {
  const season = String(req.query.season || ''); const semester = Number(req.query.semester);
  if (!/^20\d\d-20\d\d$/.test(season) || ![1, 2, 3].includes(semester)) return res.status(400).json({ error: 'Geçerli sezon ve dönem seçin.' });
  try {
    const data = await readOisAssignedCourses(req.instructorId, season, semester);
    const instructor = instructors[req.instructorId];
    if (data.instructorName) { instructor.name = data.instructorName; saveInstructorProfile(instructor); }
    res.json({ ok: true, instructor: { id: instructor.id, name: instructor.name, photo: data.instructorPhoto } });
  } catch (error) { res.status(502).json({ error: error.message }); }
});
app.get('/api/instructors/me/courses', auth, (req, res) => { const instructor = instructors[req.instructorId]; res.json({ id: instructor.id, name: instructor.name, courses: instructor.courses.map(publicCourse) }); });
app.get('/api/instructors/me/participation', auth, (req, res) => {
  const season = String(req.query.season || '');
  const semester = Number(req.query.semester);
  if (!/^20\d\d-20\d\d$/.test(season) || ![1, 2, 3].includes(semester)) return res.status(400).json({ error: 'Geçerli sezon ve dönem seçin.' });
  const courses = (instructors[req.instructorId]?.courses || []).filter(course => String(course.academicYear) === season && Number(course.semester) === semester);
  const rows = courses.map(course => courseParticipation(req.instructorId, course));
  const attendedTotal = rows.reduce((total, row) => total + row.attendedTotal, 0);
  const possibleTotal = rows.reduce((total, row) => total + row.possibleTotal, 0);
  res.json({
    season,
    semester,
    courses: rows,
    summary: {
      totalCourses: courses.length,
      coursesWithAttendance: rows.filter(row => row.participationRate !== null).length,
      sentSessions: rows.reduce((total, row) => total + row.sentSessions, 0),
      attendedTotal,
      possibleTotal,
      participationRate: possibleTotal ? attendedTotal / possibleTotal : null,
    },
  });
});
app.get('/api/courses/:id/students', auth, (req, res) => { if (!getCourse(req.instructorId, req.params.id)) return res.status(403).json({ error: 'Bu ders size atanmış değil' }); res.json({ courseId: Number(req.params.id), students: courseStudents[req.params.id] || [] }); });
app.get('/api/courses/:id/attendance-history', auth, (req, res) => {
  const course = getCourse(req.instructorId, req.params.id);
  if (!course) return res.status(403).json({ error: 'Bu ders size atanmış değil' });
  const meeting = course.meetings.find(item => item.id === String(req.query.meetingId || ''));
  if (!meeting) return res.status(400).json({ error: 'Geçerli ders oturumu seçin.' });
  const record = attendanceHistory[attendanceHistoryKey(req.instructorId, course, meeting)] || null;
  res.json({
    courseId: course.id,
    meetingId: meeting.id,
    delivered: Boolean(record?.lastSentAt),
    present: (record?.present || []).map(student => ({ no: String(student.no), name: student.name, checkedAt: student.checkedAt })),
    sentAt: record?.lastSentAt || null,
  });
});
app.post('/api/courses/:id/ois-students', auth, async (req, res) => { const course = getCourse(req.instructorId, req.params.id); if (!course) return res.status(403).json({ error: 'Bu ders size atanmış değil' }); try { const students = await readOisStudents(course); courseStudents[course.id] = students; res.json({ ok: true, courseId: course.id, students, source: isControlledTestCourse(course) ? 'OİS test' : 'OİS' }); } catch (error) { if (isControlledTestCourse(course)) return res.json({ ok: true, courseId: course.id, students: courseStudents[course.id] || [], source: 'OİS test için tanımlı kontrollü test listesi', oisWarning: error.message }); res.status(502).json({ error: error.message }); } });
app.get('/api/courses/:id/ois-program', auth, async (req, res) => { const course = getCourse(req.instructorId, req.params.id); if (!course) return res.status(403).json({ error: 'Bu ders size atanmış değil' }); try { const program = await readOisCourseProgram(req.instructorId, course); res.json({ ok: true, course: { id: course.id, code: course.code, title: course.title, academicYear: course.academicYear, semester: course.semester, section: course.section }, ...program }); } catch (error) { res.status(502).json({ error: error.message, oisDebug: error.oisDebug || null }); } });
app.get('/api/ois/assigned-courses', auth, async (req, res) => { const season = String(req.query.season || ''); const semester = Number(req.query.semester); if (!/^20\d\d-20\d\d$/.test(season) || ![1,2,3].includes(semester)) return res.status(400).json({ error: 'Geçerli sezon ve dönem seçin.' }); const controlledCourse = controlledTestCourseFor(req.instructorId, season, semester); try { let data; try { data = await readOisAssignedCourses(req.instructorId, season, semester); } catch (error) { if (!controlledCourse) throw error; console.warn(`[OİS] Kontrollü test dersi için canlı ders listesi okunamadı; yalnız test dersi sunuluyor · ${error.message}`); data = { courses: [], instructorName: null, instructorPhoto: null, raw: null }; } const sourceCourses = controlledCourse ? [...data.courses.filter(course => !(course.id === controlledCourse.id && course.section === controlledCourse.section)), controlledCourse] : data.courses; const courses = (await Promise.all(sourceCourses.map(course => attachOisMeetings(req.instructorId, { ...course, oisInstructorId: req.instructorId })))).map(course => ({ ...course, editable: courseIsEditable(course) })); instructors[req.instructorId].courses = courses; if (data.instructorName) { instructors[req.instructorId].name = data.instructorName; saveInstructorProfile(instructors[req.instructorId]); } res.json({ ok: true, instructor: { id: req.instructorId, name: instructors[req.instructorId].name, photo: data.instructorPhoto }, season, semester, courses, raw: data.raw }); } catch (error) { res.status(502).json({ error: error.message }); } });
app.post('/api/sessions', auth, (req, res) => {
  const instructor = instructors[req.instructorId];
  const created = createAttendanceSession(req.instructorId, req.body, auditContext(req, 'instructor', req.instructorId, instructor?.name));
  if (created.error) return res.status(created.status).json({ error: created.error });
  res.status(created.status).json(created.data);
});

app.post('/api/tv/pairings', auth, (req, res) => {
  const course = getCourse(req.instructorId, req.body.courseId);
  if (!course) return res.status(403).json({ error: 'Bu ders size atanmış değil.' });
  if (!courseIsEditable(course)) return res.status(403).json({ error: 'Yalnızca aktif dönemde TV bağlantısı açılabilir.' });
  const meeting = findCourseMeeting(course, req.body);
  if (!meeting) return res.status(400).json({ error: 'Önce OİS planından geçerli teori veya uygulama oturumunu seçin.' });
  for (const pairing of tvPairings.values()) if (pairing.instructorId === req.instructorId && pairing.status !== 'ENDED') pairing.status = 'SUPERSEDED';
  const pairing = { id: id(), code: String(crypto.randomInt(100000, 1_000_000)), instructorId: req.instructorId, courseId: course.id, meetingId: meeting.id, meetingDate: meeting.date, week: meeting.week, status: 'WAITING_FOR_TV', createdAt: Date.now(), expiresAt: Date.now() + TV_PAIR_TTL, displayToken: null, sessionId: null };
  tvPairings.set(pairing.id, pairing);
  event('TV bağlantı kodu üretildi', `${course.code} · hafta ${meeting.week}`);
  res.status(201).json(publicTvPairing(pairing));
});
app.get('/api/tv/pairings/:id', auth, (req, res) => {
  const pairing = tvPairings.get(req.params.id);
  if (!pairing || pairing.instructorId !== req.instructorId) return res.status(404).json({ error: 'TV bağlantı isteği bulunamadı.' });
  if (pairing.expiresAt < Date.now() && pairing.status !== 'ACTIVE') pairing.status = 'EXPIRED';
  res.json(publicTvPairing(pairing));
});
app.post('/api/tv/connect', (req, res) => {
  const code = String(req.body.code || '').replace(/\D/g, '');
  const pairing = findTvPairingByCode(code);
  if (!pairing || pairing.status !== 'WAITING_FOR_TV') return res.status(400).json({ error: 'Bu TV kodu geçersiz, kullanılmış veya süresi dolmuş.' });
  const displayToken = secret();
  pairing.status = 'WAITING_FOR_APPROVAL'; pairing.displayToken = displayToken;
  tvDisplayTokens.set(displayToken, { pairingId: pairing.id, expiresAt: pairing.expiresAt });
  event('TV bağlantısı onay bekliyor', pairing.id);
  res.json({ ok: true, displayToken, expiresAt: pairing.expiresAt });
});
app.post('/api/tv/pairings/:id/approve', auth, (req, res) => {
  const pairing = tvPairings.get(req.params.id);
  if (!pairing || pairing.instructorId !== req.instructorId) return res.status(404).json({ error: 'TV bağlantı isteği bulunamadı.' });
  if (pairing.expiresAt < Date.now()) { pairing.status = 'EXPIRED'; return res.status(410).json({ error: 'TV bağlantı kodunun süresi doldu.' }); }
  if (pairing.status !== 'WAITING_FOR_APPROVAL') return res.status(409).json({ error: 'TV henüz kodu girmedi veya bu istek artık geçerli değil.' });
  const created = createAttendanceSession(req.instructorId, pairing, auditContext(req, 'instructor', req.instructorId, instructors[req.instructorId]?.name));
  if (created.error) return res.status(created.status).json({ error: created.error });
  pairing.status = 'ACTIVE'; pairing.sessionId = created.data.id;
  const tokenRecord = tvDisplayTokens.get(pairing.displayToken); if (tokenRecord) tokenRecord.expiresAt = created.data.closesAt;
  event('TV bağlantısı onaylandı', `${created.data.course.code} · hafta ${created.data.week}`);
  res.status(created.status).json({ pairing: publicTvPairing(pairing), session: created.data });
});
app.get('/api/tv/status', tvAuth, (req, res) => {
  const pairing = req.tvPairing;
  if (pairing.status === 'WAITING_FOR_APPROVAL') return res.json({ status: pairing.status, expiresAt: pairing.expiresAt });
  if (pairing.status !== 'ACTIVE') return res.json({ status: pairing.status });
  const session = sessions.get(pairing.sessionId);
  if (!session || session.state !== 'CLASS_OPEN' || Date.now() > session.closesAt) return res.json({ status: 'ENDED' });
  const qr = !session.challenge || session.challenge.expiresAt < Date.now() ? issue(session) : null;
  res.json({ status: 'ACTIVE', course: { title: session.course.title, code: session.course.code, section: session.course.section }, week: session.week, meetingDate: session.meetingDate, meetingType: session.meetingType, sessionId: session.id, qrOpen: session.qrOpen, challenge: qr?.challenge || session.challenge.raw, challengeExpiresAt: qr?.expiresAt || session.challenge.expiresAt, presentCount: session.present.length, total: (courseStudents[session.course.id] || []).length });
});
app.post('/api/sessions/:id/qr-close', auth, (req, res) => { const session = getSession(req, res); if (!session) return; if (session.state !== 'CLASS_OPEN') return res.status(410).json({ error: 'Ders oturumu kapalı' }); session.qrOpen = false; session.challenge = null; event('QR yoklaması kapatıldı', `${session.course.code} · ${session.present.length} öğrenci korundu`, { ...auditContext(req, 'instructor', req.instructorId, instructors[req.instructorId]?.name), category: 'attendance', metrics: { courseId: session.course.id, courseCode: session.course.code, meetingId: session.meetingId, week: session.week } }); res.json({ ok: true, present: session.present, maxOpens: MAX_QR_OPENS, opensRemaining: MAX_QR_OPENS - session.openNumber }); });
app.get('/api/sessions/:id/challenge', auth, (req, res) => { const session = getSession(req, res); if (!session) return; if (session.state !== 'CLASS_OPEN' || !session.qrOpen || Date.now() > session.closesAt) return res.status(410).json({ error: 'QR yoklaması kapalı' }); res.json(issue(session)); });
app.get('/api/checkin/validate', (req, res) => { const session = sessions.get(String(req.query.session || '')); if (!validChallenge(session, req.query.challenge)) return res.status(403).json({ error: 'Bu QR geçersiz, eski veya QR yoklaması kapalı' }); const ticket = secret(), expiresAt = Date.now() + CHECKIN_TICKET_TTL; checkinTickets.set(ticket, { sessionId: session.id, expiresAt }); res.json({ valid: true, course: session.course.title, week: session.week, ticket, expiresAt }); });
app.get('/api/sessions/:id', auth, (req, res) => { const session = getSession(req, res); if (!session) return; res.json({ id: session.id, state: session.state, qrOpen: session.qrOpen, course: publicCourse(session.course), meetingId: session.meetingId, week: session.week, apiWeek: session.apiWeek, meetingDate: session.meetingDate, meetingType: session.meetingType, absenceHours: session.absenceHours, absentField: session.absentField, presentField: session.presentField, closesAt: session.closesAt, present: session.present, previouslyDeliveredCount: session.previouslyDelivered?.size || 0, eligible: (courseStudents[session.course.id] || []).length, openNumber: session.openNumber, maxOpens: MAX_QR_OPENS, opensRemaining: MAX_QR_OPENS - session.openNumber }); });
app.get('/api/sessions/:id/ois-preview', auth, (req, res) => { const session = getSession(req, res); if (!session) return; const instructor = instructors[session.instructorId], target = oisWriteTarget(session.course); res.json({ deliveryTarget: { environment: target.environment, label: target.label, endpoint: target.base || null }, instructor: { id: instructor.id, name: instructor.name }, course: { id: session.course.id, code: session.course.code, title: session.course.title, academicYear: session.course.academicYear, semester: session.course.semester, section: session.course.section }, week: session.week, apiWeek: session.apiWeek, date: session.meetingDate, type: session.meetingType, absenceHours: session.absenceHours, absentField: session.absentField, presentField: session.presentField, payload: attendancePayload(session) }); });
app.post('/api/attendance/claim', (req, res) => { const { sessionId, ticket, studentNo } = req.body; const session = sessions.get(sessionId), checkin = checkinTickets.get(String(ticket || '')); if (!session || session.state !== 'CLASS_OPEN' || !session.qrOpen || Date.now() > session.closesAt) return res.status(410).json({ error: 'QR yoklaması kapalı veya ders bitmiş' }); if (!checkin || checkin.sessionId !== session.id || checkin.expiresAt < Date.now()) return res.status(400).json({ error: 'Öğrenci doğrulama süresi doldu. Güncel QR’ı yeniden okutun.' }); const student = (courseStudents[session.course.id] || []).find(item => item.no === String(studentNo)); if (!student) return res.status(403).json({ error: 'Bu öğrenci numarası dersin kayıt listesinde bulunamadı' }); if (session.previouslyDelivered?.has(student.no)) return res.status(409).json({ error: 'Bu dersin bu oturumundaki yoklamanız daha önce OİS’e gönderildi.' }); if (session.present.some(item => item.no === student.no)) return res.status(409).json({ error: 'Bu öğrenci için yoklama zaten alınmış' }); checkinTickets.delete(ticket); session.present.push({ ...student, checkedAt: new Date().toISOString() }); event('Yoklama kaydedildi', `${student.no} · ${student.name}`, { ...auditContext(req, 'student', student.no, student.name), category: 'attendance', metrics: { studentNo: student.no, courseId: session.course.id, courseCode: session.course.code, meetingId: session.meetingId, week: session.week } }); res.status(201).json({ ok: true, student, count: session.present.length }); });
app.post('/api/sessions/:id/end', auth, async (req, res) => { const session = getSession(req, res); if (!session) return; if (session.state !== 'CLASS_OPEN') return res.status(410).json({ error: 'Ders oturumu zaten bitmiş' }); session.state = 'ENDED'; session.qrOpen = false; session.challenge = null; const oisPayload = attendancePayload(session); try { const delivery = await sendToOis(oisPayload, session.course); session.oisDelivery = delivery; if (delivery.sent) { const history = attendanceHistory[session.historyKey] || { opens: session.openNumber, present: [] }; history.opens = Math.max(Number(history.opens) || 0, session.openNumber); history.present = session.present.map(student => ({ no: String(student.no), name: student.name, checkedAt: student.checkedAt || new Date().toISOString() })); history.enrolled = (courseStudents[session.course.id] || []).length; history.lastSentAt = new Date().toISOString(); attendanceHistory[session.historyKey] = history; saveAttendanceHistory(); } const summary = attendanceDeliverySummary(session, Boolean(delivery.sent)); for (const pairing of tvPairings.values()) if (pairing.sessionId === session.id) pairing.status = 'ENDED'; const actor = auditContext(req, 'instructor', req.instructorId, instructors[req.instructorId]?.name); event(delivery.sent ? 'OİS yoklama gönderildi' : 'OİS yoklama paketi hazırlandı', `${session.course.code} · hafta ${session.week} · ${summary.attended}/${summary.total} öğrenci`, { ...actor, category: 'attendance', metrics: { attendanceKey: session.historyKey, courseId: session.course.id, courseCode: session.course.code, meetingId: session.meetingId, week: session.week, total: summary.total, attended: summary.attended, absent: summary.absent, sent: Boolean(delivery.sent) } }); res.json({ ok: true, oisPayload, delivery, summary, openNumber: session.openNumber, maxOpens: MAX_QR_OPENS, opensRemaining: MAX_QR_OPENS - session.openNumber }); } catch (error) { session.state = 'CLASS_OPEN'; event('OİS gönderimi başarısız', `${session.course.code} · ${error.message}`, { ...auditContext(req, 'instructor', req.instructorId, instructors[req.instructorId]?.name), category: 'attendance', metrics: { courseId: session.course.id, courseCode: session.course.code, meetingId: session.meetingId, week: session.week } }); res.status(502).json({ error: 'OİS gönderimi başarısız; ders oturumu yeniden açık bırakıldı.', detail: error.message, oisPayload, oisDebug: error.oisDebug || null }); } });
app.get('/api/audit', adminAuth, (_, res) => res.json(audit));

app.post('/api/admin/login', (req, res) => { const admin = admins[String(req.body.username || '')]; if (!admin || admin.passwordHash !== hash(String(req.body.password || ''))) return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı' }); const token = secret(); adminTokens.set(token, admin.username); event('Yönetici girişi', 'Yönetim merkezine giriş yapıldı', { ...auditContext(req, 'admin', admin.username, admin.name), category: 'authentication' }); res.json({ token, passwordChangeRequired: admin.passwordIsDefault, admin: { username: admin.username, name: admin.name, passwordIsDefault: admin.passwordIsDefault } }); });
app.post('/api/admin/password', adminTokenAuth, (req, res) => { const value = String(req.body.newPassword || ''); if (value.length < 10 || !/[A-Za-zÇĞİÖŞÜçğıöşü]/.test(value) || !/\d/.test(value) || !/[^A-Za-zÇĞİÖŞÜçğıöşü0-9]/.test(value)) return res.status(400).json({ error: 'Şifre en az 10 karakter olmalı; harf, rakam ve özel karakter içermeli.' }); const admin = admins[req.adminUsername]; admin.passwordHash = hash(value); admin.passwordIsDefault = false; saveAdminPassword(admin); event('Yönetici şifresi değiştirildi', admin.username, { ...auditContext(req, 'admin', admin.username, admin.name), category: 'account' }); res.json({ ok: true }); });
app.get('/api/admin/calendars', adminAuth, (_, res) => res.json({ calendars: Object.values(academicCalendars) }));
app.put('/api/admin/calendars/:season/:semester', adminAuth, (req, res) => {
  const season = String(req.params.season), semester = Number(req.params.semester), weekOneStart = String(req.body.weekOneStart || '');
  if (!/^20\d\d-20\d\d$/.test(season) || ![1,2,3].includes(semester)) return res.status(400).json({ error: 'Geçerli akademik yıl ve dönem seçin.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOneStart) || new Date(`${weekOneStart}T00:00:00Z`).getUTCDay() !== 1) return res.status(400).json({ error: 'İlk akademik hafta başlangıcı pazartesi olmalı.' });
  const weekCount = semester === 3 ? 7 : 16, examWeeks = semester === 3 ? [] : [8,16];
  Object.values(academicCalendars).forEach(calendar => { calendar.active = false; });
  const calendar = { season, semester, weekOneStart, weekCount, attendanceWeekCount: semester === 3 ? 7 : 14, examWeeks, active: true, updatedAt: new Date().toISOString(), updatedBy: req.adminUsername };
  academicCalendars[calendarKey(season, semester)] = calendar; saveAcademicCalendars(); event('Akademik takvim güncellendi', `${season} · dönem ${semester} · ${weekCount} hafta`, { ...auditContext(req, 'admin', req.adminUsername, admins[req.adminUsername]?.name), category: 'administration' }); res.json({ ok: true, calendar });
});
function auditDateInTurkey(value) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function filterAuditEntries(query = {}) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(query.from || '')) ? String(query.from) : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(query.to || '')) ? String(query.to) : null;
  const instructorId = String(query.instructorId || '');
  const category = String(query.category || '');
  return audit.filter(entry => {
    const date = auditDateInTurkey(entry.at);
    return (!from || date >= from) && (!to || date <= to) && (!instructorId || entry.actorId === instructorId) && (!category || entry.category === category);
  });
}
function auditInstructorOptions() {
  const items = new Map(Object.values(instructors).map(instructor => [instructor.id, { id: instructor.id, name: instructor.name || 'Öğretim elemanı' }]));
  audit.filter(entry => entry.actorType === 'instructor' && entry.actorId).forEach(entry => items.set(entry.actorId, { id: entry.actorId, name: entry.actorName || 'Öğretim elemanı' }));
  return [...items.values()].sort((left, right) => left.name.localeCompare(right.name, 'tr'));
}
function statisticsFor(entries) {
  const checkins = entries.filter(entry => entry.type === 'Yoklama kaydedildi' && entry.metrics?.studentNo);
  const allStudentNumbers = new Set(audit.filter(entry => entry.type === 'Yoklama kaydedildi' && entry.metrics?.studentNo).map(entry => entry.metrics.studentNo));
  const logins = entries.filter(entry => entry.type === 'Öğretim elemanı girişi');
  const deliveryBySlot = new Map();
  entries.filter(entry => entry.type === 'OİS yoklama gönderildi' && entry.metrics?.attendanceKey).forEach(entry => { if (!deliveryBySlot.has(entry.metrics.attendanceKey)) deliveryBySlot.set(entry.metrics.attendanceKey, entry); });
  const deliveries = [...deliveryBySlot.values()];
  const participationRates = deliveries.filter(entry => Number(entry.metrics.total) > 0).map(entry => Number(entry.metrics.attended) / Number(entry.metrics.total));
  const byDay = new Map();
  entries.forEach(entry => { const day = auditDateInTurkey(entry.at); if (!byDay.has(day)) byDay.set(day, []); byDay.get(day).push(entry); });
  const daily = [...byDay.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([date, rows]) => {
    const dayDeliveries = new Map(); rows.filter(entry => entry.type === 'OİS yoklama gönderildi' && entry.metrics?.attendanceKey).forEach(entry => { if (!dayDeliveries.has(entry.metrics.attendanceKey)) dayDeliveries.set(entry.metrics.attendanceKey, entry); });
    return { date, uniqueInstructorLogins: new Set(rows.filter(entry => entry.type === 'Öğretim elemanı girişi').map(entry => entry.networkId).filter(Boolean)).size, attendanceLessons: dayDeliveries.size, attendanceCheckins: rows.filter(entry => entry.type === 'Yoklama kaydedildi').length, uniqueStudents: new Set(rows.filter(entry => entry.type === 'Yoklama kaydedildi').map(entry => entry.metrics?.studentNo).filter(Boolean)).size };
  });
  return { uniqueInstructorLogins: new Set(logins.map(entry => entry.networkId).filter(Boolean)).size, attendanceLessons: deliveries.length, attendanceCheckins: checkins.length, uniqueStudents: new Set(checkins.map(entry => entry.metrics.studentNo)).size, uniqueStudentsLifetime: allStudentNumbers.size, averageParticipationRate: participationRates.length ? participationRates.reduce((sum, rate) => sum + rate, 0) / participationRates.length : 0, coursesWithAttendance: new Set(deliveries.map(entry => entry.metrics.courseId)).size, qrSessionsOpened: entries.filter(entry => entry.type === 'QR yoklaması açıldı').length, daily };
}
app.get('/api/admin/audit', adminAuth, (req, res) => { const entries = filterAuditEntries(req.query); const limit = Math.min(Math.max(Number(req.query.limit) || 250, 1), 1000); res.json({ entries: entries.slice(0, limit), instructors: auditInstructorOptions(), categories: ['authentication', 'attendance', 'account', 'administration', 'system'] }); });
app.get('/api/admin/statistics', adminAuth, (req, res) => { const entries = filterAuditEntries(req.query); res.json({ filters: { from: req.query.from || null, to: req.query.to || null, instructorId: req.query.instructorId || null }, statistics: statisticsFor(entries), instructors: auditInstructorOptions() }); });
app.get('/api/admin/overview', adminAuth, (req, res) => { const teacherList = Object.values(instructors).map(({ id: teacherId, name, courses }) => ({ id: teacherId, name, courseCount: courses.length })); const courseList = Object.values(instructors).flatMap(instructor => instructor.courses.map(course => ({ ...publicCourse(course), instructorId: instructor.id, instructorName: instructor.name }))); const sessionList = [...sessions.values()].sort((a, b) => b.openedAt - a.openedAt).map(session => ({ id: session.id, courseId: session.course.id, courseCode: session.course.code, courseTitle: session.course.title, instructorId: session.instructorId, meetingDate: session.meetingDate, meetingType: session.meetingType, state: session.state, qrOpen: session.qrOpen, openedAt: session.openedAt, presentCount: session.present.length, eligible: (courseStudents[session.course.id] || []).length, openNumber: session.openNumber })); res.json({ admin: { username: admins[req.adminUsername].username, name: admins[req.adminUsername].name }, stats: { instructors: teacherList.length, courses: courseList.length, sessions: sessionList.length, activeSessions: sessionList.filter(session => session.state === 'CLASS_OPEN').length, checkins: sessionList.reduce((sum, session) => sum + session.presentCount, 0) }, calendars: Object.values(academicCalendars), instructors: teacherList, courses: courseList, sessions: sessionList, audit: audit.slice(0, 30) }); });
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use(express.static(DIST_DIR));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});
async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, '0.0.0.0', () => console.log(`Yoklama API http://localhost:${PORT} · hedef: ${OIS_ENVIRONMENT_LABEL} · yazım: ${process.env.OBS_LIVE_WRITE === 'true' ? 'açık' : 'kapalı'}`));
  } catch (error) {
    console.error(`[Veritabanı] Başlatma başarısız: ${error.message}`);
    process.exitCode = 1;
  }
}
void startServer();

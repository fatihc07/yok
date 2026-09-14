# Project State

## Current version

Kampüs Yoklama v1.1.0 — local QR attendance MVP with an OİS write adapter.

## Architecture

- `server.js`: Express API, local test fixtures, QR session security, OİS request construction, and admin endpoints.
- `src/main.js`: instructor dashboard, OİS-derived weekly attendance plan, QR session controls, and OİS request preview/reporting.
- `src/student.js`: QR-gated student-number attendance flow.
- `src/admin.js`: separate local administrator view.

## Active test integration

- Test course: PSK 301 Fizyolojik Psikoloji, course ID 27063, section 1.
- Test course roster has two students.
- OİS credentials are server-only environment configuration and are intentionally absent from this file.
- The local environment is currently restored to the official OİS endpoint because the OİS test host rejects the live assigned-course read API with HTTP 401. Tests in this configuration write to real OİS data and must be restricted to the user-authorized helper-instructor course. For the controlled helper-instructor test, active term is temporarily `2025-2026 Yaz (3)` so that the assigned test course can open QR attendance; restore active `2026-2027 Güz (1)` after the controlled write test.
- OİS delivery reports retain the configured endpoint even when the network connection itself fails.
- A failed connection report includes the sanitized network error code and message, separating connectivity from OİS payload errors.
- Local OİS test can use a narrowly scoped temporary TLS certificate exception because the test hostname is absent from the supplied certificate; the exception is hard-disabled for production.
- The instructor dashboard includes academic-year and Güz/Bahar/Yaz selection and queries `hocaders` using the authenticated instructor ID. Courses are registered server-side for the selected session pending real-program mapping.
- Assigned courses invoke the OİS `hocadersprogrami` read endpoint in the background and use only a returned week/date list for the attendance plan. If OİS does not return a parseable plan, the course has no selectable weeks and cannot open QR attendance; the app never substitutes a fixed week count.
- When OİS returns an unrecognized program shape, the server logs only its JSON field structure (not values) to complete the live field mapping without exposing technical data in the instructor UI.
- The assigned-course response is also used to update the instructor display name when OİS supplies a recognized name field; profile-photo support awaits a documented image field or endpoint.
- On normal login, the app now performs the selected-term OİS profile lookup before opening the dashboard and locally retains the OİS-derived instructor name for later logins.
- Name matching recognizes common Turkish OİS field spellings such as `ogretim_elemani_ad_soyad` and `hoca_ad_soyad`.
- The attendance-count card opens an instructor-only OİS roster modal, showing live QR attendance with a green check per student.
- Roster normalization recognizes OİS student name variants including `ogrenci_adi`, `ogrenci_soyadi`, and combined name fields.
- Only the configured active academic term permits QR sessions and OİS attendance writes; older terms are read-only in the UI and enforced by the server.
- Test-only TLS handling covers assigned-course and student-list reads as well as attendance writes because the OİS test certificate does not include the test hostname. Production always uses standard TLS verification.
- Read-only courses do not render any QR session-start control.
- Past-term course cards remain visible but are disabled before navigation to the attendance screen.
- The local test login is mapped to the user-supplied current instructor code for OİS course reads; the display name remains OİS-derived.
- Instructor login uses the OİS hoca kodu. The initial password is its final four digits, but that login can access only the forced password-creation panel; no courses or attendance surfaces are exposed before a stronger password is saved.
- Instructor sessions are intentionally server-memory-only. After a server restart, the browser detects a 401 response, clears the obsolete local session, and returns to the login screen instead of leaving the instructor on a broken dashboard.
- The same website now supports a separate TV mode alongside normal instructor login. A teacher who is already signed in can create a six-digit, one-time TV pairing code for the selected active course/week; the TV enters only this code and cannot receive the course or QR until the teacher explicitly approves from the computer.
- TV pairing codes expire after one minute and are distinct from the rotating student QR challenge. The TV holds an opaque display token, not an instructor password or normal instructor session.
- When the instructor ends the attendance session from the computer, any linked TV display is marked ended and returns to the TV pairing screen.
- The administrator can activate one academic-term calendar at a time. It records the Monday that starts academic week 1; every course uses that same Monday as its week date, regardless of the scheduled lesson day.
- Academic-calendar derivation recognizes Turkish and normalized weekday-field variants from live OİS program responses to identify separate course slots and calculates lesson duration from OİS start/end times when available. It also attempts the assigned-course row as a fallback if the separate program read fails.
- Güz and Bahar calendars create 16 calendar weeks: weeks 8 and 16 are displayed as vize/final and are QR-locked, leaving 14 attendance weeks. Yaz creates 7 attendance weeks. A teacher may open a non-exam week later for a make-up lesson while retaining that week’s original OİS date.
- A separate administrator account tied to the user-supplied hoca ID has forced first-login password replacement and may change only the academic year, term, and first-week start date. The account password is stored only as a local hash and is intentionally absent from this file.
- The primary login screen accepts either a hoca code or the authorized administrator username. A successful administrator login automatically routes to the management screen, so no separate administrator URL needs to be opened manually.
- `npm run tv` starts the local API and Vite UI on the local network without a Cloudflare tunnel. The deployed Railway address is used instead for cross-network TV testing.
- OİS term codes are Güz=1, Bahar=2, Yaz=3, verified from the OİS course-detail URL.
- OİS course-program rows are now treated as distinct recurring lesson slots. When a course has theory and application/practice on separate days or times, every academic week preserves both selectable slots. QR, TV pairing, opening limits, and local completed-attendance state are keyed by the specific slot rather than only by course date/week.
- When OİS provides both start and end time for a program row, the teacher plan and course header display the full time range; duration continues to be calculated from that same range.
- Week cards are intentionally minimal, showing only the week number and shared Monday date. Course day/time/type options live in the black course card above the plan, where the instructor chooses the intended session.
- The supplied OİS attendance write payload has no explicit theory/application field. The app therefore retains the selected OİS program slot’s type and duration locally, while sending the administrator-defined common Monday date, week, and absence-hour values in the documented payload.
- OİS attendance fields are selected by lesson-session type, not by each student's attendance status. A theory session sends every student through `saat`; an application/practice/laboratory session sends every student through `Usaat`. Within that single field, QR-confirmed students send `0` and absent students send the OİS lesson-hour value.
- The default server target is production and always uses standard TLS verification. Only the temporary controlled test-course bridge may use the explicit test-host TLS exception.
- The OİS endpoint responds successfully at HTTP level but previously rejected the app's course payload with a course-data error.
- Temporary controlled test bridge: only instructor `2500002318`, `2025-2026 Yaz (3)`, PSK 301 / course ID 27063 / section 1 is injected as a selectable test course. Its seven weekly sessions, known two-student controlled roster fallback, program probe, and attendance delivery target OİS test. All other course reads and writes retain the configured live OİS target. Remove this bridge and `OBS_TEST_API_BASE` before production deployment.
- OİS attendance writes use `tarih` for the selected academic week. The payload's misleadingly named `hafta` field is the recurring lesson-slot number within that week: a course with one weekly session sends `1` on every academic-week date; multiple theory/practice slots send stable `1`, `2`, and so on. An explicit OİS attendance-slot code still takes precedence when supplied.
- The controlled test-target decision is also derived from that exact instructor/course/year/term/section combination, so a stale in-memory or live-list representation of the same authorized test course cannot accidentally write to live OİS.
- OİS attendance serialization follows the administrator's validated identifier contract for every course: `ders_id` is numeric, while instructor ID, section, week, and student number are strings. The theory/application hour field is chosen once per selected recurring session.
- OİS course/program lookup identity and attendance-write identity are deliberately separate. Every attendance payload's `kullanici_id` is the authenticated instructor who opened the QR session; a course owner's identity is retained only where OİS requires it for course/program lookup. This also applies to the controlled test course.
- The post-send instructor modal exposes the non-secret OİS diagnostic evidence: HTTP status, transport, endpoint, attendance request fields, and OİS's raw response. API credentials remain server-only and never appear in the browser.
- A successful OİS send now opens an instructor-only delivery-summary modal: all roster members appear with attendance and delivery status, plus sent, attended, absent, and session-count totals. The old inline completion note and placeholder “Yaklaşan oturumlar” card were removed.
- Attendance opening and delivered-presence history are persisted locally per instructor/course/scheduled slot. A slot can open at most five QR sessions; after a successful send, previously delivered students remain present in later sessions and the server rejects their repeat QR claim while still accepting previously missing students.
- The roster modal reads persisted delivery history for the selected course slot after refresh/restart, so it keeps showing previously delivered students instead of incorrectly reverting them to “Bekliyor”. A dry-run/test package is not recorded as an OİS delivery.
- An OİS HTTP 200 / `err: 0` result is presented as an unverified API-accepted request, not a delivery. The application does not lock delivered-presence history or claim OİS persistence until OİS provides a record-reading/verification API.
- Instructor participation cards distinguish OİS API acceptance from verified attendance: accepted-but-unverified attempts are counted and labelled separately, while participation percentages continue to use only verified records.
- Instructor QR check-in now uses the two-step server contract: the rotating QR challenge first obtains a short-lived validation ticket, which is then sent to the attendance-claim endpoint. This prevents valid QR scans from being rejected as expired due to the old client/server field mismatch.
- OİS absence-hour derivation uses an explicit program-row hour when available, otherwise the OİS course summary's theory/practice/laboratory hour. Scheduled wall-clock ranges remain display information and are only a fallback, so breaks or long classroom blocks cannot inflate the absence value sent to OİS.
- The `hocaders` course fetch preserves OİS theory, practice, and laboratory hours on every course record and shows them in the teacher's course list. No instructor-side hour entry exists; those values are the source for attendance-hour calculation and the OİS request preview.
- Historical records created by older builds from an unverified HTTP 200 / `err: 0` response are invalidated at every server startup from both the local-file and PostgreSQL stores. They cannot pre-fill a new QR session, consume an opening allowance, or inflate participation figures. The browser likewise discards unverified legacy completion summaries on load.
- Administrator reporting persists audit events locally and limits raw audit access to administrator authentication. The report interface filters by date, instructor, and action category. It reports daily unique instructor logins by one-way network identifier, attendance lessons, QR check-ins, unique students (selected dates and lifetime), average per-slot participation, and QR sessions opened.
- Vite production output explicitly includes `index.html`, `admin.html`, and `student.html`, so the administrator and student surfaces are included alongside the main instructor screen in a build.
- Release version `v1.1.0` is visible on the instructor login screen and throughout the instructor interface header, providing a direct deployment/freshness check after Railway rollout.
- The instructor dashboard now displays a per-course cumulative participation rate for the selected term. It is calculated from locally persisted, successfully completed attendance deliveries as attended students divided by the enrolled-student total across delivered lesson slots; each course states the last processed academic week and session count. A period-wide instructor summary uses the same weighted calculation across that instructor’s selected-term courses.
- Render staging support: the Express server serves the built `dist` interface and API from one HTTPS service, exposes `/healthz`, and uses `DATABASE_URL` when present. The PostgreSQL-backed application-state store retains account hashes, calendars, attendance history, and audit logs while preserving the local-file fallback for development. `render.yaml` defines a free staging Postgres instance and passes its private connection string to the web service.

## Known issue / next work

- Confirm the corrected session-type mapping against an OİS-writable/open academic period. For PSK 301's theory session, one absent and one QR-confirmed student now send `saat:3` and `saat:0`, with date `2026-07-13` and lesson-slot `hafta:1`.
- Controlled browser and direct-API tests on 2026-09-11 sent the QR scenario and the administrator's example independently of the application. OİS test returned HTTP 200 / `err:0`, but both the week-5 screen and the July daily report remained 0. The test course belongs to a past/closed summer period; OİS test must confirm that this period is write-enabled or provide a current writable test course before persistence can be proven.
- The previous controlled fixture incorrectly represented PSK 301 as a six-hour theory session due to its display time range. OİS course metadata shows 3 theory, 0 practice, and 0 laboratory hours, so the next controlled test must send `saat:3` for an absent student.
- OİS must provide an attendance-history read API before historical attendance values can be independently reconciled from OİS rather than the local successful-delivery history.
- The OİS weekly-plan API currently exposes only recurring class metadata, not date/week rows; the administrator-configured academic calendar now supplies the dates until OİS provides an authoritative calendar/weekly-plan endpoint.
- A free Render service is suitable for controlled online testing but not a reliable classroom-production host: it sleeps after inactivity and its free Postgres instance expires after 30 days. Move the staging database to a permanent managed database before institution-wide production use.

## Verification

- `node --check server.js`, `npm run build`, and `git diff --check` pass after the instructor participation-statistics update. The server-side login and multi-device pairing flow could not be network-tested in the sandbox because local loopback connections are denied there.

# Changelog

## 2026-09-11 — Render çevrimiçi test hazırlığı

- Prepared the application for a single Render Web Service: Express now serves the built web interface and API at the same HTTPS address, with a health endpoint for deployment checks.
- Added a PostgreSQL-backed application-state store for account hashes, calendars, attendance history, and audit logs, while retaining the local-file fallback for local development.
- Added a free Render Postgres staging resource to `render.yaml`; its private `DATABASE_URL` is injected into the web service without exposing database credentials in the repository.

## 2026-09-11 — OİS teori/uygulama yoklama alanı düzeltmesi

- Corrected each OİS attendance payload to use one consistent field for its selected scheduled session: theory sends `saat`, while application/practice/lab sends `Usaat`.
- QR-confirmed students now send `0` and absent students send the selected session's lesson hours through that same session field.

## 2026-09-11 — Yenileme sonrası yoklama durumu tutarlılığı

- Corrected the roster modal to read the selected session's persisted OİS-delivery history after a page refresh, instead of showing all students as waiting because no live session exists.
- A dry-run/test packet is no longer persisted or presented as an OİS delivery; only an actual successful OİS write locks in the delivered attendance record.

## 2026-09-11 — Öğretim elemanı ders katılım istatistikleri

- Added a selected-term instructor participation summary to the course dashboard.
- Each course card now shows its cumulative attendance percentage, the last processed academic week, and the number of completed attendance sessions; courses without an OİS delivery clearly state that no attendance has been sent yet.
- Participation is calculated from persisted delivered attendance records and their enrolled-student counts, so it is cumulative across the teacher’s completed sessions rather than a fixed or mocked percentage.

## 2026-09-11 — Yönetici denetim günlüğü ve istatistikler

- Added persistent administrator-only audit records for instructor/admin logins, QR session lifecycle actions, student QR check-ins, OİS delivery outcomes, and academic-calendar changes.
- Added shared date, instructor, and action-category filters for the administrator audit table and statistics view.
- Added selected-period daily statistics: unique instructor logins by one-way network identifier, unique attendance lessons, QR check-ins, selected-period and lifetime unique students, mean lesson participation, and QR sessions opened.
- Restricted the raw audit endpoint to administrator authentication.
- Included the administrator and student HTML entry points in production builds.

## 2026-09-11 — OİS gönderim özeti ve tamamlayıcı QR oturumları

- Replaced the old inline OİS completion message with a post-send instructor summary modal listing every student, attendance status, green delivery status, and totals for sent records, attended students, absent students, and session usage.
- Removed the placeholder “Yaklaşan oturumlar” card from the attendance centre.
- Raised the per instructor/course/scheduled-slot QR opening limit from three to five and made the current/next session number visible on the start action.
- Persisted successful attendance delivery history per scheduled slot. A later QR session keeps previously delivered students present, rejects their repeat check-in, and permits only students whose attendance was not previously sent to check in.

## 2026-09-11 — Scoped OİS test-course bridge

- Kept the default integration on live OİS and added a temporary, explicit bridge for the authorized PSK 301 OİS test course only.
- The bridge appears only for its assigned helper instructor in `2025-2026 Yaz (3)` and sends its QR attendance output to OİS test; it does not redirect any normal course query or write.
- Defined the controlled test course as seven weekly sessions and retained its authorized two-student test roster as a fallback if the test host does not expose roster reads.
- The OİS preview and delivery report now display the actual per-course destination, making OİS test versus live OİS visible before and after a send.
- Hardened the destination rule so the exact authorized test-course identity routes to OİS test even if it originated from an older in-memory course record.

## 2026-09-11 — Restore working OİS read/write configuration

- Restored the previously working official OİS endpoint after the test host rejected assigned-course reads with HTTP 401.
- Local test activity therefore again affects the authorized real OİS course until test-host read access is available.

## 2026-09-11 — Restore controlled OİS test target

- Switched the local controlled-write environment from the live OİS host back to the OİS test host, so attendance test runs no longer write to production.
- Kept the certificate exception constrained to this explicit test environment; production continues to require standard TLS verification.

## 2026-09-11 — Theory and application session separation

- Changed OİS program handling from one weekly meeting per course to one meeting per OİS schedule row.
- A week with multiple scheduled rows now first selects the week, then displays separate Theory/Application session buttons with their OİS day, start time, and calculated duration when available.
- QR attendance, TV pairing, QR reopening limits, and completed local attendance records now use a distinct scheduled-session identifier, so two classes in the same week do not share a QR session or overwrite each other.
- The OİS preview now continues to use the documented date/week attendance payload while retaining the selected Theory/Application slot and its hours in the application.
- Made the academic week date common to every course: each week is always represented by that academic week’s Monday, while OİS lesson-day data remains an informational/session-separation attribute.
- Display the OİS end time alongside the start time in both the selected course header and per-week session labels.
- Simplified week cards to week name and shared start date only; moved selectable OİS day/time/theory/application details to the course header card.
- At that time, the attendance-field handling was aligned with the then-understood OİS sample; it has since been superseded by the session-type correction above.

## 2026-09-10 — Administrator-managed academic calendar

- Added a separate forced-password-change administrator account for the user-authorized hoca-ID-based administrator identity.
- Added an academic-calendar management screen where the administrator selects an academic year, Güz/Bahar/Yaz term, and the Monday that begins academic week 1.
- Güz and Bahar now calculate 16 calendar weeks, visually marking week 8 as vize and week 16 as final; both are blocked from QR attendance, leaving 14 attendance weeks.
- Yaz terms calculate seven attendance weeks.
- When the OİS program endpoint supplies recurring lesson days but no week/date rows, the app uses the active administrator calendar’s Monday for every course in that week. A later make-up lesson can still be recorded against the original selected week.
- Expanded recurring OİS schedule parsing so academic-calendar weeks are generated from common weekday-field variants and OİS time ranges instead of displaying an empty plan when field casing or nesting differs.
- Unified administrator access with the normal login screen: the authorized administrator username is recognized there and automatically opens the management screen.

## 2026-09-10 — Same-site classroom TV pairing

- Added a “TV ile giriş” option to the existing login screen; TV users enter only a short six-digit pairing code and never enter a teacher credential.
- Added teacher-side “TV’ye bağla” flow for the selected active course/week, including code expiration, TV connection detection, and explicit computer-side approval before QR attendance begins.
- Separated the one-time TV pairing code from the rotating student attendance QR challenge.
- Added a TV-only display state that shows the live course QR and attendance count after approval, polls for teacher-controlled QR status, and exits when the teacher ends the class on the computer.
- Linked session closure to its paired TV display so a completed lesson cannot leave an active QR visible on the classroom screen.
- Added `npm run tv` for a controlled, single-terminal Cloudflare HTTPS quick-tunnel test when the TV and teacher computer cannot reach one another on the local network.

## 2026-09-10 — Official OİS read integration

- Switched the user-authorized OİS integration target from the test hostname to the official OİS endpoint supplied by the OİS administrator.
- Added academic-year and Güz/Bahar/Yaz selection with authenticated OİS assigned-course retrieval through `hocaders`.
- Updated the instructor profile name from recognized OİS assigned-course response fields when available.
- Expanded OİS instructor-name field matching to common Turkish API naming variants.
- Added a local technical OİS response view to identify unresolved instructor-name fields.
- Added an instructor roster modal with live per-student QR attendance status.
- Expanded OİS student-name field matching in the roster integration.
- Locked QR sessions and attendance writes to the configured active academic term; past terms are read-only.
- Hid QR session-start controls entirely for read-only courses.
- Disabled past-term course cards directly in the OİS course list.
- Updated the local test-login OİS instructor mapping to the current user-supplied code.
- Corrected the Yaz term mapping back to OİS's verified course-detail value 3.
- Replaced instructor TC login with hoca-kodu login and added mandatory first-login password creation before the dashboard can be opened.
- Attempted the user-authorized OİS test course in `2025-2026 Yaz (3)` and extended the existing test-only TLS exception to OİS course and student reads. Restored the official OİS endpoint when the test course-list endpoint returned HTTP 401.
- Return instructors to the login screen automatically after a server restart invalidates their in-memory session.
- Load and retain the OİS-derived instructor name before opening the dashboard after login.
- Temporarily made `2025-2026 Yaz (3)` the QR-enabled term for the authorized helper-instructor test course and removed instructor-facing OİS query/program technical panels.
- Replaced the fixed 14-week attendance plan with automatic OİS program-week normalization; courses cannot open QR attendance until OİS supplies a usable live week/date list.
- Added a value-free OİS program-schema log for mapping unexpected live program responses.

## 2026-09-09 — OİS test environment separation

- Redirected the local controlled attendance test to the configured OİS test endpoint instead of the production OİS endpoint.
- Added a server-side environment label to delivery responses and failure reports, so the target environment is visible without exposing credentials.
- Fixed network-failure reports so they retain and display the configured OİS test endpoint.
- Restricted controlled OİS test delivery to the administrator-verified 13.07.2026 payload and expose the underlying network error code in the report.
- Added the captured connection error to the on-screen OİS report for troubleshooting test-server connectivity.
- Added a test-only, explicitly configured TLS certificate exception for the OİS test hostname mismatch; production cannot use this exception.
- Removed the date lock from OİS test delivery: each selected weekly session now sends its own selected date and API-week value.
- Added an authenticated OİS course-program probe using the administrator-supplied `hocadersprogrami` read API, with a visible sanitized raw response for mapping validation.

## 2026-09-09 — OİS test payload alignment

- Added project continuity records.
- Preparing the controlled PSK 301 OİS test request to follow the administrator-provided working example.
- Aligned the 13.07.2026 test payload with that example, including its API-week and attendance-field mapping.

## 2026-09-02 — QR attendance MVP

- Added instructor and administrator flows, QR-gated student attendance, OİS request previewing, and detailed sanitized OİS error reporting.

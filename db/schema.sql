-- PostgreSQL production schema. All write operations should run in server-side transactions.
CREATE TYPE user_role AS ENUM ('ADMIN', 'INSTRUCTOR', 'STUDENT');
CREATE TYPE attendance_status AS ENUM ('PRESENT', 'LATE', 'REJECTED');
CREATE TABLE users (id uuid PRIMARY KEY, institution_id text UNIQUE NOT NULL, role user_role NOT NULL, display_name text NOT NULL, sso_subject text UNIQUE NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE departments (id uuid PRIMARY KEY, name text UNIQUE NOT NULL);
CREATE TABLE terms (id uuid PRIMARY KEY, name text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL);
CREATE TABLE courses (id uuid PRIMARY KEY, department_id uuid REFERENCES departments NOT NULL, term_id uuid REFERENCES terms NOT NULL, code text NOT NULL, title text NOT NULL, instructor_id uuid REFERENCES users NOT NULL, UNIQUE(term_id, code));
CREATE TABLE course_enrollments (course_id uuid REFERENCES courses ON DELETE CASCADE, student_id uuid REFERENCES users ON DELETE CASCADE, PRIMARY KEY(course_id, student_id));
CREATE TABLE class_meetings (id uuid PRIMARY KEY, course_id uuid REFERENCES courses ON DELETE CASCADE, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, room text NOT NULL, UNIQUE(course_id, starts_at));
CREATE TABLE attendance_sessions (id uuid PRIMARY KEY, meeting_id uuid REFERENCES class_meetings UNIQUE NOT NULL, opened_by uuid REFERENCES users NOT NULL, opened_at timestamptz NOT NULL DEFAULT now(), closes_at timestamptz NOT NULL, state text NOT NULL CHECK(state IN ('OPEN','CLOSED')));
-- QR values are opaque random references. Store only a SHA-256 hash, never the raw QR value.
CREATE TABLE qr_challenges (id uuid PRIMARY KEY, session_id uuid REFERENCES attendance_sessions ON DELETE CASCADE NOT NULL, token_hash bytea UNIQUE NOT NULL, issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, consumed_at timestamptz, nonce_hash bytea NOT NULL);
CREATE TABLE attendance_records (id uuid PRIMARY KEY, session_id uuid REFERENCES attendance_sessions ON DELETE CASCADE NOT NULL, student_id uuid REFERENCES users NOT NULL, status attendance_status NOT NULL, checked_at timestamptz NOT NULL DEFAULT now(), device_key_id text NOT NULL, network_fingerprint_hash bytea, UNIQUE(session_id, student_id));
CREATE TABLE audit_events (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(), actor_id uuid REFERENCES users, session_id uuid REFERENCES attendance_sessions, event_type text NOT NULL, result text NOT NULL, ip_hash bytea, device_hash bytea, detail jsonb NOT NULL DEFAULT '{}', previous_hash bytea, event_hash bytea NOT NULL);
CREATE INDEX qr_challenges_valid_idx ON qr_challenges(session_id, expires_at) WHERE consumed_at IS NULL;

-- Phase 2 persistence layer (SPEC §6.5). Idempotent: every statement uses
-- IF NOT EXISTS so this can be run on every app boot with no side effects
-- once the tables already exist.
--
-- `sessions.id` is the internal, permanent id (UUID, matches the
-- crypto.randomUUID() already used for in-memory session objects) — never
-- the public join_code. See SPEC §3.

-- Phase 3a (SPEC §3a): User accounts (Google login) + session ownership.
-- `id` is generated in JS via crypto.randomUUID(), same pattern as
-- sessions.id — no dependency on a pgcrypto extension.
CREATE TABLE IF NOT EXISTS users (
  id          UUID PRIMARY KEY,
  google_sub  TEXT UNIQUE NOT NULL,
  email       TEXT,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  UUID PRIMARY KEY,
  join_code           TEXT UNIQUE NOT NULL,
  name                TEXT,
  status              TEXT NOT NULL DEFAULT 'created',
  source_lang         TEXT,
  target_langs        TEXT[],
  cleaned_transcript  TEXT,
  processing_status   TEXT,
  started_at          TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nullable on purpose: pre-phase-3a sessions have no owner, and must keep
-- working (no crashes) even though they'll no longer surface in anyone's
-- "my sessions" list or pass the ownership checks on rename/transcript.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id);

CREATE TABLE IF NOT EXISTS transcript_lines (
  id             BIGSERIAL PRIMARY KEY,
  session_id     UUID NOT NULL REFERENCES sessions(id),
  seq            INTEGER NOT NULL,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  original_text  TEXT NOT NULL
);

-- Reading a whole session's transcript back in order (batch cleanup, the
-- transcript endpoint) is the only query pattern that matters here.
CREATE INDEX IF NOT EXISTS idx_transcript_lines_session_seq
  ON transcript_lines (session_id, seq);

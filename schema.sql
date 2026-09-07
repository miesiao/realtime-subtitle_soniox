-- Phase 2 persistence layer (SPEC §6.5). Idempotent: every statement uses
-- IF NOT EXISTS so this can be run on every app boot with no side effects
-- once the tables already exist.
--
-- `sessions.id` is the internal, permanent id (UUID, matches the
-- crypto.randomUUID() already used for in-memory session objects) — never
-- the public join_code. See SPEC §3.

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

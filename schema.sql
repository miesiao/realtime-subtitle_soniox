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
  source_lang         TEXT, -- superseded by source_langs below; unused, left in place
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

-- Replaces source_lang (single value) with a multi-select-capable array —
-- see host.js's language_hints picker. Semantics match target_langs: NULL =
-- host hasn't clicked Start yet (unknown); ['auto'] = auto-detect chosen
-- explicitly (a sentinel — no real Soniox language code is 4 letters);
-- ['zh','en',...] = specific language_hints. Nothing ever reads the old
-- source_lang column (it was always NULL in practice), so it's left in place
-- rather than migrated — no existing data, nothing to break.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS source_langs TEXT[];

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

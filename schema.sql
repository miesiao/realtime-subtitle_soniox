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

-- Paid credit system (儲值制): a flat integer balance on the user, spent by
-- the minute while a session is actually recording (see usage_ledger below
-- and server.js's per-minute billing timer). New signups get a free 50-point
-- starter allowance (25 minutes of pure transcription, or ~16-17 minutes
-- with translation on) so a brand-new host can try the product before ever
-- having to top up — dbUpsertUserByGoogleSub's INSERT omits `credits`
-- entirely, so it always falls through to whatever DEFAULT is set below.
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;
-- Separate ALTER (not just editing the DEFAULT above) because ADD COLUMN IF
-- NOT EXISTS is a no-op once the column already exists on a previously
-- migrated DB — this is what actually changes the default there too, not
-- only on a fresh install. Safe to run on every boot; does not touch any
-- existing row's balance, only what NEW rows start at.
ALTER TABLE users ALTER COLUMN credits SET DEFAULT 50;

CREATE TABLE IF NOT EXISTS sessions (
  id                  UUID PRIMARY KEY,
  join_code           TEXT UNIQUE NOT NULL,
  name                TEXT,
  -- 'created' | 'live' | 'paused' | 'ended'. 'paused' (added for the
  -- "場次沒結束一直掛 live" fix) is server-driven, not host-chosen: it means
  -- the host's app WS disconnected and never reconnected within
  -- BILLING_DISCONNECT_GRACE_MS — join_code and history survive, and
  -- pressing Start again resumes straight back to 'live' (see server.js's
  -- dbMarkSessionPaused/dbMarkSessionResumed).
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

-- Top-up orders (儲值下單). Manual-verification flow, no payment gateway:
-- the amount→credits mapping is fixed server-side (see server.js's
-- TOPUP_TIERS) so a tampered client request can never buy more credits than
-- it paid for. status starts 'pending' and is flipped to 'paid' by hand
-- after a human checks the bank statement against last_five — there is no
-- code path or admin UI that marks an order paid automatically (SPEC step
-- 5); see the confirmation SQL template wherever this feature was handed off.
-- `id` is a short human-typeable code (see server.js's generateOrderCode),
-- not a UUID — a host reads/types this one, unlike sessions.id.
CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id),
  amount_paid     INTEGER NOT NULL,
  credits_to_add  INTEGER NOT NULL,
  last_five       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | paid | failed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders (user_id);
-- The orders table originally shipped with a UUID id column (before order
-- codes existed) — this widens it in place on any DB that already ran that
-- version. A no-op cast (text::text) on a DB that never had the old
-- version, since CREATE TABLE IF NOT EXISTS above already created it as
-- TEXT; safe to run on every boot either way.
ALTER TABLE orders ALTER COLUMN id TYPE TEXT USING id::TEXT;

-- Append-only usage record (SPEC step 6: "與扣點一致可追溯"). One row per
-- successful per-minute charge while a session is live — never updated or
-- deleted, so a user's balance history can always be reconstructed and
-- cross-checked against users.credits independently of the realtime path.
CREATE TABLE IF NOT EXISTS usage_ledger (
  id                 BIGSERIAL PRIMARY KEY,
  session_id         UUID NOT NULL REFERENCES sessions(id),
  user_id            UUID NOT NULL REFERENCES users(id),
  credits_charged    INTEGER NOT NULL,
  target_lang_count  INTEGER NOT NULL,
  balance_after      INTEGER NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_session_id ON usage_ledger (session_id);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_user_id ON usage_ledger (user_id);

-- Reliability rollout, executed once; existing transcripts get a 30-day grace.
CREATE TABLE IF NOT EXISTS app_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM app_migrations WHERE name = 'mvp-reliability-v1') THEN
  ALTER TABLE sessions ADD COLUMN next_seq BIGINT NOT NULL DEFAULT 1;
  ALTER TABLE sessions ADD COLUMN display_after_seq BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN transcript_revision BIGINT NOT NULL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN transcript_warning BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE sessions ADD COLUMN expires_at TIMESTAMPTZ;
  ALTER TABLE sessions ADD COLUMN transcript_expired_at TIMESTAMPTZ;
  UPDATE sessions SET expires_at = now() + interval '30 days' WHERE status = 'ended';
  -- Legacy Clear restarted seq. Normalize old rows before enforcing uniqueness.
  WITH numbered AS (SELECT id, row_number() OVER (PARTITION BY session_id ORDER BY id) AS n FROM transcript_lines)
    UPDATE transcript_lines SET seq = numbered.n FROM numbered WHERE transcript_lines.id = numbered.id;
  UPDATE sessions s SET next_seq = COALESCE((SELECT max(seq) + 1 FROM transcript_lines WHERE session_id = s.id), 1);
  ALTER TABLE transcript_lines ADD COLUMN client_message_id TEXT;
  ALTER TABLE transcript_lines ADD COLUMN translations JSONB NOT NULL DEFAULT '{}'::jsonb;
  CREATE UNIQUE INDEX transcript_message_unique ON transcript_lines(session_id, client_message_id);
  CREATE UNIQUE INDEX transcript_seq_unique ON transcript_lines(session_id, seq);
  ALTER TABLE usage_ledger ADD COLUMN source_session_id UUID;
  UPDATE usage_ledger SET source_session_id = session_id;
  ALTER TABLE usage_ledger ALTER COLUMN source_session_id SET NOT NULL;
  ALTER TABLE usage_ledger ADD COLUMN debit_id TEXT UNIQUE;
  ALTER TABLE usage_ledger ALTER COLUMN session_id DROP NOT NULL;
  ALTER TABLE usage_ledger DROP CONSTRAINT usage_ledger_session_id_fkey;
  ALTER TABLE usage_ledger ADD CONSTRAINT usage_ledger_session_id_fkey FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE SET NULL;
  INSERT INTO app_migrations(name) VALUES ('mvp-reliability-v1');
END IF;
END $$;

CREATE TABLE IF NOT EXISTS audio_meters (
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  rate INTEGER NOT NULL CHECK (rate IN (2,3)),
  processed_ms DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (processed_ms >= 0),
  paid_minutes INTEGER NOT NULL DEFAULT 0 CHECK (paid_minutes >= 0),
  PRIMARY KEY(session_id, rate)
);
CREATE TABLE IF NOT EXISTS account_opening_balances (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  credits INTEGER NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO account_opening_balances(user_id, credits) SELECT id, credits FROM users ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS credit_ledger (
  entry_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('topup','adjustment')),
  credits_delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  order_id TEXT UNIQUE REFERENCES orders(id),
  transfer_reference TEXT UNIQUE,
  operator TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cleanup_jobs (
  session_id UUID PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  source_revision BIGINT,
  source_hash TEXT,
  job_token UUID,
  lease_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cleanup_chunks (
  session_id UUID NOT NULL REFERENCES cleanup_jobs(session_id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  start_seq BIGINT NOT NULL,
  end_seq BIGINT NOT NULL,
  input_text TEXT NOT NULL,
  output_text TEXT,
  PRIMARY KEY(session_id, source_hash, chunk_index)
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at) WHERE transcript_expired_at IS NULL;

-- A reusable public entrance for a multi-session tour.
CREATE TABLE IF NOT EXISTS tour_groups (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  active_session_id UUID REFERENCES sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tour_group_id UUID REFERENCES tour_groups(id);
CREATE INDEX IF NOT EXISTS sessions_tour_group_idx ON sessions(tour_group_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_open_per_tour ON sessions(tour_group_id)
  WHERE tour_group_id IS NOT NULL AND status IN ('created','live','paused');

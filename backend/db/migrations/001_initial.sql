-- 001: the original tables. Safe to run on a database that already has them.

CREATE TABLE IF NOT EXISTS tournaments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  rounds      jsonb,                         -- null = still in setup, otherwise [[{a, b, winner}], ...]
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  name          text NOT NULL,
  image         text NOT NULL DEFAULT '',    -- https URL or a small JPEG data URL
  link          text NOT NULL DEFAULT '',
  position      int  NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS participants_tournament_idx ON participants (tournament_id, position);

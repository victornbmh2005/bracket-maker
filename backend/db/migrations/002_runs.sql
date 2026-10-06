-- 002: a tournament can be played many times. Each bracket is now a "run".

CREATE TABLE runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  number        int  NOT NULL,                       -- 1, 2, 3… per tournament
  mode          text NOT NULL CHECK (mode IN ('all', 'cut')),
                                                     -- all = everyone plays (play-in round if needed)
                                                     -- cut = smaller bracket, some sit out
  rounds        jsonb NOT NULL,                      -- [[{a, b, winner}], ...], round 1 first
  sat_out       uuid[] NOT NULL DEFAULT '{}',        -- participants left out of this run
  champion_id   uuid REFERENCES participants(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,                         -- set when the final is decided
  UNIQUE (tournament_id, number)
);

-- Participants who played in a run are archived instead of deleted, so history and stats survive.
ALTER TABLE participants ADD COLUMN archived boolean NOT NULL DEFAULT false;

-- Existing brackets become run #1 of their tournament.
INSERT INTO runs (tournament_id, number, mode, rounds, champion_id, created_at, finished_at)
SELECT id, 1, 'all', rounds,
       (rounds -> -1 -> 0 ->> 'winner')::uuid,
       updated_at,
       CASE WHEN rounds -> -1 -> 0 ->> 'winner' IS NOT NULL THEN updated_at END
  FROM tournaments
 WHERE rounds IS NOT NULL;

ALTER TABLE tournaments DROP COLUMN rounds;

-- 003: ratings mode. A rating list (e.g. a playlist) has criteria (Vocals,
-- Lyrics…) and items (songs); each item gets a 1–10 score per criterion.

CREATE TABLE rating_lists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rating_criteria (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id     uuid NOT NULL REFERENCES rating_lists(id) ON DELETE CASCADE,
  name        text NOT NULL,
  position    int  NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rating_criteria_list_idx ON rating_criteria (list_id, position);

CREATE TABLE rating_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id     uuid NOT NULL REFERENCES rating_lists(id) ON DELETE CASCADE,
  name        text NOT NULL,
  image       text NOT NULL DEFAULT '',
  link        text NOT NULL DEFAULT '',
  position    int  NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rating_items_list_idx ON rating_items (list_id, position);

-- One score per item per criterion. Deleting an item or a criterion deletes its scores.
CREATE TABLE ratings (
  item_id      uuid NOT NULL REFERENCES rating_items(id) ON DELETE CASCADE,
  criterion_id uuid NOT NULL REFERENCES rating_criteria(id) ON DELETE CASCADE,
  score        smallint NOT NULL CHECK (score BETWEEN 1 AND 10),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, criterion_id)
);
CREATE INDEX ratings_criterion_idx ON ratings (criterion_id);

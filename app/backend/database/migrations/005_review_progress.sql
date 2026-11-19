-- Immutable review events; derived states are rebuilt for late offline events.
CREATE TABLE app.review_events (
  user_id uuid NOT NULL REFERENCES app.profiles(user_id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  card_id uuid NOT NULL,
  quality smallint NOT NULL CHECK (quality BETWEEN 0 AND 5),
  score smallint CHECK (score BETWEEN 0 AND 100),
  reviewed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  timezone_at_review text NOT NULL CHECK (length(timezone_at_review) BETWEEN 1 AND 100),
  algorithm_version text NOT NULL CHECK (algorithm_version='sm2-v1'),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (user_id,id),
  FOREIGN KEY (user_id,card_id) REFERENCES app.cards(user_id,id) ON DELETE RESTRICT
);
CREATE INDEX review_events_card_order ON app.review_events(user_id,card_id,reviewed_at,id);
CREATE INDEX review_events_history ON app.review_events(user_id,reviewed_at DESC,id);
CREATE TABLE app.review_states (
  user_id uuid NOT NULL,
  card_id uuid NOT NULL,
  algorithm_version text NOT NULL CHECK (algorithm_version='sm2-v1'),
  repetitions integer NOT NULL CHECK (repetitions>=0),
  interval_days integer NOT NULL CHECK (interval_days BETWEEN 1 AND 36500),
  ease_factor numeric(12,3) NOT NULL CHECK (ease_factor>=1.3),
  total_reviews integer NOT NULL CHECK (total_reviews>0),
  last_reviewed_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  PRIMARY KEY (user_id,card_id),
  FOREIGN KEY (user_id,card_id) REFERENCES app.cards(user_id,id) ON DELETE RESTRICT
);
CREATE INDEX review_states_due ON app.review_states(user_id,due_at);
ALTER TABLE app.review_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.review_events FORCE ROW LEVEL SECURITY;
ALTER TABLE app.review_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.review_states FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON app.review_events TO vocabulary_api;
GRANT SELECT,INSERT,UPDATE ON app.review_states TO vocabulary_api;
CREATE POLICY review_events_read ON app.review_events FOR SELECT TO vocabulary_api USING (user_id=(SELECT app.current_user_id()));
CREATE POLICY review_events_insert ON app.review_events FOR INSERT TO vocabulary_api WITH CHECK (user_id=(SELECT app.current_user_id()));
CREATE POLICY review_states_read ON app.review_states FOR SELECT TO vocabulary_api USING (user_id=(SELECT app.current_user_id()));
CREATE POLICY review_states_insert ON app.review_states FOR INSERT TO vocabulary_api WITH CHECK (user_id=(SELECT app.current_user_id()));
CREATE POLICY review_states_update ON app.review_states FOR UPDATE TO vocabulary_api USING (user_id=(SELECT app.current_user_id())) WITH CHECK (user_id=(SELECT app.current_user_id()));
-- Runtime cannot UPDATE/DELETE events or physically delete derived states.

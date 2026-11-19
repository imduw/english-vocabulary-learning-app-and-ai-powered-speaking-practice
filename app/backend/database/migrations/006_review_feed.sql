-- Commit-ordered, owner-scoped feed for immutable review events.
CREATE TABLE app.review_heads (
  user_id uuid PRIMARY KEY REFERENCES app.profiles(user_id) ON DELETE RESTRICT,
  last_sequence bigint NOT NULL CHECK(last_sequence>=0)
);
ALTER TABLE app.review_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.review_heads FORCE ROW LEVEL SECURITY;
GRANT SELECT ON app.review_heads TO vocabulary_api;
CREATE POLICY review_heads_read ON app.review_heads FOR SELECT TO vocabulary_api USING(user_id=(SELECT app.current_user_id()));
ALTER TABLE app.review_events ADD COLUMN sequence bigint;
WITH ordered AS (
  SELECT user_id,id,row_number() OVER(PARTITION BY user_id ORDER BY received_at,id) AS seq FROM app.review_events
)
UPDATE app.review_events e SET sequence=o.seq FROM ordered o WHERE o.user_id=e.user_id AND o.id=e.id;
INSERT INTO app.review_heads SELECT user_id,max(sequence) FROM app.review_events GROUP BY user_id;
ALTER TABLE app.review_events ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE app.review_events ADD CONSTRAINT review_sequence_positive CHECK(sequence>0);
CREATE UNIQUE INDEX review_feed_order ON app.review_events(user_id,sequence);
CREATE FUNCTION app.assign_review_sequence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text,0));
  INSERT INTO app.review_heads(user_id,last_sequence) VALUES(NEW.user_id,1)
  ON CONFLICT(user_id) DO UPDATE SET last_sequence=app.review_heads.last_sequence+1
  RETURNING last_sequence INTO NEW.sequence;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.assign_review_sequence() FROM PUBLIC;
CREATE TRIGGER assign_review_sequence BEFORE INSERT ON app.review_events FOR EACH ROW EXECUTE FUNCTION app.assign_review_sequence();

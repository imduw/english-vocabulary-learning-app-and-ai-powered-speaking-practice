-- Immutable owner-scoped label registry. Membership is part of a card version,
-- not a separate sync entity. cards.tags is its canonical snapshot/cache.
CREATE TABLE app.tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app.profiles(user_id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (name=normalize(btrim(name),NFC) AND length(name) BETWEEN 1 AND 50),
  normalized_name text GENERATED ALWAYS AS (lower(name)) STORED,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,id),
  UNIQUE(user_id,normalized_name)
);
CREATE TABLE app.card_tags (
  user_id uuid NOT NULL,
  card_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(user_id,card_id,tag_id),
  FOREIGN KEY(user_id,card_id) REFERENCES app.cards(user_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(user_id,tag_id) REFERENCES app.tags(user_id,id) ON DELETE RESTRICT
);
CREATE INDEX card_tags_by_label ON app.card_tags(user_id,tag_id,card_id);
CREATE INDEX cards_created_list ON app.cards(user_id,created_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX cards_word_order ON app.cards(user_id,lower(word),id) WHERE deleted_at IS NULL;
ALTER TABLE app.cards ADD COLUMN tags text[] NOT NULL DEFAULT '{}';

ALTER TABLE app.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.tags FORCE ROW LEVEL SECURITY;
ALTER TABLE app.card_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.card_tags FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app.tags,app.card_tags FROM PUBLIC;
GRANT SELECT ON app.tags,app.card_tags TO vocabulary_api;
GRANT INSERT(tags),UPDATE(tags) ON app.cards TO vocabulary_api;
CREATE POLICY tags_read_owner ON app.tags FOR SELECT TO vocabulary_api
  USING(user_id=(SELECT app.current_user_id()));
CREATE POLICY card_tags_read_owner ON app.card_tags FOR SELECT TO vocabulary_api
  USING(user_id=(SELECT app.current_user_id()));

CREATE FUNCTION app.normalize_card_tags() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE label text; label_key text; canonical_label text;
  canonical text[] := '{}'; seen text[] := '{}';
BEGIN
  IF NEW.tags IS NULL OR cardinality(NEW.tags)>20 OR coalesce(array_ndims(NEW.tags),1)<>1 THEN
    RAISE EXCEPTION 'Expected at most 20 tag names' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id::text,0));
  FOREACH label IN ARRAY NEW.tags LOOP
    label := normalize(btrim(label),NFC);
    IF label IS NULL OR length(label) NOT BETWEEN 1 AND 50 THEN
      RAISE EXCEPTION 'Invalid tag name' USING ERRCODE='23514';
    END IF;
    label_key := lower(label);
    IF label_key=ANY(seen) THEN
      RAISE EXCEPTION 'Duplicate tag name' USING ERRCODE='23514';
    END IF;
    seen := array_append(seen,label_key);
    INSERT INTO app.tags(user_id,name) VALUES(NEW.user_id,label)
      ON CONFLICT(user_id,normalized_name) DO NOTHING;
    SELECT t.name INTO STRICT canonical_label FROM app.tags t
      WHERE t.user_id=NEW.user_id AND t.normalized_name=label_key;
    canonical := array_append(canonical,canonical_label);
  END LOOP;
  SELECT coalesce(array_agg(value ORDER BY lower(value),value),'{}'::text[])
    INTO NEW.tags FROM unnest(canonical) AS value;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.normalize_card_tags() FROM PUBLIC;

CREATE FUNCTION app.attach_card_tags() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  DELETE FROM app.card_tags WHERE user_id=NEW.user_id AND card_id=NEW.id;
  INSERT INTO app.card_tags(user_id,card_id,tag_id)
    SELECT NEW.user_id,NEW.id,t.id FROM app.tags t
    WHERE t.user_id=NEW.user_id AND t.name=ANY(NEW.tags);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.attach_card_tags() FROM PUBLIC;
CREATE TRIGGER normalize_card_tags BEFORE INSERT OR UPDATE OF tags ON app.cards
  FOR EACH ROW EXECUTE FUNCTION app.normalize_card_tags();
CREATE TRIGGER attach_card_tags AFTER INSERT OR UPDATE OF tags ON app.cards
  FOR EACH ROW EXECUTE FUNCTION app.attach_card_tags();

-- Old card records predate tags. Preserve versions, sequence positions and
-- request hashes while making historical responses match the additive contract.
UPDATE app.sync_changes SET snapshot=snapshot||'{"tags":[]}'::jsonb
  WHERE entity_type='card' AND NOT(snapshot ? 'tags');
UPDATE app.sync_receipts SET result=jsonb_set(result,'{record,tags}','[]'::jsonb)
  WHERE result->>'entity_type'='card' AND jsonb_typeof(result->'record')='object'
    AND NOT((result->'record') ? 'tags');

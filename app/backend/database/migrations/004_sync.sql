CREATE TABLE app.sync_heads (
 user_id uuid PRIMARY KEY REFERENCES app.profiles(user_id) ON DELETE RESTRICT,
 last_sequence bigint NOT NULL DEFAULT 0 CHECK(last_sequence>=0)
);
CREATE TABLE app.sync_changes (
 user_id uuid NOT NULL REFERENCES app.profiles(user_id) ON DELETE RESTRICT,
 sequence bigint NOT NULL CHECK(sequence>0),
 entity_type text NOT NULL CHECK(entity_type IN ('deck','card')),
 entity_id uuid NOT NULL, entity_version bigint NOT NULL,
 snapshot jsonb NOT NULL, changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,sequence)
);
CREATE TABLE app.sync_receipts (
 user_id uuid NOT NULL REFERENCES app.profiles(user_id) ON DELETE RESTRICT,
 operation_id uuid NOT NULL, request_hash text NOT NULL,
 result jsonb NOT NULL, processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,operation_id)
);

DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['sync_heads','sync_changes','sync_receipts'] LOOP
  EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC',t);
  EXECUTE format('CREATE POLICY read_self ON app.%I FOR SELECT TO vocabulary_api USING(user_id=(SELECT app.current_user_id()))',t);
 END LOOP;
END $$;
GRANT SELECT ON app.sync_heads,app.sync_changes,app.sync_receipts TO vocabulary_api;
GRANT INSERT(user_id,operation_id,request_hash,result) ON app.sync_receipts TO vocabulary_api;
CREATE POLICY insert_receipt_self ON app.sync_receipts FOR INSERT TO vocabulary_api
 WITH CHECK(user_id=(SELECT app.current_user_id()));

-- No sequence is exposed before its business transaction commits. All learning
-- writers use the same per-owner transaction lock, including raw migration writes.
CREATE FUNCTION app.append_sync_change(owner_id uuid, kind text, record_id uuid, body jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE seq bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id::text,0));
 INSERT INTO app.sync_heads(user_id,last_sequence) VALUES(owner_id,1)
 ON CONFLICT(user_id) DO UPDATE SET last_sequence=app.sync_heads.last_sequence+1
 RETURNING last_sequence INTO seq;
 INSERT INTO app.sync_changes(user_id,sequence,entity_type,entity_id,entity_version,snapshot)
 VALUES(owner_id,seq,kind,record_id,(body->>'version')::bigint,body);
END $$;
REVOKE ALL ON FUNCTION app.append_sync_change(uuid,text,uuid,jsonb) FROM PUBLIC;

CREATE FUNCTION app.capture_learning_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 PERFORM app.append_sync_change(NEW.user_id,CASE TG_TABLE_NAME WHEN 'decks' THEN 'deck' ELSE 'card' END,
   NEW.id,to_jsonb(NEW)||jsonb_build_object('version',NEW.version::text));
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.capture_learning_change() FROM PUBLIC;
CREATE TRIGGER capture_sync AFTER INSERT OR UPDATE ON app.decks FOR EACH ROW EXECUTE FUNCTION app.capture_learning_change();
CREATE TRIGGER capture_sync AFTER INSERT OR UPDATE ON app.cards FOR EACH ROW EXECUTE FUNCTION app.capture_learning_change();

-- Existing state is seeded once, parents before children, including tombstones.
DO $$ DECLARE r record; BEGIN
 FOR r IN
  SELECT user_id,id,'deck' AS kind,to_jsonb(d)||jsonb_build_object('version',d.version::text) AS body,0 AS priority FROM app.decks d
  UNION ALL
  SELECT user_id,id,'card',to_jsonb(c)||jsonb_build_object('version',c.version::text),1 FROM app.cards c
  ORDER BY user_id,priority,id
 LOOP
  PERFORM app.append_sync_change(r.user_id,r.kind,r.id,r.body);
 END LOOP;
END $$;

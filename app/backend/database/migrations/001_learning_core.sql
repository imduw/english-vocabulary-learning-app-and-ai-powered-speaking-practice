-- Requires Supabase auth.users (or the explicitly local-only fixture).
-- Private application schema: no direct client writes before CAM-07/CAM-09.
CREATE SCHEMA app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

CREATE TABLE app.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  display_name text CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 120),
  timezone text NOT NULL DEFAULT 'UTC',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz
);

CREATE TABLE app.decks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.profiles(user_id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  description text CHECK (length(description) <= 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id, id)
);

CREATE TABLE app.media_assets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.profiles(user_id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('image', 'audio')),
  object_path text UNIQUE CHECK (object_path IS NULL OR length(btrim(object_path)) BETWEEN 1 AND 1024),
  mime_type text NOT NULL CHECK (length(btrim(mime_type)) BETWEEN 1 AND 100),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  width integer CHECK (width > 0),
  height integer CHECK (height > 0),
  checksum text CHECK (length(checksum) <= 128),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  CHECK (status <> 'ready' OR object_path IS NOT NULL),
  CHECK (kind <> 'image' OR (width IS NOT NULL AND height IS NOT NULL)),
  UNIQUE (user_id, id),
  UNIQUE (user_id, id, kind)
);

CREATE TABLE app.source_documents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.profiles(user_id) ON DELETE RESTRICT,
  media_id uuid NOT NULL,
  media_kind text NOT NULL DEFAULT 'image' CHECK (media_kind = 'image'),
  ocr_original_text text NOT NULL,
  corrected_text text,
  tokens jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tokens) = 'array'),
  language text CHECK (length(language) <= 35),
  ocr_engine text NOT NULL CHECK (length(btrim(ocr_engine)) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id, id),
  UNIQUE (user_id, media_id),
  FOREIGN KEY (user_id, media_id, media_kind)
    REFERENCES app.media_assets(user_id, id, kind) ON DELETE RESTRICT
);

CREATE TABLE app.cards (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.profiles(user_id) ON DELETE RESTRICT,
  deck_id uuid NOT NULL,
  source_document_id uuid,
  word text NOT NULL CHECK (length(btrim(word)) BETWEEN 1 AND 300),
  meaning text NOT NULL CHECK (length(btrim(meaning)) BETWEEN 1 AND 4000),
  phonetic text CHECK (length(phonetic) <= 300),
  source_sentence text CHECK (length(source_sentence) <= 10000),
  ai_example text CHECK (length(ai_example) <= 10000),
  is_favorite boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  UNIQUE (user_id, id),
  FOREIGN KEY (user_id, deck_id) REFERENCES app.decks(user_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, source_document_id) REFERENCES app.source_documents(user_id, id) ON DELETE RESTRICT
);

-- IDs and owners cannot be reassigned; timestamps/version belong to the server.
CREATE FUNCTION app.stamp_record() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := 1;
    NEW.created_at := clock_timestamp();
  ELSE
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
      OR (to_jsonb(NEW)->>'id') IS DISTINCT FROM (to_jsonb(OLD)->>'id') THEN
      RAISE EXCEPTION 'Record identity is immutable' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := OLD.created_at;
    NEW.version := OLD.version + 1;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION app.validate_timezone() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Invalid timezone' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER profiles_timezone BEFORE INSERT OR UPDATE ON app.profiles
FOR EACH ROW EXECUTE FUNCTION app.validate_timezone();

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['profiles', 'decks', 'media_assets', 'source_documents', 'cards'] LOOP
    EXECUTE format('CREATE TRIGGER stamp_record BEFORE INSERT OR UPDATE ON app.%I FOR EACH ROW EXECUTE FUNCTION app.stamp_record()', table_name);
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', table_name);
  END LOOP;
END;
$$;
-- Deliberately no allow policies yet: ordinary roles have no row access.
-- CAM-07 must add verified-user access, owner checks and policy tests together.
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;

CREATE INDEX decks_active_list ON app.decks(user_id, updated_at, id) WHERE deleted_at IS NULL;
CREATE INDEX cards_active_list ON app.cards(user_id, updated_at, id) WHERE deleted_at IS NULL;
CREATE INDEX cards_deck_list ON app.cards(user_id, deck_id, updated_at, id) WHERE deleted_at IS NULL;
CREATE INDEX cards_deck_fk ON app.cards(user_id, deck_id);
CREATE INDEX cards_source_fk ON app.cards(user_id, source_document_id);
CREATE INDEX cards_word_prefix ON app.cards(user_id, lower(word) text_pattern_ops) WHERE deleted_at IS NULL;

COMMENT ON SCHEMA app IS 'Private NestJS-owned learning data; direct Data API access is not enabled';
COMMENT ON TABLE app.cards IS 'One card per context; repeated word values are intentional';
COMMENT ON COLUMN app.cards.source_sentence IS 'Source snapshot retained independently of OCR edits';
COMMENT ON COLUMN app.source_documents.tokens IS 'Array of OCR tokens; detailed token/polygon schema deferred to CAM-04';

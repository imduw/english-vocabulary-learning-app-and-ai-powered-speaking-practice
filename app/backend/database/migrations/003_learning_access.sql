-- API-only access; owner comes from the verified transaction context.
GRANT SELECT ON app.decks, app.cards, app.source_documents TO vocabulary_api;
GRANT INSERT (id,user_id,name,description) ON app.decks TO vocabulary_api;
GRANT UPDATE (name,description,deleted_at) ON app.decks TO vocabulary_api;
GRANT INSERT (id,user_id,deck_id,source_document_id,word,meaning,phonetic,source_sentence,ai_example,is_favorite) ON app.cards TO vocabulary_api;
GRANT UPDATE (deck_id,source_document_id,word,meaning,phonetic,source_sentence,ai_example,is_favorite,deleted_at) ON app.cards TO vocabulary_api;

CREATE POLICY decks_read_owner ON app.decks FOR SELECT TO vocabulary_api USING (user_id=(SELECT app.current_user_id()));
CREATE POLICY decks_insert_owner ON app.decks FOR INSERT TO vocabulary_api WITH CHECK (user_id=(SELECT app.current_user_id()) AND deleted_at IS NULL);
CREATE POLICY decks_update_owner ON app.decks FOR UPDATE TO vocabulary_api USING (user_id=(SELECT app.current_user_id())) WITH CHECK (user_id=(SELECT app.current_user_id()));
CREATE POLICY cards_read_owner ON app.cards FOR SELECT TO vocabulary_api USING (user_id=(SELECT app.current_user_id()));
CREATE POLICY cards_insert_owner ON app.cards FOR INSERT TO vocabulary_api WITH CHECK (user_id=(SELECT app.current_user_id()) AND deleted_at IS NULL);
CREATE POLICY cards_update_owner ON app.cards FOR UPDATE TO vocabulary_api USING (user_id=(SELECT app.current_user_id())) WITH CHECK (user_id=(SELECT app.current_user_id()));
CREATE POLICY sources_read_owner ON app.source_documents FOR SELECT TO vocabulary_api USING (user_id=(SELECT app.current_user_id()));
-- No physical DELETE grants. API deletion is versioned soft-delete.

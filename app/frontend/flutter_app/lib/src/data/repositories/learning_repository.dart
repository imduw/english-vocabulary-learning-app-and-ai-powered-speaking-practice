import 'dart:convert';

import 'package:sqflite_common/sqlite_api.dart';
import 'package:unorm_dart/unorm_dart.dart' as unorm;

import '../local/app_database.dart';

class LearningRepository {
  LearningRepository(this.store);
  final AppDatabase store;
  static const _deck = {'name', 'description'};
  static const _card = {
    'deck_id',
    'word',
    'meaning',
    'phonetic',
    'source_document_id',
    'source_sentence',
    'ai_example',
    'is_favorite',
    'tags',
  };

  Json _fields(String kind, Json fields, bool create) {
    if (!['deck', 'card'].contains(kind) ||
        fields.isEmpty ||
        fields.keys.any((k) => !(kind == 'deck' ? _deck : _card).contains(k))) {
      throw ArgumentError('Unknown or empty learning fields');
    }
    final result = Map<String, dynamic>.from(fields);
    for (final key in ['name', 'word', 'meaning']) {
      if (result.containsKey(key)) {
        final value = result[key];
        final max = key == 'name'
            ? 200
            : key == 'word'
            ? 300
            : 4000;
        if (value is! String ||
            value.trim().isEmpty ||
            value.runes.length > max) {
          throw ArgumentError('Invalid text');
        }
        result[key] = value.trim();
      }
    }
    if (create) {
      for (final key
          in kind == 'deck' ? ['name'] : ['deck_id', 'word', 'meaning']) {
        if (!result.containsKey(key)) {
          throw ArgumentError('Missing required learning field');
        }
      }
    }
    for (final key in ['deck_id', 'source_document_id']) {
      if (key == 'deck_id' && result.containsKey(key) && result[key] == null) {
        throw ArgumentError('Parent cannot be null');
      }
      if (result[key] != null) result[key] = checkedId(result[key] as String);
    }
    for (final entry in {
      'description': 4000,
      'phonetic': 300,
      'source_sentence': 10000,
      'ai_example': 10000,
    }.entries) {
      final value = result[entry.key];
      if (value != null &&
          (value is! String || value.runes.length > entry.value)) {
        throw ArgumentError('Invalid nullable text');
      }
    }
    if (result.containsKey('is_favorite') && result['is_favorite'] is! bool) {
      throw ArgumentError('Invalid favorite');
    }
    if (result.containsKey('tags')) {
      final tags = result['tags'];
      if (tags is! List ||
          tags.length > 20 ||
          tags.any(
            (t) => t is! String || t.trim().isEmpty || t.runes.length > 50,
          )) {
        throw ArgumentError('Invalid tags');
      }
      final normalized = tags
          .map((t) => unorm.nfc((t as String).trim()))
          .toList();
      if (normalized.map((t) => t.toLowerCase()).toSet().length !=
          normalized.length) {
        throw ArgumentError('Duplicate tags');
      }
      result['tags'] = normalized;
    }
    return result;
  }

  Future<LocalRecord?> get(
    String kind,
    String id, {
    bool includeDeleted = false,
  }) async {
    final row = await store.row(store.sql, kind, checkedId(id));
    if (row == null || (!includeDeleted && row['deleted_at'] != null)) {
      return null;
    }
    if (!includeDeleted &&
        kind == 'card' &&
        !(await _parentActive(store.sql, row['parent_id'] as String))) {
      return null;
    }
    return LocalRecord(row);
  }

  Future<List<LocalRecord>> list(
    String kind, {
    String? deckId,
    String query = '',
    int limit = 100,
    int offset = 0,
  }) async {
    if (!['deck', 'card'].contains(kind) ||
        limit < 1 ||
        limit > 1000 ||
        offset < 0) {
      throw ArgumentError('Invalid list query');
    }
    final rows = await store.sql.rawQuery(
      '''SELECT r.* FROM records r
      WHERE r.owner=? AND r.kind=? AND r.deleted_at IS NULL
      AND (? IS NULL OR r.parent_id=?) AND instr(r.search_text,?)>0
      AND (r.kind='deck' OR EXISTS(SELECT 1 FROM records d WHERE d.owner=r.owner AND d.kind='deck' AND d.id=r.parent_id AND d.deleted_at IS NULL))
      ORDER BY r.local_revision DESC,r.id LIMIT ? OFFSET ?''',
      [store.owner, kind, deckId, deckId, query.toLowerCase(), limit, offset],
    );
    return rows.map(LocalRecord.new).toList();
  }

  Future<String> create(String kind, Json fields, {String? id}) async {
    final key = checkedId(id ?? newId()), values = _fields(kind, fields, true);
    await store.sql.transaction((tx) async {
      if (await store.row(tx, kind, key) != null) {
        throw StateError('ID already exists');
      }
      if (kind == 'card' &&
          !(await _parentActive(tx, values['deck_id'] as String))) {
        throw StateError('Active parent required');
      }
      final data = <String, dynamic>{
        'id': key,
        'user_id': store.owner,
        'created_at': store.now,
        'updated_at': store.now,
        'version': '0',
        'deleted_at': null,
        if (kind == 'deck') 'description': null,
        if (kind == 'card') ...{
          'phonetic': null,
          'source_document_id': null,
          'source_sentence': null,
          'ai_example': null,
          'is_favorite': false,
          'tags': <String>[],
        },
        ...values,
      };
      await store.put(
        tx,
        kind,
        data,
        revision: 1,
        dirty: true,
        syncVersion: '0',
      );
      await _enqueue(tx, kind, key, 'create', values, null, 1, null);
    });
    return key;
  }

  Future<void> update(String kind, String id, Json fields) =>
      _write(kind, checkedId(id), _fields(kind, fields, false), false);
  Future<void> remove(String kind, String id) =>
      _write(kind, checkedId(id), {}, true);
  Future<void> _write(
    String kind,
    String id,
    Json fields,
    bool deleting,
  ) => store.sql.transaction((tx) async {
    final row = await store.row(tx, kind, id);
    if (row == null || row['deleted_at'] != null) {
      throw StateError('Active record required');
    }
    final old = decodeRecord(row['data'] as String);
    if (kind == 'card' &&
        !(await _parentActive(
          tx,
          (fields['deck_id'] ?? old['deck_id']) as String,
        ))) {
      throw StateError('Active parent required');
    }
    final pending = await tx.query(
      'outbox',
      where: 'owner=? AND kind=? AND entity_id=?',
      whereArgs: [store.owner, kind, id],
      orderBy: 'seq DESC',
      limit: 1,
    );
    var base = row['sync_version'] as String;
    if (pending.isNotEmpty) {
      final last = pending.single;
      base = last['action'] == 'create'
          ? '1'
          : (version(last['base_version'] as String) + BigInt.one).toString();
    }
    if (version(base) == BigInt.zero) {
      throw StateError('Missing create mutation');
    }
    final revision = (row['local_revision'] as int) + 1;
    final data = <String, dynamic>{
      ...old,
      ...fields,
      'updated_at': store.now,
      if (deleting) 'deleted_at': store.now,
    };
    await store.put(
      tx,
      kind,
      data,
      revision: revision,
      dirty: true,
      syncVersion: row['sync_version'] as String,
      syncedAt: row['synced_at'] as String?,
    );
    await _enqueue(
      tx,
      kind,
      id,
      deleting ? 'delete' : 'update',
      fields,
      base,
      revision,
      old,
    );
    if (deleting && kind == 'deck') {
      final cards = await tx.query(
        'records',
        where: "owner=? AND kind='card' AND parent_id=? AND deleted_at IS NULL",
        whereArgs: [store.owner, id],
      );
      for (final card in cards) {
        final data = decodeRecord(card['data'] as String)
          ..['deleted_at'] = store.now;
        await store.put(
          tx,
          'card',
          data,
          revision: (card['local_revision'] as int) + 1,
          dirty: true,
          syncVersion: card['sync_version'] as String,
          syncedAt: card['synced_at'] as String?,
        );
      }
    }
  });

  Future<bool> _parentActive(DatabaseExecutor tx, String id) async {
    final row = await store.row(tx, 'deck', id);
    return row != null && row['deleted_at'] == null;
  }

  Future<void> _enqueue(
    DatabaseExecutor tx,
    String kind,
    String id,
    String action,
    Json payload,
    String? base,
    int revision,
    Json? snapshot,
  ) => tx
      .insert('outbox', {
        'owner': store.owner,
        'operation_id': newId(),
        'kind': kind,
        'entity_id': id,
        'action': action,
        'base_version': base,
        'payload': jsonEncode(payload),
        'base_snapshot': snapshot == null ? null : jsonEncode(snapshot),
        'local_revision': revision,
        'created_at': store.now,
      })
      .then((_) {});

  /// Recovers a conflict as a NEW identity, never resurrecting a server tombstone.
  Future<String> recoverAsCopy(
    String conflictId, {
    String? activeDeckId,
  }) async {
    final rows = await store.sql.query(
      'conflicts',
      where: 'owner=? AND id=?',
      whereArgs: [store.owner, conflictId],
    );
    if (rows.isEmpty) throw StateError('Conflict not found');
    final row = rows.single,
        snapshot = decodeRecord(row['local_snapshot'] as String),
        kind = row['kind'] as String;
    final values = <String, dynamic>{
      for (final entry in snapshot.entries)
        if ((kind == 'deck' ? _deck : _card).contains(entry.key))
          entry.key: entry.value,
    };
    if (kind == 'card' && activeDeckId != null) {
      values['deck_id'] = activeDeckId;
    }
    return create(kind, values);
  }
}

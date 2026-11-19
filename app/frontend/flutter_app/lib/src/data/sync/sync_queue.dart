import 'dart:convert';

import 'package:sqflite_common/sqlite_api.dart';

import '../local/app_database.dart';
import 'conflict_resolver.dart';

class PreparedBatch {
  PreparedBatch(this.id, this.items);
  final String id;
  final List<Json> items;
  Json get body => {'items': items};
}

/// All ACKs, page/cursor changes, lease fencing and conflict decisions commit
/// together in SQLite; no network request runs inside a SQLite transaction.
class SyncQueue {
  SyncQueue(this.store);
  final AppDatabase store;
  int get _now => store.clock().toUtc().millisecondsSinceEpoch;

  Future<int> get length async =>
      (await store.sql.rawQuery(
            'SELECT count(*) AS n FROM outbox WHERE owner=?',
            [store.owner],
          )).single['n']
          as int;
  Future<List<Json>> pending() => store.sql.query(
    'outbox',
    where: 'owner=?',
    whereArgs: [store.owner],
    orderBy: 'seq',
  );
  Future<bool> hasPreparedBatch() async => (await store.sql.query(
    'prepared_batches',
    where: 'owner=?',
    whereArgs: [store.owner],
  )).isNotEmpty;
  Future<List<Json>> conflicts() => store.sql.query(
    'conflicts',
    where: 'owner=?',
    whereArgs: [store.owner],
    orderBy: 'created_at,id',
  );
  Future<String?> acquireLease() => store.sql.transaction((tx) async {
    final rows = await tx.query(
      'sync_leases',
      where: 'owner=?',
      whereArgs: [store.owner],
    );
    if (rows.isNotEmpty && (rows.single['expires_ms'] as int) > _now) {
      return null;
    }
    final token = newId();
    await tx.insert('sync_leases', {
      'owner': store.owner,
      'token': token,
      'expires_ms': _now + 30000,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
    return token;
  });
  Future<void> _fence(DatabaseExecutor tx, String token) async {
    final rows = await tx.query(
      'sync_leases',
      where: 'owner=? AND token=? AND expires_ms>?',
      whereArgs: [store.owner, token, _now],
    );
    if (rows.isEmpty) throw StateError('Sync lease expired or replaced');
    await tx.update(
      'sync_leases',
      {'expires_ms': _now + 30000},
      where: 'owner=? AND token=?',
      whereArgs: [store.owner, token],
    );
  }

  Future<void> releaseLease(String token) => store.sql
      .delete(
        'sync_leases',
        where: 'owner=? AND token=?',
        whereArgs: [store.owner, token],
      )
      .then((_) {});
  Future<void> heartbeat(String token) =>
      store.sql.transaction((tx) => _fence(tx, token));

  Json _wire(Json row) => {
    'operation_id': row['operation_id'],
    'entity_type': row['kind'],
    'entity_id': row['entity_id'],
    'action': row['action'],
    'base_version': row['base_version'],
    'payload': decodeRecord(row['payload'] as String),
  };
  Future<PreparedBatch?> prepare(
    String token, {
    int limit = 100,
  }) => store.sql.transaction((tx) async {
    if (limit < 1 || limit > 100) throw ArgumentError('Invalid batch limit');
    await _fence(tx, token);
    final rows = await tx.query(
      'outbox',
      where: 'owner=?',
      whereArgs: [store.owner],
      orderBy: 'seq',
      limit: limit,
    );
    if (rows.isEmpty ||
        rows.first['blocked_reason'] != null ||
        (rows.first['next_attempt_ms'] as int) > _now) {
      return null;
    }
    final frozen = await tx.query(
      'prepared_batches',
      where: 'owner=?',
      whereArgs: [store.owner],
    );
    if (frozen.isNotEmpty) {
      return PreparedBatch(
        frozen.single['batch_id'] as String,
        (jsonDecode(frozen.single['items'] as String) as List)
            .map((i) => Json.from(i as Map))
            .toList(),
      );
    }
    final items = <Json>[];
    var bytes = 12;
    for (final row in rows) {
      if (row['blocked_reason'] != null ||
          (row['next_attempt_ms'] as int) > _now) {
        break;
      }
      final wire = _wire(row), size = utf8.encode(jsonEncode(wire)).length + 1;
      if (bytes + size > 512 * 1024) {
        if (items.isEmpty) {
          throw const FormatException('Mutation exceeds sync request budget');
        }
        break;
      }
      bytes += size;
      items.add(wire);
    }
    final batch = PreparedBatch(newId(), items);
    await tx.insert('prepared_batches', {
      'owner': store.owner,
      'batch_id': batch.id,
      'items': jsonEncode(items),
    });
    return batch;
  });
  Future<void> _batch(DatabaseExecutor tx, PreparedBatch batch) async {
    final rows = await tx.query(
      'prepared_batches',
      where: 'owner=? AND batch_id=? AND items=?',
      whereArgs: [store.owner, batch.id, jsonEncode(batch.items)],
    );
    if (rows.isEmpty) throw StateError('Prepared batch no longer current');
  }

  void validateServer(String kind, Json record, {String? id}) {
    if (!['deck', 'card'].contains(kind) ||
        record['user_id'] != store.owner ||
        record['id'] is! String ||
        (id != null && record['id'] != id) ||
        record['version'] is! String ||
        version(record['version'] as String) <= BigInt.zero ||
        record['updated_at'] is! String ||
        DateTime.tryParse(record['updated_at'] as String) == null) {
      throw const FormatException(
        'Invalid owner, identity or revision in sync response',
      );
    }
    checkedId(record['id'] as String);
    if (kind == 'deck' && record['name'] is! String) {
      throw const FormatException('Invalid deck record');
    }
    if (kind == 'card') {
      checkedId(record['deck_id'] as String);
      if (record['word'] is! String ||
          record['meaning'] is! String ||
          record['tags'] is! List ||
          (record['tags'] as List).any((t) => t is! String)) {
        throw const FormatException('Invalid card record');
      }
    }
    if (record['deleted_at'] != null &&
        DateTime.tryParse(record['deleted_at'] as String) == null) {
      throw const FormatException('Invalid tombstone');
    }
  }

  Future<void> _server(DatabaseExecutor tx, String kind, Json server) async {
    validateServer(kind, server);
    final current = await store.row(tx, kind, server['id'] as String);
    if (current != null &&
        version(current['sync_version'] as String) >
            version(server['version'] as String)) {
      if (current['server_data'] == null) {
        throw const FormatException('Missing newer server shadow');
      }
      server = decodeRecord(current['server_data'] as String);
    }
    final pending = await tx.query(
      'outbox',
      where: 'owner=? AND kind=? AND entity_id=?',
      whereArgs: [store.owner, kind, server['id']],
      orderBy: 'seq',
    );
    final data = pending.isEmpty
        ? Map<String, dynamic>.from(server)
        : decodeRecord(current!['data'] as String);
    await store.put(
      tx,
      kind,
      data,
      revision: current?['local_revision'] as int? ?? 0,
      dirty: pending.isNotEmpty,
      syncVersion: server['version'] as String,
      syncedAt: store.now,
      serverData: server,
    );
  }

  Future<void> acknowledge(
    String token,
    PreparedBatch batch,
    List<Json> results,
  ) => store.sql.transaction((tx) async {
    await _fence(tx, token);
    await _batch(tx, batch);
    if (results.length != batch.items.length) {
      throw const FormatException('Incomplete ACK');
    }
    for (var i = 0; i < results.length; i++) {
      final result = results[i], item = batch.items[i];
      if (result['operation_id'] != item['operation_id'] ||
          result['entity_type'] != item['entity_type'] ||
          result['entity_id'] != item['entity_id'] ||
          result['record'] is! Map) {
        throw const FormatException('ACK identity mismatch');
      }
      validateServer(
        item['entity_type'] as String,
        Json.from(result['record'] as Map),
        id: item['entity_id'] as String,
      );
    }
    for (var i = 0; i < results.length; i++) {
      final item = batch.items[i];
      final deleted = await tx.delete(
        'outbox',
        where: 'owner=? AND operation_id=?',
        whereArgs: [store.owner, item['operation_id']],
      );
      if (deleted != 1) throw StateError('ACK mutation missing');
      await _server(
        tx,
        item['entity_type'] as String,
        Json.from(results[i]['record'] as Map),
      );
    }
    await tx.delete(
      'prepared_batches',
      where: 'owner=? AND batch_id=?',
      whereArgs: [store.owner, batch.id],
    );
  });

  Future<void> fail(
    String token,
    PreparedBatch batch, {
    Duration? retryAfter,
    String? blockedReason,
  }) => store.sql.transaction((tx) async {
    await _fence(tx, token);
    await _batch(tx, batch);
    for (final item in batch.items) {
      await tx.rawUpdate(
        '''UPDATE outbox SET attempts=attempts+1,next_attempt_ms=?,blocked_reason=? WHERE owner=? AND operation_id=?''',
        [
          _now + (retryAfter?.inMilliseconds ?? 0),
          blockedReason,
          store.owner,
          item['operation_id'],
        ],
      );
    }
  });

  Future<void> retryNow() => store.sql.transaction((tx) async {
    await tx.update(
      'outbox',
      {'next_attempt_ms': 0},
      where: 'owner=? AND blocked_reason IS NULL',
      whereArgs: [store.owner],
    );
    await tx.update(
      'sync_state',
      {'pull_next_ms': 0},
      where: 'owner=? AND pull_blocked=0',
      whereArgs: [store.owner],
    );
  });
  Future<Json> pullState() async {
    final rows = await store.sql.query(
      'sync_state',
      where: 'owner=?',
      whereArgs: [store.owner],
    );
    return rows.isEmpty
        ? {'pull_next_ms': 0, 'pull_attempts': 0, 'pull_blocked': 0}
        : rows.single;
  }

  Future<void> deferPull(
    String token,
    Duration delay, {
    bool blocked = false,
  }) => store.sql.transaction((tx) async {
    await _fence(tx, token);
    await tx.rawInsert('INSERT OR IGNORE INTO sync_state(owner) VALUES(?)', [
      store.owner,
    ]);
    await tx.rawUpdate(
      'UPDATE sync_state SET pull_next_ms=?,pull_attempts=pull_attempts+1,pull_blocked=? WHERE owner=?',
      [_now + delay.inMilliseconds, blocked ? 1 : 0, store.owner],
    );
  });
  Future<String?> cursor() async {
    final rows = await store.sql.query(
      'sync_state',
      where: 'owner=?',
      whereArgs: [store.owner],
    );
    return rows.isEmpty ? null : rows.single['cursor'] as String?;
  }

  Future<void> applyPage(String token, List<Json> changes, String nextCursor) =>
      store.sql.transaction((tx) async {
        await _fence(tx, token);
        if ((await tx.query(
          'prepared_batches',
          where: 'owner=?',
          whereArgs: [store.owner],
        )).isNotEmpty) {
          throw StateError('ACK prepared batch before applying delta');
        }
        for (final change in changes) {
          if (change['record'] is! Map) {
            throw const FormatException('Invalid delta record');
          }
          final kind = change['entity_type'] as String,
              record = Json.from(change['record'] as Map);
          validateServer(kind, record, id: change['entity_id'] as String);
          final current = await store.row(tx, kind, record['id'] as String);
          if (current != null &&
              version(current['sync_version'] as String) >=
                  version(record['version'] as String)) {
            continue;
          }
          final pending = await tx.query(
            'outbox',
            where: 'owner=? AND kind=? AND entity_id=?',
            whereArgs: [store.owner, kind, record['id']],
            orderBy: 'seq',
          );
          if (record['deleted_at'] != null && pending.isNotEmpty) {
            await _resolve(
              tx,
              pending.first,
              record,
              'remote_tombstone',
              forceServer: true,
            );
          } else {
            await _server(tx, kind, record);
          }
        }
        await tx.insert('sync_state', {
          'owner': store.owner,
          'cursor': nextCursor,
        }, conflictAlgorithm: ConflictAlgorithm.replace);
      });

  Future<void> resolveConflict(
    String token,
    PreparedBatch batch,
    Json details,
  ) => store.sql.transaction((tx) async {
    await _fence(tx, token);
    await _batch(tx, batch);
    final found = batch.items.where(
      (i) =>
          i['operation_id'] == details['operation_id'] &&
          i['entity_id'] == details['entity_id'] &&
          i['entity_type'] == details['entity_type'],
    );
    if (found.length != 1) {
      throw const FormatException('Conflict identity mismatch');
    }
    final rows = await tx.query(
      'outbox',
      where: 'owner=? AND operation_id=?',
      whereArgs: [store.owner, details['operation_id']],
    );
    if (rows.length != 1) {
      throw const FormatException('Conflict mutation missing');
    }
    final server = details['server'] == null
        ? null
        : Json.from(details['server'] as Map);
    if (server != null) {
      validateServer(
        details['entity_type'] as String,
        server,
        id: details['entity_id'] as String,
      );
    }
    final reason = details['reason'] as String;
    if (['constraint', 'operation_reused'].contains(reason)) {
      final mutation = rows.single,
          current = (await store.row(
            tx,
            mutation['kind'] as String,
            mutation['entity_id'] as String,
          ))!;
      await tx.insert('conflicts', {
        'id': newId(),
        'owner': store.owner,
        'kind': mutation['kind'],
        'entity_id': mutation['entity_id'],
        'reason': reason,
        'resolution': 'blocked',
        'local_snapshot': current['data'],
        'server_snapshot': server == null ? null : jsonEncode(server),
        'mutations': jsonEncode(rows),
        'created_at': store.now,
      });
      await tx.update(
        'outbox',
        {'blocked_reason': reason},
        where: 'owner=? AND seq=?',
        whereArgs: [store.owner, mutation['seq']],
      );
    } else {
      await _resolve(
        tx,
        rows.single,
        server,
        reason,
        forceServer: reason == 'missing_parent',
      );
    }
    await tx.delete(
      'prepared_batches',
      where: 'owner=?',
      whereArgs: [store.owner],
    );
  });

  Future<void> _resolve(
    DatabaseExecutor tx,
    Json mutation,
    Json? server,
    String reason, {
    bool forceServer = false,
  }) async {
    final kind = mutation['kind'] as String,
        id = mutation['entity_id'] as String;
    final row = (await store.row(tx, kind, id))!;
    if (server != null &&
        version(server['version'] as String) <
            version(row['sync_version'] as String)) {
      throw const FormatException('Server revision regressed');
    }
    final pending = await tx.query(
      'outbox',
      where: 'owner=? AND kind=? AND entity_id=?',
      whereArgs: [store.owner, kind, id],
      orderBy: 'seq',
    );
    var resolution = forceServer
        ? ConflictResolution.serverWins
        : ConflictResolver.decide(mutation, server);
    if (resolution == ConflictResolution.mergeDisjoint) {
      var simulated = Map<String, dynamic>.from(server!);
      for (final op in pending) {
        if (ConflictResolver.decide(op, simulated) !=
            ConflictResolution.mergeDisjoint) {
          resolution = ConflictResolution.serverWins;
          break;
        }
        simulated = {...simulated, ...decodeRecord(op['payload'] as String)};
      }
    }
    await tx.insert('conflicts', {
      'id': newId(),
      'owner': store.owner,
      'kind': kind,
      'entity_id': id,
      'reason': reason,
      'resolution': resolution.name,
      'local_snapshot': row['data'],
      'server_snapshot': server == null ? null : jsonEncode(server),
      'mutations': jsonEncode(pending),
      'created_at': store.now,
    });
    if (resolution == ConflictResolution.mergeDisjoint) {
      var base = version(server!['version'] as String),
          data = Map<String, dynamic>.from(server);
      for (final op in pending) {
        final before = Map<String, dynamic>.from(data),
            payload = decodeRecord(op['payload'] as String);
        if (op['action'] == 'create') {
          throw const FormatException(
            'Unexpected create after update conflict',
          );
        }
        data = {
          ...data,
          ...payload,
          if (op['action'] == 'delete') 'deleted_at': store.now,
        };
        await tx.update(
          'outbox',
          {
            'operation_id': newId(),
            'base_version': base.toString(),
            'base_snapshot': jsonEncode(before),
            'attempts': 0,
            'next_attempt_ms': 0,
            'blocked_reason': null,
          },
          where: 'owner=? AND seq=?',
          whereArgs: [store.owner, op['seq']],
        );
        base += BigInt.one;
      }
      await store.put(
        tx,
        kind,
        data,
        revision: row['local_revision'] as int,
        dirty: true,
        syncVersion: server['version'] as String,
        serverData: server,
        syncedAt: store.now,
      );
    } else {
      await tx.delete(
        'outbox',
        where: 'owner=? AND kind=? AND entity_id=?',
        whereArgs: [store.owner, kind, id],
      );
      final data =
          server ??
          (decodeRecord(row['data'] as String)..['deleted_at'] = store.now);
      await store.put(
        tx,
        kind,
        data,
        revision: row['local_revision'] as int,
        dirty: false,
        syncVersion:
            server?['version'] as String? ?? row['sync_version'] as String,
        syncedAt: store.now,
        serverData: server,
      );
      if (kind == 'deck' && data['deleted_at'] != null) {
        final children = await tx.query(
          'records',
          where: "owner=? AND kind='card' AND parent_id=?",
          whereArgs: [store.owner, id],
        );
        for (final child in children) {
          final ops = await tx.query(
            'outbox',
            where: "owner=? AND kind='card' AND entity_id=?",
            whereArgs: [store.owner, child['id']],
            orderBy: 'seq',
          );
          if (ops.isNotEmpty) {
            await _resolve(
              tx,
              ops.first,
              null,
              'parent_deleted',
              forceServer: true,
            );
          } else {
            final data = decodeRecord(child['data'] as String)
              ..['deleted_at'] = store.now;
            await store.put(
              tx,
              'card',
              data,
              revision: child['local_revision'] as int,
              dirty: false,
              syncVersion: child['sync_version'] as String,
              syncedAt: store.now,
            );
          }
        }
      }
    }
  }

  /// Explicit recovery for permanent validation errors, retaining original data.
  /// Stop the worker first; valid sibling operations in the failed batch remain.
  Future<void> archiveBlocked() async {
    final token = await acquireLease();
    if (token == null) throw StateError('Worker is active');
    try {
      await store.sql.transaction((tx) async {
        await _fence(tx, token);
        final rows = await tx.query(
          'outbox',
          where: 'owner=?',
          whereArgs: [store.owner],
          orderBy: 'seq',
          limit: 1,
        );
        if (rows.isEmpty || rows.single['blocked_reason'] == null) {
          throw StateError('No blocked head');
        }
        final row = (await store.row(
          tx,
          rows.single['kind'] as String,
          rows.single['entity_id'] as String,
        ))!;
        await _resolve(
          tx,
          rows.single,
          row['server_data'] == null
              ? null
              : decodeRecord(row['server_data'] as String),
          'explicit_discard_blocked',
          forceServer: true,
        );
        await tx.delete(
          'prepared_batches',
          where: 'owner=?',
          whereArgs: [store.owner],
        );
      });
    } finally {
      await releaseLease(token);
    }
  }
}

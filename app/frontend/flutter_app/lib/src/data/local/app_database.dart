import 'dart:convert';
import 'dart:math';

import 'package:sqflite_common/sqlite_api.dart';

import 'migrations.dart';

typedef Json = Map<String, dynamic>;
typedef Clock = DateTime Function();
final _uuid = RegExp(
  r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
  caseSensitive: false,
);
String checkedId(String id) {
  if (!_uuid.hasMatch(id)) throw ArgumentError('A UUID is required');
  return id.toLowerCase();
}

String newId() {
  final random = Random.secure();
  final bytes = List.generate(16, (_) => random.nextInt(256));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  final s = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${s.substring(0, 8)}-${s.substring(8, 12)}-${s.substring(12, 16)}-${s.substring(16, 20)}-${s.substring(20)}';
}

Json decodeRecord(String text) =>
    Map<String, dynamic>.from(jsonDecode(text) as Map);
BigInt version(String value) {
  if (!RegExp(r'^\d{1,19}$').hasMatch(value)) {
    throw const FormatException('Invalid version');
  }
  final n = BigInt.parse(value);
  if (n > BigInt.parse('9223372036854775807')) {
    throw const FormatException('Version overflow');
  }
  return n;
}

class LocalRecord {
  LocalRecord(Json row)
    : data = decodeRecord(row['data'] as String),
      syncVersion = row['sync_version'] as String,
      syncedAt = row['synced_at'] as String?,
      isDirty = row['is_dirty'] == 1,
      localRevision = row['local_revision'] as int;
  final Json data;
  final String syncVersion;
  final String? syncedAt;
  final bool isDirty;
  final int localRevision;
}

/// Owner-bound SQL store. Tokens and passwords never enter this database.
class AppDatabase {
  AppDatabase._(this.sql, this.owner, this.clock, this.closeConnection);
  final Database sql;
  final String owner;
  final Clock clock;
  final bool closeConnection;
  String get now => clock().toUtc().toIso8601String();

  static Future<AppDatabase> open({
    required DatabaseFactory factory,
    required String path,
    required String owner,
    Clock? clock,
    int schemaVersion = 2,
    bool wal = false,
    bool singleInstance = false,
    bool closeConnection = true,
  }) async {
    final user = checkedId(owner);
    if (schemaVersion < 1 || schemaVersion > 2) {
      throw ArgumentError('Unsupported schema');
    }
    final db = await factory.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: schemaVersion,
        singleInstance: singleInstance,
        onConfigure: (db) async {
          await db.execute('PRAGMA foreign_keys=ON');
          await db.execute('PRAGMA busy_timeout=5000');
          if (wal) await db.rawQuery('PRAGMA journal_mode=WAL');
        },
        onCreate: (db, to) => migrateLocal(db, 0, to),
        onUpgrade: migrateLocal,
      ),
    );
    return AppDatabase._(db, user, clock ?? DateTime.now, closeConnection);
  }

  Future<Json?> row(DatabaseExecutor tx, String kind, String id) async {
    final rows = await tx.query(
      'records',
      where: 'owner=? AND kind=? AND id=?',
      whereArgs: [owner, kind, id],
    );
    return rows.isEmpty ? null : rows.single;
  }

  Future<void> put(
    DatabaseExecutor tx,
    String kind,
    Json data, {
    required int revision,
    required bool dirty,
    required String syncVersion,
    String? syncedAt,
    Json? serverData,
  }) async {
    if (data['user_id'] != owner) throw StateError('Owner mismatch');
    final id = checkedId(data['id'] as String);
    final parent = kind == 'card' ? checkedId(data['deck_id'] as String) : null;
    final values = <String, Object?>{
      'owner': owner,
      'kind': kind,
      'id': id,
      'parent_kind': parent == null ? null : 'deck',
      'parent_id': parent,
      'data': jsonEncode(data),
      if (serverData != null) 'server_data': jsonEncode(serverData),
      'search_text': [
        data['word'],
        data['meaning'],
        data['name'],
        ...(data['tags'] as List? ?? []),
      ].whereType<String>().join(' ').toLowerCase(),
      'deleted_at': data['deleted_at'],
      'sync_version': syncVersion,
      'synced_at': syncedAt,
      'is_dirty': dirty ? 1 : 0,
      'local_revision': revision,
    };
    // UPDATE/INSERT, never REPLACE: REPLACE would delete an FK parent first.
    final n = await tx.update(
      'records',
      values,
      where: 'owner=? AND kind=? AND id=?',
      whereArgs: [owner, kind, id],
    );
    if (n == 0) await tx.insert('records', values);
  }

  Future<void> close() async {
    // The Web SharedWorker owns its connection across tabs. Closing it from
    // one session would invalidate every other tab's connection.
    if (closeConnection) await sql.close();
  }
}

import 'dart:convert';
import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flutter_app/src/data/local/app_database.dart';
import 'package:flutter_app/src/data/repositories/learning_repository.dart';
import 'package:flutter_app/src/data/sync/sync_queue.dart';
import 'package:flutter_app/src/data/sync/retry_policy.dart';
import 'package:flutter_app/src/data/sync/sync_api_client.dart';
import 'package:flutter_app/src/data/sync/sync_worker.dart';

const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const deck = '20000000-0000-4000-8000-000000000001';
const card = '30000000-0000-4000-8000-000000000001';
Json server(
  String kind,
  String id, {
  String revision = '1',
  Json fields = const {},
}) => {
  'id': id,
  'user_id': a,
  'created_at': '2026-11-19T00:00:00.000Z',
  'updated_at': '2026-11-19T01:00:00.000Z',
  'version': revision,
  'deleted_at': null,
  if (kind == 'deck') ...{'name': 'Original', 'description': null},
  if (kind == 'card') ...{
    'deck_id': deck,
    'word': 'word',
    'meaning': 'meaning',
    'is_favorite': false,
    'tags': <String>[],
  },
  ...fields,
};
Json ack(Json item, Json data) => {
  'operation_id': item['operation_id'],
  'entity_type': item['entity_type'],
  'entity_id': item['entity_id'],
  'record': data,
};
Json change(String kind, Json data) => {
  'entity_type': kind,
  'entity_id': data['id'],
  'record': data,
};

class Fixture {
  Fixture(this.dir, this.db);
  final Directory dir;
  AppDatabase db;
  DateTime time = DateTime.utc(2026, 11, 19);
  LearningRepository get repo => LearningRepository(db);
  SyncQueue get queue => SyncQueue(db);
  static Future<Fixture> open({int schema = 2}) async {
    final dir = await Directory.systemTemp.createTemp('cam-offline-');
    final db = await AppDatabase.open(
      factory: databaseFactoryFfiNoIsolate,
      path: p.join(dir.path, 'test.db'),
      owner: a,
      schemaVersion: schema,
      wal: true,
    );
    final f = Fixture(dir, db);
    await db.close();
    await f.reopen(schema: schema);
    return f;
  }

  Future<void> reopen({int schema = 2, String owner = a}) async {
    db = await AppDatabase.open(
      factory: databaseFactoryFfiNoIsolate,
      path: p.join(dir.path, 'test.db'),
      owner: owner,
      schemaVersion: schema,
      clock: () => time,
      wal: true,
    );
  }

  Future<void> seed({bool withCard = false, String revision = '1'}) async {
    final token = (await queue.acquireLease())!;
    try {
      await queue.applyPage(token, [
        change('deck', server('deck', deck, revision: revision)),
        if (withCard) change('card', server('card', card)),
      ], 'fixture-cursor');
    } finally {
      await queue.releaseLease(token);
    }
  }

  Future<void> close() async {
    await db.close();
    // Delete only this fixture's generated direct child of the OS temp folder.
    if (p.dirname(dir.absolute.path) !=
            p.normalize(Directory.systemTemp.absolute.path) ||
        !p.basename(dir.path).startsWith('cam-offline-')) {
      throw StateError('Unsafe fixture cleanup');
    }
    await dir.delete(recursive: true);
  }
}

class FakeApi implements SyncApi {
  Future<List<Json>> Function(PreparedRequest)? onPush;
  Future<Json> Function(String?)? onPull;
  int pushes = 0, pulls = 0;
  @override
  Future<List<Json>> push(PreparedRequest request) {
    pushes++;
    return onPush!(request);
  }

  @override
  Future<Json> pull(String? cursor) async {
    pulls++;
    return onPull == null
        ? {
            'changes': <Json>[],
            'next_cursor': cursor ?? 'fixture',
            'has_more': false,
          }
        : onPull!(cursor);
  }
}

void main() {
  sqfliteFfiInit();
  late Fixture f;
  setUp(() async {
    f = await Fixture.open();
  });
  tearDown(() async {
    await f.close();
  });

  test(
    'local CRUD/search/index metadata and FIFO are atomic and owner scoped',
    () async {
      await f.repo.create('deck', {'name': 'A'}, id: deck);
      await f.repo.create('card', {
        'deck_id': deck,
        'word': 'Café 100%',
        'meaning': 'bank',
        'tags': ['Travel'],
      }, id: card);
      await f.repo.update('card', card, {'meaning': 'river'});
      final record = (await f.repo.get('card', card))!;
      expect(record.isDirty, true);
      expect(record.syncVersion, '0');
      expect(record.syncedAt, null);
      expect(record.localRevision, 2);
      expect(
        (await f.repo.list('card', query: 'café 100%')).single.data['meaning'],
        'river',
      );
      expect(await f.repo.list('card', query: 'does-not-exist'), isEmpty);
      expect((await f.queue.pending()).map((r) => r['action']), [
        'create',
        'create',
        'update',
      ]);
      expect((await f.queue.pending()).last['base_version'], '1');
      await f.db.close();
      await f.reopen(owner: b);
      expect(await f.repo.list('deck'), isEmpty);
      expect(await f.queue.length, 0);
      expect(await f.repo.get('card', card), null);
      await expectLater(
        f.repo.create('card', {
          'deck_id': deck,
          'word': 'bad',
          'meaning': 'owner',
        }),
        throwsStateError,
      );
      await expectLater(
        f.db.sql.rawInsert(
          "INSERT INTO records(owner,kind,id,parent_kind,parent_id,data) VALUES(?, 'card', ?, 'deck', ?, '{}')",
          [b, newId(), deck],
        ),
        throwsA(isA<DatabaseException>()),
      );
    },
  );
  test(
    'failed outbox insert rolls back local write and all metadata',
    () async {
      await f.db.sql.execute(
        "CREATE TRIGGER fixture_reject BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'fixture'); END",
      );
      await expectLater(
        f.repo.create('deck', {'name': 'Rollback'}, id: deck),
        throwsA(isA<DatabaseException>()),
      );
      expect(await f.repo.get('deck', deck), null);
      expect(await f.queue.length, 0);
    },
  );
  test('v1 to v2 migration keeps learning data, pending mutations and cursor on disk', () async {
    final old = await Fixture.open(schema: 1);
    try {
      await old.repo.create('deck', {'name': 'Before migration'}, id: deck);
      await old.db.sql.insert('sync_state', {
        'owner': a,
        'cursor': 'old-cursor',
      });
      final pending = await old.queue.pending();
      await old.db.close();
      await old.reopen();
      expect(
        (await old.repo.get('deck', deck))!.data['name'],
        'Before migration',
      );
      expect(await old.queue.pending(), pending);
      expect(await old.queue.cursor(), 'old-cursor');
      expect(await old.queue.conflicts(), isEmpty);
    } finally {
      await old.close();
    }
  });
  test('frozen request survives restart and backoff without changing IDs or payload', () async {
    await f.repo.create('deck', {'name': 'Durable'}, id: deck);
    final token = (await f.queue.acquireLease())!,
        batch = (await f.queue.prepare(token))!;
    await f.queue.fail(token, batch, retryAfter: const Duration(seconds: 5));
    await f.db.close();
    f.time = f.time.add(const Duration(seconds: 31));
    await f.reopen();
    final nextToken = (await f.queue.acquireLease())!,
        replay = (await f.queue.prepare(nextToken))!;
    expect(replay.id, batch.id);
    expect(jsonEncode(replay.body), jsonEncode(batch.body));
    await f.queue.acknowledge(nextToken, replay, [
      ack(replay.items.single, server('deck', deck)),
    ]);
    expect(await f.queue.length, 0);
    final local = (await f.repo.get('deck', deck))!;
    expect(local.isDirty, false);
    expect(local.syncVersion, '1');
    expect(local.syncedAt, isNotNull);
  });
  test('late ACK cannot overwrite a newer local edit; follow-up mutation uses next version', () async {
    await f.repo.create('deck', {'name': 'Original'}, id: deck);
    final token = (await f.queue.acquireLease())!,
        first = (await f.queue.prepare(token))!;
    await f.repo.update('deck', deck, {'name': 'Newer local'});
    await f.queue.acknowledge(token, first, [
      ack(first.items.single, server('deck', deck)),
    ]);
    final local = (await f.repo.get('deck', deck))!;
    expect(local.data['name'], 'Newer local');
    expect(local.isDirty, true);
    final second = (await f.queue.prepare(token))!;
    expect(second.items.single['base_version'], '1');
    await f.queue.acknowledge(token, second, [
      ack(
        second.items.single,
        server('deck', deck, revision: '2', fields: {'name': 'Newer local'}),
      ),
    ]);
    expect((await f.repo.get('deck', deck))!.isDirty, false);
  });
  test('incomplete, wrong-owner and partial SQL ACK failures preserve the whole outbox', () async {
    await f.repo.create('deck', {'name': 'Original'}, id: deck);
    await f.repo.create('card', {
      'deck_id': deck,
      'word': 'word',
      'meaning': 'meaning',
    }, id: card);
    final token = (await f.queue.acquireLease())!,
        batch = (await f.queue.prepare(token))!;
    await expectLater(
      f.queue.acknowledge(token, batch, []),
      throwsFormatException,
    );
    final replies = [
      ack(batch.items[0], server('deck', deck)),
      ack(batch.items[1], server('card', card, fields: {'user_id': b})),
    ];
    await expectLater(
      f.queue.acknowledge(token, batch, replies),
      throwsFormatException,
    );
    expect(await f.queue.length, 2);
    replies[1] = ack(batch.items[1], server('card', card));
    await f.db.sql.execute(
      "CREATE TRIGGER fixture_ack BEFORE UPDATE ON records WHEN NEW.kind='card' BEGIN SELECT RAISE(ABORT,'fixture'); END",
    );
    await expectLater(
      f.queue.acknowledge(token, batch, replies),
      throwsA(isA<DatabaseException>()),
    );
    expect(await f.queue.length, 2);
    expect((await f.repo.get('deck', deck))!.syncVersion, '0');
  });
  test(
    'expired/replaced lease fences old ACK and only new worker can commit',
    () async {
      await f.repo.create('deck', {'name': 'Original'}, id: deck);
      final first = (await f.queue.acquireLease())!,
          batch = (await f.queue.prepare(first))!;
      expect(await f.queue.acquireLease(), null);
      f.time = f.time.add(const Duration(seconds: 31));
      final second = (await f.queue.acquireLease())!;
      await expectLater(
        f.queue.acknowledge(first, batch, [
          ack(batch.items.single, server('deck', deck)),
        ]),
        throwsStateError,
      );
      expect(await f.queue.length, 1);
      await f.queue.acknowledge(second, batch, [
        ack(batch.items.single, server('deck', deck)),
      ]);
      expect(await f.queue.length, 0);
    },
  );
  test(
    'server data/cursor commit together and orphan pages cannot advance cursor',
    () async {
      final token = (await f.queue.acquireLease())!;
      await f.queue.applyPage(token, [], 'before');
      final missing = newId();
      await expectLater(
        f.queue.applyPage(token, [
          change('deck', server('deck', deck)),
          change('card', server('card', card, fields: {'deck_id': missing})),
        ], 'after'),
        throwsA(isA<DatabaseException>()),
      );
      expect(await f.queue.cursor(), 'before');
      expect(await f.repo.get('deck', deck), null);
      await f.queue.applyPage(token, [
        change('deck', server('deck', deck)),
        change('card', server('card', card)),
      ], 'after');
      expect(await f.queue.cursor(), 'after');
      expect((await f.repo.get('card', card))!.syncVersion, '1');
    },
  );
  test(
    'versions beyond JS safe integer stay strings and snapshots never regress',
    () async {
      await f.seed(revision: '9007199254740993');
      await f.repo.update('deck', deck, {'name': 'Precision'});
      final token = (await f.queue.acquireLease())!,
          batch = (await f.queue.prepare(token))!;
      expect(batch.items.single['base_version'], '9007199254740993');
      await f.queue.acknowledge(token, batch, [
        ack(
          batch.items.single,
          server('deck', deck, revision: '9007199254740994'),
        ),
      ]);
      await f.queue.applyPage(token, [
        change('deck', server('deck', deck, revision: '1')),
      ], 'old-page');
      expect((await f.repo.get('deck', deck))!.syncVersion, '9007199254740994');
    },
  );
  test('disjoint fields rebase with NEW operation IDs, preserve server changes and audit original intent', () async {
    await f.seed();
    await f.repo.update('deck', deck, {'description': 'Local context'});
    final token = (await f.queue.acquireLease())!,
        batch = (await f.queue.prepare(token))!,
        op = batch.items.single;
    await f.queue.resolveConflict(token, batch, {
      'operation_id': op['operation_id'],
      'entity_type': 'deck',
      'entity_id': deck,
      'reason': 'version_mismatch',
      'server': server(
        'deck',
        deck,
        revision: '2',
        fields: {'name': 'Remote name'},
      ),
    });
    final rebased = (await f.queue.prepare(token))!;
    expect(rebased.items.single['operation_id'], isNot(op['operation_id']));
    expect(rebased.items.single['base_version'], '2');
    final local = (await f.repo.get('deck', deck))!;
    expect(local.data['name'], 'Remote name');
    expect(local.data['description'], 'Local context');
    expect((await f.queue.conflicts()).single['resolution'], 'mergeDisjoint');
  });
  test('overlap in a later queued edit chooses server and preserves every local edit for recovery', () async {
    await f.seed(withCard: true);
    await f.repo.update('card', card, {'meaning': 'local meaning'});
    await f.repo.update('card', card, {'word': 'local word'});
    final token = (await f.queue.acquireLease())!,
        batch = (await f.queue.prepare(token))!,
        op = batch.items.first;
    await f.queue.resolveConflict(token, batch, {
      'operation_id': op['operation_id'],
      'entity_type': 'card',
      'entity_id': card,
      'reason': 'version_mismatch',
      'server': server(
        'card',
        card,
        revision: '2',
        fields: {'word': 'remote word'},
      ),
    });
    expect(await f.queue.length, 0);
    expect((await f.repo.get('card', card))!.data['word'], 'remote word');
    final conflict = (await f.queue.conflicts()).single;
    expect((jsonDecode(conflict['mutations'] as String) as List).length, 2);
    final copy = await f.repo.recoverAsCopy(conflict['id'] as String);
    expect(copy, isNot(card));
    expect((await f.repo.get('card', copy))!.data['word'], 'local word');
    expect(await f.queue.length, 1);
  });
  test('remote parent/card tombstones defeat pending edits without losing recovery snapshot', () async {
    await f.seed(withCard: true);
    await f.repo.update('card', card, {'meaning': 'offline saved intent'});
    final token = (await f.queue.acquireLease())!;
    await f.queue.applyPage(token, [
      change(
        'deck',
        server(
          'deck',
          deck,
          revision: '2',
          fields: {'deleted_at': '2026-11-19T02:00:00Z'},
        ),
      ),
      change(
        'card',
        server(
          'card',
          card,
          revision: '2',
          fields: {'deleted_at': '2026-11-19T02:00:00Z'},
        ),
      ),
    ], 'deleted');
    expect(await f.repo.list('card'), isEmpty);
    expect(await f.queue.length, 0);
    expect(
      decodeRecord(
        (await f.queue.conflicts()).single['local_snapshot'] as String,
      )['meaning'],
      'offline saved intent',
    );
    await expectLater(
      f.repo.update('card', card, {'meaning': 'resurrect'}),
      throwsStateError,
    );
  });
  test('deleting a deck locally hides child rows and never permits a new orphan card', () async {
    await f.seed(withCard: true);
    await f.repo.remove('deck', deck);
    expect(await f.repo.list('card'), isEmpty);
    await expectLater(
      f.repo.create('card', {
        'deck_id': deck,
        'word': 'bad',
        'meaning': 'parent',
      }),
      throwsStateError,
    );
    expect((await f.queue.pending()).single['action'], 'delete');
  });
  test(
    'worker persists network backoff and never sends later FIFO items early',
    () async {
      await f.repo.create('deck', {'name': 'Offline'}, id: deck);
      final api = FakeApi()..onPush = (_) async => throw SyncFailure('network');
      final worker = SyncWorker(
        queue: f.queue,
        api: api,
        retry: RetryPolicy(random: Random(7)),
      );
      expect(await worker.run(), SyncStatus.deferred);
      expect(api.pushes, 1);
      expect((await f.queue.pending()).single['attempts'], 1);
      await worker.run();
      expect(api.pushes, 1);
      await f.queue.retryNow();
      await worker.run();
      expect(api.pushes, 2);
      await worker.stop();
    },
  );
  test('permanent error blocks queue until explicit archival, preserving local recovery data', () async {
    await f.repo.create('deck', {'name': 'Fix me'}, id: deck);
    final api = FakeApi()
      ..onPush = (_) async =>
          throw SyncFailure('VALIDATION_ERROR', status: 422);
    final worker = SyncWorker(queue: f.queue, api: api);
    expect(await worker.run(), SyncStatus.blocked);
    await worker.stop();
    await f.queue.archiveBlocked();
    expect(await f.queue.length, 0);
    expect(
      (await f.queue.conflicts()).single['reason'],
      'explicit_discard_blocked',
    );
    expect(await f.repo.get('deck', deck), null);
  });
  test('pull Retry-After and auth failures survive runs without discarding pending data', () async {
    final api = FakeApi()
      ..onPull = (_) async => throw SyncFailure(
        'RATE_LIMITED',
        status: 429,
        retryAfter: const Duration(minutes: 2),
      );
    final worker = SyncWorker(queue: f.queue, api: api);
    expect(await worker.run(), SyncStatus.deferred);
    expect(api.pulls, 1);
    await worker.run();
    expect(api.pulls, 1);
    f.time = f.time.add(const Duration(minutes: 3));
    api.onPull = (_) async => throw SyncFailure('UNAUTHORIZED', status: 401);
    expect(await worker.run(), SyncStatus.authRequired);
    await worker.stop();
  });
  test(
    'retry jitter is capped and Retry-After seconds/date is a lower bound',
    () {
      final policy = RetryPolicy(random: Random(42));
      for (var n = 1; n < 30; n++) {
        expect(policy.delay(n).inMilliseconds, lessThanOrEqualTo(60000));
      }
      expect(
        policy.delay(20, retryAfter: const Duration(minutes: 3)),
        const Duration(minutes: 3),
      );
      expect(
        RetryPolicy.parseRetryAfter('60', f.time),
        const Duration(seconds: 60),
      );
      expect(
        RetryPolicy.parseRetryAfter('Thu, 19 Nov 2026 00:02:00 GMT', f.time),
        const Duration(minutes: 2),
      );
      expect(RetryPolicy.parseRetryAfter('invalid', f.time), null);
    },
  );
  test(
    'constraint conflicts stay blocked rather than endlessly rebasing',
    () async {
      await f.seed();
      await f.repo.update('deck', deck, {'name': 'Local invalid intent'});
      final token = (await f.queue.acquireLease())!,
          batch = (await f.queue.prepare(token))!,
          op = batch.items.single;
      await f.queue.resolveConflict(token, batch, {
        'operation_id': op['operation_id'],
        'entity_id': deck,
        'entity_type': 'deck',
        'reason': 'constraint',
        'server': server('deck', deck),
      });
      expect(await f.queue.length, 1);
      expect((await f.queue.pending()).single['blocked_reason'], 'constraint');
      expect((await f.queue.conflicts()).single['resolution'], 'blocked');
      expect(await f.queue.prepare(token), null);
    },
  );
  test('delta cannot overtake an unacknowledged frozen batch', () async {
    await f.repo.create('deck', {'name': 'Original'}, id: deck);
    final token = (await f.queue.acquireLease())!;
    await f.queue.prepare(token);
    await expectLater(
      f.queue.applyPage(token, [
        change(
          'deck',
          server(
            'deck',
            deck,
            revision: '2',
            fields: {'deleted_at': '2026-11-19T02:00:00Z'},
          ),
        ),
      ], 'unsafe-cursor'),
      throwsStateError,
    );
    expect(await f.queue.cursor(), null);
    expect(await f.queue.length, 1);
  });
  test('NFC tags reject equivalent duplicates without mutating data', () async {
    await f.repo.create('deck', {'name': 'Unicode'}, id: deck);
    await expectLater(
      f.repo.create('card', {
        'deck_id': deck,
        'word': 'word',
        'meaning': 'meaning',
        'tags': ['Cafe\u0301', 'Café'],
      }),
      throwsArgumentError,
    );
    expect(await f.queue.length, 1);
  });
  test('batch respects FIFO count and UTF-8 request budget', () async {
    await f.repo.create('deck', {'name': 'Large batch'}, id: deck);
    for (var i = 0; i < 60; i++) {
      await f.repo.create('card', {
        'deck_id': deck,
        'word': 'word $i',
        'meaning': 'm',
        'source_sentence': 'x' * 10000,
      });
    }
    final token = (await f.queue.acquireLease())!,
        batch = (await f.queue.prepare(token))!;
    expect(batch.items.length, lessThan(61));
    expect(
      utf8.encode(jsonEncode(batch.body)).length,
      lessThanOrEqualTo(512 * 1024),
    );
    expect(
      jsonEncode((await f.queue.prepare(token, limit: 1))!.body),
      jsonEncode(batch.body),
    );
  });
  test(
    'stop during in-flight push retains frozen batch; concurrent runs coalesce',
    () async {
      await f.repo.create('deck', {'name': 'Original'}, id: deck);
      final started = Completer<void>(), completion = Completer<List<Json>>();
      PreparedRequest? request;
      final api = FakeApi()
        ..onPush = (value) {
          request = value;
          started.complete();
          return completion.future;
        };
      final worker = SyncWorker(queue: f.queue, api: api);
      final first = worker.run(), second = worker.run();
      expect(identical(first, second), true);
      await started.future;
      final stopping = worker.stop();
      completion.complete([
        ack(
          (request!.body['items'] as List).single as Json,
          server('deck', deck),
        ),
      ]);
      expect(await first, SyncStatus.stopped);
      await stopping;
      expect(await f.queue.length, 1);
      expect(api.pushes, 1);
    },
  );
}

import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:flutter_app/src/data/local/app_database.dart';
import 'package:flutter_app/src/data/repositories/learning_repository.dart';
import 'package:flutter_app/src/data/sync/sync_api_client.dart';
import 'package:flutter_app/src/data/sync/sync_queue.dart';
import 'package:flutter_app/src/data/sync/sync_worker.dart';

void check(bool value, String label) {
  if (!value) throw OfflineCheckFailure(label);
}

class OfflineCheckFailure implements Exception {
  OfflineCheckFailure(this.label);
  final String label;
}

class LoseFirstReply implements SyncApi {
  LoseFirstReply(this.real);
  final SyncApi real;
  String? first;
  bool dropped = false, identicalReplay = false;
  @override
  Future<List<Json>> push(PreparedRequest request) async {
    final encoded = jsonEncode(request.body);
    if (first == null) {
      first = encoded;
    } else {
      identicalReplay = first == encoded;
    }
    final result = await real.push(request);
    if (!dropped) {
      dropped = true;
      throw SyncFailure('simulated_lost_response');
    }
    return result;
  }

  @override
  Future<Json> pull(String? cursor) => real.pull(cursor);
}

Future<void> main() async {
  final config = Json.from(
    jsonDecode(await stdin.transform(utf8.decoder).join()) as Map,
  );
  final origin = config['origin'] as String,
      owner = config['ownerA'] as String,
      token = config['tokenA'] as String;
  final dir = await Directory.systemTemp.createTemp('cam-offline-http-');
  final open = <AppDatabase>[], clients = <SyncApiClient>[];
  final checks = <String>[];
  String? cleanupDeck;
  bool success = false;
  Future<AppDatabase> device(String name, {String? user}) async {
    final db = await AppDatabase.open(
      factory: databaseFactoryFfiNoIsolate,
      path: p.join(dir.path, '$name.db'),
      owner: user ?? owner,
      wal: true,
    );
    open.add(db);
    return db;
  }

  SyncApiClient client({String? user, String? access}) {
    final api = SyncApiClient(
      baseUri: Uri.parse(origin),
      owner: user ?? owner,
      allowDevelopmentHttp: true,
      session: () async =>
          AccessSession(owner: user ?? owner, accessToken: access ?? token),
    );
    clients.add(api);
    return api;
  }

  Future<Json> call(
    String method,
    String path, {
    String? access,
    Json? body,
  }) async {
    final r = http.Request(method, Uri.parse('$origin/api/v1/$path')).change((
      request,
    ) {
      request.headers['authorization'] = 'Bearer ${access ?? token}';
      request.headers['content-type'] = 'application/json';
      if (body != null) request.body = jsonEncode(body);
    });
    final response = await http.Response.fromStream(await r.send());
    return {
      'http': response.statusCode,
      ...Json.from(jsonDecode(response.body) as Map),
    };
  }

  void passed(String name) {
    checks.add(name);
    stdout.writeln(jsonEncode({'step': name, 'status': 'passed'}));
  }

  try {
    sqfliteFfiInit();
    var one = await device('one');
    final api = client(), lost = LoseFirstReply(api);
    final repo = LearningRepository(one);
    final deck = await repo.create('deck', {'name': 'Offline HTTP fixture'});
    cleanupDeck = deck;
    final cards = <String>[];
    for (var i = 0; i < 12; i++) {
      cards.add(
        await repo.create('card', {
          'deck_id': deck,
          'word': 'word $i',
          'meaning': 'original',
          'tags': ['Offline'],
        }),
      );
    }
    check(await SyncQueue(one).length == 13, 'FIFO setup');
    check(
      await SyncWorker(queue: SyncQueue(one), api: lost).run() ==
          SyncStatus.deferred,
      'response loss',
    );
    await one.close();
    open.remove(one);
    one = await device('one');
    final queue = SyncQueue(one);
    await queue.retryNow();
    check(
      await SyncWorker(queue: queue, api: lost).run() == SyncStatus.synced,
      'replay and pull',
    );
    check(lost.identicalReplay && await queue.length == 0, 'immutable replay');
    final listing = await call('GET', 'vocabulary?deck_id=$deck&limit=100');
    check(
      listing['http'] == 200 && (listing['data'] as List).length == 12,
      'no duplicate cards',
    );
    passed('dart_offline_restart_lost_reply_exact_receipt_replay');

    final two = await device('two'),
        otherRepo = LearningRepository(two),
        apiTwo = client();
    final workerTwo = SyncWorker(queue: SyncQueue(two), api: apiTwo);
    check(await workerTwo.run() == SyncStatus.synced, 'second device pull');
    final currentRepo = LearningRepository(one);
    await currentRepo.update('card', cards[0], {'meaning': 'local meaning'});
    await otherRepo.update('card', cards[0], {'word': 'remote word'});
    check(await workerTwo.run() == SyncStatus.synced, 'remote edit');
    check(
      await SyncWorker(queue: queue, api: api).run() == SyncStatus.synced,
      'disjoint merge',
    );
    final merged = (await currentRepo.get('card', cards[0]))!;
    check(
      merged.data['word'] == 'remote word' &&
          merged.data['meaning'] == 'local meaning' &&
          merged.syncVersion == '3',
      'merge retains both fields',
    );
    passed('dart_two_device_disjoint_conflict_rebase');

    await workerTwo.run();
    await currentRepo.update('card', cards[0], {
      'word': 'recoverable local word',
    });
    await otherRepo.update('card', cards[0], {'word': 'latest server word'});
    await workerTwo.run();
    check(
      await SyncWorker(queue: queue, api: api).run() == SyncStatus.synced,
      'overlap resolution',
    );
    check(
      (await currentRepo.get('card', cards[0]))!.data['word'] ==
          'latest server word',
      'server winner',
    );
    final audit = (await queue.conflicts())
        .where(
          (row) =>
              row['entity_id'] == cards[0] && row['resolution'] == 'serverWins',
        )
        .last;
    final copy = await currentRepo.recoverAsCopy(audit['id'] as String);
    check(copy != cards[0], 'new recovery identity');
    await SyncWorker(queue: queue, api: api).run();
    check(
      (await currentRepo.get('card', copy))!.data['word'] ==
          'recoverable local word',
      'recovered copy',
    );
    passed('dart_overlap_audit_and_recovery_as_new_card');

    final privateResponse = await call(
      'GET',
      'decks/$deck',
      access: config['tokenB'] as String,
    );
    check(privateResponse['http'] == 404, 'server owner isolation');
    final accountB = await device('one', user: config['ownerB'] as String);
    check(
      (await LearningRepository(accountB).list('deck')).isEmpty &&
          await SyncQueue(accountB).cursor() == null,
      'local owner isolation',
    );
    passed('dart_server_and_local_account_isolation');

    await currentRepo.update('card', cards[1], {
      'meaning': 'offline pending before remote deletion',
    });
    await workerTwo.run();
    await otherRepo.remove('deck', deck);
    await workerTwo.run();
    check(
      await SyncWorker(queue: queue, api: api).run() == SyncStatus.synced,
      'tombstone resolution',
    );
    check(
      (await currentRepo.list('card', deckId: deck)).isEmpty &&
          await queue.length == 0,
      'no resurrection',
    );
    check(
      (await queue.conflicts()).any(
        (row) => (row['local_snapshot'] as String).contains(
          'offline pending before remote deletion',
        ),
      ),
      'intent retained',
    );
    final orphans = await one.sql.rawQuery(
      "SELECT count(*) AS n FROM records c LEFT JOIN records d ON d.owner=c.owner AND d.kind='deck' AND d.id=c.parent_id WHERE c.kind='card' AND d.id IS NULL",
    );
    check(orphans.single['n'] == 0, 'no local orphan');
    passed('dart_remote_delete_defeats_edit_without_orphans');
    success = true;
  } catch (error) {
    stderr.writeln(
      jsonEncode({
        'step': 'offline_http',
        'status': 'failed',
        'type': error.runtimeType.toString(),
        if (error is OfflineCheckFailure) 'failed_check': error.label,
      }),
    );
    exitCode = 1;
  } finally {
    if (cleanupDeck != null) {
      try {
        final current = await call('GET', 'decks/$cleanupDeck');
        if (current['http'] == 200) {
          check(
            (await call(
                  'DELETE',
                  'decks/$cleanupDeck?base_version=${current['data']['version']}',
                ))['http'] ==
                200,
            'cleanup',
          );
        }
      } catch (_) {
        success = false;
        exitCode = 1;
      }
    }
    for (final client in clients) {
      client.close();
    }
    for (final db in open) {
      await db.close();
    }
    if (p.dirname(dir.absolute.path) !=
            p.normalize(Directory.systemTemp.absolute.path) ||
        !p.basename(dir.path).startsWith('cam-offline-http-')) {
      throw StateError('Unsafe cleanup');
    }
    await dir.delete(recursive: true);
    stdout.writeln(
      jsonEncode({
        'offline_client_pass': success,
        'checks': checks,
        'resources_closed': true,
      }),
    );
  }
}

extension _RequestSetup on http.Request {
  http.Request change(void Function(http.Request) configure) {
    configure(this);
    return this;
  }
}

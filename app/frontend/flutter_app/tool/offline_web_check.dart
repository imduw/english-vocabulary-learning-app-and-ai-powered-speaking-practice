import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:sqflite_common_ffi_web/sqflite_ffi_web.dart';
import 'package:flutter_app/src/data/local/app_database.dart';
import 'package:flutter_app/src/data/local/platform_database.dart';
import 'package:flutter_app/src/data/repositories/learning_repository.dart';
import 'package:flutter_app/src/data/sync/sync_queue.dart';

const a = '10000000-0000-4000-8000-000000000001',
    b = '10000000-0000-4000-8000-000000000002';
const deck = '20000000-0000-4000-8000-000000000001';
void check(bool ok) {
  if (!ok) {
    throw StateError('Web storage check failed');
  }
}

Future<void> send(String path, Json result) async {
  await http.post(
    Uri.base.resolve(path),
    headers: {'content-type': 'application/json'},
    body: jsonEncode(result),
  );
}

Future<void> main() async {
  final peer = Uri.base.queryParameters['peer'] == '1';
  final stores = <AppDatabase>[];
  var stage = 'open', passed = false;
  final checks = <String>[];
  try {
    var db = await openLearningDatabase(a);
    stores.add(db);
    if (peer) {
      check(await SyncQueue(db).acquireLease() == null);
      await LearningRepository(db)
          .update('deck', deck, {'description': 'from peer tab'});
      await db.close();
      stores.remove(db);
      await send('/peer-result', {'passed': true});
      return;
    }
    stage = 'web_queue_create';
    await LearningRepository(db)
        .create('deck', {'name': 'Web fixture'}, id: deck);
    checks.add(stage);
    final token = (await SyncQueue(db).acquireLease())!;
    stage = 'web_shared_worker_two_tabs';
    await send('/ready-peer', {});
    var peerOk = false;
    for (var attempt = 0; attempt < 100; attempt++) {
      final result = jsonDecode(
        (await http.get(Uri.base.resolve('/peer-result'))).body,
      ) as Map;
      if (result['passed'] == true) {
        peerOk = true;
        break;
      }
      await Future<void>.delayed(const Duration(milliseconds: 100));
    }
    check(peerOk);
    check(
      (await LearningRepository(db).get('deck', deck))!.data['description'] ==
          'from peer tab',
    );
    check(await SyncQueue(db).length == 2);
    await SyncQueue(db).releaseLease(token);
    checks.add(stage);
    stage = 'web_close_reopen_persistence';
    await db.close();
    // Only the harness can close physically here: the peer has completed.
    // This proves persisted storage, rather than reopening a cached handle.
    await db.sql.close();
    stores.remove(db);
    db = await openLearningDatabase(a);
    stores.add(db);
    check(await SyncQueue(db).length == 2);
    check((await LearningRepository(db).get('deck', deck))!.isDirty);
    checks.add(stage);
    stage = 'web_owner_isolation';
    final other = await openLearningDatabase(b);
    stores.add(other);
    check((await LearningRepository(other).list('deck')).isEmpty);
    check(await SyncQueue(other).length == 0);
    checks.add(stage);
    stage = 'web_migration_preserves_pending';
    var old = await AppDatabase.open(
      factory: databaseFactoryFfiWeb,
      path: 'migration.db',
      owner: a,
      singleInstance: true,
      schemaVersion: 1,
    );
    stores.add(old);
    await LearningRepository(old)
        .create('deck', {'name': 'Before Web migration'});
    await old.close();
    stores.remove(old);
    old = await AppDatabase.open(
      factory: databaseFactoryFfiWeb,
      path: 'migration.db',
      owner: a,
      singleInstance: true,
    );
    stores.add(old);
    check(await SyncQueue(old).length == 1);
    check(
      (await LearningRepository(old).list('deck')).single.data['name'] ==
          'Before Web migration',
    );
    checks.add(stage);
    passed = true;
  } catch (error) {
    await send(peer ? '/peer-result' : '/result', {
      'passed': false,
      'stage': stage,
      'diagnostic': error.toString().substring(
        0,
        error.toString().length > 600 ? 600 : error.toString().length,
      ),
    });
  } finally {
    for (final store in stores) {
      await store.close();
    }
    if (!peer && passed) {
      await send('/result', {
        'passed': true,
        'checks': checks,
        'resources_closed': true,
      });
    }
  }
}

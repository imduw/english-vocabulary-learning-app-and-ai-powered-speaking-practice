import 'dart:convert';
import 'dart:io';

import 'package:path/path.dart' as p;
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:flutter_app/src/data/local/app_database.dart';
import 'package:flutter_app/src/data/repositories/learning_repository.dart';

Future<void> main() async {
  sqfliteFfiInit();
  final dir = await Directory.systemTemp.createTemp('cam-offline-bench-');
  AppDatabase? db;
  var passed = false;
  try {
    const owner = '10000000-0000-4000-8000-000000000001';
    db = await AppDatabase.open(
      factory: databaseFactoryFfi,
      path: p.join(dir.path, 'bench.db'),
      owner: owner,
      wal: true,
    );
    final store = db,
        repo = LearningRepository(db),
        deck = newId(),
        now = DateTime.now().toUtc().toIso8601String();
    await store.sql.transaction((tx) async {
      await store.put(
        tx,
        'deck',
        {
          'id': deck,
          'user_id': owner,
          'name': 'Benchmark',
          'description': null,
          'version': '1',
          'created_at': now,
          'updated_at': now,
          'deleted_at': null,
        },
        revision: 0,
        dirty: false,
        syncVersion: '1',
      );
      for (var i = 0; i < 5000; i++) {
        await store.put(
          tx,
          'card',
          {
            'id': newId(),
            'user_id': owner,
            'deck_id': deck,
            'word': 'benchmark $i',
            'meaning': 'ngữ cảnh $i',
            'tags': ['Study'],
            'version': '1',
            'created_at': now,
            'updated_at': now,
            'deleted_at': null,
          },
          revision: 0,
          dirty: false,
          syncVersion: '1',
        );
      }
    });
    final samples = <String, List<double>>{
      for (final key in ['create', 'read', 'update', 'delete', 'search'])
        key: [],
    };
    Future<T> measure<T>(
      String kind,
      bool record,
      Future<T> Function() action,
    ) async {
      final watch = Stopwatch()..start();
      final result = await action();
      watch.stop();
      if (record) {
        samples[kind]!.add(watch.elapsedMicroseconds / 1000);
      }
      return result;
    }

    for (var i = 0; i < 60; i++) {
      final record = i >= 10;
      final id = await measure(
        'create',
        record,
        () => repo.create('card', {
          'deck_id': deck,
          'word': 'sample $i',
          'meaning': 'meaning',
        }),
      );
      await measure('read', record, () => repo.get('card', id));
      await measure(
        'update',
        record,
        () => repo.update('card', id, {'meaning': 'updated'}),
      );
      await measure('delete', record, () => repo.remove('card', id));
      await measure(
        'search',
        record,
        () => repo.list('card', query: 'benchmark 42', limit: 20),
      );
    }
    final results = <String, dynamic>{};
    for (final entry in samples.entries) {
      final sorted = entry.value..sort(),
          p95 = sorted[(sorted.length * .95).ceil() - 1];
      results[entry.key] = {
        'samples': sorted.length,
        'mean_ms': sorted.reduce((a, b) => a + b) / sorted.length,
        'p95_ms': p95,
        'max_ms': sorted.last,
        'target_met': p95 < 10,
      };
    }
    passed = results.values.every((r) => r['target_met'] == true);
    final result = {
      'generated_at': DateTime.now().toUtc().toIso8601String(),
      'platform': Platform.operatingSystem,
      'dart': Platform.version,
      'scope': 'Durable SQLite file on Windows host, production FFI isolate adapter, WAL; repository writes include metadata and outbox transaction. Not an Android/iOS/Web latency guarantee.',
      'sqlite': (await db.sql.rawQuery('SELECT sqlite_version() AS version'))
          .single['version'],
      'journal_mode': await db.sql.rawQuery('PRAGMA journal_mode'),
      'synchronous': await db.sql.rawQuery('PRAGMA synchronous'),
      'fixture_cards': 5000,
      'warmup_iterations': 10,
      'threshold_p95_ms': 10,
      'results': results,
      'passed': passed,
    };
    await File(
      p.join(
        '..',
        '..',
        '..',
        'docs',
        'cam',
        'benchmarks',
        'offline-local-crud.json',
      ),
    ).writeAsString('${const JsonEncoder.withIndent('  ').convert(result)}\n');
    stdout.writeln(jsonEncode(result));
  } finally {
    await db?.close();
    if (p.dirname(dir.absolute.path) !=
            p.normalize(Directory.systemTemp.absolute.path) ||
        !p.basename(dir.path).startsWith('cam-offline-bench-')) {
      throw StateError('Unsafe benchmark cleanup');
    }
    await dir.delete(recursive: true);
  }
  await stdout.flush();
  exit(passed ? 0 : 1);
}

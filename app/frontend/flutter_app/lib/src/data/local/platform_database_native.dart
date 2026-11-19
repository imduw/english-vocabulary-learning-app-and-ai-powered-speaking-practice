import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart' as mobile;
import 'package:sqflite_common_ffi/sqflite_ffi.dart' as ffi;

import 'app_database.dart';

Future<AppDatabase> openLearningDatabase(String owner) async {
  if ([
    TargetPlatform.android,
    TargetPlatform.iOS,
    TargetPlatform.macOS,
  ].contains(defaultTargetPlatform)) {
    return AppDatabase.open(
      factory: mobile.databaseFactory,
      path: p.join(await mobile.getDatabasesPath(), 'learning_v2.db'),
      owner: owner,
      wal: true,
    );
  }
  ffi.sqfliteFfiInit();
  final directory = await getApplicationSupportDirectory();
  await directory.create(recursive: true);
  return AppDatabase.open(
    factory: ffi.databaseFactoryFfi,
    path: p.join(directory.path, 'learning_v2.db'),
    owner: owner,
    wal: true,
  );
}

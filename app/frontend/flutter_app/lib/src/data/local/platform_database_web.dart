import 'package:sqflite_common_ffi_web/sqflite_ffi_web.dart';

import 'dart:js_interop';

import 'app_database.dart';

@JS('SharedWorker')
external JSAny? get _sharedWorker;

Future<AppDatabase> openLearningDatabase(String owner) {
  if (_sharedWorker == null) {
    throw UnsupportedError(
      'Offline Web storage requires SharedWorker for safe multi-tab access',
    );
  }
  return AppDatabase.open(
    factory: databaseFactoryFfiWeb,
    path: 'learning_v2.db',
    owner: owner,
    singleInstance: true,
    closeConnection: false,
  );
}

import 'package:flutter/widgets.dart';

import 'local/app_database.dart';
import 'repositories/learning_repository.dart';
import 'sync/sync_api_client.dart';
import 'sync/sync_queue.dart';
import 'sync/sync_worker.dart';

/// Explicit integration point for the team's Auth lifecycle. Construct a new
/// session after account changes; await close before disposing its database.
class OfflineLearningSession with WidgetsBindingObserver {
  OfflineLearningSession({required this.database, required this.api})
    : repository = LearningRepository(database),
      worker = SyncWorker(queue: SyncQueue(database), api: api) {
    if (database.owner != api.owner) {
      throw ArgumentError('Session owner mismatch');
    }
  }
  final AppDatabase database;
  final SyncApiClient api;
  final LearningRepository repository;
  final SyncWorker worker;
  void start({Stream<void>? networkAvailable}) {
    WidgetsBinding.instance.addObserver(this);
    worker.start(networkAvailable: networkAvailable);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) worker.run();
  }

  Future<void> close() async {
    WidgetsBinding.instance.removeObserver(this);
    api.close();
    await worker.stop();
    await database.close();
  }
}

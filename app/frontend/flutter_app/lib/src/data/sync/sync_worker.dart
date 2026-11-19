import 'dart:async';

import '../local/app_database.dart';
import 'retry_policy.dart';
import 'sync_api_client.dart';
import 'sync_queue.dart';

enum SyncStatus {
  idle,
  synced,
  busy,
  deferred,
  blocked,
  authRequired,
  stopped,
  protocolError,
}

class SyncWorker {
  SyncWorker({
    required this.queue,
    required this.api,
    RetryPolicy? retry,
    this.onStatus,
  }) : retry = retry ?? RetryPolicy();
  final SyncQueue queue;
  final SyncApi api;
  final RetryPolicy retry;
  final void Function(SyncStatus)? onStatus;
  Future<SyncStatus>? _running;
  Timer? _timer;
  StreamSubscription<void>? _network;
  bool _stopped = false;
  Future<SyncStatus> run() {
    if (_stopped) return Future.value(SyncStatus.stopped);
    return _running ??= _run().whenComplete(() {
      _running = null;
    });
  }

  void start({
    Duration interval = const Duration(seconds: 30),
    Stream<void>? networkAvailable,
  }) {
    if (interval < const Duration(seconds: 1) || _stopped) {
      throw StateError('Invalid worker lifecycle');
    }
    _timer?.cancel();
    unawaited(_network?.cancel());
    _timer = Timer.periodic(interval, (_) => _trigger());
    _network = networkAvailable?.listen((_) => _trigger());
    _trigger();
  }

  void _trigger() {
    unawaited(
      run().then((status) => onStatus?.call(status)).catchError((Object _) {
        onStatus?.call(SyncStatus.protocolError);
      }),
    );
  }

  Future<SyncStatus> _run() async {
    final token = await queue.acquireLease();
    if (token == null) return SyncStatus.busy;
    try {
      for (var count = 0; count < 20 && !_stopped; count++) {
        final batch = await queue.prepare(token);
        if (batch == null) {
          if (await queue.hasPreparedBatch()) {
            final pending = await queue.pending();
            return pending.isNotEmpty && pending.first['blocked_reason'] != null
                ? SyncStatus.blocked
                : SyncStatus.deferred;
          }
          break;
        }
        try {
          final results = await api.push(PreparedRequest(batch.body));
          if (_stopped) return SyncStatus.stopped;
          await queue.acknowledge(token, batch, results);
        } on SyncFailure catch (failure) {
          if (_stopped) return SyncStatus.stopped;
          if (failure.status == 409 && failure.details != null) {
            await queue.resolveConflict(token, batch, failure.details!);
            continue;
          }
          final pending = await queue.pending();
          final attempt = pending.isEmpty
              ? 1
              : (pending.first['attempts'] as int) + 1;
          if (failure.status == 401 || failure.status == 403) {
            await queue.fail(
              token,
              batch,
              retryAfter: const Duration(seconds: 60),
            );
            return SyncStatus.authRequired;
          }
          await queue.fail(
            token,
            batch,
            retryAfter: retry.delay(attempt, retryAfter: failure.retryAfter),
            blockedReason: failure.retryable ? null : failure.code,
          );
          return failure.retryable ? SyncStatus.deferred : SyncStatus.blocked;
        }
      }
      if (_stopped) return SyncStatus.stopped;
      final pullState = await queue.pullState();
      if (pullState['pull_blocked'] == 1) return SyncStatus.protocolError;
      if ((pullState['pull_next_ms'] as int) >
          queue.store.clock().toUtc().millisecondsSinceEpoch) {
        return SyncStatus.deferred;
      }
      var more = false;
      for (var page = 0; page < 100; page++) {
        await queue.heartbeat(token);
        Json pulled;
        try {
          pulled = await api.pull(await queue.cursor());
        } on SyncFailure catch (failure) {
          final auth = [401, 403].contains(failure.status),
              state = await queue.pullState();
          await queue.deferPull(
            token,
            auth
                ? const Duration(seconds: 60)
                : retry.delay(
                    (state['pull_attempts'] as int) + 1,
                    retryAfter: failure.retryAfter,
                  ),
            blocked: !failure.retryable && !auth,
          );
          return auth
              ? SyncStatus.authRequired
              : failure.retryable
              ? SyncStatus.deferred
              : SyncStatus.protocolError;
        }
        if (_stopped) return SyncStatus.stopped;
        if (pulled['next_cursor'] is! String ||
            pulled['has_more'] is! bool ||
            pulled['changes'] is! List) {
          throw const FormatException('Invalid delta page');
        }
        await queue.applyPage(
          token,
          (pulled['changes'] as List).map((c) => Json.from(c as Map)).toList(),
          pulled['next_cursor'] as String,
        );
        more = pulled['has_more'] as bool;
        if (!more) {
          break;
        }
      }
      if (more) {
        return SyncStatus.deferred;
      }
      final pending = await queue.pending();
      return pending.isEmpty
          ? SyncStatus.synced
          : pending.first['blocked_reason'] != null
          ? SyncStatus.blocked
          : SyncStatus.deferred;
    } on FormatException {
      return SyncStatus.protocolError;
    } on TypeError {
      return SyncStatus.protocolError;
    } on StateError {
      return _stopped ? SyncStatus.stopped : SyncStatus.busy;
    } finally {
      await queue.releaseLease(token);
    }
  }

  Future<void> stop() async {
    _stopped = true;
    _timer?.cancel();
    await _network?.cancel();
    await _running;
  }
}

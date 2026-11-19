import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../local/app_database.dart';
import 'retry_policy.dart';

class AccessSession {
  AccessSession({required this.owner, required this.accessToken});
  final String owner, accessToken;
}

class SyncFailure implements Exception {
  SyncFailure(this.code, {this.status, this.details, this.retryAfter});
  final String code;
  final int? status;
  final Json? details;
  final Duration? retryAfter;
  bool get retryable =>
      status == null || [408, 425, 429].contains(status) || status! >= 500;
  @override
  String toString() => 'SyncFailure($code, $status)';
}

abstract interface class SyncApi {
  Future<List<Json>> push(PreparedRequest request);
  Future<Json> pull(String? cursor);
}

class PreparedRequest {
  PreparedRequest(this.body);
  final Json body;
}

class SyncApiClient implements SyncApi {
  SyncApiClient({
    required this.baseUri,
    required String owner,
    required this.session,
    http.Client? client,
    this.timeout = const Duration(seconds: 10),
    bool allowDevelopmentHttp = false,
  }) : owner = checkedId(owner),
       _client = client ?? http.Client(),
       _ownsClient = client == null {
    final local = [
      'localhost',
      '127.0.0.1',
      '::1',
      '[::1]',
      '10.0.2.2',
    ].contains(baseUri.host);
    if (baseUri.userInfo.isNotEmpty ||
        baseUri.hasQuery ||
        baseUri.hasFragment ||
        !['', '/'].contains(baseUri.path) ||
        (baseUri.scheme != 'https' &&
            !(allowDevelopmentHttp && local && baseUri.scheme == 'http'))) {
      throw ArgumentError('Trusted HTTPS API origin required');
    }
  }
  final Uri baseUri;
  final String owner;
  final Future<AccessSession?> Function() session;
  final Duration timeout;
  final http.Client _client;
  final bool _ownsClient;
  bool _closed = false;

  Future<Json> _request(String method, String path, {Json? body}) async {
    if (_closed) throw SyncFailure('stopped');
    AccessSession? credentials;
    try {
      credentials = await session().timeout(timeout);
    } catch (_) {
      throw SyncFailure('auth_required', status: 401);
    }
    if (_closed ||
        credentials == null ||
        credentials.owner.toLowerCase() != owner ||
        credentials.accessToken.isEmpty) {
      throw SyncFailure('auth_required', status: 401);
    }
    final abort = Completer<void>(),
        timer = Timer(timeout, () {
          if (!abort.isCompleted) abort.complete();
        });
    final request =
        http.AbortableRequest(
            method,
            baseUri.resolve(path),
            abortTrigger: abort.future,
          )
          ..headers.addAll({
            'authorization': 'Bearer ${credentials.accessToken}',
            'accept': 'application/json',
            if (body != null) 'content-type': 'application/json',
          });
    if (body != null) request.body = jsonEncode(body);
    Future<Json> exchange() async {
      final response = await _client.send(request);
      final bytes = <int>[];
      await for (final chunk in response.stream) {
        if (bytes.length + chunk.length > 16 * 1024 * 1024) {
          throw const FormatException('Sync response too large');
        }
        bytes.addAll(chunk);
      }
      final root = Json.from(jsonDecode(utf8.decode(bytes)) as Map);
      if (response.statusCode != 200) {
        final error = root['error'];
        const known = {
          'BAD_REQUEST',
          'UNAUTHORIZED',
          'FORBIDDEN',
          'NOT_FOUND',
          'CONFLICT',
          'VALIDATION_ERROR',
          'RATE_LIMITED',
          'INTERNAL_ERROR',
          'SERVICE_UNAVAILABLE',
          'SYNC_CONFLICT',
        };
        throw SyncFailure(
          error is Map && known.contains(error['code'])
              ? error['code'] as String
              : 'http_error',
          status: response.statusCode,
          details: error is Map && error['details'] is Map
              ? Json.from(error['details'] as Map)
              : null,
          retryAfter: RetryPolicy.parseRetryAfter(
            response.headers['retry-after'],
            DateTime.now(),
          ),
        );
      }
      if (root['status'] != 'ok' ||
          root['error'] != null ||
          root['data'] is! Map) {
        throw const FormatException('Invalid sync envelope');
      }
      return Json.from(root['data'] as Map);
    }

    try {
      return await exchange().timeout(timeout);
    } on SyncFailure {
      rethrow;
    } on FormatException {
      rethrow;
    } on TypeError {
      throw const FormatException('Invalid sync response shape');
    } catch (_) {
      throw SyncFailure('network');
    } finally {
      timer.cancel();
      if (!abort.isCompleted) abort.complete();
    }
  }

  @override
  Future<List<Json>> push(PreparedRequest request) async {
    final response = await _request(
      'POST',
      '/api/v1/sync/batch',
      body: request.body,
    );
    return (response['results'] as List)
        .map((r) => Json.from(r as Map))
        .toList();
  }

  @override
  Future<Json> pull(String? cursor) => _request(
    'GET',
    Uri(
      path: '/api/v1/sync/changes',
      queryParameters: {'limit': '100', 'cursor': ?cursor},
    ).toString(),
  );
  void close() {
    _closed = true;
    if (_ownsClient) _client.close();
  }
}

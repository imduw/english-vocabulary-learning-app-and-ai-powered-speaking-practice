import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:flutter_app/src/data/sync/sync_api_client.dart';

const owner = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
void main() {
  test('rejects insecure and credential-bearing origins', () {
    for (final origin in [
      'http://remote.example',
      'https://user:pass@example.com',
      'https://example.com/path',
      'https://example.com?token=secret',
    ]) {
      expect(
        () => SyncApiClient(
          baseUri: Uri.parse(origin),
          owner: owner,
          session: () async => null,
        ),
        throwsArgumentError,
      );
    }
  });
  test('fetches fresh matching credentials per request; account switching never sends another user token', () async {
    var calls = 0, sessionCalls = 0;
    var activeOwner = owner;
    final headers = <String>[];
    final client = MockClient((request) async {
      calls++;
      headers.add(request.headers['authorization']!);
      expect(request.url.path, '/api/v1/sync/batch');
      expect(jsonDecode(request.body), {'items': []});
      return http.Response(
        jsonEncode({
          'status': 'ok',
          'data': {'results': []},
          'error': null,
          'metadata': {},
        }),
        200,
      );
    });
    final api = SyncApiClient(
      baseUri: Uri.parse('https://api.example.com'),
      owner: owner,
      client: client,
      session: () async => AccessSession(
        owner: activeOwner,
        accessToken: 'fixture-${++sessionCalls}',
      ),
    );
    await api.push(PreparedRequest({'items': []}));
    await api.push(PreparedRequest({'items': []}));
    expect(headers, ['Bearer fixture-1', 'Bearer fixture-2']);
    activeOwner = other;
    await expectLater(
      api.push(PreparedRequest({'items': []})),
      throwsA(isA<SyncFailure>().having((e) => e.status, 'status', 401)),
    );
    expect(calls, 2);
    api.close();
    client.close();
  });
  test(
    'typed Retry-After errors do not expose arbitrary upstream messages',
    () async {
      final client = MockClient(
        (_) async => http.Response(
          jsonEncode({
            'error': {'code': 'RATE_LIMITED', 'message': 'private'},
          }),
          429,
          headers: {'retry-after': '120'},
        ),
      );
      final api = SyncApiClient(
        baseUri: Uri.parse('https://api.example.com'),
        owner: owner,
        client: client,
        session: () async =>
            AccessSession(owner: owner, accessToken: 'fixture'),
      );
      await expectLater(
        api.pull(null),
        throwsA(
          isA<SyncFailure>()
              .having(
                (e) => e.retryAfter,
                'retry after',
                const Duration(minutes: 2),
              )
              .having(
                (e) => e.toString().contains('private'),
                'safe error',
                false,
              ),
        ),
      );
      api.close();
      client.close();
    },
  );
  test('malformed success never becomes an ACK and custom clients cannot ignore the deadline', () async {
    var hang = false;
    final client = MockClient((_) async {
      if (hang) {
        return Completer<http.Response>().future;
      }
      return http.Response('[]', 200);
    });
    final api = SyncApiClient(
      baseUri: Uri.parse('https://api.example.com'),
      owner: owner,
      client: client,
      timeout: const Duration(milliseconds: 20),
      session: () async => AccessSession(owner: owner, accessToken: 'fixture'),
    );
    await expectLater(api.pull(null), throwsFormatException);
    hang = true;
    await expectLater(
      api.pull(null),
      throwsA(isA<SyncFailure>().having((e) => e.retryable, 'retryable', true)),
    );
    api.close();
    client.close();
  });
  test('closed API does not resolve credentials or send a request', () async {
    var calls = 0;
    final api = SyncApiClient(
      baseUri: Uri.parse('https://api.example.com'),
      owner: owner,
      session: () async {
        calls++;
        return null;
      },
    );
    api.close();
    await expectLater(api.pull(null), throwsA(isA<SyncFailure>()));
    expect(calls, 0);
  });
}

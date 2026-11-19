import 'dart:math';

import 'package:http_parser/http_parser.dart';

class RetryPolicy {
  RetryPolicy({
    Random? random,
    this.base = const Duration(milliseconds: 500),
    this.maximum = const Duration(seconds: 60),
  }) : random = random ?? Random();
  final Random random;
  final Duration base, maximum;
  Duration delay(int attempt, {Duration? retryAfter}) {
    final cap = min(
      maximum.inMilliseconds,
      base.inMilliseconds * pow(2, min(20, max(0, attempt - 1))),
    ).toInt();
    final jitter = (random.nextDouble() * cap).floor();
    return Duration(milliseconds: max(jitter, retryAfter?.inMilliseconds ?? 0));
  }

  static Duration? parseRetryAfter(String? value, DateTime now) {
    if (value == null) return null;
    final seconds = int.tryParse(value);
    if (seconds != null) return Duration(seconds: max(0, seconds));
    try {
      final difference = parseHttpDate(value).difference(now.toUtc());
      return difference.isNegative ? Duration.zero : difference;
    } on FormatException {
      return null;
    }
  }
}

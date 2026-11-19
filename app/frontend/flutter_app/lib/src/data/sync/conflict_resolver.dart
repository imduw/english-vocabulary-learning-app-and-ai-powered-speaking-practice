import 'dart:convert';

import '../local/app_database.dart';

enum ConflictResolution { mergeDisjoint, serverWins }

/// Server revisions/tombstones decide overlaps. Device wall-clock time never
/// selects a winner. Every losing local intent is archived before cancellation.
class ConflictResolver {
  static ConflictResolution decide(Json mutation, Json? server) {
    if (mutation['action'] != 'update' ||
        server == null ||
        server['deleted_at'] != null ||
        mutation['base_snapshot'] == null) {
      return ConflictResolution.serverWins;
    }
    final base = decodeRecord(mutation['base_snapshot'] as String);
    final payload = decodeRecord(mutation['payload'] as String);
    for (final key in payload.keys) {
      if (jsonEncode(base[key]) != jsonEncode(server[key])) {
        return ConflictResolution.serverWins;
      }
    }
    return ConflictResolution.mergeDisjoint;
  }
}

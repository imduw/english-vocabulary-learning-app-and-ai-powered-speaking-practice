import 'app_database.dart';
import 'platform_database_native.dart'
    if (dart.library.js_interop) 'platform_database_web.dart'
    as platform;

/// Called by the owning Auth/application lifecycle, not by a widget build.
Future<AppDatabase> openLearningDatabase(String owner) =>
    platform.openLearningDatabase(owner);

# CAM-08/09/10 — dữ liệu offline và đồng bộ client

Cập nhật 19/11/2026. Sau khi Cảm yêu cầu làm phần còn thiếu theo issue, đã bổ sung tầng dữ liệu Dart trong `app/frontend/flutter_app/lib/src/data/`. Không thêm màn hình hoặc sửa `lib/main.dart`/widget test mẫu. Đây là phần dữ liệu client mà CAM-08/09/10 yêu cầu; không thay đổi phân công UI của nhóm. Chưa push, tạo PR, có reviewer hoặc đóng issue.

## File bàn giao

| File trong `lib/src/data/` | Trách nhiệm |
| --- | --- |
| `local/app_database.dart` | Database gắn owner, transaction, UUID, metadata và version BIGINT dạng chuỗi |
| `local/migrations.dart` | Schema v1 → v2, khóa ngoại và indexes |
| `local/platform_database*.dart` | SQLite native; SQLite WASM/IndexedDB qua SharedWorker trên Web |
| `repositories/learning_repository.dart` | CRUD/search deck/card, ghi outbox cùng transaction, chuẩn hóa tags, khôi phục bản sao |
| `sync/sync_queue.dart` | FIFO bền vững, batch đã chuẩn bị, ACK, cursor, lease, audit và xử lý queue bị chặn |
| `sync/sync_api_client.dart` | HTTP `/api/v1/sync/batch` và `/sync/changes`, callback lấy access token theo owner |
| `sync/sync_worker.dart` | Push trước pull, tự chạy định kỳ/khi có mạng, dừng phiên và phân loại lỗi |
| `sync/retry_policy.dart` | Exponential backoff, full jitter, Retry-After |
| `sync/conflict_resolver.dart` | So sánh ba phía, merge các field độc lập; server thắng khi sửa trùng/xóa |
| `offline_learning_session.dart` | Điểm tích hợp Auth/lifecycle cho thành viên phụ trách ứng dụng |

SQLite schema v2 có 6 bảng: `records`, `outbox`, `sync_state`, `conflicts`, `prepared_batches`, `sync_leases`. Deck/card dùng JSON theo contract server; khóa ngoại tổng hợp owner/kind/id ngăn card trỏ sang owner khác. Search literal trên chuỗi tổng hợp; indexes phục vụ owner/kind/deleted, parent và FIFO. Không tuyên bố index B-tree tăng tốc mọi truy vấn substring. Metadata `synced_at`, `is_dirty`, `sync_version`, `local_revision` tự cập nhật. Migration v1 → v2 giữ dữ liệu, outbox và cursor; không sửa migration backend 001–007.

## Quy tắc đồng bộ

1. CRUD và mutation CREATE/UPDATE/DELETE được ghi atomically vào SQLite. Mỗi mutation có UUID, timestamp, base version và bản gốc phục vụ phân giải. Xóa deck ẩn cả thẻ con; không tạo/sửa thẻ dưới deck đã xóa.
2. Worker lấy lease owner 30 giây có token kiểm tra trước ghi. Batch lấy FIFO tối đa 100 mutation và 512 KiB UTF-8, lưu nguyên nội dung trong `prepared_batches` trước gửi. Backend nhận JSON tối đa 1 MiB. Mất phản hồi hoặc restart phải gửi lại nguyên batch và operation IDs để receipt chống ghi hai lần.
3. ACK phải đủ IDs, đúng owner/entity/version/timestamp và hợp lệ trước khi cập nhật metadata, xóa queue và xóa batch trong cùng transaction. ACK cũ không ghi đè chỉnh sửa local mới hơn hoặc server shadow mới hơn. Không pull delta vượt qua batch còn chờ ACK.
4. Mỗi trang delta và cursor commit trong cùng transaction. Version không tăng bị bỏ qua; parent/FK không hợp lệ làm rollback cả trang. Tombstone không tự phục hồi thực thể đã xóa.
5. Mất mạng/408/425/429/5xx dùng backoff full jitter 500 ms tăng mũ, trần cơ sở 60 giây; `Retry-After` là thời gian tối thiểu và có thể dài hơn trần. Attempts/thời điểm thử tiếp được lưu cả push và pull. 401/403 dừng để Auth xử lý; validation/constraint không lặp vô hạn. `retryNow()` là hành động chủ động sau khi sửa nguyên nhân.
6. 409 dùng `base_version` CAS và snapshot server: field sửa độc lập được merge rồi tạo operation IDs mới; field sửa trùng hoặc delete-vs-edit dùng phiên bản server đã commit. Đây là server-authoritative version/LWW, **không phải version vector hay so sánh đồng hồ thiết bị**. Bản local và mutation gốc được giữ trong audit trước khi thay thế. Server chỉ log operation ID/entity/reason, không log nội dung hoặc token.
7. `conflicts` giữ snapshot để kiểm tra/khôi phục. `recoverAsCopy()` tạo UUID mới, không hồi sinh tombstone; card cần deck đang hoạt động. Mutation bị chặn có thể `archiveBlocked()` có lease: giữ bản gốc trong audit rồi lấy lại server shadow hoặc tombstone local. Không tự bỏ mutation sai mà không lưu chứng cứ.

## Nối với ứng dụng

Thành viên phụ trách UI/Auth gọi `openLearningDatabase(userId)`, tạo `SyncApiClient` với origin backend và callback trả `AccessSession(owner: userId, accessToken: currentAccessToken)`, rồi tạo `OfflineLearningSession(database: db, api: api)` và gọi `start()`. Màn hình dùng `session.repository`, không gọi SQLite trực tiếp. Có thể truyền stream thông báo có mạng; worker vẫn chạy định kỳ 30 giây và khi app resume.

Đổi tài khoản/đăng xuất phải `await session.close()` trước khi tạo phiên mới. Callback Auth phải trả token hiện tại; client kiểm tra owner trước mỗi request và không lưu token/mật khẩu trong SQLite. Lớp này không tự đăng nhập hoặc tự lưu refresh token. UI mẫu chưa được nối vào lớp mới; chưa có demo luồng giao diện offline hoàn chỉnh. Local cache/queue review events không nằm trong đợt deck/card này; review API phía server giữ nguyên.

Android/iOS/macOS dùng đường dẫn database của sqflite; Windows/Linux dùng application support directory và FFI. Native dùng WAL với SQLite synchronous FULL. Web yêu cầu SharedWorker: nếu trình duyệt không hỗ trợ thì báo unsupported, không fallback sang chế độ thiếu khóa nhiều tab. Kết nối Web thuộc SharedWorker: đóng session chỉ dừng worker/network của phiên, không đóng SQLite dùng chung của các tab. Browser quản lý vòng đời SharedWorker; dữ liệu đã commit nằm trong IndexedDB. Không chạy song song nhiều phiên Auth trong cùng một tab. Owner scope tránh đọc nhầm trong app; không thay thế API/RLS hoặc quyền truy cập thiết bị.

Dependencies đã thêm và khóa trong pubspec.lock: sqflite, sqflite_common, sqflite_common_ffi, sqflite_common_ffi_web, http/http_parser, path/path_provider, unorm_dart. SDK tối thiểu điều chỉnh từ Dart ^3.13.3 thành ^3.13.2 phù hợp Flutter 3.47.2 hiện có. Không thêm Auth SDK hoặc giao diện đăng nhập.

## Chạy lại kiểm tra

Từ `app/frontend/flutter_app`:

```sh
flutter pub get
flutter analyze --no-pub
flutter test --no-pub
dart run tool/benchmark_offline.dart
```

Từ `app/backend`, sau `npm ci --ignore-scripts`:

```sh
docker compose up -d --wait db
npm run test:coverage
node scripts/verify-local.mjs --offline-client
node scripts/setup-offline-web.mjs --test
node scripts/check-offline-web.mjs
```

Lệnh tích hợp dùng Dart native, JWT fixture qua stdin và PostgreSQL local; không dùng credential Supabase thật. Web harness dùng Chrome/Edge headless với profile tạm riêng, hai tab, SQLite WASM thật và dọn profile sau kiểm tra; có thể đặt `CHROME_EXECUTABLE`. Không mở profile trình duyệt cá nhân.

Để chạy ứng dụng Web thật, từ backend chạy `node scripts/setup-offline-web.mjs` **không có `--test`**, rồi từ frontend chạy `flutter run -d chrome --web-port=8080` hoặc `flutter build web`. Tool biên dịch worker từ package đã khóa và tải WASM theo version package; ghi license/SHA manifest vào `web/`. Assets sinh ra được gitignore, phải tạo ở máy mới/CI trước build. Không patch SDK/Pub cache; cách này tránh lỗi đường dẫn Windows của webdev setup. Bật `CORS_ORIGINS=http://localhost:8080` cho backend khi cần gọi API từ Web; dùng chính xác origin đang mở, restart backend sau cập nhật. Mặc định không bật CORS. Production dùng origin HTTPS tường minh. Development Android emulator có thể gọi `http://10.0.2.2:3000` với `allowDevelopmentHttp:true`; cleartext chỉ được cho phép trong manifest debug.

## Bằng chứng và giới hạn

- Flutter analyzer: không lỗi; **28/28 test đạt**, gồm widget test gốc. Kiểm tra SQLite thật bao phủ rollback, migration, FIFO, ACK sai/thiếu, retry sau restart, isolation, lease, tombstone, audit/recovery, batch budget và stop khi request đang chạy.
- `flutter build web --no-pub` đã thành công với worker/WASM được tạo trong web/. Build giao diện mẫu không thay thế kiểm tra module; Web harness phía dưới gọi adapter dữ liệu trực tiếp.
- Backend: **95/95 test đạt**, coverage gate 16 Service/Repository/helper >85% cả bốn metrics; thêm kiểm tra HTTP JSON >100 KiB/413, exact CORS và audit không lộ payload.
- [Dart ↔ HTTP ↔ PostgreSQL](benchmarks/offline-client-http.json): 5 nhóm đạt — lost ACK/restart/replay, hai thiết bị merge độc lập, trùng field giữ bản phục hồi, owner isolation và delete-vs-edit. Kiểm thử tải/reconnect backend cũng đạt sau đợt bổ sung.
- [Web](benchmarks/offline-web.json): 5 nhóm trên trình duyệt thật — queue, hai tab/lease, persistence, owner isolation và migration. Đây là kiểm tra chức năng, chưa phải benchmark hiệu năng Web hoặc chứng nhận mọi trình duyệt. sqflite_common_ffi_web còn experimental.
- [Benchmark Windows](benchmarks/offline-local-crud.json): 5.000 thẻ, 10 warmup + 50 mẫu/thao tác, FFI isolate/WAL/FULL; p95 create **4,630 ms**, read **0,515 ms**, update **4,573 ms**, delete **4,256 ms**, search **4,021 ms**. Số đo máy hiện tại đáp ứng ngưỡng CRUD <10 ms theo p95; không chứng minh mọi lần gọi hoặc mọi thiết bị đều dưới 10 ms. Chưa đo Android/iOS/Web latency.

Code, tests và tài liệu đã có để review CAM-08/09/10. Còn nối UI/Auth của nhóm, đo thiết bị mục tiêu/thống nhất cách nghiệm thu AC <10 ms, chạy GitHub Actions thực tế sau push và PR/reviewer theo DoD. Không dùng test local để tuyên bố đã hoàn thành toàn bộ dự án hoặc tự đóng issue.

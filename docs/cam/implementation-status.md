# Tiến độ của Cảm — cập nhật 20/11/2026

Theo chỉ dẫn mới nhất của Cảm, đã bổ sung tầng dữ liệu Dart theo CAM-08/09/10 cùng backend/database/Auth/API hiện có. Lần gỡ frontend trước đây đã được thay bằng phạm vi mới này: local storage/queue/sync/tests được làm lại, không thêm màn hình hoặc sửa main.dart/widget test mẫu. Chưa push, tạo PR hoặc đóng issue.

| Hạng mục | Backend đã có | Còn lại |
| --- | --- | --- |
| CAM-01/02 | ERD/dictionary 13 bảng/7 migration, tag/FK/index/RLS; 24 ca query p95 <50ms có tag/Unicode | Review phạm vi ERD hiện có/dự kiến, cách đo AC và các bảng nghiệp vụ còn lại |
| CAM-03 | 4 AC kỹ thuật có bằng chứng: health, pool reconnect idle/active, Compose mới healthy, JSON log/global errors | PR/reviewer, chưa đóng issue |
| CAM-04 | OpenAPI 0.9.0-draft, Swagger/Postman, 25 operation có tags/sort/OCR | Review OCR, media/AI contracts và review nhóm |
| CAM-05 | CRUD/tag/search/page/sort/favorite/batch/context; owner/version/RLS; 5.000 thẻ/10.000 links mỗi owner, lọc tag 3,58ms p95 | PR/reviewer/nghiệm thu nhóm; kiểm chứng tải/coverage rộng hơn ở CAM-11 |
| CAM-06 | SM-2 q0–5, API review/summary/history/changes, receipt/replay, timezone/DST; benchmark 4 backend/8 owner/concurrency 48 và integrity đạt | Nhóm review mastery/timezone, CI thực tế và PR/reviewer; [bằng chứng](cam-06-progress.md) |
| CAM-07 | Ba route Auth proxy, bcrypt/salt/rotation/logout thật; registration và email confirmation thật đạt ngày 19/11; JWT/profile/RLS và rate/no-store; [tài liệu](cam-07-auth.md) | Nhóm review provider semantics khác strict invalidation/signed refresh trong issue và PR/reviewer |
| CAM-09/10 phía server | Batch/receipt/delta/tombstone, cursor commit order, version conflict và review feed | Retention/bootstrap snapshot, benchmark, review |
| CAM-08/09/10 client | SQLite/migration/Repository, FIFO transaction, frozen batch/ACK, retry/jitter, conflict merge/audit/recovery; 28 Flutter tests, 5 HTTP checks và 5 Web checks | Nối UI/Auth, đo thiết bị mục tiêu, Actions run và PR/reviewer; [bàn giao](cam-08-10-offline.md) |
| CAM-11 | 95 test; gate >85% cả 4 metrics/từng file Service/Repository/helper; tải 460 request/32 đồng thời; audit 18 FK/13 bảng; workflow và [báo cáo](cam-11-testing.md) | Actions run thực tế/chứng minh CI ổn định, nhóm review/chia sẻ, PR/reviewer và module còn lại |
| CAM-12 | [Runbook](cam-12-operations.md), dictionary/index, 2 Postman environments/body validation; restore riêng khớp 15 bảng/7 migration/RLS; automated onboarding ~20,52s với cache | Người mới thực hiện onboarding ≤15 phút, nhóm duyệt tài liệu/contract, PR/reviewer; Supabase restore/PITR chưa thử |
| CAM-13 #29 | POST /api/v1/ocr/process, native Tesseract/Sharp, JPEG/PNG/WebP, boxes/context/language, limits; HTTP mean 1,89s/6 trang A4, Supabase thật đạt | PR/reviewer/nghiệm thu; [phạm vi và bằng chứng](cam-13-ocr.md) |

Cả 13 issue CAM-01 đến CAM-13 (#17–#29) vẫn open/assigned CAMLC25 ở lần đối chiếu. CAM-08/09/10 nay có code cả phần dữ liệu client và server theo phạm vi được yêu cầu, không tự chuyển assignee hoặc sửa AC. PR/review và các giới hạn nghiệm thu vẫn còn trong [checklist theo issue](issue-checklist.md).

CAM-07 #23 đã có đủ ba route register/login/refresh tại NestJS theo lựa chọn Supabase proxy của Cảm; không tự lưu mật khẩu hoặc cấp refresh riêng. Kiểm thử provider thật xác nhận parent retry vẫn hợp lệ và logout không thu hồi access JWT tức thì; khác strict invalidation/signed refresh trong issue, cần nhóm review. CAM-11 #27 đã đo coverage và có workflow; chưa chứng minh CI ổn định trên GitHub. CAM-13 #29 đã triển khai backend; còn PR/review theo Definition of Done.

## Kiểm chứng

- Kiểm tra trước push ngày 20/11: backend 95/95 và coverage gate đạt; Flutter analyzer không lỗi/28 test đạt; tích hợp PostgreSQL + Dart offline và Web hai tab đạt lại. Đã sửa ignore nhầm .env.supabase.example. Xem [hồ sơ chuẩn bị commit/review](pre-push-review.md); chưa push, tạo PR hoặc đóng issue.

- CAM-07 registration thật: 8 bước đạt qua backend tạm, mailbox do Cảm cung cấp; trước confirmation login 401, sau xác nhận login/profile/refresh thành công, phiên script đã đóng. Không dùng token trong URL của người dùng, không sửa settings; tài khoản/profile giữ lại. [Báo cáo](benchmarks/auth-supabase-registration.json).
- CAM-06 `npm.cmd run benchmark:progress`: 4 backend/8 owner/40 cards/4 timezone, 256 review requests ở concurrency 48, 128 event duy nhất; sau late events/burst có đúng 137 event/identity/sequence. Tổng 369 request được đo, burst có 32 HTTP 503 chủ động và retry cùng ID an toàn. [Báo cáo](benchmarks/progress-multiprocess.json). Rà lại progress/contract: 17/17 test đạt; chưa chạy Actions.

- `npm.cmd run test:supabase:sessions`: proxy localhost:3001 login A/B, bcrypt/salt aggregate read-only, refresh/parent retry, JWT mới đọc profile, local logout chặn refresh A nhưng không ảnh hưởng B; hai phiên thử đã đóng. Không register/gửi email hoặc sửa settings. Xem [báo cáo](benchmarks/auth-supabase-sessions.json).

- `npm.cmd run test:coverage`: **95/95 test đạt**, gồm các ca trước và fault/cleanup/recovery DB/OCR/profile/sync. Giữ ma trận 338 cặp ILIKE; chạy files tuần tự để tránh PGlite OOM. Gate 16 file >85% cả lines/statements/functions/branches: Service/helper lines 100%, branches 93,06%; Repository lines 100%, branches 94,06%. Xem [CAM-11](cam-11-testing.md).
- Lịch sử trước tag: benchmark gốc và --mixed-text đều exit 0, 16/16 ca query p95 <50ms; dữ liệu/JSON cũ được giữ để đối chiếu. Không coi số đo cũ là phép chạy lại code sau migration 007. Xem [phương pháp/EXPLAIN](database-benchmark.md).
- `node scripts/benchmark-postgres.mjs --mixed-text --with-tags`: **exit 0 sau migration 007**, 24/24 ca query p95 <50ms, cao nhất 39,58ms. Mỗi owner thêm 105 tags/10.000 links; lọc tag 3,58ms, q theo tag 12,38ms, phân trang tag sâu 8,44ms, word DESC offset4500 25,87ms. EXPLAIN dùng index tag/sort mới; rollback fixture đã xác nhận.
- OpenAPI/example/schema/Postman được kiểm tra trong bộ test backend; 25 operation hợp lệ, bản 0.9.0-draft.
- OCR native qua HTTP/JWT thật đạt 8 nhóm functional checks; 6 mẫu A4 360/393 từ có mean 1.890,65ms, token accuracy 1,0 trên riêng fixture này. Backend Docker Supabase 3001 healthy; kiểm thử login/profile/OCR formats/box/context đạt, phiên thử đã đóng. Xem [CAM-13](cam-13-ocr.md) và JSON benchmark. Unit OCR dùng fake recognizer không thay thế kiểm thử engine thật.
- `npm.cmd run test:postgres`: **hai lần liên tiếp exit 0 sau bổ sung tải CAM-11**, mỗi lần 460 request/max 32 đang chờ HTTP, không lost update/duplicate receipt/event hoặc deadlock được phát hiện; audit 18 FK/13 bảng không orphan/index invalid. Giữ các ca tag/snapshot/rollback/RLS/cursor và mất kết nối thật. Backend tạm đã dừng, DB local giữ nguyên.
- `npm.cmd run test:supabase`: **exit 0 với tag/sort sau migration 007**, gồm ca nhãn mới và delta/receipt giữ tag theo version, Auth A/B, refresh, owner/version/RLS, CRUD/progress/sync. Fixture soft-delete, profile A khôi phục nội dung, hai phiên thử đã đóng; không in credential/token.
- Flutter: 28/28 test đạt và analyzer không lỗi. Có dependency SQLite/HTTP và manifest debug cho dữ liệu client; main.dart/widget test mẫu không đổi. Native benchmark CRUD p95 <5 ms trên Windows/5.000 thẻ; chưa đo Android/iOS. Xem [báo cáo và giới hạn](cam-08-10-offline.md).
- Compose đã rebuild với OCR native/spec 0.9.0-draft và migration exit 0. Health/liveness/Swagger/OpenAPI đều HTTP 200 tại localhost:3000; spec có tag/sort/order và update tags không có default []. Giữ nguyên volume.
- `node scripts/verify-local.mjs --offline-client` nay có tùy chọn chạy Dart SQLite ↔ HTTP ↔ PostgreSQL thật: 5 nhóm đạt. Không truyền token bằng argv hoặc lưu trong report; tùy chọn mặc định vẫn chỉ chạy backend.
- CAM-12: `npm.cmd run test:backup` đạt, archive/manifest ignored, restore vào container riêng rồi so đủ 15 bảng/18 FK/13 FORCE RLS và quyền runtime A/B; nguồn giữ nguyên. `test:onboarding` đạt 20,52s với cache và database/volume mới, project thử đã dọn. `api:validate` 4/4 đạt, kiểm tra cả body Postman/environment và sửa tags sai cấp ở ví dụ batch. Xem [runbook và giới hạn](cam-12-operations.md).
- Migrations 001–007 đã áp dụng trên local/Supabase development. Không sửa/xóa migration đã áp dụng. Registry/tag links được cập nhật qua card triggers, version card bao gồm thay đổi nhãn; xem [CAM-05 tags](cam-05-tags.md).

## Tiếp theo trong phạm vi backend

Tag/sort, OCR, coverage/load/checker CAM-11 và runbook/drill CAM-12 đã có bằng chứng kỹ thuật. Cần người mới thử onboarding, nhóm review tài liệu/contract, theo dõi Actions run sau push và xử lý các mục Auth/client/schema còn thiếu trong checklist. Tách PR theo tính năng, có reviewer theo Definition of Done rồi mới đóng issue.

Xem [hợp đồng API](api-contract.md), [CRUD](cam-05-crud.md), [tiến độ học](cam-06-progress.md), [đồng bộ phía server](cam-09-10-sync.md) và [Supabase](supabase-connection.md).

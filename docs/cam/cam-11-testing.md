# CAM-11 — Kiểm thử backend, coverage và tính nhất quán

Cập nhật 19/11/2026, đối chiếu [issue #27](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/27). Báo cáo này đo backend/API; kiểm tra tầng dữ liệu Dart bổ sung nằm ở [CAM-08/09/10](cam-08-10-offline.md). Chưa push/PR, chưa có lần chạy GitHub Actions để chứng nhận CI ổn định.

## Chạy kiểm tra

Từ app/backend, với Node.js 22 hoặc 24:

```powershell
npm.cmd ci --ignore-scripts
npm.cmd run test:coverage
docker compose up -d --wait db
npm.cmd run test:postgres
node scripts/check-consistency.mjs --local
```

Coverage/unit tests không đọc .env hoặc kết nối Supabase. Test PostgreSQL chỉ dùng database Compose cố định, kiểm tra auth.users là fixture local trước khi seed; tuyệt đối không bootstrap/seed Supabase. Các fixture mới được soft-delete, còn audit/tombstone để kiểm chứng retry. Script đóng backend/JWKS/pool tạm, không xóa volume.

Kiểm chứng OCR native thật riêng bằng `docker compose exec -T backend node scripts/check-ocr-http.mjs`; xem [CAM-13](cam-13-ocr.md). Không dùng thời gian chạy có coverage làm benchmark hiệu năng OCR.

## Coverage trên TypeScript

Bộ **95/95 test đạt**. c8 9.1.0 dùng V8 và source maps để quy coverage từ dist về src TypeScript, gồm tất cả file src kể cả file chưa được chạy. Không dùng ignore pragma để nâng số đo. [Gate](../../app/backend/scripts/check-coverage.mjs) tự duyệt source và yêu cầu **từng file Service/Repository >85% ở cả lines, statements, functions và branches**; có cả engine/adapters/helpers OCR và thuật toán SM-2, không chỉ file mang tên .service.

| Tầng | Lines / statements | Functions | Branches |
| --- | --- | --- | --- |
| Service và helper được gate | 100% | 98,68% | 93,06% |
| Repository | 100% | 100% | 94,06% |

[JSON kết quả](benchmarks/backend-coverage.json) có danh sách 16 file, metrics và SHA-256 source. Tổng toàn src: 98,31% lines/statements, 97,31% functions, 93,53% branches. Đây là độ bao phủ thực thi, không bảo đảm mọi tình huống nghiệp vụ đều đúng. Raw lcov/JSON nằm trong app/backend/coverage (ignored), CI xuất artifact.

Các ca bổ sung kiểm tra: pool connect/role không an toàn/commit/rollback/socket lỗi; không log chi tiết driver; profile bị xóa hoặc Auth user không còn; sync gặp constraint không query tiếp transaction đã abort; native OCR timeout/kill/output giới hạn/cleanup; WASM OCR thật, worker lỗi và khởi tạo lại. Native subprocess doubles chỉ chứng minh giao thức/lifecycle/error handling; độ chính xác native dùng bằng chứng engine thật của CAM-13.

## Tải đồng thời và ACID

`test:postgres` giữ các ca CRUD/sync/progress/RLS, transaction rollback và cắt kết nối thật, đồng thời gọi [bài tải HTTP](../../app/backend/scripts/check-concurrent-load.mjs). [Báo cáo](benchmarks/backend-load.json) ghi 460 request, tối đa 32 request đang chờ HTTP, hai owner và một API process:

- 64 PUT cùng base_version: đúng 1 response 200, 63 response 409, version cuối tăng đúng một lần.
- 63 cập nhật riêng xen kẽ 128 lượt đọc: mọi cập nhật giữ lại, không lẫn owner, version cuối đúng.
- 64 review mỗi cái gửi hai lần: 128 request trả 200 nhưng chỉ có 64 event/state, mỗi state total_reviews=1.
- 64 lần gửi lại sync mutation: đúng một receipt và một thẻ version=1 cho mỗi owner.

Không có HTTP lỗi ngoài các 409 dự kiến; delta pg_stat_database.deadlocks=0 trong lần đo. Đây là burst có giới hạn trên máy local, không phải công suất production, nhiều process/replica hoặc bằng chứng không bao giờ có deadlock. Các ca rollback/write bị cắt giữ nguyên dữ liệu/version; đây là bằng chứng ranh giới giao dịch ở PostgreSQL đang chạy, chưa mô phỏng mất điện/fsync hoặc disaster recovery.

## Kiểm tra database

[Checker](../../app/backend/scripts/check-consistency.mjs) duyệt catalog, kiểm tra 18 FK đã validate trên đủ 13 bảng app; không có orphan, không có index invalid/unready, FORCE RLS bật đủ 13 bảng. Tên bảng/cột lấy từ catalog và quote identifier; không nhận SQL từ request.

Một mục cần review index là FK source_documents(user_id,media_id,media_kind): không có index phủ đủ cả ba cột. Bảng đã có UNIQUE(user_id,media_id), nên tra hai cột này trả tối đa một row để lọc media_kind; CHECK cũng giới hạn media_kind=image. Chưa có workload lưu nguồn OCR và không có lý do đo được để thêm index ba cột trùng chức năng. Giữ finding trong báo cáo cho reviewer, không khẳng định mọi FK phải có index riêng. Xem [dictionary](database-core.md) và [EXPLAIN/benchmark hiện có](database-benchmark.md).

## CI và nghiệm thu

[Workflow backend](../../.github/workflows/backend-ci.yml) chạy trên push feature/fix/develop/main, pull_request có thay đổi backend/contracts/workflow và workflow_dispatch. Node 22, npm ci theo lock, coverage gate; PostgreSQL thật và lặp toàn bộ integration hai lần, không tự retry để che failure; build production Docker và kiểm thử OCR native thật. Workflow dùng quyền contents:read, không cần secret Supabase; giữ coverage/load/OCR artifact 14 ngày và dừng Compose kể cả khi lỗi.

YAML đã parse local. Các lệnh test được chạy local; **chưa có Actions run URL** vì thay đổi chưa push. Hai lần local đạt cũng không chứng minh CI không flaky: cần push nhánh, tạo PR, theo dõi nhiều run thực tế và xử lý failure trước khi đánh dấu AC này.

Auth/JWT expiry/issuer/role/owner/tampering đã có trong tests; Supabase login/refresh thật có bằng chứng riêng ở [Supabase](supabase-connection.md). CI dùng khóa ES256/JWKS fixture bỏ sau test, không gọi Supabase thật hoặc kiểm thử email/refresh reuse toàn diện. Những khác biệt Auth và nghiệm thu/tích hợp lớp dữ liệu CAM-08/09/10 vẫn cần giải quyết theo [checklist](issue-checklist.md).

Báo cáo này đã sẵn sàng để nhóm review trong repository; chưa gửi tin nhắn cho đội hoặc tự phê duyệt. CAM-11 còn bằng chứng CI thực tế, chia sẻ/nghiệm thu nhóm và PR/reviewer trước khi đóng issue.

Nguồn kỹ thuật: [c8 source maps/all-files](https://github.com/bcoe/c8), [GitHub Node CI](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs), [setup-node](https://github.com/actions/setup-node), [upload-artifact](https://github.com/actions/upload-artifact).

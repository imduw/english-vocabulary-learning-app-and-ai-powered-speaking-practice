# Backend — NestJS và PostgreSQL

Supabase development đã kết nối tại .env.supabase.local, Backend Docker riêng cổng 3001, OCR native. Đã có JWT/profile và CRUD bộ thẻ/từ vựng, kiểm thử A/B và race trên Supabase thật đạt. Xem [Supabase](../../docs/cam/supabase-connection.md) và [CAM-05](../../docs/cam/cam-05-crud.md).

## Trạng thái

Đã có nền tảng CAM-03, bảy migration, JWT guard, API hồ sơ, decks/vocabulary/tag/sort, sync và progress. Hợp đồng đồng bộ ở [CAM-09/10](../../docs/cam/cam-09-10-sync.md); API tiến độ/SM-2 ở [CAM-06](../../docs/cam/cam-06-progress.md), nhãn/sắp xếp ở [CAM-05 tags](../../docs/cam/cam-05-tags.md). Test Supabase thật dùng file riêng. Tầng dữ liệu Dart CAM-08/09/10 đã được bổ sung theo chỉ dẫn mới; UI giữ nguyên. Xem [bàn giao offline](../../docs/cam/cam-08-10-offline.md).

- NestJS/TypeScript, connection pool pg, kiểm tra biến môi trường trước khởi động.
- `GET /health`: truy vấn DB thành công trả 200, DB không truy cập được trả 503.
- `GET /health/live`: kiểm tra HTTP, độc lập với DB.
- JSON log theo request ID; không ghi body, header, URL query hay connection string; global error handler lọc thông tin nội bộ.
- Migration SQL có lịch sử/checksum, transaction và khóa chống hai runner cùng chạy.
- 13 bảng: profiles, decks, media_assets, source_documents, cards, tags, card_tags, sync_heads, sync_changes, sync_receipts, review_events, review_states, review_heads. RLS theo owner; media chưa mở.
- Swagger ở /docs/, OpenAPI ở /openapi.json, Postman trong api/. 25 operation có tag/sort/OCR; contract 0.9.0-draft chờ review nhóm.

CAM-03 đã bổ sung kiểm thử mất kết nối idle và giữa transaction trong `npm.cmd run test:postgres`: health 200→503→200, rollback nội dung/version và giữ RLS sau reconnect. Đã sửa lỗi socket của client đang checkout có thể làm Node thoát. Compose cũng đã build/chạy lại với bản sửa, DB/Backend healthy và migration exit 0. Xem [checklist nghiệm thu](../../docs/cam/issue-checklist.md); issue còn chờ PR/reviewer.

## 1. Chạy kiểm thử ngay, không cần Docker/Supabase

Người mới bắt đầu tại [CAM-12 onboarding](../../docs/cam/cam-12-operations.md): `docker compose up --build -d --wait backend`, kiểm tra health/docs rồi import [Postman local](api/postman.local.environment.json) hoặc [Supabase dev](api/postman.supabase-dev.environment.json). Có [troubleshooting](../../docs/cam/troubleshooting.md), [env/deploy](../../docs/cam/backend-deployment.md) và [backup/restore](../../docs/cam/backup-restore.md). Automated onboarding dùng DB/volume mới đạt ~20,52s khi cache có sẵn; chưa phải số đo người mới/cold download.

Yêu cầu Node.js 22 hoặc 24 và npm. PowerShell dùng `npm.cmd` nếu execution policy chặn `npm.ps1`.

`npm.cmd test` chạy từng file test tuần tự để tránh nhiều PGlite/WASM instance làm máy phát triển hết bộ nhớ. Giữ nguyên toàn bộ assertions; đổi này chỉ giới hạn test concurrency.

```powershell
cd app/backend
npm.cmd ci
npm.cmd test
```

Test build TypeScript, chạy Nest HTTP trên cổng tạm thời và SQL trên PostgreSQL nhúng PGlite trong bộ nhớ. Không đọc `.env` hoặc truy cập Supabase. HTTP test mô phỏng dependency DB; SQL test thực thi migration và constraint thật trong engine nhúng.

PGlite không kiểm chứng TCP, TLS, Supabase Auth, Docker hoặc tải nhiều connection. Package-lock cố định phiên bản cài đặt.

Kiểm tra riêng contract: `npm.cmd run api:validate`. Xem [hợp đồng CAM-04](../../docs/cam/api-contract.md) trước khi dùng ví dụ cho Flutter.

## 2. Chạy Backend + Postgres local bằng Docker

Mở Docker Desktop và đợi engine sẵn sàng. Từ `app/backend`:

```powershell
docker compose up --build -d
docker compose ps
Invoke-RestMethod http://localhost:3000/health
```

Compose khởi tạo Postgres → chạy migration → chạy Backend. Response thành công:

```json
{"status":"ok","data":{"database":"up"},"error":null,"metadata":{}}
```

DB publish trên `127.0.0.1:54329`, API trên `127.0.0.1:3000`. Mật khẩu Compose chỉ dành cho local. Migration 002 cấp nhóm quyền profile cho cam_backend; guard vẫn yêu cầu Auth được cấu hình. Role migration là tài khoản quản trị riêng. Volume cam_pgdata giữ dữ liệu khi dừng container; không xóa volume để sửa lỗi nếu có dữ liệu cần giữ.

Bootstrap local chỉ tạo bảng giả `auth.users(id)` để kiểm tra FK. Đây **không phải Supabase Auth**, không đăng nhập/cấp token. Không chạy `database/local/bootstrap.sql` hoặc `seed.sql` trên Supabase thật.

Lần chạy lại ngày 15/11 đã build image và khởi động toàn bộ Compose thành công: DB/Backend healthy, migration exit 0, health và Swagger trả 200. Lỗi thiếu bộ nhớ ở lần trước không tái diễn; không cần sửa Dockerfile. Nếu máy gặp lại lỗi thiếu bộ nhớ, có thể dùng phương án NestJS trên máy ở mục 3.

## 3. Chạy NestJS trên máy, Postgres trong Docker

```powershell
docker compose up -d db
# Chỉ tạo .env lần đầu, giữ cấu hình riêng nếu file đã tồn tại.
Copy-Item .env.example .env
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run build
npm.cmd start
```

Không chạy container backend và `npm start` cùng cổng 3000. Seed chỉ cho phép NODE_ENV=development, host local, DB vocabulary, user cam_migrator. Có 2 danh tính hư cấu, 2 bộ và 2 thẻ “bank” khác nghĩa; chạy lại không nhân đôi. Chúng không phải tài khoản đăng nhập.

`npm.cmd run start:dev` build và chạy một lần, chưa watch/reload. Khi sửa code, dừng và chạy lại.

Sau khi DB local đã chạy, dùng `npm.cmd run test:postgres` để kiểm tra migration/chạy lại, seed, FK owner, Backend thật và Swagger qua TCP. Script chỉ dùng database Compose local cố định, không đọc `.env`, tạo process Backend tạm rồi dừng khi xong. Nó giữ database/seed để bạn dùng tiếp, không xóa volume.

Để xem tài liệu sau `npm.cmd start`, mở `http://localhost:3000/docs/`. Có thể import `api/postman.collection.json`; access_token mặc định để trống. Đừng chạy toàn bộ collection trên dữ liệu dùng chung: các request nghiệp vụ chỉ là bản nháp và chứa ví dụ thao tác ghi/xóa.

## 4. Kết nối Supabase

Môi trường Supabase development dùng .env.supabase.local riêng. Các biến cấu hình:

| Biến | Ý nghĩa |
| --- | --- |
| DATABASE_URL | Runtime bằng role hạn chế quyền, không dùng credential migration |
| MIGRATION_DATABASE_URL | Role tạo schema/bảng/trigger và tham chiếu auth.users; nên dùng direct/session connection |
| DATABASE_SSL | true trên server từ xa, có xác minh certificate |
| DATABASE_CA_FILE | File CA riêng cho DB; hiện dùng ./supabase-ca.local.crt |
| SUPABASE_URL | Project origin, dùng suy ra issuer và JWKS |
| SUPABASE_PUBLISHABLE_KEY | Auth proxy register/login/refresh và test thật; JWT verifier riêng không cần key này |
| DATABASE_POOL_MAX | 1–20, mặc định 5 |
| DATABASE_TIMEOUT_MS | 1–30000, mặc định 3000 ms cho connection/query/statement |
| PORT | 1–65535, mặc định 3000 |
| NODE_EXTRA_CA_CERTS | File CA tin cậy nếu môi trường yêu cầu; không tắt xác minh TLS |

Không đặt tham số SSL trong URL; dùng DATABASE_SSL và DATABASE_CA_FILE. Migration yêu cầu auth.users và role đủ quyền. Schema app không mở cho Data API; profile có policy riêng cho runtime role, các module khác cần owner-aware Repository/policy khi triển khai.

`npm.cmd run test:supabase` build và kiểm thử đăng nhập A/B thật trong development, dùng TEST_A_EMAIL/TEST_A_PASSWORD và TEST_B_EMAIL/TEST_B_PASSWORD ở file riêng. Test sửa rồi khôi phục nội dung profile A (version/updated_at vẫn tăng), giữ hồ sơ được tạo và đóng các phiên thử. Lần chạy 16/11 đạt exit 0; không in token hoặc mật khẩu.

## Auth proxy — CAM-07

Đã thêm POST /api/v1/auth/register, /login, /refresh theo lựa chọn Supabase Auth của Cảm. Ba route public có whitelist/giới hạn, no-store, rate limit và xác minh JWT trả về. Runtime cần publishable key; không lưu/băm mật khẩu hoặc cấp refresh token riêng trong app DB. `npm.cmd run test:supabase:sessions` kiểm tra proxy thật, bcrypt/salt aggregate, rotation/parent exception và logout từng phiên thử; không register/gửi email. Xem [CAM-07 và phần review còn lại](../../docs/cam/cam-07-auth.md).

Ngày 19/11 đã có thêm registration/email confirmation thật: begin gửi một signup tới mailbox được chủ sở hữu cung cấp, complete sau khi người dùng xác nhận kiểm tra login/profile/refresh và đóng phiên script. Lệnh hai bước và giới hạn SMTP ở tài liệu CAM-07; không chạy tự động trong CI, không dùng example.com làm bằng chứng email delivery.

`npm.cmd run benchmark:progress` kiểm tra CAM-06 với 4 backend thật/8 tài khoản/48 request đồng thời trên PostgreSQL local, đối chiếu lịch ôn với SM-2 fixtures, mastery/owner/history, late events và backpressure/retry. Báo cáo tại docs/cam/benchmarks/progress-multiprocess.json; workflow backend CI đã thêm lệnh, chưa có run GitHub. Xem [CAM-06](../../docs/cam/cam-06-progress.md).

## OCR — CAM-13

POST /api/v1/ocr/process nhận multipart image, Bearer JWT, JPEG/PNG/WebP ≤10 MiB; trả text, word boxes trên ảnh gốc đã auto-orient, câu ngữ cảnh, confidence và ngôn ngữ. Không lưu ảnh hoặc tạo DB record. Có validation, quota 10 lần/60 giây/owner/process và một OCR đang xử lý/process.

Docker cài native Tesseract, Sharp preprocess, model eng/vie fast đóng gói/hash/license; không tải model khi gọi API. Node trực tiếp mặc định OCR_ENGINE=wasm; OCR_WARMUP=true. Benchmark native đạt mean 1,89 giây/trang trên 6 mẫu A4 360/393 từ, không suy rộng thành SLA Windows/WAN.

```powershell
# Backend Supabase 3001, dùng runtime URL/CA trong file ignored
docker compose --env-file .env.supabase.local -f compose.supabase.yaml -p vocabulary-supabase up --build -d
# Functional + benchmark engine thật, dùng container local 3000
docker compose exec -T backend node scripts/check-ocr-http.mjs --benchmark --output /tmp/ocr-native.json
# Kiểm chứng backend Supabase đang chạy và tự đóng phiên thử
node --env-file=.env.supabase.local scripts/verify-supabase-ocr.mjs
```

Unit suite hiện đạt 95/95; engine thực được kiểm tra riêng, không lấy fake recognizer làm bằng chứng accuracy. Xem [CAM-13 và giới hạn số đo](../../docs/cam/cam-13-ocr.md). Không khởi động backend Node khác trên cùng cổng 3001.

## Coverage và CI — CAM-11

`npm.cmd run test:coverage` build source maps và dùng c8 đo TypeScript, tự kiểm tra từng file Service/Repository/helper OCR/SM-2 >85% ở lines/statements/functions/branches. Báo cáo raw ở coverage/ (ignored), JSON tóm tắt trong docs/cam/benchmarks. Hiện 95 test đạt; Service/helper lines 100%, Repository 100%.

`npm.cmd run test:postgres` có thêm 460 request tải HTTP, tối đa 32 đồng thời; kiểm tra lost update, review/receipt trùng và database consistency. `node scripts/check-consistency.mjs --local` chạy riêng audit local. Workflow .github/workflows/backend-ci.yml chạy coverage, PostgreSQL integration hai lần và OCR native; chưa có bằng chứng Actions thực tế trước khi push. Xem [CAM-11](../../docs/cam/cam-11-testing.md), gồm giới hạn tải và finding index cần review.

## 5. Cấu trúc và migration

src/common xử lý HTTP; src/database quản lý pool/transaction theo owner; src/health có controller/service; src/auth xác minh JWT; src/profiles quản lý hồ sơ; src/learning có CRUD; src/sync và src/progress có API đồng bộ/ôn tập; src/ocr xử lý multipart/preprocess/engine/context/limits; src/config.ts kiểm tra env.

`database/migrations` chứa SQL bất biến sau khi áp dụng; `database/local` chỉ cho demo/test. `scripts` chạy migration/seed; `test` chứa HTTP/config/schema tests.

Sau khi migration được dùng ở môi trường chia sẻ, thêm file `002_...sql` thay vì sửa file cũ. Runner từ chối checksum thay đổi, file lịch sử bị mất hoặc chèn migration vào giữa lịch sử. Tất cả migration mới chạy trong một transaction, lỗi rollback cả SQL và ledger. Chưa hỗ trợ lệnh không transactional như CREATE INDEX CONCURRENTLY, tự động rollback phiên bản hoặc schema reset.

## 6. Kết quả và tài liệu

`npm.cmd run test:backup` tạo logical archive của DB Compose và restore vào container riêng, so đủ 15 bảng/ledger/18 FK/13 FORCE RLS, kiểm tra runtime owner A/B rồi dọn container thử. Archive/manifest ở backups/ bị Git/Docker bỏ qua, không ghi vào Supabase. `npm.cmd run test:onboarding` dựng project/DB/volume mới với port ngẫu nhiên, đo build/migrate/health/docs/401 và tự dọn đúng project. [CAM-12](../../docs/cam/cam-12-operations.md) có lệnh, bằng chứng và phần nghiệm thu còn lại.

`npm.cmd run benchmark:postgres -- --mixed-text --with-tags` đo SQL Repository/Service trên Compose: 2 owner, mỗi owner 5.000 thẻ/50.000 reviews/105 tags/10.000 links, 20% nghĩa Unicode, role chịu RLS, 40 mẫu sau warm-up, rollback fixture. **24/24 ca query p95 <50ms**, cao nhất 39,58ms; lọc tag 3,58ms, q tên tag 12,38ms, word DESC offset4500 25,87ms. Không đọc .env/Supabase; exit 1 nếu có ca vượt ngưỡng. Xem [phương pháp/giới hạn và số đo trước tag](../../docs/cam/database-benchmark.md), không coi đây là HTTP/production latency. `node scripts/probe-search.mjs` sau build đối chiếu ILIKE gốc/nhánh ASCII trên cùng fixture.

Xem [tiến độ](../../docs/cam/implementation-status.md) và [từ điển schema](../../docs/cam/database-core.md). Backend đã kiểm chứng PostgreSQL local/Supabase thật; còn review, schema/module bổ sung và các kiểm tra nêu trong tiến độ trước khi đóng issue.

Tài liệu đã đối chiếu: [NestJS](https://docs.nestjs.com/first-steps), [pg pooling](https://node-postgres.com/features/pooling), [pg SSL](https://node-postgres.com/features/ssl), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [PGlite](https://pglite.dev/docs/).


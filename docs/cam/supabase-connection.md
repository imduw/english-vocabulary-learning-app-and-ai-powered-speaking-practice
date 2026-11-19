# Supabase development — Backend của Cảm

Ngày cập nhật: 18/11/2026. Project URL: https://ypkprcqplopqzifjlifh.supabase.co. Không ghi credential/token trong tài liệu.

## Kết nối và phân quyền

- NestJS trong Docker riêng vocabulary-supabase ở cổng 3001 kết nối Session pooler qua TLS, xác minh CA/hostname; OCR dùng native Tesseract. Docker cổng 3000 là PostgreSQL local riêng.
- Runtime role vocabulary_backend kế thừa vocabulary_api, không superuser/BYPASSRLS/CREATEROLE/CREATEDB. Migration dùng credential quản trị riêng.
- Migrations 001–007 đã áp dụng: 13 bảng schema app, FORCE RLS, gồm tags/card_tags và snapshot cards.tags. API lấy owner từ JWT đã xác minh rồi đặt identity transaction-local; không tin user_id trong body và không để identity rò sang request khác.
- JWT ES256/RS256 được xác minh issuer/audience/expiry/role/sub qua JWKS. Không hỗ trợ legacy HS256; xác minh offline không kiểm tra thu hồi access token tức thời.
- Profiles/decks/cards có owner policies; review/sync tables có policy và quyền riêng. Media chưa mở API. Schema app không mở trực tiếp cho client Data API.

## Cấu hình local

`app/backend/.env.supabase.local` bị Git bỏ qua: DATABASE_URL cho runtime, MIGRATION_DATABASE_URL cho migration, SUPABASE_URL, DATABASE_SSL=true, DATABASE_CA_FILE=./supabase-ca.local.crt và PORT=3001. SUPABASE_PUBLISHABLE_KEY dùng cho Auth proxy runtime và kiểm thử; TEST_A_EMAIL/TEST_A_PASSWORD/TEST_B_EMAIL/TEST_B_PASSWORD chỉ dùng cho kiểm thử Auth thật; không đưa vào API examples hoặc Git.

CA công khai: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt. SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`. File local được ignore trong Git/Docker build. Giữ xác minh TLS; pg_stat_ssl ở DB chỉ mô tả pooler→DB, checker kiểm tra socket TLS của Node→pooler.

## Lệnh từ app/backend

```powershell
npm.cmd run supabase:check
node --env-file=.env.supabase.local scripts/migrate.mjs
node --env-file=.env.supabase.local scripts/setup-supabase-runtime.mjs
docker compose --env-file .env.supabase.local -f compose.supabase.yaml -p vocabulary-supabase up --build -d
docker compose --env-file .env.supabase.local -f compose.supabase.yaml -p vocabulary-supabase ps
npm.cmd run test:supabase
```

Compose này không chạy migration tự động, chỉ nhận runtime URL/config và mount CA read-only, không truyền migration credential hoặc test keys vào container. Nếu chọn Node trên máy thay Docker, build rồi dùng node --env-file=.env.supabase.local dist/src/main.js; cổng 3001 phải trống, OCR mặc định WASM chưa đạt benchmark native. Không dừng Compose local 3000 khi quản lý project vocabulary-supabase.

Checker chỉ đọc. Migration đối chiếu checksum và chỉ chạy file mới; setup runtime chạy lại giữ credential hiện có. Không chạy bootstrap/seed local trên Supabase. Không xóa/sửa migration đã áp dụng để gỡ phần ứng dụng client.

## Auth proxy tại cổng 3001

Ba POST /api/v1/auth/register, /login và /refresh đã có theo lựa chọn của Cảm. Runtime nhận publishable key, không nhận mật khẩu test hoặc migration URL. Test sessions đã đạt login/rotation/parent retry/logout isolation và bcrypt/salt aggregate. Ngày 19/11 thêm registration qua backend tạm và email confirmation thật với mailbox do Cảm cung cấp; login/profile/refresh sau xác nhận đạt, phiên script đã đóng. Xem [CAM-07](cam-07-auth.md), [sessions](benchmarks/auth-supabase-sessions.json) và [registration](benchmarks/auth-supabase-registration.json). Còn nhóm review parent/reuse exception và PR/reviewer.

## OCR trên backend Supabase đang chạy

`node --env-file=.env.supabase.local scripts/verify-supabase-ocr.mjs` đã đạt login thật, GET profile đúng owner/DB runtime, JPEG/PNG/WebP và box/câu trên ảnh gốc. Phiên thử đã đóng, không PATCH profile hoặc lưu ảnh/thẻ; GET profile có thể provision nếu chưa có. [Báo cáo](benchmarks/ocr-supabase.json) không chứa token/ID. Xem [CAM-13](cam-13-ocr.md) để chạy benchmark native; hiệu năng đó đo loopback HTTP, không phải WAN Supabase.

## Kiểm thử backend thật

Script verify-supabase-auth.mjs dùng publishable key đăng nhập hai tài khoản development và dựng Backend tạm. Không cần SDK Flutter, Dart hoặc emulator.

| Phạm vi | Kiểm tra |
| --- | --- |
| Auth/profile | A/B khác danh tính, thiếu token 401, JWT tampering bị chặn, owner injection 422, version 409, timezone validation |
| Database | RLS tự chặn truy cập chéo; rollback/pool không giữ identity; TLS runtime |
| CRUD | Tag create/filter/search/replace/clear, sort, page/favorite, Unicode/literal % _ backslash, owner isolation, batch atomic, optimistic concurrency và delete-parent race |
| Progress | Receipt trùng không tăng lượt; 8 request trùng và 16 event riêng đồng thời; summary/history và owner isolation |
| Đồng bộ | Receipt/delta có tags đúng version kể cả replay sau update, stable cursor/tenant binding, rollback cả change log, review feed |
| Kết thúc | Khôi phục nội dung profile A, đóng các phiên thử, dừng Backend tạm và soft-delete fixture |

Version/updated_at profile tăng theo các lần ghi; review audit/tombstone giữ nguyên nên test có thể ảnh hưởng thống kê tài khoản development. Script không dừng Backend riêng nếu có đang phục vụ cổng 3001. Lần kiểm thử mới với bản tối ưu search đã exit 0, bao gồm Unicode/literal/owner; profile A khôi phục nội dung và hai phiên thử đã đóng. Xem [tiến độ](implementation-status.md) và [benchmark local](database-benchmark.md); chưa đo hiệu năng dữ liệu lớn trên Supabase.

Registration/email confirmation thật đã được kiểm chứng ngày 19/11. Chưa kiểm tra thu hồi tức thời access token, mọi tình huống refresh reuse, tải lớn trên Supabase hoặc deploy production. Benchmark CAM-06 nhiều tiến trình dùng PostgreSQL local, không thay thế Supabase load test. Chưa đóng CAM-07 trước review nhóm. Phần ứng dụng đăng nhập/refresh thuộc thành viên frontend; Cảm bàn giao hợp đồng và bảo vệ API.

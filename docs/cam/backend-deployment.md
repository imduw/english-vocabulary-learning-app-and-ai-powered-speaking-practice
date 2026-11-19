# Cấu hình và triển khai backend

Compose mặc định và compose.supabase.yaml hiện là môi trường development. Chưa triển khai production trong đợt này. Supabase development đang ở cổng 3001; [hướng dẫn kết nối](supabase-connection.md) ghi rõ runtime role/TLS và lệnh quản lý riêng.

## Biến môi trường

| Biến | Runtime / công cụ | Giá trị/quy tắc |
| --- | --- | --- |
| NODE_ENV | Cả hai | development local; production bắt buộc Auth origin và TLS DB |
| PORT | Runtime | Mặc định 3000, 1–65535; API container hiện listen port này |
| DATABASE_URL | Runtime | Role hạn chế, không superuser/BYPASSRLS; không dùng credential migration |
| MIGRATION_DATABASE_URL | Migration/setup | Role tạo schema/trigger và tham chiếu auth.users; không đưa vào container API |
| DATABASE_SSL | Cả hai | true mặc định; false chỉ cho DB local ngoài production |
| DATABASE_CA_FILE | Cả hai | File CA đọc được tại đường dẫn của process/container; không tắt rejectUnauthorized |
| DATABASE_POOL_MAX | Runtime | 1–20, mặc định 5; cân đối số replica và giới hạn pooler |
| DATABASE_TIMEOUT_MS | Runtime | 1–30000ms, mặc định 3000 cho connection/query/statement; runner migration dùng connection 10000ms và statement 30000ms cố định |
| SUPABASE_URL | Runtime/Auth tests | Project HTTPS origin, suy ra issuer/JWKS; bắt buộc trong production |
| OCR_ENGINE | Runtime | wasm mặc định Node; Docker native cần CLI tesseract |
| OCR_WARMUP | Runtime | true mặc định, false khi NODE_ENV=test; engine/model khởi tạo trước khi phục vụ khi true |
| SUPABASE_PUBLISHABLE_KEY | Auth proxy runtime và Auth test | Gọi Supabase register/login/refresh; không dùng secret/service_role key. JWT verifier riêng không cần key này |
| TEST_A_EMAIL / TEST_A_PASSWORD | Auth test trên host | Tài khoản development A, file ignored |
| TEST_B_EMAIL / TEST_B_PASSWORD | Auth test trên host | Tài khoản development B, file ignored |
| NODE_EXTRA_CA_CERTS | Node host khi cần | Bổ sung CA tin cậy cho TLS; không đặt NODE_TLS_REJECT_UNAUTHORIZED=0 |

URL DB không chứa sslmode/SSL query parameter vì có thể ghi đè cấu hình pg; đặt SSL/CA bằng biến riêng. Dùng direct/session connection phù hợp migration, giữ credential quản trị riêng. Khi CA được mount vào container, đường dẫn DATABASE_CA_FILE là đường dẫn trong container, không phải đường dẫn Windows.

## Đưa lên môi trường thật

1. Review PR/contracts và kiểm tra CAM-11; chọn image/revision được duyệt. Chạy backup/restore rehearsal phù hợp môi trường ở [runbook](backup-restore.md).
2. Tạo runtime role hạn chế và Auth project thật; cấu hình DNS/HTTPS reverse proxy, outbound DB/TLS và JWKS. app schema không mở trực tiếp cho client Data API; không phát DB URL/service_role key cho ứng dụng client.
3. Cấp riêng cấu hình migration cho job triển khai. Chạy `node --env-file=.env.migration.local scripts/migrate.mjs` đúng target sau kiểm tra backup/ledger; không chạy seed/bootstrap local. Runner transaction + advisory lock, skip file đã áp dụng; không sửa checksum hoặc xóa ledger để vượt lỗi.
4. Build image bằng `docker build -t vocabulary-backend:review .`. API chỉ nhận file runtime chứa DATABASE_URL/SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY/TLS/PORT/OCR, không nhận file Supabase development có cả mật khẩu test/migration. Mount CA read-only, đặt NODE_ENV=production, DATABASE_SSL=true và OCR_ENGINE=native; dùng secret manager của nơi deploy nếu có.
5. Đưa traffic vào sau khi readiness /health trả 200. /health/live độc lập DB dùng cho liveness. Kiểm tra /openapi.json đúng version, 401 không token và login/profile/owner/RLS thật ở môi trường đích. OCR quota hiện theo process; nhiều replica cần cơ chế rate limit dùng chung trước khi coi là giới hạn toàn hệ thống.
6. Quan sát x-request-id/log JSON, lỗi DB/timeouts và quota; không log token/body/connection string. Bảo vệ quyền xem log và chọn chính sách mở Swagger phù hợp môi trường. Chưa có cấu hình reverse proxy, orchestration hoặc monitoring production trong repository này.

Runtime Dockerfile chạy user node. Các file env/CA/backup không vào build context. Kiểm tra cấu hình cụ thể của nền tảng trước khi mở public port; Compose local chỉ bind loopback.

## Migration và rollback

Nguồn chuẩn là [SQL migrations](../../app/backend/database/migrations/) và [dictionary](database-core.md). Mọi thay đổi thêm file mới theo số thứ tự, cập nhật dictionary và contract nếu cần; không sửa 001–007 đã áp dụng. Đợt OCR/coverage/operations không thêm bảng/migration.

Rollback image chỉ dùng khi phiên bản cũ tương thích schema mới. Runner chưa có down migration/reset; không tự drop cột/bảng hoặc hoàn tác ledger. Nếu cần khôi phục dữ liệu, dùng target riêng và quy trình cutover đã review; ghi rõ dữ liệu sau snapshot có thể cần reconcile. Các bước này là runbook, chưa được dùng để thay đổi production trong phiên làm việc.

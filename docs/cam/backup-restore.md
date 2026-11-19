# Backup và restore dữ liệu backend

Phân biệt PostgreSQL Compose local với Supabase thật. Script dưới chỉ nhận database local cố định, kiểm tra auth.users chỉ có cột id và lịch sử migration khớp trước khi sao lưu; không đọc .env hoặc nhận URL tùy ý.

## Kiểm chứng local

Từ app/backend, DB Compose đã chạy, đã có migration/seed A/B và dependencies host:

```powershell
npm.cmd ci --ignore-scripts
docker compose up -d --wait db
npm.cmd run test:postgres
npm.cmd run test:backup
```

test:postgres chuẩn bị/kiểm chứng fixture và soft-delete dữ liệu thử; không chạy lên DB dùng chung. test:backup dùng pg_dump custom của chính container PostgreSQL 17, export một repeatable-read snapshot, lấy fingerprint từng bảng và pg_dump --snapshot trên cùng trạng thái. Dump gồm auth fixture, app và app_migrations; giữ policy/index/trigger/grants, bỏ ownership để restore vào owner cục bộ tương ứng.

Archive .dump và manifest .json nằm trong app/backend/backups với tên UUID mới, không ghi đè file có sẵn, được .gitignore/.dockerignore bỏ qua. Manifest có SHA-256 archive và fingerprint/count từng bảng. Fingerprint nội dung dùng MD5 của tập row JSON đã sắp xếp, phục vụ đối chiếu dữ liệu thử; SHA-256 dùng kiểm tra archive không bị đổi. Archive hiện không mã hóa và không phải bản sao ngoài máy; không commit hoặc upload nó cùng CI artifact. Script không tự xóa archive; người quản lý chủ động quản lý lưu trữ phù hợp với dữ liệu của mình.

Restore tạo **container PostgreSQL mới**, port loopback ngẫu nhiên, dựng hai role local vocabulary_api/cam_backend rồi pg_restore --single-transaction --exit-on-error --no-owner. Không có tham số restore vào database nguồn. Sau restore:

1. Fingerprint và số row của toàn bộ 15 bảng (13 app + auth.users + ledger) phải khớp snapshot.
2. Migration 001–007 rerun không có file mới, không sửa ledger.
3. Kiểm tra 18 FK, orphan, index invalid và FORCE RLS đủ 13 bảng.
4. Kết nối bằng cam_backend không superuser/BYPASSRLS, chuyển context A/B và xác nhận chỉ đọc được profile của owner tương ứng.
5. Đóng pool, kiểm tra đúng name/label container thử trước khi xóa container cùng volume tạm. Giữ DB/volume nguồn và hai backend 3000/3001.

[Báo cáo](benchmarks/backup-restore-local.json) lưu dung lượng/thời gian, counts, migrations, consistency và resources_closed; không chứa row, credential hoặc archive. Đây là phục hồi logic local đã kiểm chứng, không chứng minh PITR, storage recovery hoặc RTO/RPO production. Thời gian restore nhỏ trên bộ fixture không được dùng làm cam kết cho dữ liệu lớn.

## Supabase development và production

Không dùng script/local bootstrap này để khôi phục Supabase Auth. Xác định rõ project nguồn/đích và phương thức backup trong Dashboard hoặc CLI chính thức; ưu tiên thử vào project riêng trước khi thay đổi dịch vụ đang hoạt động. Archive chỉ schema app không đủ: app.profiles tham chiếu auth.users; cần bảo toàn Auth identities và mapping user ID, custom roles/grants, ledger migration và cấu hình dịch vụ.

Theo [Supabase Database Backups](https://supabase.com/docs/guides/platform/backups), backup DB không chứa object files của Storage; cần kế hoạch sao chép Storage riêng nếu module lưu ảnh/audio được bật. Cấu hình Auth provider/redirect URL, signing keys, secrets và môi trường deploy cần kiểm kê riêng. Không coi một pg_dump là bản sao đầy đủ mọi dịch vụ. Khả năng lịch backup/restore/PITR phụ thuộc cấu hình/gói của project; kiểm tra Dashboard thực tế thay vì mặc định đã bật.

Quy trình nhóm cần áp dụng cho môi trường thật:

- Chọn RPO/RTO và người chịu trách nhiệm; thiết lập lịch, retention và lưu trữ archive mã hóa ngoài máy theo dữ liệu thực tế.
- Trước migration/release quan trọng, xác nhận backup dùng được, SHA-256 và thời điểm snapshot; ghi phiên bản image/migration tương ứng.
- Restore thử vào đích riêng theo [hướng dẫn Supabase](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore), xác minh owner/FK/RLS/ledger/row counts, Auth login/refresh và object files nếu có.
- Khi cần cutover, thống nhất dừng ghi/đồng bộ pending, kiểm tra cursor/receipt sau restore và chuyển runtime URL sau nghiệm thu. Thiết bị có dữ liệu sau snapshot cần bootstrap/reconcile theo hợp đồng; không xóa queue hay giả định cursor cũ còn hợp lệ.

Trong phiên này chưa backup/restore Supabase, chưa đặt lịch hay thay đổi gói dịch vụ. Nguồn PostgreSQL: [pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html), [pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html); backup một DB không bao gồm global roles/tablespaces của cluster.

# CAM-12 — Cài đặt và bàn giao backend

Cập nhật 18/11/2026 theo [issue #28](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/28). Hướng dẫn áp dụng cho 25 API hiện có, schema app 13 bảng/7 migration; không coi là tài liệu của các module AI/client chưa triển khai. Chưa có phê duyệt nhóm hoặc PR/reviewer.

## Khởi động trong 15 phút

Chuẩn bị Git, Docker Desktop/Engine đã chạy và Docker Compose ≥2.24.4. Node.js 22/24 và npm cần cho test/script trên host; chạy backend Docker không cần cài PostgreSQL/Tesseract trên máy. Thời gian cài các công cụ hệ thống và tải repository không nằm trong phép đo dưới đây.

1. Clone repository, mở terminal tại app/backend. Nếu đã clone, giữ cấu hình cá nhân và thay đổi đang làm; không ghi đè .env.
2. Chạy `docker compose up --build -d --wait backend`. Compose tạo DB, áp dụng migration rồi chạy API native OCR; không cần npm install trên host cho cách này.
3. Mở `http://localhost:3000/health`, `/health/live`, `/docs/`, `/openapi.json`: HTTP 200. POST/GET nghiệp vụ cần JWT; GET profile không token trả 401 là đúng.
4. Dùng `docker compose ps -a` xem db/backend healthy và migrate exit 0. Dừng bình thường bằng `docker compose stop`; giữ volume để dùng tiếp.

PostgreSQL local ở 127.0.0.1:54329. auth.users local chỉ có UUID fixture, không phải dịch vụ đăng nhập. Muốn gọi API với Auth thật, dùng [backend Supabase 3001](supabase-connection.md) và access token development. Không chạy bootstrap/seed local trên Supabase.

Có thể kiểm chứng cài mới mà không đụng hai cổng đang dùng bằng `node scripts/check-onboarding.mjs` hoặc `npm.cmd run test:onboarding`. Script dùng Compose gốc + compose.onboarding.yaml, project/volume mới, bỏ port DB host và cấp port API loopback ngẫu nhiên; build/migrate/health/docs/spec và 401 đều phải đạt, rồi kiểm tra nhãn và dọn đúng project tạm.

[Lần đo local](benchmarks/onboarding-local.json) đạt khoảng **20,52 giây**, dưới 15 phút, với database/volume mới. Docker image/layer cache có sẵn; chưa đo tải image từ đầu hoặc một lập trình viên mới tự thao tác. Cần một thành viên khác làm theo các bước trên và ghi thời gian/lỗi gặp phải trước khi nghiệm thu AC onboarding.

## API và Postman

Import cả [collection 25 operation](../../app/backend/api/postman.collection.json) và một environment:

- [Local 3000](../../app/backend/api/postman.local.environment.json).
- [Supabase development 3001](../../app/backend/api/postman.supabase-dev.environment.json).

Chọn environment tương ứng. access_token được để trống/type secret; nhập access token đã đăng nhập vào giá trị local của Postman. Không gửi refresh token cho API này và không export token vào Git. deck_id/card_id/base_version được cấu hình bằng fixture; chúng không tạo dữ liệu hay tự cập nhật request body. Khi tạo dữ liệu thật, thay UUID trong body bằng UUID mới, rồi dùng ID/version từ response cho request tiếp theo và environment. Tên trùng được phép, ID trùng có thể trả 409.

Gửi từng request theo thứ tự GET profile → POST deck → POST vocabulary → GET/PUT với version mới. Ví dụ body dùng UUID giả cố định, không tự đọc collection variable để thay toàn bộ body; không chạy cả collection trên dữ liệu chung. Review/sync phải dùng ID mới cho ý định mới và giữ nguyên ID/payload khi retry. OCR chọn file field image và để Postman tự thêm multipart boundary.

`npm.cmd run api:validate` kiểm tra OpenAPI, ví dụ JSON, từng body Postman và environment; **4/4 test đạt**. Đã sửa payload createCardsBatch có tags đặt sai cấp; tags nay nằm trong từng item. Swagger không lưu token sau reload. Hợp đồng vẫn là 0.9.0-draft chờ review; xem [CAM-04](api-contract.md), [OCR](cam-13-ocr.md), [progress](cam-06-progress.md), [sync](cam-09-10-sync.md).

## Tài liệu vận hành liên quan

- [Database dictionary](database-core.md): đủ bảng/cột/default/FK/CHECK/index/trigger/RLS hiện có; [EXPLAIN và lý do index](database-benchmark.md), [finding FK index](cam-11-testing.md).
- [Backup và restore](backup-restore.md): lệnh thực thi local, manifest/snapshot, bằng chứng khôi phục và ranh giới Supabase/Storage.
- [Cấu hình và triển khai](backend-deployment.md): tách credential runtime/migration, TLS, rollout và rollback.
- [Troubleshooting Auth/sync/DB/OCR](troubleshooting.md): chẩn đoán theo lỗi và cách retry an toàn.
- [CAM-11](cam-11-testing.md): coverage/load/CI; chạy backup drill trong workflow, chưa có Actions run sau push.

## Checklist để nhóm nghiệm thu

| Tiêu chí #28 | Bằng chứng | Còn lại |
| --- | --- | --- |
| Cài chạy ≤15 phút | Automated build/volume mới 20,52s, health/docs/migrate/spec/Auth guard đạt | Người mới làm theo hướng dẫn; cold download chưa đo |
| Dictionary đầy đủ | 13 bảng, 7 migration; xem dictionary/ERD/index | Thành viên review phạm vi module hiện có và dự kiến |
| Postman/environment | 25 operation, 2 environment, token trống, body validate theo schema | Nhóm tích hợp và xác nhận tên field/semantics |
| Toàn đội duyệt | Tài liệu đã có trong repository local | Nhóm rà soát/thông qua, PR và ≥1 reviewer; chưa tự phê duyệt |

Báo cáo này chưa được gửi cho thành viên khác. Không đóng CAM-12 trước các mục review/onboarding thực tế còn lại.

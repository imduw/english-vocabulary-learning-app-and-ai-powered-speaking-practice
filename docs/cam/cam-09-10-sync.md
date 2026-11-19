# CAM-09/10 — API đồng bộ phía server

Phạm vi bàn giao của Cảm là NestJS/PostgreSQL và hợp đồng HTTP. Không kèm worker client, local storage hoặc UI. Client tích hợp theo OpenAPI/Postman 0.9.0-draft; phần bổ sung Auth không đổi sync contract. tags thuộc payload/snapshot của card; migration 007 bổ sung tags=[] cho lịch sử cũ, giữ nguyên hash/version/sequence. Xem [tag/sort](cam-05-tags.md).

## API bộ/thẻ

- `POST /api/v1/sync/batch`: 1–100 mutation trong cùng transaction. Mỗi operation có UUID, entity/action, payload và base_version cho update/delete. Receipt theo owner/operation ID trả lại kết quả khi retry request đã commit; đổi nội dung nhưng dùng lại operation ID trả 409.
- Lỗi một mutation rollback mọi ghi mới, receipt và change log trong batch. Receipt cũ đã commit vẫn giữ nguyên. Server không trả thành công một phần cho các operation mới.
- `GET /api/v1/sync/changes`: snapshot đầy đủ, version dạng chuỗi bigint và tombstone. Cursor ràng buộc owner, giữ giới hạn trên cố định khi phân trang; lượt sau nhận thay đổi mới. Cursor không thay thế Bearer token.
- Update stale trả 409 SYNC_CONFLICT với operation/entity/reason và snapshot server trong phạm vi quyền. Resource ngoài owner không làm lộ snapshot. Không hồi sinh dữ liệu đã xóa.
- Migration 004 thêm sync_heads, sync_changes, sync_receipts và trigger cho cả CRUD thông thường. Sequence cấp trong transaction dưới khóa theo owner. Reader không vượt qua một thay đổi chưa commit; SQL sắp theo bigint, tránh thứ tự chữ 1,10,11,2.

## API sự kiện ôn

`POST /api/v1/progress/review` lưu event bất biến và receipt; trùng ID/nội dung replay kết quả, nội dung khác trả 409. Lượt đến muộn được đưa vào replay theo reviewed_at rồi UUID để tính lại state SM-2.

`GET /api/v1/progress/changes` trả events/has_more/next_cursor. Đây là cursor riêng có stream=reviews, không dùng thay cursor bộ/thẻ. Migration 006 thêm review_heads và sequence theo owner, backfill lịch sử cũ mà giữ receipt. Thứ tự tải là commit order, tách khỏi thời điểm học do client gửi.

## Quy ước cần client tuân thủ

Client giữ UUID/nội dung request khi retry, chỉ coi ghi thành công sau ACK, đồng bộ parent trước child, áp dụng mỗi page và cursor cùng transaction. 401 xử lý qua Supabase Auth; 409 cần lựa chọn xung đột; lỗi validation không retry vô hạn; 408/429/5xx có thể retry với backoff. Từ 19/11 đã triển khai [Dart offline data](cam-08-10-offline.md) theo hợp đồng này, gồm audit/recovery và test nối server thật. Backend nhận JSON tối đa 1 MiB; client giới hạn mỗi batch 512 KiB và 100 mutation. CORS bật qua allowlist CORS_ORIGINS, không dùng wildcard.

## Kiểm chứng và giới hạn

`npm.cmd test`, `npm.cmd run api:validate`, `npm.cmd run test:postgres`, `npm.cmd run test:supabase` chạy độc lập bằng Node.js. Các ca API kiểm tra receipt replay, rollback kèm log, tenant isolation, stable upper bound, numeric sequence, event đến muộn, backfill và concurrency. PostgreSQL local còn kiểm tra reader không bỏ qua writer chưa commit.

Chưa prune receipt/change log/tombstone; thiết bị mới đọc lại từ đầu. Cần retention, bootstrap snapshot/resync và benchmark contention trước tải lớn. Chưa đồng bộ media/source documents. Chưa đủ điều kiện đóng issue khi còn review/acceptance criteria nhóm. Xem [tiến độ](implementation-status.md).

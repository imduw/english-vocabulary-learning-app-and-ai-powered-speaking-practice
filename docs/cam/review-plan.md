# Kế hoạch review backend của Cảm

Phạm vi hiện tại: backend/database/API và [tầng dữ liệu offline CAM-08/09/10](cam-08-10-offline.md). UI/Auth lifecycle cần nhóm ứng dụng nối vào module; các tình huống client dưới đây nay có cả kiểm thử Dart/SQLite/HTTP, không chỉ kiểm tra hợp đồng server.

## Nội dung bàn giao

1. Yêu cầu dữ liệu, ERD, dictionary và migrations 001–007; đối chiếu constraint, tag/sort index, ownership/FORCE RLS.
2. NestJS/pg, runtime role hạn chế, TLS/config, health, JSON log và lỗi không lộ credential.
3. OpenAPI/Postman cho Auth-protected profile, CRUD, progress SM-2 và sync/review feed.
4. Kết quả test Node.js, PostgreSQL Docker và Supabase development thật. Không yêu cầu môi trường Flutter để chạy backend tests.

## Tình huống review

| Tình huống | Kết quả cần kiểm tra |
| --- | --- |
| Token thiếu/sửa/hết hạn hoặc role sai | 401 và không truy cập dữ liệu |
| A đọc/sửa/ghi liên kết đến B | API/RLS/FK owner chặn, không lộ snapshot B |
| Cùng từ ở nhiều ngữ cảnh | Cho phép card khác ID, không UNIQUE word |
| Update stale hoặc update/delete đồng thời | Kiểm tra version trong transaction, 409 khi stale |
| Batch có một item lỗi | Rollback ghi mới, receipt và change log |
| Mất phản hồi, gửi lại cùng ID | Receipt replay, không lặp side effect; đổi payload cùng ID trả 409 |
| Xóa bộ trong lúc sửa thẻ | Tombstone con nguyên tử, không tự hồi sinh |
| Lượt ôn đến sai thứ tự | Giữ event, replay theo thời điểm học/UUID, tính SM-2 đúng fixture |
| Học qua nửa đêm/DST | Summary/streak theo timezone profile, đúng ngày 23/25 giờ |
| Phân trang khi có writer chưa commit | Cursor không bỏ qua thay đổi; bigint sắp đúng thứ tự số |
| Đổi owner trên pool sau lỗi | Identity transaction-local không rò sang request sau |

## Công việc còn lại

- Nhóm review contract tag/sort đã triển khai, chốt mastery/timezone và các API OCR/media/AI còn thiếu.
- Benchmark contention, lượng lịch sử lớn, nhiều account/process; đánh giá coverage so với yêu cầu CAM-11.
- Proxy reconnect/rollback/RLS đã đạt; còn restart DB toàn phần và backup/restore. Thống nhất retention/resync trước khi purge log/receipt.
- Rà soát OpenAPI với các thành viên tích hợp; phân chia PR nhỏ, ít nhất một reviewer theo CONTRIBUTING.
- Không tự coi code/tests hoặc tài liệu là phê duyệt nhóm; chỉ đóng issue sau acceptance criteria và review.

Hướng dẫn chạy ở [Backend README](../../app/backend/README.md), kết quả ở [tiến độ](implementation-status.md).

# Checklist nghiệm thu theo issue của Cảm

Ngày đối chiếu: 19/11/2026. Giữ nguyên phân công/tiêu chí GitHub; đã đọc lại CAM-06/07 trên GitHub ngày này. Mỗi issue cần đủ phạm vi, Acceptance Criteria, kiểm thử, tài liệu và PR review; số test đạt không thay thế coverage, benchmark hoặc phê duyệt nhóm.

Cập nhật 18/11: tag/sort và OCR đã triển khai, 7 migration/13 bảng, OpenAPI 0.9.0-draft/25 operation; 95 test đạt, coverage gate Service/Repository >85%, PostgreSQL load/consistency và Supabase integration có bằng chứng. OCR native đạt trung bình 1,89 giây/trang trên bộ ảnh A4 thử nghiệm. Benchmark có tag đạt 24/24 ca query p95 <50ms. Workflow CI mới chưa chạy trên GitHub; chưa thay đổi issue trên GitHub.

## Quy tắc đánh dấu

- **Có bằng chứng:** mã/tài liệu và phép kiểm tra tương ứng đã tồn tại, ghi rõ giới hạn môi trường.
- **Chưa chứng minh:** có thể đã có mã nhưng chưa có số đo/test đúng yêu cầu.
- **Chưa triển khai:** chưa có phần thực thi hoặc đã được gỡ theo yêu cầu trước đó.
- **Chờ nhóm:** cần xác nhận thiết kế/hợp đồng hoặc reviewer, không tự đánh dấu hoàn thành.

## Đối chiếu các issue

| Issue | Có bằng chứng hiện tại | Cần bổ sung trước nghiệm thu |
| --- | --- | --- |
| [CAM-01 #17](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/17) | Phân tích thực thể, vòng đời, ownership, sync/soft-delete và workload | Hoàn thiện metadata/cache contract theo issue và nhóm phê duyệt |
| [CAM-02 #18](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/18) | ERD + dictionary 13 bảng/7 migration; FK/tag/index/RLS; migration rerun/upgrade bảo toàn dữ liệu; 24 ca query p95 <50ms với 5.000 thẻ/50.000 reviews/10.000 tag links mỗi owner | Review phạm vi ERD hiện có/dự kiến, cách đo AC và PR; chưa suy ra HTTP/production latency |
| [CAM-03 #19](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/19) | 4 tiêu chí kỹ thuật có bằng chứng: health 200, idle/active reconnect, Compose một lệnh, JSON log/global errors | Tạo PR và có reviewer phê duyệt; chưa đóng issue |
| [CAM-04 #20](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/20) | OpenAPI 3.0.3/0.9.0-draft, envelope/errors/examples, Swagger/Postman, 25 operation có tags/sort/OCR | Review OCR, thống nhất Auth phù hợp issue và Frontend/AI ký duyệt |
| [CAM-05 #21](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/21) | CRUD/tag/search/page/sort/favorite/batch/context; validation/version/owner; AC kỹ thuật có bằng chứng qua test/API DB thật và benchmark | PR/reviewer và nghiệm thu nhóm; load/coverage lớn hơn thuộc CAM-11, không tự đánh dấu toàn bộ dự án hoàn thành |
| [CAM-06 #22](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/22) | SM-2 q0–5, lịch/due, mastery/history, timezone/DST; 4 backend/8 owner/48 đồng thời, 256 review request và late events/burst/integrity đạt; [bằng chứng](cam-06-progress.md) | Nhóm review mastery/day semantics, chạy CI thực tế và PR/reviewer; chưa chứng nhận production |
| [CAM-07 #23](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/23) | Supabase + ba route NestJS; bcrypt/salt, login/rotation/logout, JWT/profile/RLS; registration/email confirmation thật qua mailbox của Cảm đạt ngày 19/11; [CAM-07](cam-07-auth.md) | Nhóm review khác biệt strict invalidation/signed refresh với Supabase opaque/reuse exceptions; PR/reviewer |
| [CAM-08 #24](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/24) | SQLite v2/Repository/migration, metadata, indexes/search, owner/FK; native CRUD p95 <5ms với 5.000 thẻ, unit tests và Web migration đạt; [bằng chứng](cam-08-10-offline.md) | Đo thiết bị mục tiêu/thống nhất AC <10ms theo p95, nối UI/Auth và PR/reviewer |
| [CAM-09 #25](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/25) | FIFO transaction, frozen batch/receipt replay sau restart, ACK transaction, cursor và HTTP integration thật đạt | Review hợp đồng, nối luồng ứng dụng, Actions run và PR/reviewer |
| [CAM-10 #26](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/26) | Backoff+jitter/Retry-After bền vững; merge field độc lập/server version thắng field trùng, tombstone, lease, audit/recover và test hai thiết bị/tải | Nhóm chấp nhận chính sách server-authoritative version/LWW (không phải version vector), kiểm chứng thiết bị/CI và PR/reviewer |
| [CAM-11 #27](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/27) | 95 test đạt; 16 file Service/Repository/helper đều >85% cả 4 metrics; tải 460 request/32 đồng thời, orphan/FK/RLS/index và reconnect có bằng chứng; workflow và [báo cáo](cam-11-testing.md) đã có | Chạy/quan sát CI thực tế sau push, review finding index, chia sẻ/nghiệm thu nhóm và PR/reviewer; tích hợp UI/Auth và kiểm chứng thiết bị CAM-08/09/10 còn lại |
| [CAM-12 #28](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/28) | [Runbook](cam-12-operations.md), dictionary/index, 25 operation/2 Postman environments/body validation; backup/restore riêng khớp 15 bảng; automated onboarding 20,52s với cache; deployment/troubleshooting | Một thành viên mới làm theo ≤15 phút, nhóm duyệt toàn bộ tài liệu và PR/reviewer; chưa chứng minh cold download hoặc Supabase recovery |
| [CAM-13 #29](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/29) | POST /ocr/process, JPEG/PNG/WebP ≤10 MiB, boxes/context/confidence/language, validation/rate limit; native HTTP mean 1,89s trên 6 trang mẫu; Supabase thật đạt | PR/reviewer/nghiệm thu nhóm; giới hạn số đo và cách chạy ở [CAM-13](cam-13-ocr.md) |

## Bằng chứng bổ sung CAM-03

`scripts/check-database-recovery.mjs` được gọi trong `npm.cmd run test:postgres`. Nó dựng Nest HTTP dùng DatabaseService thật và proxy TCP riêng tới PostgreSQL Docker:

1. Cắt kết nối idle, xác nhận readiness 503 và liveness 200; bật lại mạng, cùng pool trả readiness 200.
2. Cắt kết nối khi transaction đã UPDATE nhưng chưa commit; request thất bại, nội dung/version profile không đổi sau phục hồi.
3. Sau reconnect, đổi context B rồi A vẫn chỉ thấy profile của đúng owner.

Phép thử đã phát hiện và sửa lỗi ECONNRESET không được bắt khi client đang được checkout. DatabaseService giờ bắt event lỗi ở từng connection, loại connection hỏng và trả lỗi dịch vụ khi transaction bị ngắt. Không tự gửi lại transaction ghi. Log chỉ ghi nhãn lỗi, không ghi SQL/credential.

Đây là mất kết nối qua proxy tới PostgreSQL thật, không phải test giả lập repository hoặc restart toàn container. Không ngắt kết nối process Backend khác hay Supabase. Đã đạt cùng bộ 51 test backend. Cách quản lý/release connection được đối chiếu [node-postgres pool](https://node-postgres.com/apis/pool).

`docker compose up --build -d` đã build/chạy lại với tag/sort và spec 0.7.0-draft, migration exit 0; /health, /health/live, /docs và /openapi.json trả 200. Swagger có tag/sort/order, update tags không có default [] để tránh hiểu nhầm gỡ nhãn khi bỏ field. Không xóa volume. Bộ 58 test vẫn giữ các ca JSON log/lọc lỗi/reconnect. Bằng chứng kỹ thuật CAM-03 có đủ; Definition of Done còn PR/reviewer.

## Thứ tự thực hiện

1. CAM-03 có bằng chứng kỹ thuật; CAM-02/05 đã có tag/sort, dictionary và query p95 <50ms cho schema hiện có. Bước kỹ thuật đợt này xong, PR/review vẫn còn. Xem [tag/sort](cam-05-tags.md) và [benchmark](database-benchmark.md).
2. CAM-13 đã có bằng chứng kỹ thuật và hợp đồng CAM-04 0.9.0-draft; review OCR/Auth và đối chiếu schema của các module nghiệp vụ còn thiếu.
3. Chốt sự khác biệt Auth trong CAM-07 và review quy tắc CAM-06.
4. CAM-08/09/10 đã có tầng dữ liệu client; tiếp tục review, tích hợp UI/Auth và kiểm chứng thiết bị theo tài liệu bàn giao. Không tự chuyển assignee hoặc sửa acceptance criteria.
5. CAM-11 đã có coverage/load/checker và workflow local; cần Actions run thực tế và review. CAM-12 đã có runbook/restore drill/onboarding tự động; cần người mới thử và nhóm duyệt. Chia PR nhỏ và nhờ review.

PR chỉ được merge theo reviewer của nhóm. Không có mục review nào đã được tự phê duyệt trong checklist này.

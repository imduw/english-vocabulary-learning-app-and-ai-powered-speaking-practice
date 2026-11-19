# CAM-04 — Hợp đồng API cốt lõi, bản nháp 0.9.0

Nguồn máy đọc: [OpenAPI 3.0.3](../../app/backend/api/openapi.json). Bộ request: [Postman collection](../../app/backend/api/postman.collection.json). Đây là đề xuất chờ Đức và Nguyên review, chưa phải toàn bộ CAM-04.

## Mở và kiểm tra

Trong app/backend: `npm.cmd run api:validate` để kiểm tra OpenAPI và ví dụ theo JSON schema. Khi Backend đang chạy, mở `http://localhost:3000/docs/`; file gốc được phục vụ ở `/openapi.json`. Swagger dùng asset local, không cần CDN hoặc gửi spec đến validator công cộng. Không lưu token qua các lần tải lại UI.

Import Postman collection, đặt base_url cho môi trường của mình. access_token để trống mặc định. Chỉ đặt access token Supabase thật trên máy khi CAM-07 đã có; không export token vào Git. Cảm đã chọn Supabase Auth với ba route register/login/refresh tại NestJS làm lớp tích hợp; logout vẫn qua Supabase. Xem [CAM-07](cam-07-auth.md).

Đã có environment [local 3000](../../app/backend/api/postman.local.environment.json) và [Supabase development 3001](../../app/backend/api/postman.supabase-dev.environment.json), token để trống/type secret. Mọi raw body Postman được kiểm tra theo request schema; xem [CAM-12](cam-12-operations.md) để import/gửi từng request và thay ID/version fixture.

## Các endpoint

| Nhóm | Endpoint | Trạng thái |
| --- | --- | --- |
| Sức khỏe | GET /health, GET /health/live | Đã triển khai |
| Auth công khai | POST /api/v1/auth/register, /login, /refresh | Đã triển khai proxy Supabase; [CAM-07](cam-07-auth.md) |
| Hồ sơ | GET, PATCH /api/v1/user/profile | Đã triển khai và kiểm thử Supabase thật |
| Bộ thẻ | GET, POST /api/v1/decks | Đã triển khai |
| Bộ thẻ theo ID | GET, PATCH, DELETE /api/v1/decks/{id} | Đã triển khai |
| Từ vựng | GET, POST /api/v1/vocabulary | Đã triển khai |
| Từ vựng theo ID | GET, PUT, DELETE /api/v1/vocabulary/{id} | Đã triển khai |
| Xử lý OCR | POST /api/v1/ocr/process | Đã triển khai, native benchmark và Supabase thật đạt; [CAM-13](cam-13-ocr.md) |
| Nhập OCR hàng loạt | POST /api/v1/vocabulary/batch | Đã triển khai |
| Đồng bộ | POST /api/v1/sync/batch, GET /api/v1/sync/changes | Đã triển khai; kiểm thử API/PostgreSQL/Supabase thật |
| Tiến độ | POST /api/v1/progress/review, GET /api/v1/progress/summary, GET /api/v1/progress/history | Đã triển khai, Supabase thật đạt; Cảm xác nhận SM-2 0–5 |
| Đồng bộ lượt ôn | GET /api/v1/progress/changes | Cursor riêng, commit order; hỗ trợ replay lịch offline |

Cả 25 operation phía server đã triển khai; xem [CAM-05](cam-05-crud.md), [CAM-09/10](cam-09-10-sync.md), [CAM-06](cam-06-progress.md) và báo cáo Supabase. Ví dụ Swagger/Postman là fixture; thay UUID khi tạo dữ liệu thật. API nghiệp vụ không token trả 401; ba route Auth công khai không yêu cầu Bearer. Resource ngoài quyền/đã xóa trả 404; receipt đã commit có thể replay sau xóa.

0.9.0-draft thêm ba route Auth public; mật khẩu/rotation do Supabase quản lý, no-store, whitelist/rate limit và session được xác minh JWKS. Parent/reuse exception vẫn áp dụng; không phải strict immediate old-token invalidation.

0.8.0-draft thêm OCR multipart với JPEG/PNG/WebP ≤10 MiB, xác minh JWT, lỗi 400/413/422/429/503 và Retry-After cho quota/capacity. Response có text/words/bbox/context/sentences/language và image geometry trên ảnh gốc đã auto-orient. OCR không tạo DB record/version/receipt; xem [hợp đồng OCR](cam-13-ocr.md).

0.7.0-draft thêm tags vào card/create/update/batch và sync payload/record; GET vocabulary có tag, sort, order và q tìm cả tên nhãn. Không thêm operation mới. Tag 0–20 tên, trim/NFC/case-insensitive uniqueness, [] để gỡ hết, bỏ field khi update để giữ nguyên. Chi tiết [CAM-05 tags](cam-05-tags.md). Card cũ/snapshot/receipt đã được migration 007 bổ sung tags=[]; client đọc dữ liệu local cũ cần default tương tự.

## Quy tắc chung đề xuất

- Bearer access token Supabase, không gửi refresh token cho API nghiệp vụ. Server lấy owner từ token đã xác minh; request body không nhận user_id.
- Response giữ status/data/error/metadata. Thành công error=null; lỗi data=null. Header x-request-id hỗ trợ đối chiếu log.
- UUID do client tạo cho deck/card để sẵn sàng offline. Không UNIQUE theo word; cùng từ khác ngữ cảnh được tạo thẻ khác nhau.
- version và base_version là chuỗi số nguyên dương vì PostgreSQL bigint có thể vượt độ chính xác số nguyên JavaScript. Không dùng thời gian thiết bị làm version.
- Update phải có base_version và ít nhất một trường chỉnh sửa; server kiểm tra và tăng version trong cùng thao tác ghi. DELETE truyền base_version ở query. Version cũ trả 409 và không thay đổi dữ liệu.
- Omitted field giữ nguyên; null xóa giá trị nullable. Các giá trị text bắt buộc được trim, không nhận chuỗi chỉ có khoảng trắng; giới hạn độ dài theo schema. display_name nếu không null phải có nội dung. Các text nullable khác có thể rỗng theo schema; UI nên dùng null khi không có dữ liệu.
- Card dùng PUT theo issue CAM-05, nhưng hợp đồng quy định cập nhật các trường được gửi, không thay thế toàn bộ resource. Nhóm cần xác nhận cách gọi này trước sinh client.
- Chỉ liệt kê dữ liệu chưa soft-delete và có parent còn hoạt động. Resource của người khác hoặc đã xóa trả 404 để không tiết lộ sự tồn tại; thiếu/sai token trả 401. 403 dùng cho thao tác bị cấm mà không tiết lộ resource ngoài quyền.
- Các code 400/401/403/404/409/422/429/500/503 đã được định nghĩa cho phiên bản API tương lai. Error handler nền tảng hiện chưa triển khai toàn bộ mã lỗi nghiệp vụ; không coi spec là chứng nhận behavior đã chạy.
- Hồ sơ được provision idempotent sau xác minh Auth; Auth user không còn tồn tại trả 401, profile đã xóa không thể đọc/sửa; thiếu cấu hình Auth hoặc keys không truy cập được trả 503.

## Danh sách, tìm kiếm và batch

- limit mặc định 20, tối đa 100; offset >=0. Đề xuất sort cố định updated_at DESC, id ASC. Phản hồi danh sách có metadata.pagination gồm limit/offset/has_more.
- Offset dùng cho UI online; khi có ghi đồng thời có thể thấy dịch chuyển trang. Không dùng phân trang này thay delta cursor của CAM-09.
- Từ vựng lọc deck_id/is_favorite/tag và q; q tìm substring literal không phân biệt hoa/thường trong word/meaning/tên tag. Có sort=updated_at/created_at/word và order=asc/desc, phá hòa id ASC. Benchmark local có tag đạt query p95 <50ms; không cam kết tìm không dấu hoặc SLA HTTP/production.
- Batch 1–100 thẻ, all-or-nothing. Trả theo thứ tự đầu vào, không pagination. Một item không hợp lệ hoặc parent không truy cập được làm thất bại cả batch.
- Trùng ID ở CRUD thông thường trả 409; client offline dùng sync/batch với operation_id và receipt để retry cùng request sau timeout. Không áp dụng bảo đảm receipt của sync cho route CRUD thường.
- Xóa deck kèm soft-delete card đã triển khai trong cùng transaction; cần Đức xác nhận UI trước nghiệm thu. Không xóa media vật lý từ API này.

## Hướng dẫn tích hợp Frontend

Tầng dữ liệu Dart đã có tại [CAM-08/09/10 offline](cam-08-10-offline.md); UI/Auth của nhóm cần nối vào module này. Backend giới hạn JSON 1 MiB (quá giới hạn trả 413), client batch 512 KiB/100 mutation. Với Web, cấu hình CORS_ORIGINS theo origin chính xác; mặc định tắt CORS, không dùng wildcard.

Đức dùng example JSON từ spec để xây model và UI; Backend nghiệp vụ đã chạy, có thể tích hợp bằng token thật. Kết quả ghi dữ liệu thật phải lấy từ response API, không dùng ID trong fixture lặp lại.

Khi CAM-07/CAM-05 hoàn thành, kiểm tra theo thứ tự: nhận token từ Supabase → GET profile → POST deck → POST vocabulary → GET danh sách → PUT với base_version → DELETE. Kiểm chứng tài khoản A không đọc/sửa hoặc liên kết tới dữ liệu B.

## Phần chưa nằm trong bản contract này

Media upload và AI streaming chưa có trong OpenAPI đợt này; cần thống nhất contract cùng Đức/Nguyên. Progress SM-2 có từ 0.5.0-draft, review feed từ 0.6.0-draft; còn review mastery/múi giờ và acceptance criteria. Cảm bàn giao API; thành viên frontend chịu trách nhiệm UI/client. CAM-04 chưa đủ điều kiện đóng trước review nhóm.

Checklist review: chốt soft-delete deck; xác nhận PUT partial semantics/version chuỗi và hợp đồng pagination/search/tag/sort; xác nhận tên trường với bên tích hợp và quy tắc lỗi. Auth guard/validation/Repository, OCR và API tests đã có; các module còn thiếu cần bổ sung tiếp.

Đặc tả dựa trên [OpenAPI 3.0.3](https://spec.openapis.org/oas/v3.0.3.html); Swagger dùng [Swagger UI](https://swagger.io/docs/open-source-tools/swagger-ui/usage/installation/).

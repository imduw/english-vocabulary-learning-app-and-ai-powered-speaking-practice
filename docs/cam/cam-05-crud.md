# CAM-05 — CRUD bộ thẻ và từ vựng

Đã triển khai CRUD/tag/search/page/sort/batch và kiểm chứng PostgreSQL local/Supabase thật, cập nhật 18/11/2026. Chưa review nhóm hoặc đóng issue. Xem [tag, schema và đồng bộ theo version](cam-05-tags.md).

## Endpoint đã chạy

Tất cả yêu cầu Bearer access token Supabase; owner lấy từ token, không nhận user_id trong body.

| Method | Route | Hành vi |
| --- | --- | --- |
| GET, POST | /api/v1/decks | Danh sách phân trang hoặc tạo bộ |
| GET, PATCH | /api/v1/decks/{id} | Đọc hoặc sửa bộ theo version |
| DELETE | /api/v1/decks/{id}?base_version=... | Xóa mềm bộ và thẻ con trong cùng transaction |
| GET, POST | /api/v1/vocabulary | Danh sách/filter/search hoặc tạo thẻ |
| GET, PUT | /api/v1/vocabulary/{id} | Đọc hoặc partial update theo version |
| DELETE | /api/v1/vocabulary/{id}?base_version=... | Xóa mềm một thẻ |
| POST | /api/v1/vocabulary/batch | Tạo 1–100 thẻ all-or-nothing |

Các operation trên đã triển khai trong OpenAPI/Postman. Bản hiện tại 0.9.0-draft có cả Auth/OCR/progress/sync; AI chưa có trong spec. Draft thể hiện còn chờ nhóm review.

## Payload và quy tắc

Tạo thẻ gồm id (UUID client), deck_id, word, meaning; tùy chọn source_document_id, phonetic, source_sentence, ai_example, is_favorite và tags. Cùng từ ở ngữ cảnh khác được tạo thẻ khác ID. Câu gốc và ví dụ AI lưu riêng. tags mặc định [], tối đa 20 tên đã trim/NFC, mỗi tên 1–50 code points; không nhận tên trùng không phân biệt hoa/thường.

```json
{
  "base_version": "1",
  "is_favorite": true,
  "phonetic": null
}
```

Update phải có base_version dạng chuỗi bigint dương và ít nhất một trường chỉnh sửa. Trường không gửi giữ nguyên, null xóa trường nullable; tags=[] gỡ hết nhãn. Version cũ trả 409. CRUD trực tiếp không có receipt riêng, trùng ID trả 409; POST sync/batch hỗ trợ operation_id/receipt để retry an toàn.

- 201 khi tạo; 200 khi đọc/sửa/xóa mềm; 401 khi thiếu/sai token.
- 404 cho resource ngoài quyền, đã xóa hoặc parent không có trong phạm vi owner. deck/source của thẻ phải cùng owner và đang hoạt động.
- 422 cho field server-owned, UUID/query/version sai, text bắt buộc trống, batch ngoài 1–100 phần tử; 409 cho ID trùng/version cũ.
- limit mặc định 20, tối đa 100; offset 0–2147483647. sort=updated_at/created_at/word, order=asc/desc, mặc định updated_at DESC; luôn phá hòa id ASC. metadata.pagination có has_more; không dùng offset làm cursor sync.
- q tìm substring không phân biệt hoa/thường trong word/meaning/tên tag; %, _ và backslash literal. Có tag chính xác (case-insensitive/NFC), deck_id và is_favorite, kết hợp bằng AND. Chưa cam kết tìm không dấu.
- Xóa bộ soft-delete các thẻ chưa xóa, giữ tombstone; không cấp SQL DELETE cho runtime. Cần Đức xác nhận hành vi này trong UI trước nghiệm thu.

## Kiến trúc

learning.controller nhận route/Auth guard; learning.service validate, provision profile và điều phối; learning.repository chạy SQL tham số hóa.

Migration 003_learning_access.sql cấp quyền cột và RLS theo owner cho decks/cards; source_documents chỉ SELECT để kiểm tra liên kết. Media chưa mở quyền nghiệp vụ.

Mỗi truy vấn có transaction identity, SQL lọc owner và FK composite. CRUD và sync cùng owner dùng chung advisory transaction lock, tránh race với xóa bộ. Các owner khác vẫn ghi đồng thời. Migration 004 capture change log của CRUD; migration 007 chuẩn hóa tags/dựng membership trước khi hoàn tất transaction, snapshot/receipt mang nhãn đúng version. Client outbox/FIFO là phần chưa triển khai.

## Kiểm chứng

| Lệnh | Kết quả |
| --- | --- |
| npm.cmd test | 58 test đạt, build TypeScript thành công, gồm tag/sort và upgrade migration |
| npm.cmd run test:postgres | CRUD/Auth trên PostgreSQL Docker thật đạt |
| npm.cmd run test:supabase | JWT thật, CRUD, batch, owner isolation và race trên Supabase thật đạt |

Đã kiểm tra auth/validation, RLS độc lập, owner FK, contextual duplicate, tìm nghĩa, phân trang/favorite/wildcard literal, source cùng/khác owner, nullable update, conflict, batch rollback, xóa mềm/cascade. Test pool PostgreSQL thật: hai update cùng version có kết quả 200/409; tạo thẻ cạnh tranh xóa bộ không để lại thẻ active.

Fixture dùng UUID riêng, kết thúc xóa mềm bộ/thẻ do test tạo, giữ tombstone và đóng các phiên thử. Không xóa bộ/thẻ đã có trước test. Profile có thể được provision; nội dung profile A được khôi phục bởi test Auth.

## Còn lại trước khi đóng issue

- Review API/tích hợp với Đức/Nguyên.
- Review giới hạn/canonical tag và hợp đồng sort đã triển khai; không bỏ tag khỏi phạm vi issue.
- Benchmark đọc đã đạt query p95 <50ms trên bộ gốc và 20% nghĩa Unicode; tải ghi và coverage >85% (CAM-11) vẫn chưa chứng minh.
- Tạo PR và có reviewer phê duyệt; chưa push/đóng issue trong đợt này.

## Benchmark sau tối ưu tìm kiếm

Sau migration 007, mỗi owner có 5.000 thẻ/50.000 reviews/105 tags/10.000 links và 20% nghĩa Unicode. **24/24 ca query p95 <50ms**, cao nhất 39,58ms; lọc tag 3,58ms, q theo tag 12,38ms, trang sâu theo nhãn 8,44ms, word DESC offset4500 25,87ms. Xem [báo cáo/EXPLAIN](database-benchmark.md). 58/58 test, PostgreSQL và Supabase integration đạt với tag/sort. Không suy ra latency HTTP/production; PR/review và load/coverage CAM-11 còn riêng.

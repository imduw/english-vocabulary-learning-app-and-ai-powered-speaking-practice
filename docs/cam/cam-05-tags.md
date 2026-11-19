# CAM-02/05 — Tag và sắp xếp từ vựng

Cập nhật 18/11/2026 theo phạm vi thật của [CAM-02 #18](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/18) và [CAM-05 #21](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/21). Tag đã triển khai trong backend; không thêm mã Flutter hoặc endpoint quản lý tag độc lập. OpenAPI 0.7.0-draft vẫn có 21 operation.

## Hợp đồng sử dụng

POST /api/v1/vocabulary, PUT /api/v1/vocabulary/:id và từng item trong POST /api/v1/vocabulary/batch nhận thêm tags:

```json
{
  "id": "30000000-0000-4000-8000-000000000010",
  "deck_id": "20000000-0000-4000-8000-000000000001",
  "word": "journey",
  "meaning": "chuyến đi",
  "tags": ["Travel", "TOEIC"]
}
```

Khi PUT, bỏ id và thêm base_version dạng chuỗi. tags là mảng tối đa 20 tên, mỗi tên trim/NFC dài 1–50 code points; không nhận null, phần tử không phải string hoặc tên trùng sau chuẩn hóa/đổi hoa thường. tags bị bỏ qua khi tạo thì mặc định []; khi sửa, không gửi tags nghĩa là giữ nguyên, gửi [] nghĩa là gỡ hết nhãn khỏi thẻ.

Registry theo owner lưu cách viết đầu tiên làm tên chuẩn. Ví dụ A đã có Travel thì A gửi travel sẽ nhận Travel; B có thể dùng travel độc lập. Response trả tên chuẩn, sắp xếp theo lower(name) và name của database. Thay mảng tags chỉ đổi nhãn của thẻ đang sửa, không đổi tên tag trên các thẻ khác.

GET /api/v1/vocabulary hỗ trợ:

| Query | Hành vi |
| --- | --- |
| tag=Travel | Tên nhãn chính xác, không phân biệt hoa/thường, trim/NFC |
| q=trav | Substring literal trong word, meaning **hoặc tên nhãn**, giữ escaping %, _, backslash |
| sort=updated_at / created_at / word | Mặc định updated_at; word dùng lower(word) |
| order=asc / desc | Mặc định desc; mọi sort dùng id ASC để phá hòa |
| deck_id, is_favorite, limit, offset | Kết hợp bằng AND với tag/q; giới hạn trang 1–100 |

Không tạo bản ghi trùng trong kết quả khi một thẻ khớp nhiều nhãn. Sort/order chỉ nhận whitelist; không ghép SQL trực tiếp từ dữ liệu người dùng. Dữ liệu sai trả 422, version cũ trả 409, resource ngoài owner/đã xóa trả 404 như hợp đồng hiện có.

## Schema, dữ liệu cũ và đồng bộ

[007_card_tags.sql](../../app/backend/database/migrations/007_card_tags.sql) đã áp dụng trên PostgreSQL local và Supabase development. Không sửa migration 001–006. Schema hiện có 13 bảng:

- tags: registry tên theo owner, UUID server sinh, unique(user_id,lower(name)), tên immutable với runtime.
- card_tags: quan hệ cùng owner tới card/tag qua hai FK composite ON DELETE RESTRICT; index (user_id,tag_id,card_id) cho lọc nhãn.
- cards.tags text[]: snapshot tên chuẩn để GET/list/sync không phải dựng JSON bằng nhiều query. BEFORE trigger chuẩn hóa/tra registry; AFTER trigger thay membership trong cùng transaction. Runtime chỉ SELECT registry/membership, không tự ghi các bảng này.
- Index cards_created_list và cards_word_order phục vụ sắp xếp. Cả tags/card_tags ENABLE + FORCE RLS.

Membership thuộc version của card. Chỉ một lần UPDATE card là một lần tăng version; thay tags không tạo các version trung gian theo từng link. capture_sync lấy cards.tags đã chuẩn hóa nên snapshot/receipt đúng với từng mutation, kể cả create rồi update cùng một card trong cùng sync batch. Tag không có stream/version riêng.

Migration đặt tags=[] cho card cũ và bổ sung trường này vào snapshot/receipt card lịch sử. Giữ nguyên version, updated_at, sequence/head, request_hash và nội dung cũ khác. Client đọc dữ liệu local cũ cần hiểu thiếu tags là []; đợt này không triển khai client migration.

Soft-delete giữ membership và registry để lịch sử/receipt còn đủ nghĩa; API lọc card và parent deck active. Gỡ tags khỏi một card không xóa nhãn đang dùng trên card khác. Registry chưa có API rename/delete hoặc purge nhãn không dùng; không sửa tên thủ công trong DB vì cards.tags là snapshot được trigger quản lý.

## Bằng chứng

- **58/58 test backend đạt**: validate/Unicode/NFC/canonical owner, lọc/kết hợp/sort/page, DB FK/RLS/grants, rollback registry/link/log, receipt theo version, nâng cấp dữ liệu trước 007 không mất thông tin và rerun migration.
- PostgreSQL HTTP/JWT integration đạt, gồm thay/gỡ tag, search tag, sort, owner protection; sync kiểm tra receipt cũ và delta version mới có đúng nhãn. Không bỏ các ca concurrency/reconnect cũ.
- [Benchmark migration 007](benchmarks/postgres-local-tags.json): 2 owner, mỗi owner 5.000 thẻ, 50.000 reviews, 105 tags, 10.000 links, 20% nghĩa Unicode. **24/24 ca có từng query p95 <50ms**, cao nhất 39,58ms; lọc tag 3,58ms, search tên tag 12,38ms, trang sâu trong tag 8,44ms, word DESC offset 4500 là 25,87ms. Đây là SQL local, không phải HTTP/production SLA.
- EXPLAIN thực tế dùng card_tags_by_label cho lọc/phân trang tag, cards_word_order cho word và cards_created_list cho created_at. Fixture benchmark rollback đã xác nhận. Xem [phương pháp đầy đủ](database-benchmark.md).

Chưa tạo PR/reviewer hoặc đóng issue. CAM-05 đã có bằng chứng cho các AC kỹ thuật trong phạm vi hiện tại; nhóm vẫn cần review API/thiết kế và cách hiểu tiêu chí hiệu năng. Sau đợt tag đã bổ sung [OCR](cam-13-ocr.md), [Auth proxy](cam-07-auth.md) và coverage/load CAM-11: OpenAPI 0.9.0-draft/25 operation, 95/95 test đạt. Actions run thực tế và các thực thể ERD dự kiến khác vẫn còn.

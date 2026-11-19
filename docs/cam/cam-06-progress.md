# CAM-06 — API tiến độ và lịch ôn

Phạm vi bàn giao: backend/database/API. Có `/progress/changes` để client tải review events theo cursor; không kèm triển khai local storage hoặc lịch ôn phía ứng dụng.

Triển khai cho [issue #22](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/22), cập nhật 19/11/2026 sau đối chiếu issue thật. Cảm đã xác nhận chọn SM-2 với điểm nhớ 0–5 trong phiên làm việc. Các quy ước mastery/múi giờ và tích hợp vẫn cần review nhóm. Chưa đóng issue hoặc tạo PR.

## API và cách gọi

Bốn route yêu cầu Bearer access token Supabase:

| Route | Mục đích |
| --- | --- |
| POST /api/v1/progress/review | Ghi sự kiện ôn bất biến và tính lại trạng thái thẻ |
| GET /api/v1/progress/summary | Thống kê, chuỗi ngày học và hoạt động 30 ngày |
| GET /api/v1/progress/history | Lịch sử, lọc card_id, limit 1–100, offset |
| GET /api/v1/progress/changes | Event feed theo cursor commit-order, tách với cursor bộ/thẻ |

Ví dụ body; thay card_id bằng thẻ thuộc tài khoản hiện tại và reviewed_at bằng thời điểm học thực tế:

```json
{
  "id": "50000000-0000-4000-8000-000000000001",
  "card_id": "30000000-0000-4000-8000-000000000001",
  "quality": 4,
  "score": 80,
  "reviewed_at": "2026-11-16T00:00:00.000Z",
  "timezone_at_review": "Asia/Ho_Chi_Minh",
  "algorithm_version": "sm2-v1"
}
```

Mỗi lượt học có UUID mới; retry phải giữ nguyên ID và nội dung. score là điểm đánh giá tùy chọn 0–100, không dùng thay quality; không gửi user_id, due_at hoặc ease_factor. Thời điểm yêu cầu UTC đủ milliseconds từ năm 2000, tối đa 5 phút phía trước đồng hồ server. Múi giờ phải được cả runtime và PostgreSQL nhận diện. API trả event và state gồm repetitions, interval_days, ease_factor, total_reviews, last_reviewed_at, due_at.

Gửi lại cùng ID/nội dung trả receipt đã commit; đổi nội dung cùng ID trả 409 REVIEW_ID_REUSED. Receipt giữ state tại lúc xử lý ban đầu, có thể cũ hơn các lượt ôn sau đó. Retry vẫn trả receipt khi thẻ sau đó bị xóa; lượt mới trên thẻ/bộ đã xóa hoặc ngoài quyền trả 404.

## Đặc tả sm2-v1

Dựa trên [đặc tả gốc của SuperMemo](https://www.super-memory.org/archive/english/ol/sm2.htm). Các công thức/biên bên dưới cũng có fixture kiểm thử:

- Khởi đầu EF=2,5; quality là số nguyên 0–5. Thành công từ 3 trở lên: khoảng ôn đầu 1 ngày, tiếp 6 ngày, sau đó ceil(khoảng trước × EF trước lượt).
- Sau mỗi lượt, EF mới = max(1,3; EF + 0,1 − (5−q) × (0,08 + (5−q) × 0,02)). Tính bằng milli-EF nguyên để tránh sai số tích lũy.
- Quality dưới 3 đặt số lần thành công liên tiếp về 0, khoảng kế tiếp 1 ngày; không đặt lại EF về 2,5. Lượt thành công sau đó bắt đầu lại chuỗi 1, 6, …
- Mỗi ngày khoảng ôn là 24 giờ tính từ reviewed_at; interval có trần vận hành 36.500 ngày. Trần này và chính sách mỗi sự kiện đều tính là lựa chọn của ứng dụng, không phải tuyên bố triển khai toàn bộ phiên học của SuperMemo.
- Mỗi ID khác nhau được tính là lượt khác nhau, kể cả luyện lại trong cùng ngày. Không tự tạo thêm lượt luyện trong ngày.

Server giữ mọi event, sắp xếp reviewed_at tăng dần rồi UUID tăng dần và replay toàn bộ lịch sử thẻ. Vì vậy lượt offline đến muộn không bị bỏ hoặc áp dụng theo thứ tự request. Chưa dùng đồng hồ thiết bị để ghi đè/xóa một event khác. Việc tin thời điểm học client trong giới hạn trên là chính sách development; chưa có cơ chế chống gian lận.

## Thống kê và múi giờ

Profile.timezone quyết định ngày hiện tại và cách nhóm toàn bộ lịch sử. timezone_at_review lưu để đối chiếu; đổi múi giờ profile sẽ nhóm lại lịch sử và có thể đổi streak. Đây là quy ước cần nhóm xác nhận khi thiết kế UI.

- new_count: thẻ chưa có state; relearning_count: đã ôn, repetitions=0; learning_count: repetitions 1–2; mastered_count: repetitions>=3. “Đã thuộc” là chỉ báo sản phẩm theo quy ước, không phải đo lường khả năng nhớ chắc chắn.
- due_today_count gồm thẻ đã ôn quá hạn và đến hạn trước nửa đêm ngày mai theo múi giờ profile; không gộp thẻ mới. PostgreSQL chuyển ranh giới ngày sang UTC, xử lý ngày DST dài 23/25 giờ.
- current_streak là chuỗi ngày có ôn kết thúc hôm nay hoặc hôm qua; ngày không ôn hôm nay chưa cắt chuỗi ngay. Một ngày có nhiều event vẫn chỉ tính một ngày.
- activity trả các ngày có sự kiện trong 30 ngày lịch gần nhất; UI cần điền 0 cho ngày trống. Chỉ các event đã đến thời điểm học theo đồng hồ server được tính vào tổng/hoạt động.
- Thẻ/bộ xóa mềm bị loại khỏi mastery/due; lịch sử, tổng lượt và streak vẫn giữ để không mất quá trình học đã ghi nhận.

History sắp reviewed_at DESC, id ASC; offset có thể dịch chuyển khi có event mới, không dùng làm cursor offline.

## Dữ liệu, retry và đồng thời

Migration `005_review_progress.sql` thêm review_events và review_states, FK cùng owner, FORCE RLS và chỉ mục. Runtime không có quyền UPDATE/DELETE event. Event, receipt và state commit cùng transaction; lỗi ghi state rollback cả event và receipt.

Hàng đợi trong tiến trình tối đa 64 request chưa xong cho mỗi tài khoản, xếp trước khi mượn kết nối DB để hạn chế pool bị chiếm bởi các request chờ cùng khóa. Quá giới hạn trả 503; client giữ nguyên event để retry. Khóa transaction PostgreSQL theo owner vẫn bảo vệ khi chạy nhiều backend và khi CRUD/sync cùng sửa dữ liệu. Statement timeout khi chờ khóa trả 503; không đánh dấu lượt đã thành công nếu transaction rollback.

Replay và summary hiện đọc lịch sử tương ứng; chưa tối ưu bằng checkpoint/cache. Đã bổ sung phép thử nhiều tài khoản và nhiều tiến trình dưới đây; số đo không chứng minh khả năng mở rộng vô hạn hoặc SLA production. Checkpoint/cache chỉ cần bổ sung khi dữ liệu/tải mục tiêu cho thấy cần, không tự coi là yêu cầu mới để đóng issue.

## Kiểm chứng và bàn giao

- Bộ backend 95/95 test đạt ở lần chạy coverage gần nhất, trong đó có SM-2 đủ quality 0–5, sự kiện đến muộn, receipt, rollback, RLS, múi giờ/DST, cursor và migration backfill. Rà soát đợt này không đổi thuật toán hoặc schema server.
- `npm.cmd run api:validate`: 4 test; OpenAPI/Postman hiện là 0.9.0-draft với 25 operation; đợt Auth không đổi contract progress.
- `npm.cmd run test:postgres`: đã đạt API tiến độ với 8 request cùng event và 16 event riêng đồng thời; không trùng hoặc mất lượt. Mỗi lần chạy dùng dữ liệu fixture mới.
- Migration 005 đã áp dụng trên PostgreSQL local và Supabase development. `npm.cmd run test:supabase` sau bổ sung hàng đợi kết thúc exit 0: 8 request trùng và 16 lượt riêng đồng thời đều đạt, cùng summary/history/phân quyền. CRUD, sync, khôi phục profile A và đóng hai phiên thử cũng đạt. Xem [tiến độ tổng hợp](implementation-status.md).

Script `scripts/check-progress-api.mjs` tự tạo deck/card, kiểm tra API rồi xóa mềm fixture; review audit giữ nguyên. Chỉ dùng tài khoản development vì lượt thử có thể ảnh hưởng total_reviews/streak trên hai tài khoản đó. Script tích hợp Supabase đóng phiên thử và khôi phục nội dung profile A.

## Tải nhiều backend — 19/11/2026

`npm.cmd run benchmark:progress` build source rồi chạy scripts/benchmark-progress.mjs, chỉ dùng database Compose local. Script kiểm tra auth.users là stub chỉ có id để tránh nhầm Supabase. Bốn tiến trình NestJS thật dùng chung PostgreSQL TCP, mỗi tiến trình pool 5 connections/timeout 30 giây; identity/JWKS fixture riêng, không dùng credential Supabase. Tám tài khoản mới có tổng 40 thẻ và 4 timezone. Mỗi lượt thử dùng UUID mới.

[Báo cáo](benchmarks/progress-multiprocess.json) đạt:

- 256 request review ở concurrency 48, 128 event khác nhau gửi hai lần qua các tiến trình khác nhau và đảo thứ tự thời gian. Tất cả 200, receipt của cùng ID bằng nhau theo nội dung; DB có đúng 128 event.
- 32 lịch ôn khớp từng state/timestamp với fixture SM-2 đã version hóa; thêm 8 lượt offline đến muộn, tính lại đúng interval/EF/repetitions, không mất event trước.
- Mỗi owner có tổng thẻ 5, new 1, learning 1, relearning 1, mastered 2 và 17 lượt; history không lẫn owner, due_today đúng 1 và streak đúng 0 trong mẫu quá khứ này. Ngày DST/chuyển ngày được kiểm tra riêng bằng clock cố định trong unit suite, không suy từ phép thử tải.
- Burst 96 request cùng ID/tài khoản vào một tiến trình: lần đo Windows có 64 thành công và 32 trả 503 do giới hạn hàng đợi. Retry nguyên event qua tiến trình khác thành công, DB chỉ có một event cho ID đó. Số 503 có thể khác theo máy/tốc độ; script chấp nhận 200/503 cho burst, không retry hoặc bỏ qua lỗi bất ngờ trong tải chính.
- Cuối cùng có đúng 137 event, 137 identity và 137 sequence riêng; head từng owner bằng số event. Fixture deck/card xóa mềm, audit/tài khoản local giữ lại; toàn bộ 4 backend/JWKS/DB client thử đã đóng.

369 request được đo (review/summary/burst/retry), gồm 337 HTTP 200 và 32 HTTP 503 có chủ đích; p50 426,54 ms, p95 1.870,41 ms, max 2.576,10 ms ở lần chạy ghi trong JSON. Đây là HTTP latency tổng hợp của phép thử local, không phải query benchmark <50ms hoặc số đo điện thoại. Workflow backend CI đã thêm lệnh này và upload report; chưa có Actions run thực tế.

| AC #22 | Bằng chứng | Còn lại |
| --- | --- | --- |
| Lịch ôn và due chính xác | Fixtures q0–5, event muộn, state/timestamp qua 4 backend | Nhóm review sm2-v1 và các giới hạn vận hành |
| Streak/chuyển ngày/múi giờ | Clock cố định, leap day/DST 23–25h và đổi profile timezone | Nhóm chấp nhận nhóm lịch sử theo profile timezone hiện tại |
| Phân bổ mastery chính xác | Assertions đầy đủ new/learning/relearning/mastered, due/history và owner trong load test | Nhóm chấp nhận mastered = repetitions ≥3 là quy ước sản phẩm |
| Tải đồng thời không sai số liệu | 4 backend, 8 owner, 48 đồng thời; receipts/replay/late events/burst và integrity | Chạy CI thực tế, PR/reviewer; chưa chứng nhận production |

Fixture thuật toán ở contracts/sm2-v1-fixtures.json được kiểm thử từ backend và bàn giao theo hợp đồng API. Phần kỹ thuật theo 4 AC đã có bằng chứng trong môi trường trên; còn nhóm review quy ước mastery/timezone và PR/reviewer. UI/lịch ôn local của ứng dụng chưa được tích hợp trong đợt này; server không nhận review_states từ client để ghi đè lịch tính từ events.

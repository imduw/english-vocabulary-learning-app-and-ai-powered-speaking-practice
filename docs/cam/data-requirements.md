# CAM-01 — Phân tích yêu cầu dữ liệu

Trạng thái: bản nháp chờ Đức, Cảm và Nguyên review. Công nghệ dưới đây theo thông tin mới của Cảm; chi tiết thiết kế là đề xuất.

## 1. Phạm vi và trách nhiệm

- UI thuộc thành viên ứng dụng; [local storage/queue/sync CAM-08/09/10](cam-08-10-offline.md) đã được Cảm yêu cầu bổ sung ngày 19/11, theo các issue hiện có.
- NestJS/TypeScript; PostgreSQL trên Supabase; Supabase Auth và Storage riêng tư.
- Supabase Auth quản lý thông tin đăng nhập và phiên; không tạo hệ thống mật khẩu/token thứ hai.
- ML Kit là luồng OCR chính trên mobile. OCR server phục vụ dự phòng/Web nếu được đưa vào phạm vi.
- Gemini chỉ được gọi từ Backend. Lịch sử đã lưu có thể xem offline; phản hồi mới cần mạng.
- Theo phạm vi Cảm xác nhận: Cảm phụ trách schema server, backend nghiệp vụ, lưu trữ server, API Auth và hợp đồng đồng bộ. Đức phụ trách UI, local storage/worker client, camera/OCR mobile và tích hợp API. Nguyên phụ trách prompt/AI, STT/TTS, đối chiếu văn bản và QA. Ranh giới module AI trong NestJS cần review cùng Nguyên.

## 2. Ma trận yêu cầu → dữ liệu → kiểm chứng

| ID | Yêu cầu | Dữ liệu cần lưu | Tình huống kiểm chứng thiết kế |
| --- | --- | --- | --- |
| DATA-01 | Tài khoản và hồ sơ | Auth user ID, tên hiển thị, múi giờ | A không đọc/sửa dữ liệu B; chuyển tài khoản không hiện dữ liệu cũ |
| DATA-02 | Ảnh nguồn và OCR có thể sửa | Media, kích thước ảnh, văn bản gốc/đã sửa, token và vị trí | Sửa chữ vẫn truy được ảnh và vùng nhận diện ban đầu |
| DATA-03 | Bộ thẻ và từ vựng | Bộ thẻ, từ, nghĩa, phiên âm tùy chọn, câu gốc, ví dụ AI, yêu thích | Hai thẻ cùng từ nhưng khác ngữ cảnh được lưu thành công |
| DATA-04 | Ôn tập offline | Lịch sử từng lượt, rating, phiên bản thuật toán, lịch ôn hiện tại | Mất mạng vẫn tính được lần ôn tiếp; gửi lại không tăng số lượt |
| DATA-05 | Streak/thống kê | Thời điểm ôn, múi giờ tại thời điểm ôn | Ôn sát nửa đêm được quy về ngày học theo quy tắc đã chốt |
| DATA-06 | Hội thoại nhiều lượt | Phiên, vai, chủ đề, nguồn ngữ cảnh, tin nhắn, trạng thái request | Timeout/retry không tạo hai câu trả lời hoàn tất cho cùng yêu cầu |
| DATA-07 | Luyện nói | Câu mẫu, transcript, kết quả đối chiếu từng từ, audio tùy chọn | Không có audio vẫn lưu được kết quả; điểm không mô tả là chấm âm vị |
| DATA-08 | Đồng bộ hai chiều | Outbox local, ID thao tác, version, tombstone, change log server, cursor | Đóng app, retry, hai máy sửa/xóa cùng dữ liệu không làm mất thao tác âm thầm |
| DATA-09 | Media riêng tư | Object path, loại, dung lượng, trạng thái upload | B không đọc được ảnh A kể cả khi biết media ID |

CAM-05 yêu cầu tag, nên đã bổ sung tags/card_tags cùng FK owner trong migration 007, cards.tags cho snapshot, tìm/lọc theo nhãn và sort ở backend. Xem [hợp đồng và bằng chứng](cam-05-tags.md). Không tự bỏ tag khỏi phạm vi issue; mỗi thẻ hiện vẫn thuộc một bộ.

## 3. Quy tắc nghiệp vụ

### Thẻ và nguồn ngữ cảnh

- Mỗi thẻ thuộc một người dùng và một bộ thẻ. Đề xuất mỗi thẻ chỉ thuộc một bộ; việc chia sẻ bộ thẻ ngoài phạm vi hiện tại.
- Không đặt UNIQUE theo từ hoặc `(user_id, word)`. ID của thẻ phân biệt các ngữ cảnh khác nhau.
- Tách `source_sentence` khỏi `ai_example`. Sửa/xóa tài liệu nguồn không được làm mất câu gốc đã lưu trong thẻ.
- Có thể tạo thẻ thủ công không có tài liệu OCR. Một ảnh là một tài liệu OCR ở bản đầu; nhiều trang chưa nằm trong phạm vi.
- Lưu nguyên văn OCR và văn bản người dùng đã sửa riêng. Bounding box mô tả ảnh đã tiền xử lý, không suy ra lại từ số thứ tự ký tự của văn bản đã sửa.
- Các từ không có phiên âm hoặc độ tin cậy vẫn hợp lệ. Không dùng giá trị 0 để thay thế “không biết”.

### Ôn tập và thống kê

- Mỗi lượt ôn là sự kiện có UUID, giữ rating gốc; lịch ôn hiện tại là dữ liệu tính từ sự kiện.
- Client phải tính lịch ôn offline. Client và server dùng cùng đặc tả thuật toán, phiên bản và bộ fixture kiểm thử.
- Đề xuất server tái tính trạng thái từ tập sự kiện đã nhận, dùng thứ tự xác định; không dùng Last-Write-Wins để ghi đè toàn bộ lịch sử ôn.
- Lưu `reviewed_at` từ client và `received_at` do server đặt. Thời gian client mô tả hành vi học, không làm căn cứ duy nhất giải quyết xung đột.
- Cần chốt chính sách thứ tự sự kiện offline đến muộn, lệch giờ và múi giờ trước khi triển khai. Chưa cam kết client/server luôn có cùng trạng thái khi chưa đồng bộ.
- Thống kê/streak nên tính từ lịch sử, chưa tạo bảng thống kê riêng khi chưa có số đo cần tối ưu.

### Hội thoại và luyện nói

- Mỗi phiên lưu snapshot chủ đề, vai và ngữ cảnh để sửa thẻ nguồn không thay đổi ý nghĩa lịch sử.
- Mỗi lần yêu cầu AI có ID ổn định; retry dùng lại ID. Phân biệt đang xử lý, hoàn tất, thất bại, hủy.
- Nội dung streaming chưa hoàn tất không được coi là câu trả lời hoàn chỉnh. Không tự động phát lại request AI tính phí chỉ vì app khởi động lại.
- Bản đầu có thể chỉ lưu câu trả lời hoàn tất trên server và trạng thái đang nhận ở client; cơ chế tiếp tục stream sau ngắt mạng cần chốt với Nguyên.
- Luyện nói lưu câu mẫu và transcript độc lập để có thể xem lại khi không giữ audio. Phương pháp/phiên bản đối chiếu đi cùng kết quả.

### Quyền sở hữu và xóa

- Mọi bảng nghiệp vụ có `user_id`; server lấy chủ sở hữu từ danh tính đã xác minh, không tin `user_id` gửi trong body.
- Mọi liên kết cha/con phải cùng tài khoản, kể cả thẻ → bộ thẻ và tin nhắn → phiên hội thoại.
- RLS và kiểm tra ở API là hai lớp bảo vệ. Đường kết nối DB có quyền bỏ qua RLS vẫn phải kiểm tra quyền và có ràng buộc DB.
- Xóa nghiệp vụ dùng `deleted_at` để máy khác biết dữ liệu đã bị xóa. Không tự khôi phục một bản ghi đã xóa khi nhận UPDATE cũ.
- Đề xuất xóa bộ thẻ kèm soft-delete thẻ bên trong trong một giao dịch; xác nhận hành vi này với Đức. Xóa tài liệu không xóa thẻ đã tạo từ tài liệu đó.
- Chưa chốt hạn giữ tombstone, lịch sử và media. Không hard-delete định kỳ trước khi có chính sách resync cho thiết bị lâu không kết nối.
- Đăng xuất phải dừng worker sync/upload, vô hiệu hóa callback cũ và đóng database của tài khoản trước khi mở tài khoản khác. Dữ liệu chưa sync được giữ riêng hoặc xóa theo lựa chọn rõ ràng của người dùng, không âm thầm bỏ.

## 4. Dung lượng và kiểu truy cập (giả định để lập benchmark)

Đề xuất bộ dữ liệu thử cho một tài khoản: 5.000 thẻ, 100 bộ thẻ, 50.000 lượt ôn, 10.000 tin nhắn. Đây không phải quota sản phẩm hoặc số liệu người dùng thực tế.

- Truy vấn thường xuyên: danh sách thẻ/bộ, tìm từ/nghĩa, thẻ đến hạn, thống kê theo ngày, tin nhắn theo phiên, delta sync theo cursor.
- Ghi nhiều: lượt ôn append-only và tin nhắn. Ghi theo cụm: nhập thẻ từ OCR và sync.
- Ước lượng ban đầu nếu mỗi thẻ trung bình 2 KB thì 5.000 thẻ khoảng 10 MB payload, chưa tính index, lịch sử và overhead của database; đo lại bằng dữ liệu seed. Media tách riêng và có thể lớn hơn dữ liệu text nhiều lần.
- OCR token lưu JSON theo một tài liệu vì đọc cùng tài liệu, chưa có nhu cầu truy vấn từng bounding box bằng SQL.
- Mục tiêu của issue: query cơ bản <50 ms, local CRUD <10 ms, OCR server trung bình <2,5 s. Query PostgreSQL local đã đo 24 ca p95 <50ms; OCR native HTTP đạt mean 1,89s trên bộ A4 thử nghiệm, xem [benchmark DB](database-benchmark.md) và [CAM-13](cam-13-ocr.md). Local CRUD client chưa kiểm chứng; không suy rộng số đo backend sang client hoặc production.

## 5. Quyết định còn thiếu

| Quyết định | Người phối hợp | Giả định để tiếp tục thiết kế |
| --- | --- | --- |
| Android/iOS/Web nào bắt buộc nghiệm thu? | Đức + cả nhóm | Mobile là luồng chính; Web cần khảo sát riêng, chưa cam kết đủ tính năng |
| Thuật toán ôn, rating, thứ tự lượt ôn offline | Đức + Nguyên | Giữ event và algorithm_version; chưa hard-code SM-2/Leitner |
| Tag và thẻ thuộc nhiều bộ? | Đức | Tag đã có theo CAM-05; mỗi thẻ hiện vẫn một bộ, xem contract tag/sort để review |
| OCR engine/quota và hợp đồng tích hợp | Đức + Cảm | Đã có Tesseract native/WASM, giới hạn và API; xem [CAM-13](cam-13-ocr.md), chờ review nhóm |
| Xung đột nội dung và xóa bộ thẻ | Đức + Cảm | Optimistic version; trả conflict thay vì âm thầm ghi đè |
| Thời gian giữ media/tombstone và xử lý xóa tài khoản | Cả nhóm | Chưa tự động dọn dữ liệu; thiết kế full resync khi cursor hết hạn |
| Streaming, lưu audio, cách tính điểm đối chiếu | Nguyên | Lưu transcript/kết quả; audio tùy chọn |
| ORM, migration runner, đường kết nối Postgres | Cảm | Đặc tả logic độc lập công cụ; chọn trước khi tạo migration thực thi |

## 6. Trạng thái nghiệm thu CAM-01

- [x] Có bản nháp thực thể, vòng đời, phạm vi và workload.
- [x] Có đề xuất kiểu dữ liệu/null/unique và quan hệ trong [ERD](architecture-erd.md).
- [x] Có đề xuất cache/local và metadata sync.
- [ ] Đức và Nguyên review; ghi nhận quyết định và phê duyệt tài liệu.

Không đóng CAM-01 chỉ dựa vào checklist soạn tài liệu ở trên; còn phụ thuộc phạm vi chung PROJ-01 và review nhóm.

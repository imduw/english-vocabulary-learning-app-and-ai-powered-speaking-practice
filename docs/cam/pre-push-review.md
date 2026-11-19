# Kiểm tra trước push — 20/11/2026

Nhánh làm việc: feature/cam-data-design. Đã fetch origin và đối chiếu: origin/main vẫn ở 20ce2c9, chưa có nhánh develop tại thời điểm này. Không sửa main, không push/merge hoặc đóng issue trong đợt chuẩn bị. Khi có develop hoặc remote thay đổi, kiểm tra lại nhánh đích trước tạo PR.

## Thay đổi để review

Bộ thay đổi được chia thành 3 commit local theo phụ thuộc:

1. Backend, PostgreSQL migrations/RLS, Auth, CRUD/tag/sync/progress/OCR, contracts, tests/scripts và báo cáo kiểm chứng. Backend trước đây chưa được commit nên phần này vẫn lớn; không coi đây là một PR nhỏ độc lập cho mỗi issue.
2. Tầng dữ liệu offline Dart: SQLite/migration/Repository, outbox/ACK, retry/conflict, adapters native/Web, dependencies, tests và công cụ kiểm tra. Không đổi main.dart hoặc widget test mẫu, không thêm màn hình.
3. CI, README và tài liệu review/nghiệm thu. Các workflow chỉ chạy trên GitHub sau khi push, chưa có Actions run để chứng nhận.

Trước khi tạo PR nên tách nhánh/PR theo module với dependency/base phù hợp, hoặc thống nhất phạm vi với reviewer theo CONTRIBUTING.md mục 9.5. Chia commit không thay thế yêu cầu PR tập trung. Mỗi PR cần ít nhất một reviewer phê duyệt trước merge; không dùng tự phê duyệt để đóng issue.

## Kiểm tra đã chạy trong đợt này

| Kiểm tra | Kết quả |
| --- | --- |
| npm run test:coverage | 95/95 test; gate 16 file Service/Repository/helper >85% cả lines/statements/functions/branches |
| flutter analyze --no-pub | No issues found |
| flutter test --no-pub | 28/28 test đạt |
| node scripts/verify-local.mjs --offline-client | PostgreSQL TCP/transaction/RLS, CRUD/tag/sync/progress, 5 nhóm Dart offline, load/consistency và reconnect đạt |
| node scripts/check-offline-web.mjs | 5 nhóm SQLite/IndexedDB/SharedWorker qua hai tab trình duyệt thật đạt; profile thử đã dọn |
| git diff --check | Không lỗi whitespace; Git chỉ báo chuyển LF/CRLF theo cấu hình Windows hiện có |
| Rà file chuẩn bị commit | Không phát hiện private key, token JWT/GitHub/Supabase thật hoặc remote DB credential qua các mẫu đã kiểm tra; model OCR khớp SHA manifest |

Đã sửa một lỗi đóng gói: .env.supabase.example bị ignore nhầm, nay được phép track. File mẫu chỉ có placeholder/giá trị development, password và key thật không được điền vào. .env.supabase.local, CA local, state đăng ký, build/cache/WASM sinh tự động và backup vẫn bị Git bỏ qua. Models OCR có source/hash/license và ảnh fixture tổng hợp được giữ vì là đầu vào runtime/test cần thiết.

Các số đo lịch sử SM-2 nhiều backend, OCR, SQL, backup/restore, Supabase và Windows CRUD có ngày/môi trường riêng trong JSON; không tuyên bố đã chạy lại tất cả benchmark vào ngày 20/11. Không gọi đăng ký hoặc gửi email thật lại trong kiểm tra trước push này.

## Những điểm cần nêu trong PR

- Supabase refresh là opaque và có parent/reuse exceptions; logout refresh không thu hồi access JWT tức thì ở verifier offline. Đây là khác biệt với mô tả strict invalidation/signed refresh của CAM-07, cần nhóm review.
- Mastered = repetitions ≥3; ngày/streak nhóm theo profile timezone hiện tại. Nhóm cần chấp nhận quy ước sản phẩm của CAM-06.
- UI/Auth của nhóm chưa nối module offline; native CRUD <10 ms mới có số đo p95 trên Windows, chưa chứng nhận Android/iOS/Web latency.
- Media/AI contracts và các mục còn lại trong issue-checklist.md không tự được coi hoàn thành vì test hiện có đạt.
- Chưa có CI run, PR approval hoặc nghiệm thu onboarding bởi thành viên mới. Không tự merge hoặc đóng issue.

Xem [checklist theo issue](issue-checklist.md), [tiến độ](implementation-status.md), [CAM-07](cam-07-auth.md), [CAM-06](cam-06-progress.md) và [offline](cam-08-10-offline.md).

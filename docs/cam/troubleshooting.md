# Xử lý lỗi Auth, sync, database và OCR

Ghi thời điểm, HTTP status, error.code và x-request-id khi báo lỗi. Không gửi access/refresh token, mật khẩu hoặc URL DB có credential trong issue/log. Các lệnh dưới chạy từ app/backend và không yêu cầu sửa frontend.

| Triệu chứng | Kiểm tra và hành động |
| --- | --- |
| Docker không chạy/cổng bị chiếm | Xem docker compose ps -a và Docker Desktop. Local 3000/54329, Supabase 3001 là hai môi trường riêng. Không dừng process lạ hoặc xóa volume; dùng onboarding drill với port ngẫu nhiên nếu chỉ cần thử cài mới. |
| /health 503 nhưng /health/live 200 | Process HTTP còn sống, DB chưa sẵn sàng. Kiểm tra db healthy, runtime URL/role, pooler/TLS/CA. Health phục hồi không có nghĩa request ghi bị ngắt đã commit; kiểm tra/retry theo receipt. |
| Lỗi certificate/DB timeout | Đúng hostname/pooler, CA và DATABASE_CA_FILE nhìn thấy trong container; DATABASE_SSL=true cho remote. Không thêm sslmode hay tắt TLS để bỏ qua lỗi. Pool/quota/timeouts cần kiểm tra theo tải thực. |
| Migration failed/checksum mismatch | Kiểm tra kết nối riêng, auth.users thật, quyền migration và file ledger/checksum. Thêm migration mới cho sửa đổi; không sửa file đã áp dụng, không truncate ledger hay chạy bootstrap local trên Supabase. |
| Thiếu bộ nhớ khi build/test | Đóng các tác vụ nặng do mình sở hữu nếu cần, chạy test tuần tự theo npm scripts. Kiểm tra tài nguyên Docker Desktop; không reset DB hoặc tự dừng ứng dụng khác. Khi chỉ test unit dùng npm.cmd test, không cần dựng thêm Docker backend. |
| 401 không token/JWT hết hạn | Gửi Bearer access token của đúng project, không dùng publishable/service_role/refresh token thay access token. Đăng nhập/refresh qua Supabase Auth, rồi gọi lại API. Không mở public route hay bỏ guard để thử. |
| Auth 503 | SUPABASE_URL/JWKS chưa cấu hình hoặc keys không truy cập được. Kiểm tra HTTPS issuer/project, mạng/DNS và cấu hình runtime; không retry bằng credential migration. HS256 legacy chưa hỗ trợ. |
| 403 profile unavailable / 404 resource | Profile đã soft-delete hoặc resource ngoài owner/đã xóa/parent không còn active. ID fixture không tạo resource thật. API dùng 404 để không lộ dữ liệu owner khác; không thêm user_id vào body để đổi tài khoản. |
| 422 validation | Xem schema: UUID, version dạng chuỗi nguyên dương, timezone hợp lệ, whitelist field. tags phải nằm trong từng card/item; bỏ field update để giữ nguyên, [] để gỡ tags. |
| CRUD 409 stale version | GET bản mới, so sánh ý định người dùng và gửi cập nhật với base_version mới nếu phù hợp. Không tự ghi đè thay đổi khác bằng vòng lặp lấy version mới rồi retry mù. |
| Sync 409 SYNC_CONFLICT | Đọc reason/server và operation_id. Batch chưa commit các mutation mới khi thất bại; receipts đã commit trước vẫn giữ. Phân giải conflict rõ ràng rồi tạo ý định/operation ID mới; không sửa payload dưới ID cũ. |
| Timeout/mất phản hồi sau sync/review | Retry cùng operation/event ID, payload và base_version để nhận receipt đã commit. CRUD thường không có bảo đảm receipt; GET kiểm tra trước khi gửi ghi mới. |
| Sync cursor 422 | Cursor gắn owner/stream và upper bound; không dùng review cursor cho cards, không dùng cursor tài khoản khác hoặc tự sửa chuỗi. Sau restore/retention có thể cần bootstrap/reconcile; server hiện chưa có endpoint bootstrap snapshot tự động. Giữ queue pending, không reset/xóa dữ liệu để che lỗi. |
| Thẻ xóa xuất hiện lại sau sync | Áp dụng tombstone cùng metadata/version; commit page/cursor và data local nguyên tử theo contract. Backend đã có tombstone, worker/local queue chưa thuộc bản triển khai này; không suy ra lỗi server trước khi kiểm tra hai phía. |
| OCR 400 / 413 | Một file field image, JPEG/PNG/WebP thật, ảnh tĩnh ≤16MP và ≤10 MiB. Để HTTP client tự đặt boundary; sửa ảnh/giảm dung lượng, không retry cùng file lỗi vô hạn. |
| OCR 422 | Kết quả quá phức tạp/từ/context vượt giới hạn; chia nhỏ ảnh hoặc chọn vùng phù hợp. |
| OCR 429 / 503 | Tôn trọng Retry-After; 429 quota owner/process, 503 capacity một request hoặc engine lỗi. Đảm bảo native CLI và model/hash tồn tại. Windows Node WASM chưa đạt benchmark native; xem đúng môi trường đo trước kết luận chậm. |

Lệnh chẩn đoán ít tác động: `npm.cmd run supabase:check` chỉ đọc cấu hình/kết nối; `/openapi.json` và `/docs/` để so contract. `test:supabase` đăng nhập và ghi/khôi phục fixture development, không phải checker chỉ đọc; chỉ dùng với tài khoản thử đã cấu hình. `test:postgres`, `test:backup` và checker --local dùng DB Compose riêng.

Xem [Auth/Supabase](supabase-connection.md), [sync](cam-09-10-sync.md), [OCR](cam-13-ocr.md), [backup](backup-restore.md). Nếu còn lỗi, gửi request ID/status/code cùng thao tác tái hiện và phiên bản spec; che toàn bộ credential/token.

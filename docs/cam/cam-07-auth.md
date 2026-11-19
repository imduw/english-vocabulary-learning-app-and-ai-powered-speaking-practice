# CAM-07 — Auth backend tích hợp Supabase

Cảm xác nhận ngày 18/11/2026: giữ Supabase Auth và thêm ba route NestJS làm lớp tích hợp. Không tạo hệ thống mật khẩu/refresh token thứ hai trong schema app, không thêm frontend. [Issue #23](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/23) còn cần nhóm review sự khác biệt refresh semantics và PR/reviewer; chưa đóng issue.

## Hợp đồng 0.9.0-draft

| Route công khai | JSON body | HTTP 200 |
| --- | --- | --- |
| POST /api/v1/auth/register | email, password; tùy chọn captcha_token | session nếu Supabase cho đăng nhập ngay; hoặc user=null/session=null/requires_email_confirmation=true |
| POST /api/v1/auth/login | email, password; tùy chọn captcha_token | user và session đã xác minh JWKS |
| POST /api/v1/auth/refresh | refresh_token | user và cặp token mới theo Supabase |

Response giữ status/data/error/metadata. user chỉ có id/email tùy trường được provider trả; session gồm access_token/refresh_token/token_type=bearer/expires_in. Không trả app_metadata, identities, encrypted_password hoặc nguyên response lỗi provider. Registration chờ confirmation/đã tồn tại được chuẩn hóa thành response pending không lộ ID; pending không bảo đảm email đã được gửi. Site URL/confirmation policy lấy từ Supabase, request không được truyền redirect_to/provider/role/user_id.

Ba route không yêu cầu Bearer; API nghiệp vụ vẫn dùng JWT guard. Cache-Control:no-store và Pragma:no-cache trên response qua guard. Dùng HTTPS ở môi trường thật. Email được trim; password được giữ nguyên, register tối thiểu 8 ký tự, login cho phép mật khẩu cũ ngắn hơn; tối đa 72 UTF-8 bytes phù hợp bcrypt. Mật khẩu không lưu trong app, không log, không được băm lần nữa trước khi chuyển tới Supabase. Xem [password security](https://supabase.com/docs/guides/auth/password-security).

Input có whitelist/giới hạn; query không được chấp nhận. CAPTCHA token tùy chọn được chuyển vào gotrue_meta_security. Timeout upstream 10s, không theo redirect và response tối đa 256KiB. Token được xác minh issuer/audience/expiry/role/sub/chữ ký qua JWKS rồi so với user.id trước khi trả cặp token cho client.

Lỗi JSON/parser 400; validation 422; login/refresh bị từ chối 401; CAPTCHA challenge 403; rate limit 429; thiếu cấu hình/provider không dùng được/response hỏng 503. Không trả chi tiết upstream. 429/503 có Retry-After. Tổng register/login/refresh tối đa 30 request/60 giây/socket IP/process, map có giới hạn 10.000 IP; không tin X-Forwarded-For. Khi sau proxy hoặc có nhiều replica, cần rate limit ở edge phù hợp; bộ đếm RAM không phải quota toàn cụm.

## Cấu hình và sử dụng

Runtime cần SUPABASE_URL và **SUPABASE_PUBLISHABLE_KEY=sb_publishable_...**. Key này phục vụ gọi Supabase Auth, không thay JWT của người dùng; không dùng secret/service_role key. Thiếu key làm route Auth trả 503, business JWT verification vẫn hoạt động nếu đã có issuer/JWKS. Không cần thêm package SDK hoặc thư viện bcrypt trong backend.

Compose Supabase 3001 nhận publishable key từ file ignored hiện có, cùng runtime URL/CA. Không truyền mật khẩu test/credential migration vào API container. Compose local 3000 nếu không cấu hình Auth origin/key vẫn chạy health/docs/DB, còn Auth proxy không thể cấp token. Không dùng fixture auth.users local như dịch vụ Auth.

Swagger ở http://localhost:3001/docs/ có ba operation mới. Import [Postman](../../app/backend/api/postman.collection.json) cùng [environment Supabase](../../app/backend/api/postman.supabase-dev.environment.json), thay credential giả trong body bằng tài khoản development. Gửi từng request, lưu cặp token mới đúng một lần ở client và dùng access_token cho GET profile. Không export token/password vào Git. Client có thể tiếp tục dùng SDK Supabase với cùng provider; cần thống nhất một nơi quản lý refresh để tránh gọi đồng thời ngoài ý muốn. Không sửa client trong đợt này.

## Rotation và logout đã kiểm chứng

[Supabase sessions](https://supabase.com/docs/guides/auth/sessions) cho phép reuse trong một khoảng thời gian và retry bằng token cha của token hiện hành. Refresh token là chuỗi opaque, không cam kết JWT có chữ ký theo mô tả cũ của issue. Vì vậy, không thể coi mọi token cũ bị từ chối ngay sau refresh.

Logout scope=local qua Supabase chặn refresh của phiên đó; không làm access JWT tự hết hạn tức thì ở verifier offline. Nếu yêu cầu thu hồi access token ngay, cần thiết kế kiểm tra trạng thái session riêng. Backend hiện không có logout route mới; scope local được dùng trực tiếp với Supabase trong kiểm thử.

`npm.cmd run test:supabase:sessions` dùng hai tài khoản example.com hiện có, gọi proxy tại localhost:3001. Script không register, không gửi email hoặc sửa settings; chỉ logout các phiên do chính lần thử tạo. GET profile có thể provision nếu thiếu. Kiểm tra bcrypt/salt chạy read-only bằng connection migration trên host, chỉ lấy boolean/count, không lấy hash/salt/row ra máy.

[Báo cáo thật](benchmarks/auth-supabase-sessions.json) đạt: login A/B; hai hash bcrypt và hai salt khác nhau; refresh đổi token giữ owner; retry token cha trả token hiện hành; JWT mới đọc đúng profile; logout A khiến refresh gốc/mới nhất của A trả 401; refresh B vẫn hoạt động; access token A đã cấp còn dùng được cho đến expiry theo verifier offline. Hai phiên thử đã đóng; JSON không có token/credential/ID người dùng.

## Kiểm thử và nghiệm thu

Bộ backend hiện **95/95 test đạt**, coverage gate 16 file Service/Repository/helper >85% cả bốn metrics. Service/helper lines 100%, functions 98,68%, branches 93,06%; Repository lines/functions 100%, branches 94,06%. Unit/integration local dùng upstream/JWKS fixture để thử register session/pending, whitelist, CAPTCHA, lỗi mạng/timeout/redirect/response lớn/hỏng, rate limit và response filtering. Ngày 19/11 đã kiểm thử thêm registration/email confirmation thật như bên dưới; fixture không thay thế bằng chứng provider.

## Đăng ký và email xác nhận thật — 19/11/2026

[Báo cáo](benchmarks/auth-supabase-registration.json) đạt 8 bước trên email thật do Cảm cung cấp: mailbox chưa có trong project; đăng ký qua backend tạm chạy source build hiện tại; response pending/no-store; DB lưu bcrypt và yêu cầu confirmation; login trước xác nhận trả 401; chủ mailbox nhận và mở luồng xác nhận; DB xác nhận email đã confirmed; login/profile đúng owner rồi refresh đổi token; logout scope local phiên do script tạo.

Email nhận được và thao tác mở xác nhận do chủ mailbox cung cấp bằng chứng; script đối chiếu trạng thái provider, không đọc hộp thư hoặc tự admin-confirm. Không dùng token trong URL người dùng gửi. Không thay settings, Site URL hoặc cấu hình SMTP; không xóa/sửa tài khoản khác. Tài khoản mới và profile vẫn giữ trên Supabase. Phiên login/refresh do script tạo đã đóng; phiên của liên kết xác nhận trong trình duyệt không nằm trong tuyên bố cleanup này.

Script `scripts/verify-supabase-registration.mjs` chạy hai bước, từ app/backend, chỉ cho development:

```sh
# REGISTRATION_TEST_EMAIL đặt trong .env.supabase.local, dùng mailbox thật chưa đăng ký.
npm run test:supabase:registration:begin
# Sau khi chủ hộp thư nhận email và mở liên kết xác nhận:
npm run test:supabase:registration:complete -- --email-received
```

Begin gửi tối đa một signup, không retry email tự động. Script tạo mật khẩu ngẫu nhiên riêng, lưu vào `.registration-test.local.json` ignored/Git và excluded/Docker để có thể hoàn tất sau thao tác tay; file được xóa sau khi toàn bộ kiểm tra thành công. Không truyền password/token qua argv hoặc report. Nếu cần dùng lại tài khoản này cho app, chủ email có thể reset password; script không đặt mật khẩu email cá nhân hoặc giữ mật khẩu thử sau khi xong. Complete không gửi thêm signup/email. Nếu mất phản hồi begin, kiểm tra state/provider trước khi làm tiếp; không xóa state để gửi lại tùy tiện.

Khi chưa cấu hình SMTP riêng, Supabase chỉ gửi tới email thành viên tổ chức và giới hạn mặc định hiện tại 2 email/giờ; xem [SMTP chính thức](https://supabase.com/docs/guides/auth/auth-smtp). Không dùng địa chỉ example.com để chứng minh email delivery. Trường hợp CAPTCHA/quota/SMTP từ chối phải xử lý cấu hình tương ứng, không tắt confirmation để làm test đạt.

OpenAPI/Postman hiện có **25 operation**, contract 0.9.0-draft. Schema app vẫn 13 bảng/7 migration. Xem [CAM-11](cam-11-testing.md) và [API contract](api-contract.md).

| AC #23 | Đối chiếu |
| --- | --- |
| Hash và salt an toàn | Delegated Supabase bcrypt; read-only aggregate trên hai tài khoản thử đạt |
| Route bảo vệ thiếu/hết hạn token trả 401 | JWT/HTTP tests đạt; route Auth public là ngoại lệ theo hợp đồng |
| Refresh vô hiệu token cũ/cấp cặp mới | Rotation và logout revocation đạt; **strict immediate invalidation không đúng với parent/reuse exceptions của Supabase**, cần nhóm nghiệm thu phương án đã chọn |
| GET profile an toàn/chính xác | JWT mới/owner thật đạt; RLS và owner isolation có bằng chứng |

Các route register/login/refresh và registration/confirmation thật đã có bằng chứng theo lựa chọn của Cảm. Trước khi đóng CAM-07 vẫn cần nhóm review provider semantics khác strict invalidation/signed refresh trong issue và PR/reviewer; không tự sửa acceptance criteria hoặc issue trên GitHub.

REST upstream được đối chiếu [OpenAPI chính thức Supabase Auth](https://github.com/supabase/auth/blob/master/openapi.yaml).

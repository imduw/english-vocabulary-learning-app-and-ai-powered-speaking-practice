# CAM-13 — API OCR phía backend

Cập nhật 18/11/2026, đối chiếu [issue #29](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/29). Đã triển khai và kiểm chứng kỹ thuật; còn PR/reviewer và nghiệm thu nhóm. Không bổ sung frontend.

## Gọi API

`POST /api/v1/ocr/process`, Bearer access token Supabase, multipart/form-data với đúng một file tên `image`. Dùng Swagger/Postman để chọn file; để công cụ tự đặt Content-Type kèm multipart boundary. Backend Supabase development ở `http://localhost:3001`, backend PostgreSQL local ở cổng 3000. OpenAPI 0.9.0-draft có 25 operation.

Kết quả theo envelope status/data/error/metadata. data gồm text, words, sentences, language và image; metadata.processing_ms đo xử lý phía server. Mỗi word có index/text/confidence/bbox/sentence_index/context; mỗi sentence có index/text/word_indices. Confidence OCR chuẩn hóa 0–1, không phải xác suất chính xác đã hiệu chuẩn.

Bounding box dùng x/y/width/height nguyên trên ảnh gốc **sau khi áp dụng EXIF orientation**, coordinate_space=upright_original_pixels. image.width/height là kích thước này; processed_width/height mô tả ảnh đã thu nhỏ đưa vào OCR. Câu được ghép qua dòng trong cùng paragraph, tách bằng Intl.Segmenter và không tách giữa một OCR token. Đây là ngữ cảnh theo văn bản nhận dạng, cần người dùng kiểm tra khi ảnh thiếu dấu câu hoặc có bố cục phức tạp.

Language lấy từ TinyLD trên văn bản, trả und nếu quá ngắn hoặc chưa đủ điểm. Model OCR có tiếng Anh và tiếng Việt; việc detector nhận ra ngôn ngữ khác không có nghĩa engine hỗ trợ đầy đủ ngôn ngữ đó. Ảnh trắng trả 200 với text/words/sentences rỗng và language und.

## An toàn và giới hạn

- JPEG/PNG/WebP, tối đa **10 MiB = 10.485.760 bytes**, một ảnh tĩnh, tối đa 16 triệu pixel; kiểm tra MIME, magic bytes và decoder thực, không tin đuôi tên file.
- Không nhận URL tải từ xa, field phụ hoặc query parameter. Upload giữ trong RAM, không ghi ảnh/nội dung OCR vào DB, object storage hoặc log. OCR chưa tạo media_assets/source_documents; lưu thẻ được xác nhận qua API vocabulary/batch riêng.
- Thiếu/sai JWT: 401. Sai định dạng, ảnh hỏng hoặc multipart không hợp lệ: 400 với lý do cụ thể. File quá dung lượng: 413. Kết quả quá phức tạp: 422. Tối đa 20.000 từ và 2 triệu ký tự context lặp trong response.
- Mỗi owner đã xác minh tối đa 10 lần upload được chấp nhận/60 giây/process, gồm ảnh không hợp lệ sau khi nhận lease: 429. Mỗi process chỉ một upload/OCR đang xử lý; bận hoặc engine không sẵn sàng: 503. 429/503 có Retry-After. Không coi bộ đếm RAM là rate limit dùng chung nhiều replica.
- Upload có deadline 15 giây; Sharp timeout 5 giây; OCR timeout 15 giây. Client ngắt kết nối khi OCR đang chạy vẫn giữ lease đến khi engine dừng, tránh vượt giới hạn đồng thời.
- Native engine đọc PNG qua stdin, trả TSV qua stdout, không dùng shell. Process con không nhận credential DB/Auth; model giải nén vào thư mục tạm riêng, kiểm tra hash và dọn khi backend dừng bình thường. Không có file ảnh tạm.

## Engine và cách chạy

Sharp 0.35.5 auto-orient, giới hạn pixel, thu nhỏ trong 1800×2400 không phóng lớn, nền trắng, grayscale/normalise/sharpen. Docker dùng Tesseract native 5.3.0, PSM 3, eng+vie, một thread và tắt adaptive learning để các request độc lập. Node trên máy mặc định dùng Tesseract.js 7.0.0 WASM; TinyLD 1.3.4 nhận diện ngôn ngữ. Package-lock cố định dependency.

Model tessdata_fast được đóng gói tại [models](../../app/backend/models/README.md), pin commit 65727574dfcd264acbb0c3e07860e4e9e9b22185, kèm LICENSE Apache-2.0 và manifest SHA-256; không tải model khi nhận request. OCR_ENGINE=native cần CLI tesseract; OCR_ENGINE=wasm dùng Node worker. OCR_WARMUP mặc định true ngoài test.

Từ app/backend, chạy PostgreSQL local bằng `docker compose up --build -d`. Với Supabase đã cấu hình runtime URL/CA trong file ignored, chạy:

```powershell
docker compose --env-file .env.supabase.local -f compose.supabase.yaml -p vocabulary-supabase up --build -d
```

Compose Supabase chỉ truyền cấu hình runtime cần thiết và mount CA read-only; truyền publishable key cho Auth proxy; không truyền credential migration hoặc mật khẩu thử vào container. Không khởi động hai backend trên cùng cổng 3001. Xem [Supabase](supabase-connection.md).

## Bằng chứng kiểm thử và hiệu năng

Đợt CAM-13 có **70/70 test đạt**, gồm 11 test OCR về validation/ảnh thật qua Sharp, quota/lease, tọa độ/context, parser TSV, HTTP errors và phục hồi sau lỗi. Sau bổ sung [CAM-11](cam-11-testing.md), bộ test hiện **95/95**, có thêm engine lifecycle/fault tests và WASM OCR thật. Các unit test dùng recognizer giả để kiểm tra logic không được dùng làm bằng chứng độ chính xác OCR.

Kiểm chứng engine thật và benchmark qua HTTP multipart/JWT:

```powershell
docker compose exec -T backend node scripts/check-ocr-http.mjs --benchmark --output /tmp/ocr-native.json
```

[Báo cáo native](benchmarks/ocr-native.json): 8 nhóm functional checks đạt, gồm JPEG/PNG/WebP, tiếng Việt, EXIF, ảnh trắng, JWT, upload validation, quota và global capacity. Sau một trang warm-up, 6 request luân phiên hai ảnh A4 2480×3508, 360/393 từ, đạt **trung bình 1.890,65 ms**, max/p95 mẫu 1.938,55 ms, dưới ngưỡng trung bình 2.500 ms. Token accuracy Levenshtein đạt 1,0 trên riêng hai fixture công khai này; script yêu cầu ít nhất 0,95 để tránh tối ưu tốc độ bằng cách bỏ từ.

Môi trường: Linux Docker x64, Node 22.23.5, Ryzen 7 8745H, native Tesseract 5.3.0; concurrency 1. Thời gian gồm upload loopback, xác minh JWT/JWKS, preprocess, OCR, parse và JSON; startup đo riêng. Không suy rộng thành SLA qua Internet, mọi ảnh chụp/bố cục, nhiều replica hoặc Windows WASM. WASM fallback chưa được chứng minh đạt ngưỡng 2,5 giây. Fixture PNG đã đóng băng/hash; không regenerate khi benchmark. Xem [fixtures](../../app/backend/fixtures/ocr/README.md).

Backend Supabase đang chạy ở 3001 được kiểm thử riêng bằng `node --env-file=.env.supabase.local scripts/verify-supabase-ocr.mjs`: login thật, GET profile xác nhận owner/DB runtime, OCR ba định dạng và box/câu trên ảnh A4 gốc đều đạt. [Báo cáo](benchmarks/ocr-supabase.json) xác nhận phiên thử đã đóng; không lưu token hoặc ID người dùng. GET profile có thể provision profile nếu chưa có; script không PATCH nội dung profile và không lưu ảnh/thẻ.

CAM-13 đã có mã/contract/test/docs và bằng chứng performance đúng môi trường nêu trên. Cần đưa thay đổi vào PR, reviewer duyệt và nhóm nghiệm thu trước khi đóng issue.

Nguồn kỹ thuật: [Sharp input](https://sharp.pixelplumbing.com/api-input/), [Tesseract.js](https://github.com/naptha/tesseract.js), [Tesseract FAQ](https://tesseract-ocr.github.io/tessdoc/FAQ.html), [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast), [TinyLD](https://github.com/komodojp/tinyld).

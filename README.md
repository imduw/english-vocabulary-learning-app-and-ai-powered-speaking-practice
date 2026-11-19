# English Vocabulary Learning App & AI-Powered Speaking Practice

## Mô tả dự án (Project Description)
Ứng dụng học từ vựng tiếng Anh qua ngữ cảnh thực tế sử dụng công nghệ OCR và luyện phát âm, nói tiếng Anh tương tác với AI.

## Trạng thái dự án (Current Project Status)
- Giai đoạn: **Xây dựng và kiểm thử Backend/API**.
- Phần của Cảm gồm backend, database, Auth phía server và [tầng dữ liệu offline CAM-08/09/10](docs/cam/cam-08-10-offline.md); giao diện mẫu của nhóm giữ nguyên.
- Backend có NestJS, Supabase Auth/JWT, API hồ sơ và CRUD bộ thẻ/từ vựng; đã kiểm thử Supabase development thật. Xem [hướng dẫn Backend](app/backend/README.md) và [tiến độ CAM](docs/cam/implementation-status.md).
- Backend có API batch/receipt/delta, tombstone, version conflict và review feed; xem [CAM-09/10 phía server](docs/cam/cam-09-10-sync.md).
- Backend có API ghi lượt ôn, lịch SM-2 và thống kê theo múi giờ; xem [CAM-06](docs/cam/cam-06-progress.md).
- Backend đã hỗ trợ tag/nhãn và sắp xếp từ vựng, giữ nhãn đúng version khi sync; xem [CAM-02/05](docs/cam/cam-05-tags.md). Schema 13 bảng/7 migration; benchmark có tag đạt 24 ca query p95 <50ms trên PostgreSQL local.

- Backend đã có OCR JPEG/PNG/WebP, boxes/câu ngữ cảnh/ngôn ngữ; native benchmark trung bình 1,89 giây/trang trên bộ A4 thử nghiệm. Xem [CAM-13](docs/cam/cam-13-ocr.md).

## Cấu trúc Repository (Repository Structure)

Auth backend: [CAM-07](docs/cam/cam-07-auth.md) có ba route register/login/refresh tích hợp Supabase; mật khẩu và refresh rotation do provider quản lý, đã kiểm chứng với tài khoản thử.

Hướng dẫn bàn giao backend: [CAM-12](docs/cam/cam-12-operations.md), gồm onboarding, Postman environments, backup/restore, triển khai và troubleshooting Auth/sync.
```text
english-vocabulary-learning-app-and-ai-powered-speaking-practice/
│
├── app/
│   ├── frontend/
│   │   └── flutter_app/     # Ứng dụng Flutter tiêu chuẩn (Android & Web)
│   └── backend/
│       └── README.md        # Hướng dẫn NestJS, migration và kiểm thử
│
├── docs/
│   └── README.md            # Nơi lưu tài liệu dự án (Requirements, Architecture, API, UI/UX)
│
├── infrastructure/
│   └── README.md            # Cấu hình môi trường, Docker, CI/CD trong tương lai
│
├── .gitignore               # Cấu hình bỏ qua theo dõi file cho Monorepo
├── CONTRIBUTING.md          # Hướng dẫn quy trình Git, PR, và quy tắc làm việc nhóm
└── README.md                # Tài liệu tổng quan dự án
```

## Công nghệ sử dụng (Technology Stack)
- **Frontend:** Flutter & Dart.
- **Target Platforms:** Android & Web.
- **Backend:** NestJS/TypeScript, PostgreSQL; định hướng Supabase Auth/Storage theo thông tin mới của Cảm. Thiết kế và hợp đồng tích hợp chờ nhóm review.

## Hướng dẫn thiết lập môi trường phát triển (Development Setup)

### Yêu cầu tiên quyết
- Flutter SDK (stable channel)
- Dart SDK (tích hợp kèm Flutter SDK)
- Android Studio / Android SDK (cho phát triển Android)
- Google Chrome (cho phát triển Web)

### Cài đặt và chạy ứng dụng Frontend
1. Điều hướng vào thư mục ứng dụng Flutter:
   ```bash
   cd app/frontend/flutter_app
   ```
2. Cài đặt dependencies:
   ```bash
   flutter pub get
   dart run build_runner build
   ```
3. Kiểm tra code:
   ```bash
   flutter analyze
   flutter test
   ```
4. Khởi chạy ứng dụng:
   - Trên thiết bị Android / Emulator:
     ```bash
     flutter run -d android
     ```
   - Trên Chrome (Web):
     ```bash
     flutter run -d chrome
     ```

## Quy trình đóng góp & Quy tắc nhóm (Contributing)
Xem chi tiết tại [CONTRIBUTING.md](CONTRIBUTING.md) để nắm rõ:
- Cách clone và tạo branch.
- Quy chuẩn commit và Pull Request.
- Cách đồng bộ code và xử lý conflict.
- Các quy tắc bắt buộc cho 3 thành viên trong nhóm.

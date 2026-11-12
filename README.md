# English Vocabulary Learning App & AI-Powered Speaking Practice

## Mô tả dự án (Project Description)
Ứng dụng học từ vựng tiếng Anh qua ngữ cảnh thực tế sử dụng công nghệ OCR và luyện phát âm, nói tiếng Anh tương tác với AI.

## Trạng thái dự án (Current Project Status)
- Giai đoạn: **Khởi tạo nền móng dự án (Project Foundation Initialization)**.
- Đang hoàn tất cấu trúc monorepo và thiết lập Flutter application tiêu chuẩn.

## Cấu trúc Repository (Repository Structure)
```text
english-vocabulary-learning-app-and-ai-powered-speaking-practice/
│
├── app/
│   ├── frontend/
│   │   └── flutter_app/     # Ứng dụng Flutter tiêu chuẩn (Android & Web)
│   └── backend/
│       └── README.md        # Tài liệu trạng thái Backend (chờ thống nhất công nghệ)
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
- **Backend:** Chưa quyết định (Pending team decision).

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

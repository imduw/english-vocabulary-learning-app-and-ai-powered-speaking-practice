# Hướng dẫn đóng góp dự án (Contributing Guide)

Chào mừng các thành viên tham gia phát triển dự án **English Vocabulary Learning App & AI-Powered Speaking Practice**! Tài liệu này quy định toàn bộ quy trình làm việc với Git, tiêu chuẩn mã nguồn và các nguyên tắc bắt buộc khi làm việc nhóm (teamwork) để đảm bảo chất lượng và tính nhất quán của mã nguồn.

---

## Mục lục
1. [Yêu cầu tiên quyết](#1-yêu-cầu-tiên-quyết)
2. [Cách clone repository](#2-cách-clone-repository)
3. [Chiến lược nhánh & Cách tạo branch](#3-chiến-lược-nhánh--cách-tạo-branch)
4. [Quy chuẩn commit & Cách commit](#4-quy-chuẩn-commit--cách-commit)
5. [Cách push branch lên GitHub](#5-cách-push-branch-lên-github)
6. [Cách tạo Pull Request (PR)](#6-cách-tạo-pull-request-pr)
7. [Cách đồng bộ code mới nhất](#7-cách-đồng-bộ-code-mới-nhất)
8. [Cách xử lý xung đột (Merge Conflict)](#8-cách-xử-lý-xung-đột-merge-conflict)
9. [Các quy tắc bắt buộc khi làm việc nhóm](#9-các-quy-tắc-bắt-buộc-khi-làm-việc-nhóm)

---

## 1. Yêu cầu tiên quyết
Trước khi bắt đầu, hãy đảm bảo máy tính đã cài đặt:
- **Git** (khuyến nghị phiên bản mới nhất).
- **Flutter SDK** (kênh `stable`).
- **Dart SDK** (đi kèm Flutter SDK).
- Cấu hình danh tính Git chính xác:
  ```bash
  git config --global user.name "Tên Của Bạn"
  git config --global user.email "email_cua_ban@example.com"
  ```

---

## 2. Cách clone repository
Clone dự án về thư mục làm việc trên máy tính:
```bash
# 1. Điều hướng đến thư mục chứa dự án
#(ví dụ)
cd D:/Dev/Projects 

# 2. Clone repository từ GitHub
git clone https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice.git

# 3. Di chuyển vào thư mục dự án
cd english-vocabulary-learning-app-and-ai-powered-speaking-practice
```

---

## 3. Chiến lược nhánh & Cách tạo branch

### Cấu trúc nhánh chính
- `main`: Nhánh ổn định (production/stable). Mã nguồn trên nhánh này luôn sẵn sàng triển khai.
- `develop`: Nhánh tích hợp (integration). Tất cả các tính năng mới sau khi review xong sẽ được merge vào đây trước khi release sang `main`.
- `feature/<tên-tính-năng>`: Nhánh làm việc cho các tính năng mới.
- `fix/<tên-lỗi>`: Nhánh sửa lỗi phát sinh trong quá trình phát triển.
- `hotfix/<tên-lỗi-khẩn-cấp>`: Nhánh sửa lỗi nóng trực tiếp từ `main`.

### Cách tạo branch
Luôn cập nhật nhánh gốc trước khi tạo nhánh mới:
```bash
# 1. Chuyển sang nhánh develop (hoặc main nếu chưa có develop)
git checkout develop

# 2. Kéo code mới nhất từ remote
git pull origin develop

# 3. Tạo nhánh mới và chuyển sang nhánh đó
# Quy ước: feature/<tên-tính-năng> hoặc fix/<tên-lỗi>
git checkout -b feature/vocab-flashcard
```

> **Lưu ý:** Tên branch nên viết chữ thường, ngăn cách bằng dấu gạch ngang (`-`), ngắn gọn và phản ánh đúng nhiệm vụ.

---

## 4. Quy chuẩn commit & Cách commit

Dự án áp dụng tiêu chuẩn **Conventional Commits** để lịch sử commit rõ ràng, dễ theo dõi:
```text
<loại>(<phạm vi>): <mô tả ngắn gọn bằng thể mệnh lệnh>
```

### Các loại commit (Types):
- `feat`: Thêm tính năng mới (vd: `feat(vocab): add flashcard flip animation`).
- `fix`: Sửa lỗi (vd: `fix(auth): fix login button overflow on small screens`).
- `docs`: Cập nhật tài liệu (vd: `docs: update CONTRIBUTING.md`).
- `style`: Định dạng code (whitespace, format code, không đổi logic).
- `refactor`: Tái cấu trúc mã nguồn (không thêm tính năng, không sửa lỗi).
- `test`: Thêm hoặc cập nhật unit/widget tests.
- `chore`: Cấu hình build, package, cập nhật dependencies hoặc file phụ trợ.

### Các bước commit:
```bash
# 1. Kiểm tra trạng thái các file đã thay đổi
git status

# 2. Thêm file vào staging area (chỉ thêm file thuộc phạm vi commit)
git add app/frontend/flutter_app/lib/src/screens/vocabulary_screen.dart

# 3. Tạo commit với thông điệp rõ ràng
git commit -m "feat(vocab): create initial vocabulary list screen"
```

---

## 5. Cách push branch lên GitHub
Lần đầu tiên push một branch mới lên GitHub:
```bash
git push -u origin feature/vocab-flashcard
```
Các lần push tiếp theo trên cùng branch:
```bash
git push
```

---

## 6. Cách tạo Pull Request (PR)

1. Truy cập vào repository trên GitHub.
2. Bạn sẽ thấy thông báo gợi ý tạo PR cho branch vừa push, bấm nút **Compare & pull request**.
3. **Target branch:**
   - Chọn `develop` làm nhánh đích (base) cho các tính năng thông thường.
   - Chọn `main` nếu là hotfix nghiêm trọng hoặc chuẩn bị release phiên bản.
4. **Tiêu đề PR:** Đặt theo chuẩn Conventional Commit, ví dụ: `feat(vocab): implement flashcard study mode`.
5. **Nội dung PR:** Cần mô tả rõ ràng:
   - **Mục đích:** Tính năng này giải quyết vấn đề gì?
   - **Thay đổi chính:** Liệt kê các thay đổi trọng tâm.
   - **Hình ảnh / Video minh họa (nếu có UI):** Đính kèm ảnh chụp màn hình/GIF.
   - **Tự kiểm tra:** Đã chạy `flutter analyze` và `flutter test` thành công chưa.
6. Gán ít nhất **1 reviewer** từ nhóm và chờ phản hồi trước khi merge.

---

## 7. Cách đồng bộ code mới nhất

Trong quá trình làm việc, các thành viên khác có thể đã merge code mới vào nhánh chính (`develop`). Bạn cần đồng bộ code mới vào nhánh của mình thường xuyên để tránh xung đột lớn:

### Cách 1: Sử dụng Git Rebase (Khuyến nghị để giữ commit history sạch)
```bash
# 1. Lưu lại các thay đổi tạm thời nếu chưa commit
git stash

# 2. Chuyển về nhánh develop và lấy code mới
git checkout develop
git pull origin develop

# 3. Quay lại nhánh tính năng của bạn và rebase
git checkout feature/vocab-flashcard
git rebase develop

# 4. Phục hồi các thay đổi tạm thời (nếu có dùng stash)
git stash pop
```

### Cách 2: Sử dụng Git Merge (Khi cần giữ lại lịch sử merge rõ ràng)
```bash
git checkout feature/vocab-flashcard
git fetch origin
git merge origin/develop
```

---

## 8. Cách xử lý xung đột (Merge Conflict)

Khi bạn đồng bộ code và xảy ra xung đột (conflict):

1. **Xác định các file bị conflict:**
   ```bash
   git status
   ```
   Các file bị xung đột sẽ hiển thị trong mục `both modified`.

2. **Mở file conflict trong IDE (VS Code / Android Studio):**
   Bạn sẽ thấy các đoạn đánh dấu xung đột:
   ```text
   <<<<<<< HEAD (Current Change - Code hiện tại của bạn)
   Text('Điểm số: $score');
   =======
   Text('Score: $score');
   >>>>>>> develop (Incoming Change - Code từ nhánh develop)
   ```

3. **Giải quyết xung đột:**
   - Trao đổi với tác giả của đoạn code xung đột nếu cần.
   - Chọn giữ code hiện tại (`Accept Current Change`), code mới đến (`Accept Incoming Change`), hoặc kết hợp cả hai (`Accept Both Changes`).
   - Xóa bỏ các ký hiệu đánh dấu (`<<<<<<<`, `=======`, `>>>>>>>`).

4. **Đánh dấu đã giải quyết và tiếp tục:**
   - Nếu đang trong quá trình `rebase`:
     ```bash
     git add <tên-file-đã-sửa>
     git rebase --continue
     ```
   - Nếu đang trong quá trình `merge`:
     ```bash
     git add <tên-file-đã-sửa>
     git commit -m "chore: resolve merge conflict with develop"
     ```

5. **Chạy lại kiểm tra:**
   Sau khi giải quyết conflict, luôn chạy lại:
   ```bash
   cd app/frontend/flutter_app
   flutter analyze
   flutter test
   ```

---

## 9. Các quy tắc bắt buộc khi làm việc nhóm

Để duy trì tính ổn định của dự án và tôn trọng công sức của các thành viên, **tất cả 3 lập trình viên đều phải tuân thủ nghiêm ngặt 8 quy tắc sau**:

1. ❌ **Tuyệt đối không commit/push trực tiếp lên `main` hoặc `develop`:**
   - Mọi thay đổi đều phải đi qua branch riêng và tạo Pull Request.
2. ❌ **Tuyệt đối không sử dụng `git push --force` lên các branch chung:**
   - Thao tác này sẽ ghi đè lịch sử commit và làm mất code của thành viên khác.
3. ❌ **Không commit file rác, file sinh tự động hoặc thông tin nhạy cảm:**
   - Không commit: `.env`, khóa API (API keys), file cấu hình máy cá nhân (`local.properties`), thư mục `build/`, `.dart_tool/`. Luôn kiểm tra `.gitignore`.
4. ✅ **Zero Warnings & Zero Failures trước khi tạo PR:**
   - Bắt buộc chạy `flutter analyze` (phải đạt `No issues found!`) và `flutter test` (phải đạt `All tests passed!`) trước khi đẩy PR lên.
5. ✅ **Phạm vi Pull Request nhỏ và tập trung (Small PRs):**
   - Mỗi PR chỉ giải quyết một tính năng hoặc một lỗi cụ thể. Tránh PR quá lớn với hàng trăm thay đổi gây khó khăn cho người review.
6. ✅ **Tối thiểu 1 Reviewer phê duyệt (Approval):**
   - PR chỉ được merge khi có ít nhất 1 thành viên trong nhóm review và bấm **Approve**. Người tạo PR không được tự ý merge khi chưa có sự đồng thuận.
7. ✅ **Thảo luận trước khi thêm thư viện bên thứ ba (Dependencies):**
   - Trước khi thêm bất kỳ package nào vào `pubspec.yaml`, phải thảo luận với cả nhóm để đánh giá tính cần thiết, chất lượng package và khả năng bảo trì.
8. ✅ **Tôn trọng cấu trúc dự án đã thống nhất:**
   - Tuân thủ cấu trúc thư mục Monorepo (`app/frontend/`, `app/backend/`, `docs/`, `infrastructure/`). Không tự ý đặt source code ngoài quy định.


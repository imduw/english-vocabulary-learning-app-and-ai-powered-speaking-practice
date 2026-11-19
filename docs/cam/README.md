# Hồ sơ thiết kế dữ liệu của Cảm

Ngày lập: 14/11/2026. Trạng thái: **bản nháp để review**, chưa phải thiết kế đã được cả nhóm phê duyệt.

## Đọc theo thứ tự

1. [CAM-01: Yêu cầu dữ liệu](data-requirements.md): phạm vi, quy tắc nghiệp vụ, các quyết định còn thiếu.
2. [CAM-02: Kiến trúc và ERD](architecture-erd.md): bảng, quan hệ, ràng buộc, local storage và đồng bộ.
3. [Kế hoạch review và triển khai](review-plan.md): tiêu chí nghiệm thu, bước tiếp theo, đối chiếu issue cũ.
4. [Schema đã triển khai](database-core.md): từ điển 13 bảng, 7 migration, FK/index/trigger/RLS và phần nghiệp vụ chưa có.
5. [Tiến độ thực hiện](implementation-status.md): kiểm thử và giới hạn hiện tại.
   [Kiểm tra trước push 20/11](pre-push-review.md): kết quả kiểm tra cuối, cách chia commit và các điểm cần review trước PR.
6. [CAM-04: Hợp đồng API cốt lõi](api-contract.md): OpenAPI, Swagger, Postman và ranh giới chưa triển khai.
7. [Kết nối Supabase thật](supabase-connection.md): kết quả kết nối, migration, quyền runtime và bước Auth tiếp theo.
8. [CAM-05: CRUD bộ thẻ và từ vựng](cam-05-crud.md): endpoint, quyền, transaction và bằng chứng kiểm thử.
9. [CAM-09/10: API đồng bộ](cam-09-10-sync.md): receipt/delta, conflict, commit-order cursor và review feed phía server.
   [CAM-08/09/10: dữ liệu offline](cam-08-10-offline.md): SQLite/migration/Repository, FIFO/ACK, retry/conflict, tests và hướng dẫn nối Auth/UI.
10. [CAM-06: API tiến độ](cam-06-progress.md): SM-2, sự kiện ôn, thống kê/múi giờ, retry và kiểm tra đồng thời.
11. [Checklist theo issue/Definition of Done](issue-checklist.md): bằng chứng, phần thiếu và thứ tự thực hiện theo chỉ dẫn hiện tại của Cảm.
12. [Benchmark PostgreSQL](database-benchmark.md): 5.000 thẻ/50.000 lượt ôn/10.000 tag links mỗi owner; 24 ca query p95 <50ms sau migration 007, EXPLAIN/giới hạn đo.
13. [CAM-02/05: Tag và sắp xếp](cam-05-tags.md): hợp đồng tags/tag/q/sort/order, schema và snapshot/receipt theo version, migration không mất dữ liệu cũ.

Nguồn yêu cầu: tài liệu dự án do Cảm cung cấp trong phiên làm việc ngày 14/11/2026; đối chiếu các issue [CAM-01 #17](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/17), [CAM-02 #18](https://github.com/imduw/english-vocabulary-learning-app-and-ai-powered-speaking-practice/issues/18) và nội dung repository. Các lựa chọn được ghi là “đề xuất” chưa phải quyết định của nhóm hay yêu cầu của giảng viên.

14. [CAM-13: OCR backend](cam-13-ocr.md): multipart/JWT, boxes/context/language, giới hạn, native engine và benchmark/Supabase thật.

15. [CAM-11: Kiểm thử và coverage](cam-11-testing.md): TypeScript coverage gate, 95 tests, tải đồng thời, audit FK/orphan/RLS/index và workflow CI chờ chạy trên GitHub.

16. [CAM-12: Cài đặt và bàn giao](cam-12-operations.md): onboarding, hai Postman environments và checklist nhóm nghiệm thu.
17. [Backup/restore](backup-restore.md): archive/manifest local ignored, restore trên đích riêng và phạm vi Supabase/Storage.
18. [Cấu hình và triển khai](backend-deployment.md): env runtime/migration, TLS, rollout/rollback.
19. [Troubleshooting](troubleshooting.md): Auth/sync/version/cursor/DB/OCR và cách thu thập request ID.

20. [CAM-07: Auth proxy Supabase](cam-07-auth.md): ba route register/login/refresh, no-store/rate/validation/JWKS, bcrypt và phiên thử thật, provider semantics cần review.

## Phạm vi bàn giao đợt này

- Hoàn thiện bản nháp phân tích dữ liệu CAM-01 và ERD logic CAM-02.
- Đã bổ sung backend/database/API và tầng dữ liệu client CAM-08/09/10 theo chỉ dẫn mới; màn hình và việc nối UI/Auth thuộc nhóm ứng dụng. Xem tiến độ tổng hợp; review và nghiệm thu nhóm còn lại.
- Không có thông tin bí mật hoặc cấu hình truy cập Supabase trong hồ sơ.

## Cách xem và kiểm tra

Mở các file Markdown trong chế độ Preview của trình soạn thảo có hỗ trợ Mermaid, hoặc xem trên GitHub sau khi nhóm đưa tài liệu lên. ERD nằm trong `architecture-erd.md`; bảng dữ liệu bên dưới giải thích thêm các quan hệ không thể hiện hết trên sơ đồ.

Đối chiếu từng dòng trong ma trận yêu cầu với ERD, rồi dùng các tình huống ở `review-plan.md` để review bằng ví dụ dữ liệu. Đây là kiểm tra thiết kế; không thay thế test chạy trên database ở giai đoạn migration.

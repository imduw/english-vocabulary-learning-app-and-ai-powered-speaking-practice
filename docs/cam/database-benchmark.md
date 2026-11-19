# CAM-02/05 — Benchmark PostgreSQL local, gồm tag và sort

**Mới nhất: 24/24 ca có từng SELECT đạt p95 <50 ms sau migration 007**, cao nhất **39,58 ms**. Mỗi owner có 5.000 thẻ, 50.000 reviews, 105 tags/10.000 links và 20% nghĩa Unicode. Tags/sort đã triển khai; đây là bằng chứng SQL local, không phải SLA HTTP/production. PR/reviewer và phạm vi ERD các module khác vẫn còn.

## Kết quả tag/sort sau migration 007

[JSON/EXPLAIN đầy đủ](benchmarks/postgres-local-tags.json), generated_at 2026-11-17T17:54:34.214Z (18/11/2026 tại Việt Nam). 16 ca search/progress/sync trước đó vẫn được chạy; thêm 8 ca sau, cùng role chịu FORCE RLS, 40 mẫu sau 3 warm-up. Fixture và số tag/link thực tế được kiểm tra, rollback đã xác nhận.

| Ca bổ sung | Query p95 (ms) |
| --- | ---: |
| Lọc tag chính xác | 3,58 |
| Lọc tag không tồn tại | 2,16 |
| q theo tên tag | 12,38 |
| Kết hợp tag + q | 6,82 |
| Tag level-0 offset 650 | 8,44 |
| Sort word ASC | 3,65 |
| Sort word DESC offset 4500 | 25,87 |
| Sort created_at ASC | 3,88 |

Trong 16 ca cũ, query p95 cao nhất là search Unicode không kết quả 39,58ms; summary operation tổng 42,33ms. EXPLAIN dùng card_tags_by_label cho tag/page, cards_word_order cho word, cards_created_list cho created_at. Không ép index hoặc tắt RLS. [Thiết kế tag/snapshot](cam-05-tags.md) giải thích vì sao membership đi cùng version card.

## Tái lập

Từ app/backend, khi Compose DB đã chạy và đủ migrations:

```powershell
npm.cmd run benchmark:postgres
npm.cmd run benchmark:postgres -- --mixed-text
npm.cmd run benchmark:postgres -- --mixed-text --with-tags
node scripts/probe-search.mjs
```

Lệnh benchmark build code rồi chạy [benchmark-postgres.mjs](../../app/backend/scripts/benchmark-postgres.mjs). Chỉ dùng Compose cố định 127.0.0.1:54329/vocabulary với credential demo local, không đọc .env hoặc nhận URL ngoài. Script kiểm tra fixture auth.users chỉ có id và toàn bộ tên/checksum migration khớp. Không dùng bootstrap/seed local trên Supabase.

Báo cáo có timestamps UTC, SQL, min/p50/p95/max, row counts và EXPLAIN ANALYZE/BUFFERS:

- [Trước tối ưu: 13 ca, hai ca search chưa đạt](benchmarks/postgres-local-before-search.json), generated_at 2026-11-16T17:02:12.583Z.
- [Sau tối ưu: 16 ca, dữ liệu gốc](benchmarks/postgres-local.json), generated_at 2026-11-17T17:16:30.474Z.
- [Sau tối ưu: 16 ca, thêm 20% nghĩa Unicode](benchmarks/postgres-local-mixed.json), generated_at 2026-11-17T17:17:29.636Z.
- [Sau migration 007: 24 ca, Unicode + tag/sort](benchmarks/postgres-local-tags.json), generated_at 2026-11-17T17:54:34.214Z.

Exit 1 nếu có query p95 >=50 ms. Hai lượt sau tối ưu exit 0, fixture rollback đã xác nhận. Chạy riêng benchmark, tránh test/build đồng thời khi so sánh latency.

## Phạm vi đo

- PostgreSQL **17.12**, Compose postgres:17-bookworm; Node **24.19.0**, Windows. Đây là máy phát triển dùng chung tài nguyên, không phải máy cô lập CPU/RAM.
- Hai owner, mỗi owner có **100 decks, 5.000 cards (4.750 active), 50.000 events, 5.000 states**; text thẻ khoảng 2 KB. 5% thẻ là tombstone, 20% favorite. Giữ nguyên quy mô/kích thước nội dung giữa các phép đo; bộ hỗn hợp thêm tiền tố Việt/Unicode cho 20% nghĩa.
- Với --with-tags, mỗi owner thêm 105 nhãn (100 topic, 5 level), 10.000 links, hai nhãn mỗi thẻ. Không giảm số thẻ/reviews hoặc độ dài nội dung để vượt ngưỡng.
- 3 lượt warm-up, 40 mẫu/ca, một client, concurrency=1, ANALYZE sau fixture. p95 nearest-rank, cache nóng; không phải SLA production hoặc tải đồng thời.
- Role **vocabulary_api**, NOSUPERUSER/NOBYPASSRLS; ENABLE/FORCE RLS giữ nguyên. SELECT không chỉ định owner chỉ thấy 5.000 thẻ A, tìm thẻ B trả 0.
- Gọi LearningRepository, ProgressService, SyncService từ build thật. Adapter giữ một transaction/context và bỏ qua profile provisioning đã có; không thay SQL nghiệp vụ hoặc ép planner dùng index.
- Đo pg round-trip từng SELECT, gồm truyền/parse kết quả Node. Với ca nhiều SELECT, bảng hiển thị p95 lớn nhất trong từng SELECT; không cộng các p95 riêng để suy ra p95 request.
- Không gồm HTTP/JWT, lấy pool connection, BEGIN/set_config/COMMIT, TLS/WAN tới Supabase, SM-2 write/replay, lock contention hoặc nhiều process. Review fixture INSERT trực tiếp phục vụ đọc, không thay kiểm thử thuật toán.
- Toàn bộ fixture nằm trong transaction không commit; cuối script rollback và kiểm tra auth users không còn. ANALYZE metadata được khôi phục theo dữ liệu thật sau rollback. Không xóa volume/dữ liệu Supabase.

## Lịch sử tối ưu search trước migration 007

Đơn vị ms; cột trước/sau là **query p95 cao nhất của ca đo**, không phải latency API end-to-end. 13 ca gốc giữ nguyên; bổ sung ba ca Unicode/literal.

| Ca đo | Trước tối ưu | Sau: dữ liệu gốc | Sau: 20% nghĩa Unicode |
| --- | ---: | ---: | ---: |
| Danh sách deck | 3,52 | 2,00 | 2,01 |
| Một card theo ID | 2,56 | 1,55 | 1,63 |
| Danh sách card | 5,86 | 3,36 | 3,77 |
| Card theo deck | 4,03 | 2,68 | 2,88 |
| Card yêu thích | 5,63 | 3,61 | 3,85 |
| Search có kết quả | **66,99** | **35,07** | **40,76** |
| Search không kết quả | **67,98** | **34,80** | **38,83** |
| Card offset 4500 | 11,76 | 6,45 | 6,36 |
| Lịch sử review | 3,32 | 1,60 | 1,72 |
| Lịch sử một card | 2,71 | 1,54 | 1,28 |
| Summary tiến độ | 46,85 | 32,62 | 32,14 |
| Delta deck/card | 2,95 | 1,50 | 1,57 |
| Delta review | 4,47 | 2,19 | 2,15 |
| Search tiếng Việt | Chưa đo | 33,89 | 8,08 |
| Search Unicode không kết quả | Chưa đo | 34,00 | 41,23 |
| Search literal %_ và backslash | Chưa đo | 33,97 | 8,45 |

Mọi query p95 của hai bộ sau tối ưu đều <50 ms. **Không khẳng định mọi mẫu <50 ms**; xem max trong JSON. Tổng operation summary là 41,86 ms (gốc) và 40,28 ms (hỗn hợp), vẫn chưa đo HTTP/Supabase latency.

Phiên đo cũ/mới không cô lập hoàn toàn tải máy, nên không quy toàn bộ chênh lệch vào bản sửa. [probe-search.mjs](../../app/backend/scripts/probe-search.mjs) đối chiếu SQL cũ/mới trên cùng fixture, RLS và phiên kết nối: search hit/miss cũ khoảng 50,7/51,3 ms, mới 34,6/34,4 ms (20 mẫu sau 3 warm-up). Nó cũng so sánh kết quả ID và kiểm tra 230 cặp text/needle với ILIKE trên PostgreSQL thật. Đây là chẩn đoán bổ sung, không thay benchmark đầy đủ.

## Thay đổi và tính đúng

[substring-match.ts](../../app/backend/src/learning/substring-match.ts) giữ bound pattern và escaping LIKE của Repository. Với UTF-8, chuỗi ASCII được nhận diện bằng octet_length=length. Khi locale chuyển hoa/thường ASCII theo quy tắc thông thường, nhánh này dùng C collation và lower(pattern COLLATE "default"); nhờ đó không phải làm phép so sánh locale cho từng ký tự ASCII. lower pattern vẫn dùng locale gốc, kể cả needle Unicode có dạng thường ánh xạ sang ASCII.

Nội dung không phải ASCII, encoding khác UTF-8 hoặc locale có quy tắc ASCII khác (ví dụ Turkish I) vẫn dùng ILIKE gốc. Riêng tối ưu ASCII không đổi encoding/collation database, policy/grant hoặc migration; SELECT search không dùng SECURITY DEFINER/BYPASSRLS để tăng tốc. Migration 007 thêm schema/trigger quản lý tag riêng như phần đầu báo cáo. Đây là tối ưu chi phí lọc, **không thêm substring index**; cards_word_prefix vẫn không giải quyết trực tiếp '%q%'.

Đối chiếu cơ sở ngữ nghĩa ở [PostgreSQL string functions](https://www.postgresql.org/docs/17/functions-string.html) và [pattern matching](https://www.postgresql.org/docs/17/functions-matching.html). RLS giữ nguyên theo [PostgreSQL row security](https://www.postgresql.org/docs/17/ddl-rowsecurity.html).

58/58 test backend hiện đạt, giữ ma trận 338 cặp text/needle so với ILIKE (Việt/accents, dotted I, long s, Kelvin, sharp S, sigma/final sigma, emoji, CJK, newline, wildcard/backslash, SQL/regex-like input). Có thêm tag/sort/filter/owner, rollback, receipt đúng version và upgrade dữ liệu trước 007. Không thêm package.

`npm.cmd run test:supabase` exit 0 sau migration 007: tag create/filter/search/replace/clear/sort, delta/receipt có nhãn đúng version, cùng đăng nhập/refresh A/B, owner, CRUD/concurrency, progress/sync đạt; đã khôi phục nội dung profile A, soft-delete fixture và đóng hai phiên thử. Đây là kiểm thử chức năng qua Supabase, không phải phép đo latency 5.000 thẻ trên Supabase.

## Giới hạn và phần còn lại

- Bộ hỗn hợp mới có 20% nghĩa Unicode; cần đo thêm dữ liệu Unicode chiếm đa số, nhiều owner/phân bố khác và tải đồng thời. Không suy ra mọi dữ liệu tương lai đều <50 ms.
- Nếu nhóm hiểu <50 ms là toàn bộ HTTP request, cần phép đo HTTP tương ứng; không tự đổi acceptance criteria sang query p95 mà không reviewer xác nhận.
- Tag/sort đã có và đã cập nhật dictionary/test/benchmark. Các bảng/module khác trong ERD dự kiến vẫn chưa triển khai; khi thêm cần làm tương tự.
- Coverage >85%, CI/load CAM-11, hiệu năng Supabase và PR/reviewer vẫn là các mục nghiệm thu riêng. Chưa đóng issue dựa riêng vào báo cáo này.

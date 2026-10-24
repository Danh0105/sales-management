# Recruitment — rà soát và bổ sung chức năng ngày 24/10/2026

Đợt bổ sung tiếp theo theo yêu cầu: [Chọn chức danh hệ thống và tự tạo tài khoản khi HR tuyển thành công](RECRUITMENT-HIRE-ACCOUNTS-2026-10-24.md). Đã kiểm thử riêng, chưa triển khai production.

## Changes

Phạm vi: luồng HR Recruitment, API Recruitment, giao diện quản trị và vận hành Zalo hiện có.
Các thay đổi được thực hiện trong worktree riêng; không thay mã chạy, cấu hình, dữ liệu ứng viên hoặc hạn mức trên production.

| Nhóm | Hiện trạng rà soát | Bổ sung/sửa trong đợt này |
| --- | --- | --- |
| Vị trí tuyển dụng | API tạo, sửa, công bố, tạm dừng, đóng đã có | Nối nút tạm dừng/đóng và sửa tiêu chí sàng lọc với API; tìm kiếm/phân trang phía server |
| Ứng viên | API tạo, sửa, phát hiện nghi trùng, yêu cầu xoá đã có | Form sửa hồ sơ; gắn vị trí; ghi nhận yêu cầu xoá; xử lý cảnh báo trùng khi tạo/sửa, chỉ cho vượt cảnh báo sau xác nhận HR |
| Hồ sơ ứng tuyển | Backend đã có state machine và `allowedNextStatuses` | Phân trang pipeline, tìm kiếm phía server; mở hồ sơ từ ứng viên; không chọn sẵn trạng thái thay HR |
| Sàng lọc | Backend chấm điểm tất định; AI không quyết định tuyển/loại | HR cấu hình các tiêu chí đã được backend cho phép; không chấm lại hoặc sửa kết quả cũ tự động |
| Phỏng vấn | API tạo/sửa/huỷ/xác nhận/hoàn tất/no-show đã có | Giao diện tạo, xem, dời giờ, ghi chú, đổi trạng thái, lý do huỷ; API trả các bước kế tiếp theo state machine |
| Khung giờ | API quản lý sức chứa và đặt chỗ đã có | Giao diện mở/sửa/đóng/mở lại khung giờ dùng chung; kiểm ngày giờ Việt Nam; giữ lịch đã đặt khi đóng khung giờ |
| Bàn giao HR | API resolve và resume AI đã có | Phân trang/lọc yêu cầu HR; nhập kết quả xử lý thay ghi chú chung chung; resolve không tự mở lại AI |
| Hội thoại | API lịch sử, tiếp quản, trả AI, đóng và gửi tin HR đã có | Lọc chính xác `candidateId`; huỷ tin HR PENDING/RETRY với lý do; hiển thị nguyên nhân lỗi gửi |
| Đối soát Zalo | API UNKNOWN đã có nhưng UI duyệt tin AI không bao phủ tin HR | Đánh dấu HR đã gửi / gửi lại / kết thúc theo dõi UNKNOWN ngay trong hội thoại; gửi lại yêu cầu xác nhận rủi ro nhận trùng |
| Vận hành | Runtime stop/resume, cảnh báo và ledger đã có | Hiển thị quota thực sự áp dụng, cửa sổ trượt khi API hỗ trợ, số lượt gửi và ngân sách/chi phí ước tính |
| Phân quyền | HR thao tác; director/director_la/troly_gd chỉ xem | Route/menu theo đúng nhóm quyền; UI chỉ xem không có các nút ghi ứng viên/lịch |

### Các lỗi backend đã sửa

- Sửa khung giờ đọc/ghi trong một transaction có khoá bản ghi: không ghi đè số chỗ vừa được AI đặt và không hạ sức chứa dưới số chỗ đã đặt.
- Chặn dời khung giờ chưa đặt vào quá khứ.
- Hai thao tác huỷ cùng lịch được tuần tự hoá, chỉ trả chỗ một lần.
- AI xác nhận lịch đọc lại lịch, hồ sơ và ứng viên trong transaction có khoá; lịch HR vừa huỷ không thể bị AI khôi phục thành CONFIRMED bằng dữ liệu cũ.
- Cập nhật lịch/khung giờ và xác nhận AI ghi audit bắt buộc trong cùng transaction. Audit thất bại thì rollback trạng thái.
- Bước HR chuyển hồ sơ sang INTERVIEW khoá hồ sơ trước khi đọc và ghi.
- Danh sách/chi tiết lịch trả `allowedNextStatuses`; giao diện sử dụng trực tiếp, không tự suy diễn state machine.

## Tests

| Kiểm tra | Kết quả | Phạm vi thực sự đã chạy |
| --- | --- | --- |
| Recruitment regression | 559 PASS, 31 skipped, 0 FAIL | Jest, 32 suite PASS / 2 suite PG dispatch không được bật trong lượt này |
| Kiểm thử tập trung HR | 19/19 PASS | 14 unit/service và 5 PostgreSQL; là tập con của regression |
| PostgreSQL quyền ứng dụng | 5/5 PASS | DB Docker riêng `g8_hr_test`, dịch vụ chạy bằng `sales_app`; fixture chỉ dữ liệu giả lập |
| UI browser | 21/21 PASS, 0 page errors | Chrome headless; toàn bộ API giả lập; desktop và mobile 390px; trình duyệt đặt múi giờ Mỹ để kiểm chuyển giờ Việt Nam |
| Hàm dữ liệu/thời gian UI | 4/4 PASS | Ngày không hợp lệ, giờ quá khứ, thứ tự giờ, patch field thực sự đổi, xoá field và số 0 |
| Backend build | PASS | `npm run build` |
| Backend lint | PASS | Ba file production TypeScript có thay đổi |
| Frontend build | PASS | Vite/PWA, output riêng `/tmp/recruitment-verified-build-ya9tJQ`; không ghi đè web đang phục vụ |
| Frontend TypeScript toàn repo | FAIL ngoài phạm vi Recruitment | 18 diagnostic ở các module có sẵn như ExpenseRequest/Teaching; 0 diagnostic tại Recruitment, service Recruitment, route/menu thay đổi |
| Git diff whitespace | PASS | Backend và frontend |

21 kịch bản browser bao phủ phân trang/tìm kiếm vượt 100 hồ sơ, tạo/sửa ứng viên nghi trùng, patch field đã đổi, gắn vị trí, tạo/đóng khung giờ, đặt lịch đúng UTC+7, trạng thái do backend trả, lý do huỷ, sửa tiêu chí, tạm dừng/đóng vị trí, quota hiệu lực, ghi chú xử lý HR, huỷ tin chờ, ba nhánh đối soát UNKNOWN, yêu cầu xoá dữ liệu, quyền chỉ xem và modal trên mobile.

Lệnh chạy lại chính:

```bash
# Backend: chỉ bật PG suite khi URL là DB test riêng đã dựng schema và quyền tương ứng.
RECRUITMENT_HR_TEST_PG_URL=postgresql://postgres@127.0.0.1:<test-port>/g8_hr_test \
  npm test -- --runInBand src/recruitment

# Frontend: worktree kido-app-recruitment-review, dependencies đã được cài.
node --experimental-strip-types --test tests/recruitment-workflow.test.mjs
VITE_API_URL=/__recruitment_test_api node node_modules/vite/bin/vite.js \
  --host 127.0.0.1 --port 4188 --strictPort
# Terminal khác; PLAYWRIGHT_MODULE trỏ tới playwright/playwright-core được cài tại môi trường kiểm thử.
PLAYWRIGHT_MODULE=<absolute-path-to-playwright-core/index.mjs> node tests/recruitment-browser.mjs
```

## Conversation scenarios

- A — strong candidate: chưa chạy lại hội thoại LLM thực trong đợt này. Unit AI và test DB không thay thế nghiệm thu này.
- B — yêu cầu người thật: chưa chạy lại hội thoại LLM thực; giao diện bàn giao được kiểm bằng API giả lập.
- C — thông tin nhạy cảm: chưa chạy lại hội thoại LLM thực; schema tiêu chí hợp lệ và test policy hiện có được giữ nguyên.
- Isolation: chưa chạy lại hai phiên LLM xen kẽ. Bộ lọc danh tính chính xác và cơ chế trusted subject hiện có không bị nới.
- Không gọi Zalo thật, không tạo lượt OpenAI thật trong các kiểm thử mới.

## Database verification

- Candidate: không sửa ứng viên thật; browser dùng dữ liệu tổng hợp. DB test tạo ứng viên giả lập riêng.
- Application: kiểm rollback khi AI xác nhận lỗi audit; trạng thái vẫn QUALIFIED và không bị chuyển bởi lịch đã huỷ.
- Messages: không thay đổi cơ chế lưu tin nhắn. Browser xác minh hợp đồng API huỷ/đối soát; không tuyên bố đã nghiệm thu giao nhận Zalo thật.
- Screening: không đổi thuật toán, trọng số hay quyền ra quyết định; UI chỉ ghi schema `screeningCriteria` hiện có.
- Interview: kiểm khoá đồng thời, số chỗ còn lại, không khôi phục lịch đã huỷ và rollback giao dịch.
- Handoff: resolve nhập ghi chú qua API hiện có; không tự resume AI.
- Audit: PG suite dùng `RecruitmentAuditService.recordMandatory` thật trên quyền `sales_app`, xác minh dòng `INTERVIEW_UPDATE`; lỗi giả lập audit làm rollback DB.
- Không cần migration mới cho phần bổ sung HR trong đợt này. Nhánh backend vẫn chứa migration quota `1794000000000` đã chuẩn bị từ công việc trước, chưa triển khai.

## Security

- Tool allowlist: plugin vẫn có 15 `recruitment_*`; không thêm shell/filesystem/browser/unrestricted messaging cho AI.
- Secrets: không sao chép secret vào report hoặc commit. JWT trong browser test là chuỗi giả lập, không được gửi tới API thật.
- Exposed ports: web kiểm thử và DB Docker chỉ bind `127.0.0.1`; dừng các tài nguyên kiểm thử sau nghiệm thu.
- Giữ nguyên xác thực/role guard phía backend. Kiểm thử browser quyền chỉ xem không được coi là bằng chứng thay thế cho kiểm tra quyền server.

## Commits

- Backend: `8cb2f99` — `release/g8-prod`, worktree `/opt/kido-recruiter/worktrees/g8-prod-release`.
- Frontend: `eb80e80` — `feat/recruitment-workflow-review`, worktree `/opt/kido-recruiter/worktrees/kido-app-recruitment-review`.
- Các WIP ngoài Recruitment tại `/var/www/sales-management` và `/var/www/kido-app` được giữ nguyên.

## Known limitations

- Chưa triển khai backend/frontend mới lên production. Cần dùng cùng phiên bản backend trước khi mở các thao tác UI mới.
- Không coi Vite build PASS là TypeScript toàn repo PASS; 18 lỗi ngoài Recruitment được để nguyên trong phạm vi công việc khác.
- Chưa có nghiệm thu LLM A/B/C/Isolation và Send API thật trên bản mới; staging tool-e2e 20/20 không được chạy lại trong đợt này.
- Yêu cầu xoá dữ liệu chỉ ghi nhận, dừng AI và bàn giao HR theo hợp đồng sẵn có. Chưa bổ sung hard delete/anonymization vì chưa có quy tắc giữ/xoá dữ liệu đã chốt.
- Luồng OFFER/HIRED tiếp tục là quyết định HR qua state machine. Chưa thêm tạo nhân viên/onboarding, thư mời có ký số, nhắc lịch tự gửi hoặc đồng bộ lịch ngoài vì đó là các hợp đồng nghiệp vụ mới.
- Đợt nâng quota 25 tin/5 giờ trước đó vẫn cần quy trình rollout, migration và Owner GO PROD đang có; việc bổ sung HR không tự nâng hạn mức live.

## Status

IMPLEMENTATION REVIEW = COMPLETE — các thiếu hụt xác định trong bảng đã được bổ sung, build và kiểm thử theo phạm vi nêu trên.

PRODUCTION DEPLOYMENT = NOT PERFORMED.

PHASE 2 = BLOCKED — chưa có kết quả hội thoại LLM A/B/C/Isolation và tool-e2e thực của bản này để tái chứng nhận Definition of Done.

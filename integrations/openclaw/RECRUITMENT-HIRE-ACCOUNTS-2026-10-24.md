# Recruitment — chọn chức danh và tạo tài khoản khi tuyển thành công

Ngày: 24/10/2026. Phạm vi triển khai mã nguồn, chưa triển khai production.

## Changes

- Tạo vị trí: chọn chức danh có sẵn từ danh mục server, không nhập quyền tự do. Danh mục 16 chức danh lấy từ các vai trò hiện có ở Nhân viên; không coi nhãn thử việc/khu vực hoặc `dev` là chức danh tuyển dụng.
- Hai API đọc dùng chung danh mục: `GET /recruitment/jobs/positions` và `GET /employees/positions`, giữ guards/nhóm quyền hiện có. Màn Nhân viên ưu tiên danh mục server, giữ fallback cũ khi endpoint chưa rollout.
- Job lưu `positionRole`. Tạo mới bắt buộc chọn; vị trí cũ cần HR gắn thủ công khi sửa, không đoán từ tên. Tên đăng tuyển khi tạo lấy theo lựa chọn, sau đó vẫn sửa nội dung đăng tuyển được.
- “Ứng tuyển thành công” trong bản này = HR chuyển **OFFER → HIRED**. Nộp hồ sơ, HIGH_MATCH hay phỏng vấn không cấp tài khoản. Không mở thêm tool AI và không thay state machine tuyển dụng.
- HR nhập mật khẩu ban đầu và xác nhận quyền tài khoản tại bước tuyển. Server đối chiếu `accountPositionRole` với job đã khoá để từ chối xác nhận quyền cũ nếu chức danh vừa thay đổi.
- Tự tạo Employee từ họ tên, điện thoại, email, phòng ban của vị trí và đúng một role đã chọn. Giáo viên được tạo cả Teacher gắn Employee, trong cùng giao dịch HR duyệt tuyển. Không sao chép CV, dữ liệu nhạy cảm hoặc định danh OA tuyển dụng sang tài khoản/Mini App/OA công ty.
- Lưu liên kết `employeeId` tại ứng viên và hồ sơ. Khoá hồ sơ/ứng viên ngăn hai yêu cầu tạo trùng; retry cùng hồ sơ trả lại tài khoản đã cấp, không đổi mật khẩu/quyền.
- Transaction bao gồm tài khoản, hồ sơ giáo viên nếu có, liên kết, trạng thái, đóng công việc treo và audit bắt buộc. Bất kỳ bước lỗi đều rollback.
- DB giữ liên kết tài khoản một khi đã cấp, chặn snapshot cũ ghi đè mất liên kết và chặn đưa hồ sơ đã gắn tài khoản ra khỏi HIRED.
- Migration: `1794100000000-RecruitmentHireAccounts.ts`. Không backfill chức danh hoặc cấp tài khoản cho HIRED cũ. Down migration từ chối xoá liên kết đã sử dụng; không xoá Employee/Teacher.

## Tests

| Kiểm tra | Kết quả | Phạm vi |
| --- | --- | --- |
| Recruitment Jest, chạy lại không cache | **594 PASS / 31 skipped / 0 FAIL** | 34 suite PASS, 2 suite dispatch PG không bật |
| PG trong tổng trên | **15/15 PASS** | 10 ca tài khoản + 5 ca lịch HR, DB Docker riêng `g8_hr_test`, quyền `sales_app` |
| Unit mới cho chức danh/tài khoản | **25/25 PASS** | Nằm trong tổng Jest, không cộng trùng |
| Trình duyệt | **26/26 PASS**, 0 page errors | Chromium, API mock hoàn toàn; có 5 ca mới về tạo/sửa vị trí và tuyển/cấp tài khoản |
| Helper UI | **4/4 PASS** | Dữ liệu form, kỹ năng và giờ Việt Nam |
| Nest build | PASS | Build worktree riêng |
| Vite/PWA build | PASS | Artifact `/tmp/recruitment-hire-fe-build-20261024`, chưa publish; cảnh báo kích thước chunk có sẵn |
| ESLint | PASS | 12 file production TypeScript của thay đổi Recruitment/catalog/migration |
| Frontend TypeScript toàn repo | **18 lỗi có sẵn ngoài phạm vi** | 0 lỗi tại Recruitment, EmployeeManagement và hai service đã đổi; không tuyên bố toàn repo typecheck PASS |
| Git diff check | PASS | Hai worktree |

Lệnh hồi quy backend:

```bash
RECRUITMENT_HR_TEST_PG_URL=postgresql://postgres@127.0.0.1:<isolated-port>/g8_hr_test \
  npm test -- --no-cache --runInBand recruitment
```

PG suite tự từ chối database ngoài tiền tố test, đồng thời guard Jest chặn `sales_db`. Schema được sao chép **schema-only**, không có dữ liệu production; toàn bộ fixture người dùng giả lập. Những dòng ERROR/WARN về failsafe/auth trong Jest là tình huống lỗi chủ động của mock, không phải thao tác runtime production.

## Conversation scenarios

- A: Không chạy lại hội thoại LLM thực; không thay screening/interview AI.
- B: Không chạy lại hội thoại LLM thực; giữ handoff/AI pause.
- C: Không chạy lại hội thoại LLM thực; không thêm thuộc tính nhạy cảm vào scoring.
- Isolation: Không chạy lại hội thoại LLM thực; giữ identity boundary và session routing.

## Database verification

- Candidate: liên kết đúng Employee, chặn hai hồ sơ cùng ứng viên tạo hai tài khoản; stale writer không xoá được liên kết.
- Application: OFFER → HIRED và `employeeId` cùng commit, retry đồng thời chỉ một tài khoản/một audit cấp tài khoản; stale writer không đổi lại trạng thái tuyển.
- Messages: không gửi hoặc ghi tin nhắn thật trong lượt này; không thay cơ chế persistence.
- Screening: không đổi thuật toán/quyết định.
- Interview: 5 ca PostgreSQL hồi quy lịch HR PASS; không invent lịch hay gọi provider ngoài.
- Handoff: giữ cơ chế đóng công việc khi hồ sơ kết thúc; hồi quy Recruitment PASS.
- Account/Teacher: kiểm hash bcrypt khớp mật khẩu giả lập, role đúng, giáo viên có hồ sơ gắn tài khoản; lỗi audit rollback cả tài khoản/Teacher/liên kết/trạng thái.
- Existing identities: SĐT trùng hoặc email trùng không phân biệt hoa/thường bị từ chối, không tự ghép hoặc nâng quyền tài khoản có sẵn.
- Migration: up, down khi chưa sử dụng và up lại PASS; down sau khi đã cấp tài khoản bị chặn đúng thiết kế.

## Security

- Tool allowlist: không thêm/bỏ tool, không cấp exec/browser/DB hay API tạo tài khoản cho AI. Chỉ actor HR có quyền Recruitment được HIRED/cấp tài khoản.
- Secrets: bcrypt, không mật khẩu mặc định, không trả hash/plaintext qua API; audit nghiệp vụ không chứa mật khẩu, request sanitizer sẵn có che field `password`.
- Credential handoff: HR bàn giao qua kênh riêng. Chưa có gửi invitation, reset một lần hay ép đổi mật khẩu đầu tiên; không tự gửi credential qua Zalo.
- Exposed ports: chỉ localhost cho Vite/test PostgreSQL tạm thời; dừng các dịch vụ test sau kiểm tra. Không đổi cổng hoặc service production.

## Commits

- Chưa tạo commit mới cho thay đổi này.
- Backend worktree: `/opt/kido-recruiter/worktrees/g8-prod-release`, nền `ca07494`.
- Frontend worktree: `/opt/kido-recruiter/worktrees/kido-app-recruitment-review`, nền `eb80e80`.
- Không ghi đè WIP ở `/var/www/sales-management` hoặc `/var/www/kido-app`.

## Known limitations

- **Chưa chạy migration, deploy, restart, gửi tin hoặc tạo tài khoản thật trên production.** Cần review và rollout đồng bộ migration → backend → frontend; API tạo job mới cần `positionRole`, client cũ chưa gửi sẽ bị từ chối.
- Vị trí cũ chưa map cần HR chọn chức danh; vị trí CLOSED giữ chính sách không sửa được. HIRED cũ hoặc ứng viên đã có tài khoản từ lần tuyển khác cần HR đối soát, không tự cấp hồi tố/thêm quyền.
- Tài khoản trùng không tự ghép. Chưa có luồng đối soát/gắn tài khoản có sẵn từ màn Recruitment.
- Hồ sơ Teacher mới chỉ có thông tin liên hệ/liên kết tài khoản; năng lực môn, địa bàn và các thông tin giảng dạy cần bổ sung trong luồng quản lý giáo viên hiện có.
- Chưa kiểm đăng nhập HTTP thực hoặc luồng activation của tài khoản trên production; kiểm chứng credential ở tầng DB/bcrypt và contract UI/API riêng.
- Không đổi cấu hình/hạn mức Zalo hoặc bypass GO/duyệt HR hiện có.

## Status

Yêu cầu chức danh/tài khoản: mã nguồn và kiểm thử trong môi trường riêng đã hoàn tất; chờ review/triển khai production.

**PHASE 2 = BLOCKED** đối với việc chứng nhận lại toàn bộ OpenClaw: chưa chạy lại các hội thoại LLM A/B/C/Isolation trong lượt này; không tự chuyển phase.

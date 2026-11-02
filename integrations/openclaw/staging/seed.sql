-- Dữ liệu mẫu cho DB STAGING (sales_db_staging) — chạy sau 01-schema.sql
-- (schema-only dump của production, không có dữ liệu thật).
--
-- Chỉ phục vụ test OpenClaw → NestJS → PostgreSQL: vài phòng ban, vị trí
-- tuyển dụng và slot phỏng vấn. Không có nhân viên/ứng viên thật.

SET TIME ZONE 'Asia/Ho_Chi_Minh';

INSERT INTO department (id, name) VALUES
  (1, 'Phòng Kinh doanh (staging)'),
  (2, 'Phòng Đào tạo (staging)');
SELECT setval('department_id_seq', 10);

INSERT INTO recruitment_jobs (
  code, title, description, department_id, location, employment_type,
  number_of_positions, salary_min, salary_max, currency, requirements,
  responsibilities, screening_criteria, status, published_at
) VALUES
  (
    'SALES-CM-01',
    'Nhân viên kinh doanh',
    'Tư vấn và chăm sóc các trường học sử dụng chương trình STEM của KIDO tại Cà Mau.',
    1, 'Cà Mau', 'FULL_TIME', 2, 8000000, 15000000, 'VND',
    'Tối thiểu 12 tháng kinh nghiệm bán hàng. Ưu tiên biết dùng CRM.',
    'Tìm kiếm trường mới, chăm sóc trường hiện có, báo cáo tuần.',
    '{"minimumExperienceMonths":12,"requiredSkills":["sales"],"preferredSkills":["CRM"],"locations":["Cà Mau"],"availableImmediatelyPreferred":true}',
    'ACTIVE', now()
  ),
  (
    'GV-STEM-HCM-01',
    'Giáo viên STEM (cộng tác viên)',
    'Giảng dạy STEM/robotics tại các trường tiểu học ở TP. Hồ Chí Minh, trả theo buổi.',
    2, 'TP. Hồ Chí Minh', 'COLLABORATOR', 5, 150000, 250000, 'VND',
    'Có kinh nghiệm đứng lớp. Ưu tiên robotics, Scratch.',
    'Dạy theo giáo án, báo giảng sau mỗi buổi.',
    '{"minimumExperienceMonths":6,"requiredSkills":["giảng dạy"],"preferredSkills":["robotics","scratch"],"locations":["Hồ Chí Minh"],"maxStartDelayDays":14}',
    'ACTIVE', now()
  ),
  (
    'KT-DRAFT-01',
    'Kế toán (nháp — AI không được thấy)',
    'Vị trí nháp để kiểm tra AI không lấy được tin chưa công bố.',
    1, 'Cà Mau', 'FULL_TIME', 1, NULL, NULL, 'VND', NULL, NULL, '{}',
    'DRAFT', NULL
  );

-- Slot phỏng vấn trong tương lai (giờ Việt Nam), tính theo ngày khởi tạo DB.
INSERT INTO recruitment_interview_slots (job_id, start_at, end_at, location, meeting_url, capacity, notes)
SELECT j.id,
       date_trunc('day', now()) + s.day_offset + s.start_time,
       date_trunc('day', now()) + s.day_offset + s.start_time + interval '45 minutes',
       s.location, s.meeting_url, s.capacity, 'seed staging'
FROM recruitment_jobs j
JOIN (VALUES
  ('SALES-CM-01',    interval '2 day', interval '9 hour',  'Văn phòng KIDO Cà Mau', NULL, 1),
  ('SALES-CM-01',    interval '2 day', interval '14 hour', 'Văn phòng KIDO Cà Mau', NULL, 1),
  ('SALES-CM-01',    interval '3 day', interval '9 hour',  NULL, 'https://meet.example.com/kido-staging-1', 2),
  ('GV-STEM-HCM-01', interval '2 day', interval '10 hour', NULL, 'https://meet.example.com/kido-staging-2', 3),
  ('GV-STEM-HCM-01', interval '4 day', interval '15 hour', 'Văn phòng KIDO TP.HCM', NULL, 2)
) AS s(code, day_offset, start_time, location, meeting_url, capacity) ON s.code = j.code;

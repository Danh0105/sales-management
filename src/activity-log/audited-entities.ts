import type { EntityTarget, ObjectLiteral } from 'typeorm';

import { Employee } from '../employee/employee.entity';
import { School } from '../school/schools.entity';
import { SchoolPeriod } from '../school/entities/school-period.entity';
import { Subject } from '../subject/subject.entity';
import { FuelAllowanceTier } from '../teaching/entities/fuel-allowance-tier.entity';
import { SchoolClass } from '../teaching/entities/school-class.entity';
import { Teacher } from '../teaching/entities/teacher.entity';
import { TeachingSchedule } from '../teaching/entities/teaching-schedule.entity';
import { TeachingSession } from '../teaching/entities/teaching-session.entity';

/**
 * Bảng nào so được "trước / sau" khi Giáo vụ hoặc Nhân sự sửa.
 *
 * Cố ý khai tay thay vì suy từ path: đoạn đầu của URL không phải lúc nào cũng
 * là tên bảng, và đoán sai thì sinh ra một câu chuyện sai trong nhật ký — tệ
 * hơn hẳn việc không có dòng "trước / sau" nào. Endpoint không nằm trong đây
 * vẫn được ghi log bình thường, chỉ thiếu phần so sánh.
 */
export const AUDITED_ENTITIES: Record<string, EntityTarget<ObjectLiteral>> = {
  teachers: Teacher,
  employees: Employee,
  'school-classes': SchoolClass,
  'teaching-schedules': TeachingSchedule,
  'teaching-sessions': TeachingSession,
  subjects: Subject,
  schools: School,
  'fuel-allowance-tiers': FuelAllowanceTier,
};

/**
 * Field bỏ qua khi so sánh: dấu thời gian tự đổi mỗi lần lưu (mọi dòng log sẽ
 * có "updatedAt đã đổi", vô nghĩa), và mật khẩu thì không được lộ kể cả dạng hash.
 */
export const DIFF_IGNORED_FIELDS = [
  'updatedAt',
  'updated_at',
  'createdAt',
  'created_at',
  'deletedAt',
  'deleted_at',
  'password',
];

/**
 * Bảng con được chụp cả **danh sách** thay vì một dòng.
 *
 * `PUT /schools/365/periods` ghi đè cả bảng tiết, nhưng bản ghi `schools` thì
 * không đổi một chữ nào — chụp theo id trong path chỉ ra một diff rỗng. Khai ở
 * đây để chụp đúng thứ endpoint thực sự sửa: mảng trước và mảng sau, để nhật ký
 * chỉ ra được "tiết 1: 07:00 → 07:15".
 *
 * `key` là tên field hiện trong `changes`, cố ý trùng tên field trong payload
 * (`periods`) để người đọc đối chiếu được với cột "Dữ liệu mới".
 */
export const AUDITED_SUBCOLLECTIONS: {
  /** Đoạn đầu path. */
  resource: string;
  /** Đoạn sau id: `/schools/365/periods` → `periods`. */
  suffix: string;
  entity: EntityTarget<ObjectLiteral>;
  /** Cột khoá ngoại trỏ về bản ghi cha. */
  parentField: string;
  key: string;
  order?: Record<string, 'ASC' | 'DESC'>;
}[] = [
  {
    resource: 'schools',
    suffix: 'periods',
    entity: SchoolPeriod,
    parentField: 'schoolId',
    key: 'periods',
    order: { periodNo: 'ASC' },
  },
];

/**
 * Quan hệ cần nạp kèm khi chụp bản ghi, theo từng nhóm dữ liệu.
 *
 * Mặc định bản chụp là **phẳng, không quan hệ** — quan hệ đã có ở `context` và
 * kéo vào đây chỉ làm phình log. Ngoại lệ là những bản ghi mà chính id là toàn
 * bộ nội dung: xoá một lịch dạy xong, `beforeData` chỉ còn `schoolId: 448`,
 * `classId: 91` thì không ai dựng lại được đã xoá mất buổi dạy nào — mà các
 * bảng kia thì vẫn còn, không tra ngược được từ log.
 *
 * Quan hệ nạp về được rút gọn thành `schoolName` / `className`… (xem
 * `flattenRelationNames`), nên bản chụp vẫn phẳng.
 */
export const SNAPSHOT_RELATIONS: Record<string, string[]> = {
  'teaching-schedules': ['school', 'class', 'subject', 'teacher'],
  'teaching-sessions': ['school', 'class', 'subject', 'teacher'],
  'school-classes': ['school'],
};

/**
 * Endpoint tạo hàng loạt: chụp **các bản ghi vừa tạo** vào `afterData`.
 *
 * `POST /teaching-schedules/bulk` tạo một lúc hàng chục lịch, mà payload thì
 * gần như không đọc được: mặc định nằm ở cấp lô, override nằm ở từng lớp, và
 * môn thì được tra từ `catalogId` chứ client không hề gửi `subjectId`. Nên đọc
 * lại đúng bản ghi đã lưu theo id trong response, rồi chốt tên.
 *
 * `fields` cố ý là danh sách hẹp: 200 lịch × cả bản ghi thì vượt ngưỡng cắt của
 * `capPayload` và cả dòng log thành `{ _truncated: true }` — thà giữ đúng thứ
 * đọc được: trường nào, lớp nào, môn gì, giáo viên nào, thứ và tiết nào.
 */
export const AUDITED_BULK_CREATES: {
  resource: string;
  suffix: string;
  entity: EntityTarget<ObjectLiteral>;
  relations: string[];
  key: string;
  fields: string[];
  /** Rút id các bản ghi vừa tạo từ response của endpoint. */
  idsOf: (data: any) => number[];
}[] = [
  {
    resource: 'teaching-schedules',
    suffix: 'bulk',
    entity: TeachingSchedule,
    relations: ['school', 'class', 'subject', 'teacher'],
    key: 'schedules',
    fields: [
      'schoolId',
      'schoolName',
      'classId',
      'className',
      'subjectId',
      'subjectName',
      'teacherId',
      'teacherName',
      'dayOfWeek',
      'startTime',
      'endTime',
      'periods',
    ],
    idsOf: (data) =>
      (Array.isArray(data?.results) ? data.results : [])
        .map((row: any) => Number(row?.scheduleId))
        .filter((id: number) => Number.isInteger(id) && id > 0),
  },
];

/**
 * Field kỹ thuật cắt khỏi **từng dòng** của bảng con trước khi so sánh.
 * `DIFF_IGNORED_FIELDS` chỉ bỏ qua được field ở cấp gốc, mà ở đây cả mảng là
 * một field: không cắt thì `updatedAt` của mỗi dòng làm mảng nào cũng "đã đổi".
 */
export const ROW_IGNORED_FIELDS = [...DIFF_IGNORED_FIELDS, 'id'];

/**
 * Nhóm dữ liệu **không** ghi nhật ký.
 *
 * Đây là các endpoint hạ tầng mà người dùng không hề "thao tác": mở app là
 * đăng ký token thông báo, vào màn hình là ping phiên. Ghi hết thì nhật ký
 * đầy rác và thao tác nghiệp vụ thật bị đẩy xuống trang 3.
 */
export const SKIPPED_RESOURCES = [
  'employee-fcm-token',
  'activity-logs',
  'auth',
  'notifications',
  'face',
  'version',
  'zalo',
  'zalo-oa',
  'zalo-token',
  'zalo-location',
  'virtual-tryon',
  'display',
];

/**
 * Đuôi path là **tra cứu** dù gọi bằng POST (payload lọc quá dài cho query
 * string). Tra cứu không đổi dữ liệu nên không thuộc phạm vi nhật ký.
 */
export const LOOKUP_PATH_SUFFIXES = [
  '/candidates',
  '/search',
  '/filter',
  '/preview',
  '/export',
  '/validate',
  '/check',
];

/**
 * Field id trong body → tên quan hệ cần tra. Body của endpoint tạo mới chỉ có
 * `schoolId: 448`, không kèm quan hệ nào; tra sẵn ở đây để nhật ký hiện tên
 * trường thay vì con số người đọc không tra được.
 */
export const ID_FIELD_LOOKUPS: {
  field: string;
  entity: keyof typeof AUDITED_ENTITIES;
  context: string;
}[] = [
  { field: 'schoolId', entity: 'schools', context: 'schoolName' },
  { field: 'classId', entity: 'school-classes', context: 'className' },
  { field: 'subjectId', entity: 'subjects', context: 'subjectName' },
  { field: 'teacherId', entity: 'teachers', context: 'teacherName' },
  { field: 'employeeId', entity: 'employees', context: 'employeeName' },
];

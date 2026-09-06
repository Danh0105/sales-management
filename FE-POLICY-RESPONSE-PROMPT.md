# Prompt FE — xử lý response chính sách

Hãy cập nhật frontend TypeScript để đọc đúng response của module **Chính sách**. Không tự đổi tên field từ API và không dùng chung một interface cho hai endpoint danh sách vì contract của chúng khác nhau.

## 1. Danh sách nhẹ: `GET /policies/all`

Endpoint dùng cho tab **Tất cả chính sách**. Response:

```ts
type PolicyStatus =
  | 'DRAFT'
  | 'PENDING'
  | 'SALE_ADMIN_APPROVED'
  | 'DIRECTOR_APPROVED'
  | 'REJECTED';

interface PolicyPageItem {
  policyId: number;
  policyStatus: PolicyStatus;
  policyCreatedAt: string; // ISO 8601 UTC

  schoolId: number;
  schoolName: string;
  subjectId: number;
  subjectName: string;
  schoolYear: string | null;

  employeeId: number | null;
  employeeName: string | null;
}

interface PolicyPageResponse {
  data: PolicyPageItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

Ví dụ:

```json
{
  "data": [
    {
      "policyId": 1055,
      "policyStatus": "DIRECTOR_APPROVED",
      "policyCreatedAt": "2026-08-04T03:33:58.051Z",
      "schoolId": 529,
      "schoolName": "Trường TEST",
      "subjectId": 795,
      "subjectName": "Toán",
      "schoolYear": "2026-2027",
      "employeeId": 28,
      "employeeName": "Nguyễn Văn A"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 12,
    "total": 1,
    "totalPages": 1
  }
}
```

Khi không có dữ liệu:

```json
{
  "data": [],
  "pagination": { "page": 1, "limit": 12, "total": 0, "totalPages": 0 }
}
```

Endpoint này **không trả** `policyData`, `status`, `createdAt` hay `meta`. Dùng chính xác `policyStatus`, `policyCreatedAt` và `pagination`.

## 2. Danh sách đầy đủ: `GET /policies/admin/all`

Endpoint dùng khi FE cần tìm kiếm, sắp xếp hoặc hiển thị dữ liệu tính toán trong chính sách.

```ts
type PolicyData = Record<string, unknown>;

interface PolicyListItem {
  policyId: number;
  status: PolicyStatus;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC

  employeeId: number | null;
  employeeName: string | null;
  schoolId: number;
  schoolName: string;
  subjectId: number;
  subjectName: string;
  schoolYear: string | null;
  contractNumber: string | null;
  studentCount: number | null;
  totalLessons: number | null;

  policyData: PolicyData | null;
  currentHistoryId: number | null;
}

interface PolicyListResponse {
  data: PolicyListItem[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
}
```

Ví dụ:

```json
{
  "data": [
    {
      "policyId": 1055,
      "status": "DIRECTOR_APPROVED",
      "createdAt": "2026-08-04T03:33:58.051Z",
      "updatedAt": "2026-08-05T02:12:10.000Z",
      "employeeId": 28,
      "employeeName": "Nguyễn Văn A",
      "schoolId": 529,
      "schoolName": "Trường TEST",
      "subjectId": 795,
      "subjectName": "Toán",
      "schoolYear": "2026-2027",
      "contractNumber": "T795|2026",
      "studentCount": 30,
      "totalLessons": 30,
      "policyData": {
        "fee": 600000,
        "durationMonths": 9,
        "studentPerClass": 36,
        "companyProfit": 1200000,
        "companyProfitPerHS": 40000,
        "csvc": 200000,
        "thue": 20000,
        "ttcs": [],
        "httienmat": [],
        "htthietbi": []
      },
      "currentHistoryId": 1146
    }
  ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1,
    "hasNextPage": false,
    "hasPreviousPage": false
  }
}
```

`policyData` là JSON động được lưu nguyên vẹn từ chính sách. Chỉ truy cập một thuộc tính sau khi kiểm tra kiểu; không giả định mọi bản ghi đều có đủ `fee`, `durationMonths`, `ttcs`, `httienmat` hoặc `htthietbi`.

## 3. Tùy chọn bộ lọc: `GET /policies/filter-options`

```ts
interface PolicyFilterOptions {
  statuses: Array<{ value: PolicyStatus; label: string }>;
  schools: Array<{ id: number; name: string }>;
  subjects: Array<{ id: number; name: string }>;
  schoolYears: string[];
  employees: Array<{ id: number; name: string | null }>;
}
```

FE dùng `statuses[].label` do backend trả về, không cần tự tạo lại nhãn trạng thái.

## 4. Chi tiết: `GET /policies/:id`

Endpoint chi tiết trả entity chính sách cùng quan hệ `subject`:

```ts
interface PolicyDetail {
  id: number;
  subjectId: number;
  subject: Record<string, unknown>;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  status: PolicyStatus;
  note: string | null;
  currentHistoryId: number | null;
  durationMonths: number | null;
}
```

Lưu ý endpoint chi tiết dùng `id` và `data`, trong khi danh sách dùng `policyId` và danh sách đầy đủ dùng `policyData`.

## 5. Yêu cầu triển khai FE

- Khai báo riêng `PolicyPageResponse`, `PolicyListResponse` và `PolicyDetail`.
- Không dùng `any`; với JSON động dùng `Record<string, unknown>` và type guard.
- Hiển thị `—` cho các giá trị `null`; không ép `null` thành `0` hoặc chuỗi rỗng.
- Parse thời gian ISO bằng thư viện ngày hiện có và hiển thị theo múi giờ Việt Nam.
- Khi đổi filter, đưa `page` về `1`.
- Khi response có `totalPages = 0`, tắt điều hướng phân trang và hiển thị empty state.
- Điều hướng tới chi tiết bằng `policyId`: `/director/policy/${policyId}`.
- Map badge trạng thái theo `PolicyStatus`; ưu tiên nhãn từ `/policies/filter-options`.
- Không đọc số tiền từ trường cấp cao của item danh sách. Các dữ liệu tài chính (nếu có) nằm trong `policyData`/`data`.

Mục tiêu hoàn thành: UI render đúng cả response có dữ liệu, response rỗng và các field `null`, không nhầm `pagination` với `meta`, không nhầm `policyStatus` với `status`.

import { PolicyStatus } from '../policy.enum';

/**
 * Schema thống nhất cho danh sách chính sách — FE không cần normalize.
 * Không đổi tên trường giữa các endpoint: policyId / status / createdAt / employeeName.
 */
export interface PolicyListItem {
    policyId: number;
    status: PolicyStatus;
    /** ISO 8601, ví dụ "2026-08-04T08:30:00.000Z". */
    createdAt: string;
    updatedAt: string;

    /** null khi trường chưa được gán nhân viên phụ trách. */
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

    policyData: Record<string, any> | null;

    currentHistoryId: number | null;
}

export interface PaginationMeta {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
}

export interface PolicyListResponse {
    data: PolicyListItem[];
    meta: PaginationMeta;
}

/**
 * Item của GET /policies/all — tiền tố `policy*` theo đúng contract FE chốt
 * cho tab "Tất cả chính sách". Khác với PolicyListItem của /policies/admin/all
 * (dùng `status` / `createdAt` và có thêm policyData); hai endpoint không trộn tên.
 */
export interface PolicyPageItem {
    policyId: number;
    policyStatus: PolicyStatus;
    /** ISO 8601, ví dụ "2026-08-04T08:30:00.000Z". */
    policyCreatedAt: string;

    schoolId: number;
    schoolName: string;

    subjectId: number;
    subjectName: string;
    schoolYear: string | null;

    employeeId: number | null;
    employeeName: string | null;
}

export interface PolicyPagination {
    page: number;
    limit: number;
    total: number;
    /** 0 khi total = 0. */
    totalPages: number;
}

export interface PolicyPageResponse {
    data: PolicyPageItem[];
    pagination: PolicyPagination;
}

export interface PolicyFilterOptions {
    statuses: { value: PolicyStatus; label: string }[];
    schools: { id: number; name: string }[];
    subjects: { id: number; name: string }[];
    schoolYears: string[];
    employees: { id: number; name: string | null }[];
}

export const POLICY_STATUS_LABELS: Record<PolicyStatus, string> = {
    [PolicyStatus.DRAFT]: 'Nháp',
    [PolicyStatus.PENDING]: 'Chờ duyệt',
    [PolicyStatus.SALE_ADMIN_APPROVED]: 'Sale admin đã duyệt',
    [PolicyStatus.DIRECTOR_APPROVED]: 'Giám đốc đã duyệt',
    [PolicyStatus.REJECTED]: 'Từ chối',
};

import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Sĩ số lưu khi báo giảng.
 * - Mini App mới gửi tổng sĩ số + họ tên học sinh vắng: server tự tính sĩ số
 *   thực tế = tổng − số vắng (không tin số client gửi). Số vắng > tổng → 400.
 * - Bản cũ chỉ gửi sĩ số thực tế: giữ nguyên, hai trường mới để null.
 */
export function lessonStudentCounts(dto: {
  actualStudentCount: number;
  totalStudentCount?: number | null;
  absentStudentNames?: string[] | null;
}): {
  actualStudentCount: number;
  totalStudentCount: number | null;
  absentStudentNames: string[] | null;
} {
  if (dto.totalStudentCount === undefined || dto.totalStudentCount === null) {
    return {
      actualStudentCount: dto.actualStudentCount,
      totalStudentCount: null,
      absentStudentNames: null,
    };
  }
  const absent = dto.absentStudentNames ?? [];
  if (absent.length > dto.totalStudentCount) {
    throw new HttpException(
      {
        statusCode: 400,
        code: 'TEACHING_SESSION_LESSON_ABSENT_EXCEEDS_TOTAL',
        message: 'Số học sinh vắng không được vượt quá tổng sĩ số lớp.',
      },
      HttpStatus.BAD_REQUEST,
    );
  }
  return {
    actualStudentCount: dto.totalStudentCount - absent.length,
    totalStudentCount: dto.totalStudentCount,
    absentStudentNames: absent,
  };
}

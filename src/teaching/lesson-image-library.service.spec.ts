import { BadRequestException } from '@nestjs/common';
import { LessonImageLibraryService } from './lesson-image-library.service';

describe('LessonImageLibraryService', () => {
  const row = {
    id: 31, url: '/uploads/lesson-images/a.webp',
    thumbnailUrl: '/uploads/lesson-images/thumb/a.webp',
    createdAt: '2026-09-10T01:00:00.000Z', type: 'LESSON_REPORT',
    sessionId: 9, date: '2026-09-09', startTime: '14:15:00', endTime: '15:00:00',
    status: 'PRESENT', teacherId: 4, teacherName: 'Nguyen A',
    schoolId: 8, schoolName: 'School', schoolLocationId: null,
    schoolLocationName: null, className: '3A1', subjectName: 'Life skills',
    provinceId: 6, provinceName: 'HCM',
  };

  it('paginates image rows and applies the JWT teacher scope in SQL', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([{ total: 31, teachersWithImages: 2, schoolsWithImages: 3 }]);
    const service = new LessonImageLibraryService(
      { query } as never,
      {
        ensureThumbnail: jest.fn().mockResolvedValue(row.thumbnailUrl),
        publicUrl: jest.fn((url) => url),
      } as never,
    );

    const result = await service.findAll(
      { page: 2, limit: 30, sortBy: 'createdAt', sortOrder: 'DESC' },
      { kind: 'self', employeeId: 77 },
    );

    expect(result.data).toHaveLength(1);
    expect(result.pagination).toEqual(expect.objectContaining({ total: 31, totalPages: 2, hasPrevPage: true }));
    expect(query.mock.calls[0][0]).toContain('t.employee_id = $1');
    expect(query.mock.calls[0][0]).toContain('ORDER BY li.created_at DESC, li.id DESC');
    expect(query.mock.calls[0][1]).toEqual([77, 30, 30]);
  });

  it('rejects an inverted date range before querying', async () => {
    const service = new LessonImageLibraryService({ query: jest.fn() } as never, {} as never);
    await expect(service.findAll(
      { fromDate: '2026-09-10', toDate: '2026-09-09', page: 1, limit: 30, sortBy: 'createdAt', sortOrder: 'DESC' },
      { kind: 'manage' },
    )).rejects.toBeInstanceOf(BadRequestException);
  });
});

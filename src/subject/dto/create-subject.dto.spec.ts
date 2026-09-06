import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateSubjectDto } from './create-subject.dto';

const pipe = new ValidationPipe({ whitelist: true, transform: true });
const transform = (value: Record<string, unknown>) =>
    pipe.transform(value, { type: 'body', metatype: CreateSubjectDto, data: '' });

const validSubject = {
    catalogId: 1,
    schoolId: 10,
};

describe('Đơn giá mỗi tiết của môn học (CreateSubjectDto)', () => {
    it('ép kiểu chuỗi số từ form', async () => {
        const result: any = await transform({
            ...validSubject,
            ratePerPeriod: '150000',
        });
        expect(result.ratePerPeriod).toBe(150_000);
    });

    it.each([
        ['âm', -1],
        ['quá 2 chữ số thập phân', 150_000.123],
        ['vượt trần', 200_000_000],
    ])('400 khi đơn giá %s', async (_label, ratePerPeriod) => {
        await expect(
            transform({ ...validSubject, ratePerPeriod }),
        ).rejects.toBeInstanceOf(BadRequestException);
    });
});

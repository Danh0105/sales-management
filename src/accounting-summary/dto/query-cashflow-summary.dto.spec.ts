import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QueryCashflowSummaryDto } from './query-cashflow-summary.dto';

describe('QueryCashflowSummaryDto', () => {
  it('chuyển query string hợp lệ sang đúng kiểu dữ liệu', async () => {
    const dto = plainToInstance(QueryCashflowSummaryDto, {
      year: '2026',
      month: '10',
      schoolId: '2',
      subjectId: '7',
      finalized: 'false',
    });

    await expect(validate(dto)).resolves.toEqual([]);
    expect(dto).toMatchObject({
      year: 2026,
      month: 10,
      schoolId: 2,
      subjectId: 7,
      finalized: false,
    });
  });

  it('từ chối tháng và boolean không hợp lệ', async () => {
    const dto = plainToInstance(QueryCashflowSummaryDto, {
      month: '13',
      finalized: 'yes',
    });

    const errors = await validate(dto);
    expect(errors.map((error) => error.property).sort()).toEqual([
      'finalized',
      'month',
    ]);
  });
});

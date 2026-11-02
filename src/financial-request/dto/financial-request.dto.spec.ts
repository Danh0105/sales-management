import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { SavePayeeProfileDto } from './financial-request.dto';

const errorsOf = async (body: Record<string, unknown>) =>
  (
    await validate(plainToInstance(SavePayeeProfileDto, body), {
      whitelist: true,
    })
  ).map((e) => e.property);

describe('SavePayeeProfileDto', () => {
  it('dùng cùng ràng buộc với thông tin nhận tiền trên phiếu', async () => {
    expect(
      await errorsOf({
        payeeName: 'Nguyễn Văn A',
        bankAccountHolder: 'NGUYEN VAN A',
        bankName: 'VCB',
        bankAccountNumber: '0011223344',
      }),
    ).toEqual([]);
    expect(await errorsOf({ bankAccountNumber: '12' })).toEqual([
      'bankAccountNumber',
    ]);
    expect(await errorsOf({ bankName: 'x'.repeat(256) })).toEqual([
      'bankName',
    ]);
    // Ô để trống được lưu là chưa có.
    expect(await errorsOf({ bankAccountNumber: '' })).toEqual([]);
  });
});

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateEmployeeDto } from './dto/create-employee.dto';
import { UpdateEmployeeDto } from './dto/update-employee.dto';

describe('Thông tin tài khoản ngân hàng nhân viên', () => {
  it('giữ số 0 đầu và cắt khoảng trắng khi tạo', async () => {
    const dto = plainToInstance(CreateEmployeeDto, {
      name: 'Nguyễn Thế Phan',
      bankAccountNumber: ' 0914732580 ',
      bankName: ' MB - Ngân hàng TMCP Quân Đội ',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.bankAccountNumber).toBe('0914732580');
    expect(dto.bankName).toBe('MB - Ngân hàng TMCP Quân Đội');
  });

  it('đổi chuỗi trống thành null để có thể xoá thông tin', async () => {
    const dto = plainToInstance(UpdateEmployeeDto, {
      bankAccountNumber: '   ',
      bankName: '',
    });

    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.bankAccountNumber).toBeNull();
    expect(dto.bankName).toBeNull();
  });
});

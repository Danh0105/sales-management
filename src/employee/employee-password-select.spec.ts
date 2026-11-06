import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { getMetadataArgsStorage } from 'typeorm';

import { Employee } from './employee.entity';
import { EmployeeService } from './employee.service';

const makeService = (user: Partial<Employee> | null) => {
  const qb = {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(user),
  };
  const repo = {
    createQueryBuilder: jest.fn(() => qb),
    save: jest.fn(async (row: unknown) => row),
    findOne: jest.fn(),
  };
  const service = Object.create(EmployeeService.prototype) as EmployeeService;
  (service as unknown as { repo: typeof repo }).repo = repo;
  return { service, repo, qb };
};

describe('Hash mật khẩu nhân viên', () => {
  it('cột password không được đọc mặc định', () => {
    const column = getMetadataArgsStorage().columns.find(
      (c) => c.target === Employee && c.propertyName === 'password',
    );
    expect(column?.options.select).toBe(false);
  });

  it('đăng nhập vẫn đọc được hash, nếu thiếu thì mọi người sẽ bị báo sai mật khẩu', async () => {
    const user = { id: 1, phone: '0900', password: 'hash' };
    const { service, qb } = makeService(user);
    await expect(service.findByPhone('0900')).resolves.toBe(user);
    expect(qb.addSelect).toHaveBeenCalledWith('employee.password');
    expect(qb.where).toHaveBeenCalledWith('employee.phone = :phone', {
      phone: '0900',
    });
  });

  describe('đổi mật khẩu', () => {
    const dto = { oldPassword: 'cu-123456', newPassword: 'moi-123456' };

    it('đọc hash để so mật khẩu cũ rồi lưu hash mới', async () => {
      const user = {
        id: 1,
        password: await bcrypt.hash(dto.oldPassword, 4),
      } as Employee;
      const { service, repo, qb } = makeService(user);
      await expect(service.changePassword(1, dto)).resolves.toEqual({
        message: 'Password changed successfully',
      });
      expect(qb.addSelect).toHaveBeenCalledWith('employee.password');
      expect(repo.save).toHaveBeenCalledTimes(1);
      expect(await bcrypt.compare(dto.newPassword, user.password!)).toBe(true);
    });

    it('sai mật khẩu cũ thì từ chối, không lưu', async () => {
      const { service, repo } = makeService({
        id: 1,
        password: await bcrypt.hash('khac-123456', 4),
      });
      await expect(service.changePassword(1, dto)).rejects.toThrow(
        BadRequestException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('tài khoản chưa có mật khẩu thì từ chối', async () => {
      const { service } = makeService({ id: 1, password: undefined });
      await expect(service.changePassword(1, dto)).rejects.toThrow(
        'User chưa có mật khẩu',
      );
    });
  });
});

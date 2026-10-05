import { ConflictException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Employee } from '../../employee/employee.entity';
import { EmployeeService } from '../../employee/employee.service';
import { HrAccessSafetyService } from './hr-access-safety.service';

/**
 * EmployeeService (module cũ) chỉ đi qua HrAccessSafetyService khi KHOÁ một
 * tài khoản đang active hoặc XOÁ tài khoản. Mọi cập nhật khác chạy như trước.
 */
function setup(current: Partial<Employee> = { id: 7, isActive: true }) {
  const repo = {
    findOne: jest.fn(() => Promise.resolve({ ...current })),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    delete: jest.fn(),
  };
  const storage = {
    store: jest.fn(() => Promise.resolve('/uploads/avatars/new.webp')),
    remove: jest.fn(() => Promise.resolve()),
  };
  const txManager = {
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    delete: jest.fn(() => Promise.resolve({ affected: 1 })),
  };
  const hrSafety = {
    guardAccountRemoval: jest.fn(
      (
        _id: number,
        _op: string,
        _actor: unknown,
        write: (m: EntityManager) => Promise<unknown>,
      ) => write(txManager as unknown as EntityManager),
    ),
  };
  const service = new EmployeeService(
    repo as never,
    {} as never,
    storage as never,
    hrSafety as unknown as HrAccessSafetyService,
  );
  return { service, repo, storage, txManager, hrSafety };
}

const actor = { accountId: 158, name: 'HR', roles: ['nhansu'] };

describe('EmployeeService — khoá/xoá tài khoản qua HrAccessSafetyService', () => {
  it('khoá tài khoản đang active → đi qua guard, ghi bằng manager của transaction', async () => {
    const { service, repo, txManager, hrSafety } = setup();
    await service.update(7, { isActive: false }, undefined, actor);
    expect(hrSafety.guardAccountRemoval).toHaveBeenCalledWith(
      7,
      'deactivate',
      actor,
      expect.any(Function),
    );
    expect(txManager.update).toHaveBeenCalledWith(Employee, 7, {
      isActive: false,
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('guard trả 409 → không khoá, dọn ảnh vừa upload, ném lỗi ra ngoài', async () => {
    const { service, repo, storage, hrSafety } = setup();
    hrSafety.guardAccountRemoval.mockRejectedValueOnce(
      new ConflictException('Cannot deactivate this account'),
    );
    await expect(
      service.update(
        7,
        { isActive: false },
        { buffer: Buffer.from('x') } as never,
        actor,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repo.update).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith('/uploads/avatars/new.webp');
  });

  it('cập nhật thường (tên, SĐT...) → như cũ, không qua guard', async () => {
    const { service, repo, hrSafety } = setup();
    await service.update(7, { name: 'Tên mới' });
    expect(repo.update).toHaveBeenCalledWith(7, { name: 'Tên mới' });
    expect(hrSafety.guardAccountRemoval).not.toHaveBeenCalled();
  });

  it('mở khoá (isActive: true) → như cũ, không qua guard', async () => {
    const { service, repo, hrSafety } = setup({ id: 7, isActive: false });
    await service.update(7, { isActive: true });
    expect(repo.update).toHaveBeenCalledWith(7, { isActive: true });
    expect(hrSafety.guardAccountRemoval).not.toHaveBeenCalled();
  });

  it('gửi isActive: false cho tài khoản ĐÃ khoá → không phải thao tác khoá mới, như cũ', async () => {
    const { service, repo, hrSafety } = setup({ id: 7, isActive: false });
    await service.update(7, { isActive: false, name: 'x' });
    expect(repo.update).toHaveBeenCalled();
    expect(hrSafety.guardAccountRemoval).not.toHaveBeenCalled();
  });

  it('xoá tài khoản → đi qua guard với operation delete', async () => {
    const { service, txManager, hrSafety } = setup();
    await service.remove(7, actor);
    expect(hrSafety.guardAccountRemoval).toHaveBeenCalledWith(
      7,
      'delete',
      actor,
      expect.any(Function),
    );
    expect(txManager.delete).toHaveBeenCalledWith(Employee, 7);
  });

  it('thiếu HrAccessSafetyService (khởi tạo tay) mà khoá → fail-closed, không ghi', async () => {
    const repo = {
      findOne: jest.fn(() => Promise.resolve({ id: 7, isActive: true })),
      update: jest.fn(),
    };
    const service = new EmployeeService(
      repo as never,
      {} as never,
      {
        remove: jest.fn(),
      } as never,
    );
    await expect(service.update(7, { isActive: false })).rejects.toThrow(
      'chưa được inject',
    );
    expect(repo.update).not.toHaveBeenCalled();
  });
});

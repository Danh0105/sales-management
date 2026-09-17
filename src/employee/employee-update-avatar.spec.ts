import { NotFoundException } from '@nestjs/common';
import { EmployeeService } from './employee.service';

/**
 * Tái hiện lỗi 12/9/2026: trang hồ sơ gửi multipart có `avatar`, backend
 * không parse → body rỗng → `repo.update(id, {})` nổ UpdateValuesMissingError.
 */
describe('EmployeeService.update — avatar', () => {
  const file = { buffer: Buffer.from('img'), mimetype: 'image/png' } as never;

  function make(existing: Record<string, unknown> | null) {
    const repo = {
      findOne: jest.fn().mockResolvedValue(existing),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const storage = {
      store: jest.fn().mockResolvedValue('/uploads/avatars/new.webp'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const service = new EmployeeService(repo as never, {} as never, storage as never);
    return { service, repo, storage };
  }

  it('lưu ảnh, ghi avatarUrl, rồi mới xoá ảnh cũ', async () => {
    const { service, repo, storage } = make({
      id: 158,
      avatarUrl: '/uploads/avatars/old.webp',
    });

    await service.update(158, { name: 'Trúc' } as never, file);

    expect(storage.store).toHaveBeenCalledWith(file);
    expect(repo.update).toHaveBeenCalledWith(158, {
      name: 'Trúc',
      avatarUrl: '/uploads/avatars/new.webp',
    });
    expect(storage.remove).toHaveBeenCalledWith('/uploads/avatars/old.webp');
    // Xoá cũ phải SAU khi ghi DB thành công.
    expect(repo.update.mock.invocationCallOrder[0]).toBeLessThan(
      storage.remove.mock.invocationCallOrder[0],
    );
  });

  it('ghi DB hỏng thì xoá ảnh mới, giữ ảnh cũ', async () => {
    const { service, repo, storage } = make({ id: 158, avatarUrl: '/uploads/avatars/old.webp' });
    repo.update.mockRejectedValue(new Error('db down'));

    await expect(service.update(158, {} as never, file)).rejects.toThrow('db down');

    expect(storage.remove).toHaveBeenCalledTimes(1);
    expect(storage.remove).toHaveBeenCalledWith('/uploads/avatars/new.webp');
  });

  it('body rỗng không có ảnh → không gọi update, không 500', async () => {
    const { service, repo } = make({ id: 158, name: 'Trúc' });

    const result = await service.update(158, {} as never);

    expect(repo.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: 158, name: 'Trúc' });
  });

  it('không có nhân viên → 404, không lưu ảnh', async () => {
    const { service, storage } = make(null);
    await expect(service.update(999, {} as never, file)).rejects.toThrow(NotFoundException);
    expect(storage.store).not.toHaveBeenCalled();
  });
});

describe('EmployeeService.findOne — trang cá nhân', () => {
  it('trả avatarUrl để FE render sau reload', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue({ id: 158 }) };
    const service = new EmployeeService(repo as never, {} as never, {} as never);
    await service.findOne(158);
    const select = repo.findOne.mock.calls[0][0].select as string[];
    expect(select).toContain('avatarUrl');
    expect(select).not.toContain('password');
  });
});

import { In } from 'typeorm';
import { EmployeeFcmTokenService } from './employee-fcm-token.service';

/**
 * Hỗ trợ nhiều thiết bị/nhân viên: mỗi thiết bị một token riêng, không có
 * ràng buộc "1 token / nhân viên" nào ở tầng ứng dụng.
 */
describe('EmployeeFcmTokenService', () => {
  function makeService(existing: any = null) {
    const repo: any = {
      findOne: jest.fn().mockResolvedValue(existing),
      save: jest.fn(async (data: any) => ({ id: 1, ...data })),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
    };
    const service = new EmployeeFcmTokenService(repo);
    return { service, repo };
  }

  describe('saveToken', () => {
    it('thiết bị mới (token chưa từng có) thì tạo dòng mới, không đụng thiết bị khác', async () => {
      const { service, repo } = makeService(null);

      await service.saveToken(5, 'token-device-b', 'android');

      expect(repo.findOne).toHaveBeenCalledWith({ where: { token: 'token-device-b' } });
      expect(repo.save).toHaveBeenCalledWith({
        employeeId: 5,
        token: 'token-device-b',
        platform: 'android',
      });
    });

    it('cùng nhân viên đăng nhập thiết bị thứ hai: token cũ (thiết bị A) không bị xoá/sửa', async () => {
      // saveToken tra theo `token`, không theo `employeeId` — token khác nhau
      // thì không bao giờ chạm vào dòng của thiết bị kia.
      const { service, repo } = makeService(null);

      await service.saveToken(5, 'token-device-a', 'ios');
      await service.saveToken(5, 'token-device-b', 'android');

      expect(repo.findOne).toHaveBeenNthCalledWith(1, { where: { token: 'token-device-a' } });
      expect(repo.findOne).toHaveBeenNthCalledWith(2, { where: { token: 'token-device-b' } });
      expect(repo.save).toHaveBeenCalledTimes(2);
    });

    it('token đã tồn tại (thiết bị dùng chung/cài lại) thì chuyển quyền sở hữu sang nhân viên mới', async () => {
      const existing = { id: 9, employeeId: 3, token: 'shared-token', platform: 'ios' };
      const { service, repo } = makeService(existing);

      const result = await service.saveToken(5, 'shared-token', 'android');

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 9, employeeId: 5, platform: 'android' }),
      );
      expect((result as any).employeeId).toBe(5);
    });

    it('không gửi platform mới thì giữ platform cũ khi chuyển quyền sở hữu', async () => {
      const existing = { id: 9, employeeId: 3, token: 'shared-token', platform: 'ios' };
      const { service, repo } = makeService(existing);

      await service.saveToken(5, 'shared-token');

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ platform: 'ios' }),
      );
    });
  });

  describe('getTokens', () => {
    it('trả về TẤT CẢ token của mọi thiết bị cho danh sách nhân viên — không cắt còn 1 token/người', async () => {
      const rows = [
        { id: 1, employeeId: 5, token: 'a-ios' },
        { id: 2, employeeId: 5, token: 'a-android' },
        { id: 3, employeeId: 6, token: 'b-web' },
      ];
      const { service, repo } = makeService();
      repo.find.mockResolvedValue(rows);

      const result = await service.getTokens([5, 6]);

      expect(repo.find).toHaveBeenCalledWith({
        where: { employeeId: In([5, 6]) },
      });
      expect(result).toHaveLength(3);
      expect(result.filter((r: any) => r.employeeId === 5)).toHaveLength(2);
    });
  });

  describe('removeInvalidTokens', () => {
    it('không gọi DB khi danh sách rỗng', async () => {
      const { service, repo } = makeService();
      await service.removeInvalidTokens([]);
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('xoá đúng các token đã cho, không ảnh hưởng token còn hợp lệ', async () => {
      const { service, repo } = makeService();
      await service.removeInvalidTokens(['dead-1', 'dead-2']);
      expect(repo.delete).toHaveBeenCalledWith({
        token: In(['dead-1', 'dead-2']),
      });
    });
  });

  describe('removeToken', () => {
    it('gỡ đúng 1 thiết bị của đúng nhân viên (dùng lúc đăng xuất)', async () => {
      const { service, repo } = makeService();
      await service.removeToken(5, 'token-device-a');
      expect(repo.delete).toHaveBeenCalledWith({ employeeId: 5, token: 'token-device-a' });
    });
  });
});

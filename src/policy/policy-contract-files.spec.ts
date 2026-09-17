import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MAX_CONTRACT_FILES, PolicyService } from './policy.service';
import { PolicyStatus } from './policy.enum';

const pdf = (name: string) =>
  ({ originalname: name, size: 1234, buffer: Buffer.from('%PDF-1.4') }) as never;

function make(policy: Record<string, unknown>) {
  const service = Object.create(PolicyService.prototype) as PolicyService;
  const repo = { save: jest.fn(async (p: unknown) => p) };
  const storage = {
    store: jest.fn(async (f: { originalname: string }) => ({
      url: `/uploads/policy-contracts/${f.originalname}`,
      originalName: f.originalname,
    })),
    remove: jest.fn(async () => undefined),
  };
  Object.assign(service, {
    policyRepo: repo,
    contractStorage: storage,
    findOne: jest.fn(async () => policy),
  });
  return { service, repo, storage, policy };
}

const approved = () => ({ id: 1, status: PolicyStatus.DIRECTOR_APPROVED, contractFiles: null });
const uploader = { id: 9, name: 'Sales Admin' };

describe('PolicyService — nhiều hợp đồng PDF', () => {
  it('upload nhiều file một lần, nối vào danh sách', async () => {
    const { service, storage } = make(approved());
    const saved = (await service.uploadContract(1, [pdf('hd.pdf'), pdf('phuluc.pdf')], uploader)) as never as {
      contractFiles: { originalName: string; category?: string }[];
      contractFileName: string;
    };
    expect(storage.store).toHaveBeenCalledTimes(2);
    expect(saved.contractFiles.map((f) => f.originalName)).toEqual(['hd.pdf', 'phuluc.pdf']);
    // Cột đơn phản chiếu file mới nhất cho FE cũ.
    expect(saved.contractFileName).toBe('phuluc.pdf');
  });

  it('không gửi category -> mặc định CONTRACT', async () => {
    const { service } = make(approved());
    const saved = (await service.uploadContract(1, pdf('a.pdf'), uploader)) as never as {
      contractFiles: { category?: string }[];
    };
    expect(saved.contractFiles[0].category).toBe('CONTRACT');
  });

  it('category không hợp lệ -> mặc định CONTRACT, không reject request', async () => {
    const { service } = make(approved());
    const saved = (await service.uploadContract(1, pdf('a.pdf'), uploader, 'NOT_A_CATEGORY')) as never as {
      contractFiles: { category?: string }[];
    };
    expect(saved.contractFiles[0].category).toBe('CONTRACT');
  });

  it('upload với category BBCS thì lưu đúng category cho cả batch', async () => {
    const { service } = make(approved());
    const saved = (await service.uploadContract(1, [pdf('a.pdf'), pdf('b.pdf')], uploader, 'BBCS')) as never as {
      contractFiles: { category?: string }[];
    };
    expect(saved.contractFiles.every((f) => f.category === 'BBCS')).toBe(true);
  });

  it('upload với category HANDOVER_IMAGE thì lưu đúng category', async () => {
    const { service } = make(approved());
    const saved = (await service.uploadContract(1, pdf('a.jpg'), uploader, 'HANDOVER_IMAGE')) as never as {
      contractFiles: { category?: string }[];
    };
    expect(saved.contractFiles[0].category).toBe('HANDOVER_IMAGE');
  });

  it('upload thêm không xoá file cũ', async () => {
    const { service, storage } = make({
      ...approved(),
      contractFiles: [{ id: 'a', url: '/uploads/policy-contracts/cu.pdf', originalName: 'cu.pdf', size: 1, uploadedById: 1, uploadedAt: '2026-09-01T00:00:00Z' }],
    });
    const saved = (await service.uploadContract(1, pdf('moi.pdf'), uploader)) as never as { contractFiles: unknown[] };
    expect(saved.contractFiles).toHaveLength(2);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('bản ghi cũ chỉ có cột đơn được giữ làm phần tử đầu', async () => {
    const { service } = make({
      ...approved(),
      contractFileUrl: '/uploads/policy-contracts/legacy.pdf',
      contractFileName: 'legacy.pdf',
      contractUploadedById: 3,
      contractUploadedAt: new Date('2026-08-01T00:00:00Z'),
    });
    const saved = (await service.uploadContract(1, pdf('moi.pdf'), uploader)) as never as {
      contractFiles: { originalName: string }[];
    };
    expect(saved.contractFiles.map((f) => f.originalName)).toEqual(['legacy.pdf', 'moi.pdf']);
  });

  it('vượt tối đa thì từ chối, không lưu file nào', async () => {
    const existing = Array.from({ length: MAX_CONTRACT_FILES }, (_, i) => ({
      id: String(i), url: `/u/${i}.pdf`, originalName: `${i}.pdf`, size: 1, uploadedById: 1, uploadedAt: 'x',
    }));
    const { service, storage } = make({ ...approved(), contractFiles: existing });
    await expect(service.uploadContract(1, pdf('x.pdf'), uploader)).rejects.toThrow(BadRequestException);
    expect(storage.store).not.toHaveBeenCalled();
  });

  it('ghi DB hỏng thì xoá đúng các file vừa lưu', async () => {
    const { service, repo, storage } = make(approved());
    repo.save.mockRejectedValue(new Error('db down'));
    await expect(service.uploadContract(1, [pdf('a.pdf'), pdf('b.pdf')], uploader)).rejects.toThrow('db down');
    expect(storage.remove).toHaveBeenCalledTimes(2);
  });

  it('chưa được Giám đốc duyệt thì không cho upload', async () => {
    const { service } = make({ ...approved(), status: PolicyStatus.PENDING });
    await expect(service.uploadContract(1, pdf('a.pdf'), uploader)).rejects.toThrow(BadRequestException);
  });

  it('xoá một file: cập nhật danh sách, cột đơn trỏ file còn lại mới nhất, rồi mới xoá đĩa', async () => {
    const { service, repo, storage } = make({
      ...approved(),
      contractFiles: [
        { id: 'a', url: '/uploads/policy-contracts/a.pdf', originalName: 'a.pdf', size: 1, uploadedById: 1, uploadedAt: '2026-09-01T00:00:00Z' },
        { id: 'b', url: '/uploads/policy-contracts/b.pdf', originalName: 'b.pdf', size: 1, uploadedById: 1, uploadedAt: '2026-09-02T00:00:00Z' },
      ],
    });
    const saved = (await service.removeContract(1, 'b')) as never as { contractFiles: { id: string }[]; contractFileName: string };
    expect(saved.contractFiles.map((f) => f.id)).toEqual(['a']);
    expect(saved.contractFileName).toBe('a.pdf');
    expect(storage.remove).toHaveBeenCalledWith('/uploads/policy-contracts/b.pdf');
    expect(repo.save.mock.invocationCallOrder[0]).toBeLessThan(storage.remove.mock.invocationCallOrder[0]);
  });

  it('xoá file cuối cùng thì cột đơn về null', async () => {
    const { service } = make({
      ...approved(),
      contractFiles: [{ id: 'a', url: '/u/a.pdf', originalName: 'a.pdf', size: 1, uploadedById: 1, uploadedAt: 'x' }],
    });
    const saved = (await service.removeContract(1, 'a')) as never as { contractFiles: unknown[]; contractFileUrl?: string };
    expect(saved.contractFiles).toEqual([]);
    expect(saved.contractFileUrl).toBeUndefined();
  });

  it('xoá id không tồn tại → 404', async () => {
    const { service } = make(approved());
    await expect(service.removeContract(1, 'nope')).rejects.toThrow(NotFoundException);
  });
});

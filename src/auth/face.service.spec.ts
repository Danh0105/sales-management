import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';

import { FaceService } from './face.service';
import { Employee } from '../employee/employee.entity';
import { EmployeeFace } from '../employee/employee-face.entity';

/**
 * Đăng nhập bằng khuôn mặt là một cửa vào hệ thống ngang với mật khẩu, nhưng
 * mọi quyết định của nó nằm trong hai con số chôn giữa file: ngưỡng nhận diện
 * và ngưỡng coi là trùng mặt. Nới một con số đi 0.05 thì không ai thấy gì
 * trong review, mà người lạ đăng nhập được vào tài khoản người khác.
 *
 * Các test dưới đây chốt **hành vi** ở hai bên ngưỡng, không chốt con số — đổi
 * ngưỡng có cơ sở thì test vẫn xanh, còn nới lỏng tới mức nhận nhầm thì đỏ.
 */

/** Vector 128 chiều tất định, mô phỏng descriptor của face-api. */
function faceOf(seed: number): number[] {
  let state = seed * 9301 + 49297;
  return Array.from({ length: 128 }, () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280 - 0.5;
  });
}

/** Cùng người, khác góc chụp: lệch nhẹ quanh vector gốc. */
function jitter(base: number[], amount: number, seed = 1): number[] {
  let state = seed * 7919 + 13;
  return base.map((value) => {
    state = (state * 7919 + 13) % 104729;
    return value + (state / 104729 - 0.5) * amount;
  });
}

/**
 * Dựng một vector có cosine **đúng bằng** `target` so với `base`.
 *
 * Cần thiết để chốt sát hai bên ngưỡng: nếu chỉ thử một khuôn mặt "khác hẳn"
 * (cosine ~0.2) thì có nới ngưỡng từ 0.82 xuống 0.4 test vẫn xanh, và bộ test
 * thành vô dụng đúng vào thứ nó sinh ra để canh.
 */
function atCosine(base: number[], target: number): number[] {
  const unit = normalize(base);
  // Thành phần vuông góc với `base`, dựng từ một vector độc lập.
  const raw = faceOf(777);
  const projection = raw.reduce((sum, value, i) => sum + value * unit[i], 0);
  const perpendicular = normalize(
    raw.map((value, i) => value - projection * unit[i]),
  );

  const sin = Math.sqrt(1 - target * target);
  return unit.map((value, i) => target * value + sin * perpendicular[i]);
}

function normalize(v: number[]): number[] {
  const magnitude = Math.sqrt(v.reduce((sum, value) => sum + value * value, 0));
  return v.map((value) => value / magnitude);
}

function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, value, i) => sum + value * b[i], 0);
  const magnitude = (v: number[]) =>
    Math.sqrt(v.reduce((sum, value) => sum + value * value, 0));
  return dot / (magnitude(a) * magnitude(b));
}

const DIRECTOR = { id: 5, name: 'Giám đốc', roles: ['director'] } as Employee;

function makeService(
  faces: Array<Partial<EmployeeFace> & { employee?: Employee }> = [],
) {
  const faceRepo = {
    find: jest.fn().mockResolvedValue(faces),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => data),
  };
  const employeeRepo = {
    findOne: jest.fn().mockResolvedValue(DIRECTOR),
    create: jest.fn((data) => data),
    save: jest.fn(async (data) => ({ id: 99, ...data })),
  };
  const jwt = { sign: jest.fn().mockReturnValue('token') };

  const service = new FaceService(
    employeeRepo as unknown as Repository<Employee>,
    faceRepo as unknown as Repository<EmployeeFace>,
    jwt as unknown as JwtService,
  );

  return { service, faceRepo, employeeRepo, jwt };
}

/** Mã lỗi nào cũng là 401 nên phải so bằng message. */
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'OK';
  } catch (error) {
    if (!(error instanceof UnauthorizedException)) throw error;
    return (error.getResponse() as any).message ?? error.message;
  }
}

beforeAll(() => {
  // Service in similarity ra stdout mỗi lần đăng nhập.
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

describe('Dữ liệu thử phải giống descriptor thật', () => {
  // Nếu vector thử quá giống nhau thì mọi test ngưỡng bên dưới thành vô nghĩa.
  it('hai người khác nhau thì cosine thấp, cùng người thì cao', () => {
    const a = faceOf(1);
    expect(cosine(a, faceOf(2))).toBeLessThan(0.5);
    expect(cosine(a, jitter(a, 0.05))).toBeGreaterThan(0.95);
  });

  it('atCosine dựng được vector ở đúng độ giống mong muốn', () => {
    const a = faceOf(1);
    for (const target of [0.6, 0.78, 0.86, 0.95]) {
      expect(cosine(a, atCosine(a, target))).toBeCloseTo(target, 6);
    }
  });
});

describe('loginByFace — ngưỡng nhận diện', () => {
  const face = faceOf(1);

  it('đúng mặt đã đăng ký thì vào được, kèm token và đúng người', async () => {
    const { service, jwt } = makeService([
      { descriptor: face, employee: DIRECTOR },
    ]);

    const result: any = await service.loginByFace(face);

    expect(result.success).toBe(true);
    expect(result.user).toEqual({ id: 5, name: 'Giám đốc', roles: ['director'] });
    expect(result.similarity).toBeCloseTo(1, 5);
    expect(jwt.sign).toHaveBeenCalledWith({
      sub: 5,
      roles: ['director'],
      name: 'Giám đốc',
    });
  });

  it('cùng người khác góc chụp vẫn vào được', async () => {
    const { service } = makeService([{ descriptor: face, employee: DIRECTOR }]);

    const result: any = await service.loginByFace(jitter(face, 0.05));

    expect(result.success).toBe(true);
  });

  it('MẶT NGƯỜI KHÁC phải bị từ chối', async () => {
    const { service } = makeService([{ descriptor: face, employee: DIRECTOR }]);

    expect(await messageOf(service.loginByFace(faceOf(2)))).toBe(
      'Không nhận diện được khuôn mặt',
    );
  });

  /**
   * Hai test dưới đây kẹp ngưỡng vào khoảng [0.78, 0.86]. Chúng chốt **hiện
   * trạng** (0.82), không khẳng định 0.82 là con số đúng: muốn siết chặt hơn
   * hay nới ra vì lý do chính đáng thì sửa luôn hai mốc này — miễn là sửa có ý
   * thức chứ không trôi đi lúc nào không hay.
   */
  it('giống 0.78 — dưới ngưỡng — phải bị từ chối', async () => {
    const { service } = makeService([{ descriptor: face, employee: DIRECTOR }]);

    expect(await messageOf(service.loginByFace(atCosine(face, 0.78)))).toBe(
      'Không nhận diện được khuôn mặt',
    );
  });

  it('giống 0.86 — trên ngưỡng — phải vào được', async () => {
    const { service } = makeService([{ descriptor: face, employee: DIRECTOR }]);

    expect(((await service.loginByFace(atCosine(face, 0.86))) as any).success).toBe(
      true,
    );
  });

  it('vector rác không mò được vào tài khoản nào', async () => {
    const { service } = makeService([{ descriptor: face, employee: DIRECTOR }]);

    // Vector hằng số và vector 0 là hai kiểu dò rẻ tiền nhất.
    expect(await messageOf(service.loginByFace(new Array(128).fill(1)))).toBe(
      'Không nhận diện được khuôn mặt',
    );
    expect(await messageOf(service.loginByFace(new Array(128).fill(0)))).toBe(
      'Không nhận diện được khuôn mặt',
    );
  });

  it('chọn đúng người giống nhất khi có nhiều khuôn mặt trong hệ thống', async () => {
    const other = { id: 7, name: 'Nhân viên', roles: ['employee'] } as Employee;
    const { service } = makeService([
      { descriptor: faceOf(2), employee: other },
      { descriptor: face, employee: DIRECTOR },
      { descriptor: faceOf(3), employee: other },
    ]);

    const result: any = await service.loginByFace(jitter(face, 0.05));

    expect(result.user.id).toBe(5);
  });

  it('descriptor sai độ dài bị chặn trước khi dò dữ liệu', async () => {
    const { service, faceRepo } = makeService([
      { descriptor: face, employee: DIRECTOR },
    ]);

    expect(await messageOf(service.loginByFace([1, 2, 3]))).toBe(
      'Descriptor không hợp lệ',
    );
    expect(faceRepo.find).not.toHaveBeenCalled();
  });

  it('hệ thống chưa có khuôn mặt nào thì báo rõ, không cho vào', async () => {
    const { service } = makeService([]);

    expect(await messageOf(service.loginByFace(face))).toBe(
      'Hệ thống chưa có dữ liệu khuôn mặt',
    );
  });

  it('bản ghi khuôn mặt hỏng bị bỏ qua, không làm chết đăng nhập', async () => {
    const { service } = makeService([
      { descriptor: null as any, employee: DIRECTOR },
      { descriptor: [1, 2, 3], employee: DIRECTOR },
      { descriptor: face, employee: DIRECTOR },
    ]);

    expect(((await service.loginByFace(face)) as any).success).toBe(true);
  });
});

describe('registerByFace — chống trùng khuôn mặt', () => {
  const face = faceOf(1);

  /** 15 khung hình cùng một người, đủ đa dạng để qua bước kiểm chất lượng. */
  const frames = (base: number[]) =>
    Array.from({ length: 15 }, (_, i) => jitter(base, 0.3, i + 1));

  it('MẶT ĐÃ CÓ TRONG HỆ THỐNG phải bị từ chối', async () => {
    const { service, employeeRepo } = makeService([
      { descriptor: face, employeeId: 5 } as any,
    ]);

    expect(await messageOf(service.registerByFace(frames(face), 'Kẻ mạo danh'))).toBe(
      'Khuôn mặt đã tồn tại',
    );
    // Quan trọng hơn cả message: không được tạo tài khoản nào.
    expect(employeeRepo.save).not.toHaveBeenCalled();
  });

  it('người mới thì đăng ký được', async () => {
    const { service, employeeRepo } = makeService([
      { descriptor: face, employeeId: 5 } as any,
    ]);

    const result: any = await service.registerByFace(
      frames(faceOf(2)),
      'Người mới',
    );

    expect(result.success).toBe(true);
    expect(employeeRepo.save).toHaveBeenCalled();
  });

  it('gửi thiếu số khung hình tối thiểu thì bị chặn', async () => {
    const { service, employeeRepo } = makeService();

    expect(
      await messageOf(service.registerByFace(frames(face).slice(0, 14), 'A')),
    ).toBe('Cần tối thiểu 15 mẫu khuôn mặt');
    expect(employeeRepo.save).not.toHaveBeenCalled();
  });

  it('gửi 15 khung hình gần như giống hệt nhau thì bị chặn', async () => {
    const { service } = makeService();

    // Chụp 15 kiểu một tư thế (hoặc gửi lại cùng một ảnh) không đủ để nhận
    // diện ở các góc khác — phải bắt đăng ký lại thay vì lưu dữ liệu kém.
    const same = Array.from({ length: 15 }, () => jitter(face, 0.001, 1));

    expect(await messageOf(service.registerByFace(same, 'A'))).toBe(
      'Dữ liệu khuôn mặt không đủ đa dạng',
    );
  });

  it('tên rỗng thì bị chặn', async () => {
    const { service } = makeService();

    expect(await messageOf(service.registerByFace(frames(face), '   '))).toBe(
      'Tên không hợp lệ',
    );
  });

  it('descriptor sai định dạng thì bị chặn', async () => {
    const { service } = makeService();

    const broken = frames(face);
    broken[3] = [1, 2, 3];
    expect(await messageOf(service.registerByFace(broken, 'A'))).toBe(
      'Descriptor không hợp lệ',
    );

    const withNaN = frames(face);
    withNaN[3] = [...withNaN[3].slice(0, 127), Number.NaN];
    expect(await messageOf(service.registerByFace(withNaN, 'A'))).toBe(
      'Descriptor chứa dữ liệu lỗi',
    );
  });

  it('tài khoản tạo ra chỉ có quyền employee, không tự nâng quyền được', async () => {
    const { service, employeeRepo } = makeService();

    await service.registerByFace(frames(faceOf(4)), 'Người mới');

    expect(employeeRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ roles: ['employee'] }),
    );
  });
});

describe('registerEmployeeFace — gắn mặt cho tài khoản đang đăng nhập', () => {
  const face = faceOf(1);
  const frames = Array.from({ length: 15 }, (_, i) => jitter(face, 0.3, i + 1));

  it('không gắn được mặt thứ hai cho người đã có', async () => {
    const { service, faceRepo } = makeService();
    faceRepo.count.mockResolvedValue(10);

    expect(await messageOf(service.registerEmployeeFace(5, frames))).toContain(
      'đã đăng ký',
    );
  });

  it('nhân viên không tồn tại thì bị chặn', async () => {
    const { service, employeeRepo } = makeService();
    employeeRepo.findOne.mockResolvedValue(null);

    expect(await messageOf(service.registerEmployeeFace(999, frames))).toBe(
      'Nhân viên không tồn tại',
    );
  });
});

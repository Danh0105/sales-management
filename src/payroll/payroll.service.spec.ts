import { ConflictException, NotFoundException } from '@nestjs/common';

import { PayrollService } from './payroll.service';

const employee = {
  id: 15,
  name: 'Nguyễn Xuân Danh',
  email: 'danh@example.com',
  phone: '0900000015',
  password: 'khong-duoc-lo',
  roles: ['sales'],
  department: { id: 3, name: 'Phòng Công nghệ' },
};

function setup() {
  const queryBuilder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
  const payrollRepo = {
    exist: jest.fn().mockResolvedValue(false),
    create: jest.fn((value) => value),
    save: jest.fn(async (value) => ({ id: value.id ?? 7, ...value })),
    findOne: jest.fn(),
    remove: jest.fn(),
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
  } as any;
  const employeeRepo = {
    findOne: jest.fn().mockResolvedValue(employee),
  } as any;
  return {
    payrollRepo,
    employeeRepo,
    queryBuilder,
    service: new PayrollService(payrollRepo, employeeRepo),
  };
}

describe('PayrollService', () => {
  it('tạo phiếu, chốt tên/chức vụ và tự tính các tổng', async () => {
    const { service, payrollRepo } = setup();
    payrollRepo.findOne.mockImplementation(async ({ where }: any) => ({
      ...payrollRepo.save.mock.results[0]?.value,
      id: where.id,
      employee,
      employeeId: employee.id,
      employeeName: employee.name,
      month: 8,
      year: 2026,
      officialWorkSalary: 14_000_000,
      overtimeAllowance: 1_620_000,
      otherSupport: 120_000,
      socialInsurance: 596_400,
      adjustmentAmount: 1_620_000,
      totalIncome: 15_740_000,
      totalDeduction: 2_216_400,
      netSalary: 13_523_600,
    }));

    const result = await service.create(
      {
        employeeId: 15,
        month: 8,
        year: 2026,
        officialWorkSalary: 14_000_000,
        overtimeAllowance: 1_620_000,
        otherSupport: 120_000,
        socialInsurance: 596_400,
        adjustmentAmount: 1_620_000,
      },
      { id: 2, name: 'Nhân sự', roles: ['nhansu'] },
    );

    expect(payrollRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        employeeId: 15,
        employeeName: 'Nguyễn Xuân Danh',
        jobTitle: 'Phòng Công nghệ',
        month: 8,
        year: 2026,
        totalIncome: 15_740_000,
        totalDeduction: 2_216_400,
        netSalary: 13_523_600,
      }),
    );
    expect(result.employee).toEqual({
      id: 15,
      name: 'Nguyễn Xuân Danh',
      email: 'danh@example.com',
      phone: '0900000015',
      department: { id: 3, name: 'Phòng Công nghệ' },
    });
    expect(result.employee).not.toHaveProperty('password');
    expect(result.employee).not.toHaveProperty('roles');
  });

  it('không cho tạo trùng nhân viên và kỳ lương', async () => {
    const { service, payrollRepo } = setup();
    payrollRepo.exist.mockResolvedValue(true);

    await expect(
      service.create(
        { employeeId: 15, month: 8, year: 2026 },
        { id: 2, roles: ['nhansu'] },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(payrollRepo.save).not.toHaveBeenCalled();
  });

  it('ẩn sự tồn tại của phiếu khi nhân viên khác truy cập', async () => {
    const { service, payrollRepo } = setup();
    payrollRepo.findOne.mockResolvedValue({ id: 7, employeeId: 15, employee });

    await expect(
      service.findOne(7, { id: 99, roles: ['sales'] }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('nhân viên được xem phiếu của chính mình', async () => {
    const { service, payrollRepo } = setup();
    payrollRepo.findOne.mockResolvedValue({ id: 7, employeeId: 15, employee });

    await expect(
      service.findOne(7, { id: 15, roles: ['sales'] }),
    ).resolves.toMatchObject({ id: 7, employeeId: 15 });
  });

  it('bỏ qua employeeId trên query và ép nhân viên chỉ xem danh sách của mình', async () => {
    const { service, queryBuilder } = setup();

    await service.findAll(
      { employeeId: 99, page: 1, limit: 20 },
      { id: 15, roles: ['sales'] },
    );

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'payroll.employeeId = :employeeId',
      { employeeId: 15 },
    );
    expect(queryBuilder.andWhere).not.toHaveBeenCalledWith(
      'payroll.employeeId = :employeeId',
      { employeeId: 99 },
    );
  });

  it('cho Nhân sự lọc danh sách theo nhân viên', async () => {
    const { service, queryBuilder } = setup();

    await service.findAll(
      { employeeId: 99, page: 1, limit: 20 },
      { id: 2, roles: ['nhansu'] },
    );

    expect(queryBuilder.andWhere).toHaveBeenCalledWith(
      'payroll.employeeId = :employeeId',
      { employeeId: 99 },
    );
  });
});

import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DailyReport } from './entities/daily-report.entity';
import { DataSource, In, Repository } from 'typeorm';
import { CreateReportDto } from './dto/create-report.dto';
import { UpdateReportDto } from './dto/update-report.dto';
import { Task } from './entities/task.entity';
import { startOfWeek, endOfWeek, format } from 'date-fns';
import { FcmService } from '../fcm/fcm.service';
import { Employee } from '../employee/employee.entity';
import { EmployeeFcmToken } from '../employee-fcm-token/employee-fcm-token.entity';
import fixVietnamese from '../utils/fixVietnamese';
import { NotificationService } from '../notifications/services/notification.service';
import { ReportGateway } from './report.gateway';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import { ReportMessage, ReportMessageSenderRole } from './entities/report-message.entity';
import { CreateReportMessageDto } from './dto/create-report-message';
import { DailyReportProvinceService } from './daily-report-province.service';

@Injectable()
export class DailyReportService {
    constructor(
        @InjectRepository(DailyReport)
        private reportRepo: Repository<DailyReport>,

        @InjectRepository(Task)
        private taskRepo: Repository<Task>,

        @InjectRepository(Employee)
        private employeeRepo: Repository<Employee>,
        @InjectRepository(ReportMessage)
        private reportMessageRepo: Repository<ReportMessage>,

        private readonly notificationService: NotificationService,
        private readonly fcmService: FcmService,
        private readonly dataSource: DataSource,
        private readonly reportGateway:
            ReportGateway,
        private readonly reportProvince: DailyReportProvinceService,
    ) { }

    async create(
        dto: CreateReportDto,
        user?: Employee,
    ) {
        const resolvedLocation = await this.reportProvince.resolve(
            dto.employeeId,
            dto,
        );
        let receiverIds: number[] = [];
        let tokens: string[] = [];
        let message = '';
        let savedTasks: Task[] = [];

        const savedReport =
            await this.dataSource.transaction(
                async (manager) => {
                    // ============================================
                    // EMPLOYEE
                    // ============================================

                    const employee =
                        await manager.findOne(
                            Employee,
                            {
                                where: {
                                    id: dto.employeeId,
                                },
                            },
                        );

                    if (!employee) {
                        throw new NotFoundException(
                            'Employee not found',
                        );
                    }

                    // ============================================
                    // CREATE REPORT
                    // ============================================

                    const report =
                        manager.create(
                            DailyReport,
                            {
                                date: dto.date,
                                employee,
                                provinceId: resolvedLocation.provinceId,
                                schoolId: resolvedLocation.schoolId,
                            },
                        );

                    const saved =
                        await manager.save(
                            report,
                        );

                    // ============================================
                    // CREATE TASKS
                    // ============================================

                    const tasks =
                        dto.tasks.map(
                            (t) =>
                                manager.create(
                                    Task,
                                    {
                                        ...t,
                                        report: saved,
                                    },
                                ),
                        );

                    savedTasks =
                        await manager.save(
                            tasks,
                        );

                    // ============================================
                    // RECEIVERS
                    // ============================================

                    const directors =
                        await manager.createQueryBuilder(Employee, 'e')
                            .where(`e.roles && ARRAY[:...roles]::text[]`, {
                                roles: ['director', 'director_la', 'saleadmin', 'salesadmin_la'],
                            })
                            .getMany();

                    receiverIds = directors
                        .map((e) => e.id)
                        .filter(
                            (
                                id,
                            ): id is number =>
                                !!id,
                        );

                    receiverIds = await this.notificationService.scopeBusinessReceiverIds(
                        receiverIds,
                        dto.employeeId,
                        {
                            kind: 'report',
                            provinceId: resolvedLocation.provinceId ?? undefined,
                        },
                    );

                    // ============================================
                    // FCM TOKENS
                    // ============================================

                    const fcmTokens =
                        await manager.find(
                            EmployeeFcmToken,
                            {
                                where: {
                                    employeeId:
                                        In(
                                            receiverIds,
                                        ),
                                },
                            },
                        );

                    tokens = [
                        ...new Set(
                            fcmTokens
                                .map(
                                    (t) =>
                                        t.token,
                                )
                                .filter(
                                    Boolean,
                                ),
                        ),
                    ];

                    message =
                        `${employee.name} đã gửi báo cáo công việc`;

                    return saved;
                },
            );

        // ============================================
        // META
        // ============================================

        const meta = {
            reportId: savedReport.id,
            taskIds: savedTasks.map(
                (task) => task.id,
            ),
            employeeId: dto.employeeId,
            date: dto.date,
        };

        // ============================================
        // DB NOTIFICATION
        // ============================================

        const notifications =
            await this.notificationService.createNotifications({
                receiverIds,
                type: NotificationType.REPORT,
                entityId: savedReport.id, // entityId = reportId
                message,
                senderId: dto.employeeId,
                meta,
            });

        // ============================================
        // SOCKET
        // ============================================

        notifications.forEach(
            (noti) => {
                const payload = {
                    id: noti.id,
                    type: noti.type,
                    entityId: noti.entityId, // reportId
                    message: noti.message,
                    isRead: noti.isRead,
                    createdAt: noti.createdAt,
                    createdBy: user?.id,
                    meta,
                };

                // notification realtime
                this.reportGateway.server
                    .to(
                        `user_${noti.receiverId}`,
                    )
                    .emit(
                        'notification:new',
                        payload,
                    );

                // report realtime
                this.reportGateway.server
                    .to(
                        `user_${noti.receiverId}`,
                    )
                    .emit(
                        'report:new',
                        {
                            reportId: savedReport.id,
                            taskIds: savedTasks.map(
                                (task) => task.id,
                            ),
                            employeeId: dto.employeeId,
                            createdAt: new Date(),
                        },
                    );
            },
        );

        // ============================================
        // FCM
        // ============================================

        if (tokens.length > 0) {
            await this.fcmService.sendToMultiple(
                tokens,
                '📋 Báo cáo mới',
                message,
                {
                    type: 'report',
                    id: String(
                        savedReport.id,
                    ), // reportId
                    reportId: String(
                        savedReport.id,
                    ),
                    url: `/director/reports/${savedReport.id}`,
                },
            );
        }

        // ============================================
        // RETURN
        // ============================================

        return {
            ...savedReport,
            tasks: savedTasks,
        };
    }
    async update(id: number, dto: UpdateReportDto, user: Employee) {
        const report = await this.reportRepo.findOne({
            where: { id },
            relations: ['tasks', 'employee'],
        });

        if (!report) {
            throw new NotFoundException('Report not found');
        }
        this.assertCanMutate(user, Number(report.employee.id));


        if (dto.date) {
            report.date = dto.date;
        }

        const resolvedLocation = await this.reportProvince.resolve(
            Number(report.employee.id),
            {
                ...dto,
                tasks: dto.tasks ?? report.tasks,
                schoolId: Object.prototype.hasOwnProperty.call(dto, 'schoolId')
                    ? dto.schoolId ?? undefined
                    : report.schoolId ?? undefined,
                provinceId: Object.prototype.hasOwnProperty.call(dto, 'provinceId')
                    ? dto.provinceId ?? undefined
                    : report.provinceId ?? undefined,
            },
        );
        report.provinceId = resolvedLocation.provinceId;
        report.schoolId = resolvedLocation.schoolId;

        // save report trước
        const savedReport = await this.reportRepo.save(report);

        // ❌ XÓA TASK CŨ
        if (dto.tasks && report.tasks && report.tasks.length > 0) {
            await this.taskRepo.remove(report.tasks);
        }

        // ✅ TẠO TASK MỚI
        const newTasks = (dto.tasks ?? []).map((t) =>
            this.taskRepo.create({
                ...t,
                report: savedReport,
            }),
        );

        if (newTasks.length) await this.taskRepo.save(newTasks);

        return savedReport;
    }
    async findAll(provinceId?: number) {
        const query = this.reportRepo
            .createQueryBuilder('report')
            .leftJoinAndSelect('report.tasks', 'tasks')
            .orderBy('report.date', 'DESC');
        if (provinceId) {
            query.andWhere('report.province_id = :provinceId', { provinceId });
        }
        return query.getMany();
    }

    async findOne(id: number) {
        return this.reportRepo.findOne({
            where: { id },
            relations: ['tasks'],
        });
    }

    async remove(id: number, user: Employee) {
        const report = await this.reportRepo.findOne({
            where: { id },
            relations: ['employee'],
        });
        if (!report) throw new NotFoundException('Report not found');
        this.assertCanMutate(user, Number(report.employee.id));
        return this.reportRepo.delete(id);
    }

    async findByEmployee(employeeId: number, provinceId?: number) {
        const employee = await this.employeeRepo.findOne({
            where: { id: employeeId },
        });

        if (!employee) {
            throw new NotFoundException('Employee not found');
        }

        const query = this.reportRepo
            .createQueryBuilder('report')
            .leftJoinAndSelect('report.tasks', 'tasks')
            .where('report."employeeId" = :employeeId', { employeeId })
            .orderBy('report.date', 'DESC');
        if (provinceId) {
            query.andWhere('report.province_id = :provinceId', { provinceId });
        }
        return query.getMany();
    }
    async findByEmployeeGroupByWeek(employeeId: number, provinceId?: number) {
        const reports = await this.findByEmployee(employeeId, provinceId);

        const grouped = {};

        for (const report of reports) {
            const start = startOfWeek(new Date(report.date), { weekStartsOn: 1 }); // Thứ 2
            const end = endOfWeek(new Date(report.date), { weekStartsOn: 1 });

            const key = `${format(start, 'yyyy-MM-dd')}__${format(end, 'yyyy-MM-dd')}`;

            if (!grouped[key]) {
                grouped[key] = {
                    weekStart: start,
                    weekEnd: end,
                    reports: [],
                };
            }

            grouped[key].reports.push(report);
        }

        return Object.values(grouped);
    }
    async findEmployeesReportedToday(provinceId?: number) {
        const today = new Date().toISOString().split('T')[0];

        const query = this.reportRepo
            .createQueryBuilder('report')
            .leftJoin('report.employee', 'employee')
            .select(['employee.id', 'employee.name'])
            .distinct(true)
            .where('report.date = :today', { today });

        if (provinceId) {
            query.andWhere('report.province_id = :provinceId', { provinceId });
        }

        return query.getRawMany();
    }
    async removeTask(taskId: number, user: Employee) {
        const task = await this.taskRepo.findOne({
            where: { id: taskId },
            relations: ['report', 'report.employee'],
        });

        if (!task) {
            throw new NotFoundException('Task not found');
        }
        this.assertCanMutate(user, Number(task.report.employee.id));

        await this.taskRepo.remove(task);

        return { message: 'Deleted successfully' };
    }

    private assertCanMutate(user: Employee, ownerId: number): void {
        const canManage = user.roles?.some((role) =>
            ['director', 'director_la', 'saleadmin', 'salesadmin', 'salesadmin_la']
                .includes(role),
        );
        if (user.id === ownerId || canManage) return;
        throw new ForbiddenException('Bạn không có quyền sửa hoặc xoá báo cáo này');
    }
    async createMessage(
        dto: CreateReportMessageDto,
        user: Employee,
    ) {
        let receiverIds: number[] = [];
        let tokens: string[] = [];
        let notificationMessage = '';

        const savedMessage =
            await this.dataSource.transaction(
                async (manager) => {
                    if (!user?.id) {
                        throw new NotFoundException(
                            'User not found',
                        );
                    }

                    const sender =
                        await manager.findOne(
                            Employee,
                            {
                                where: {
                                    id: user.id,
                                },
                            },
                        );

                    if (!sender) {
                        throw new NotFoundException(
                            'Sender not found',
                        );
                    }

                    const report =
                        await manager.findOne(
                            DailyReport,
                            {
                                where: {
                                    id: dto.reportId,
                                },
                                relations: {
                                    employee: true,
                                },
                            },
                        );

                    if (!report) {
                        throw new NotFoundException(
                            'Report not found',
                        );
                    }

                    const senderRole =
                        sender.roles?.some((r: string) =>
                            ['director', 'director_la', 'saleadmin', 'salesadmin_la'].includes(r)
                        )
                            ? ReportMessageSenderRole.MANAGER
                            : ReportMessageSenderRole.EMPLOYEE;

                    const reportMessage =
                        manager.create(
                            ReportMessage,
                            {
                                message: dto.message,
                                senderRole,
                                report,
                                sender,
                            },
                        );

                    const saved =
                        await manager.save(
                            reportMessage,
                        );

                    if (senderRole === 'EMPLOYEE') {
                        const managers =
                            await manager.createQueryBuilder(Employee, 'e')
                                .where(`e.roles && ARRAY[:...roles]::text[]`, {
                                    roles: ['director', 'director_la', 'saleadmin', 'salesadmin_la'],
                                })
                                .getMany();

                        receiverIds = await this.notificationService.scopeBusinessReceiverIds(
                            managers
                                .map((e) => e.id)
                                .filter(
                                    (
                                        id,
                                    ): id is number =>
                                        !!id &&
                                        id !== sender.id,
                                ),
                            sender.id,
                            { kind: 'report', reportId: report.id },
                        );

                        notificationMessage =
                            `${sender.name} đã nhắn tin trong báo cáo công việc`;
                    } else {
                        const reportEmployeeId =
                            report.employee?.id;

                        receiverIds = reportEmployeeId
                            ? [reportEmployeeId].filter(
                                (id) =>
                                    id !== sender.id,
                            )
                            : [];

                        notificationMessage =
                            `${sender.name} đã phản hồi báo cáo công việc của bạn`;
                    }

                    if (receiverIds.length > 0) {
                        const fcmTokens =
                            await manager.find(
                                EmployeeFcmToken,
                                {
                                    where: {
                                        employeeId:
                                            In(
                                                receiverIds,
                                            ),
                                    },
                                },
                            );

                        tokens = [
                            ...new Set(
                                fcmTokens
                                    .map(
                                        (t) =>
                                            t.token,
                                    )
                                    .filter(
                                        Boolean,
                                    ),
                            ),
                        ];
                    }

                    return saved;
                },
            );

        const meta = {
            reportId: dto.reportId,
            messageId: savedMessage.id,
            senderId: user.id,
        };

        const notifications =
            receiverIds.length > 0
                ? await this.notificationService.createNotifications({
                    receiverIds,
                    type: NotificationType.REPORT,
                    entityId: dto.reportId,
                    message: notificationMessage,
                    senderId: user.id,
                    meta,
                })
                : [];

        notifications.forEach((noti) => {
            const payload = {
                id: noti.id,
                type: noti.type,
                entityId: noti.entityId,
                message: noti.message,
                isRead: noti.isRead,
                createdAt: noti.createdAt,
                createdBy: user.id,
                meta,
            };

            this.reportGateway.server
                .to(`user_${noti.receiverId}`)
                .emit('notification:new', payload);

            this.reportGateway.server
                .to(`user_${noti.receiverId}`)
                .emit('report:message:new', {
                    reportId: dto.reportId,
                    messageId: savedMessage.id,
                    senderId: user.id,
                    message: savedMessage.message,
                    createdAt: savedMessage.createdAt,
                });
        });

        if (tokens.length > 0) {
            await this.fcmService.sendToMultiple(
                tokens,
                '💬 Tin nhắn báo cáo',
                notificationMessage,
                {
                    type: 'report_message',
                    id: String(savedMessage.id),
                    reportId: String(dto.reportId),
                    messageId: String(savedMessage.id),
                    url: `/director/reports/${dto.reportId}`,
                },
            );
        }

        return savedMessage;
    }
    async findMessagesByReport(reportId: number) {
        const report = await this.reportRepo.findOne({
            where: {
                id: reportId,
            },
        });

        if (!report) {
            throw new NotFoundException('Report not found');
        }

        return this.reportMessageRepo.find({
            where: {
                report: {
                    id: reportId,
                },
            },
            relations: {
                sender: true,
            },
            order: {
                createdAt: 'ASC',
            },
        });
    }
}

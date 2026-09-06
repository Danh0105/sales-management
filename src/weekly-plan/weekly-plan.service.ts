import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import { WeeklyPlan } from './entities/weekly-plan.entity';
import { WeeklyPlanTask } from './entities/weekly-plan-task.entity';
import { WeeklyPlanHistory } from './entities/weekly-plan-history.entity';
import { CreateWeeklyPlanDto } from './dto/create-weekly-plan.dto';


import { WeeklyPlanGateway } from './weekly-plan.gateway';
import { Policy } from '../policy/entities/policy.entity';
import { EmployeeFcmTokenService } from '../employee-fcm-token/employee-fcm-token.service';
import { FcmService } from '../fcm/fcm.service';
import { NotificationService } from '../notifications/services/notification.service';
import { Employee } from '../employee/employee.entity';
import { NotificationType } from '../notifications/enums/notification-type.enum';

@Injectable()
export class WeeklyPlanService {
    constructor(
        private dataSource: DataSource,

        @InjectRepository(WeeklyPlan)
        private planRepo: Repository<WeeklyPlan>,

        @InjectRepository(WeeklyPlanTask)
        private taskRepo: Repository<WeeklyPlanTask>,

        @InjectRepository(WeeklyPlanHistory)
        private historyRepo: Repository<WeeklyPlanHistory>,
        private readonly fcmService: FcmService,
        private employeeFcmTokenService:
            EmployeeFcmTokenService,
        private readonly notificationService: NotificationService,

        private readonly weeklyPlanGateway:
            WeeklyPlanGateway,
    ) { }

    // ================= CREATE =================
    async create(dto: CreateWeeklyPlanDto) {
        return this.dataSource.transaction(
            async (manager) => {
                const plan = manager.create(
                    WeeklyPlan,
                    {
                        ...dto,
                        tasks: dto.tasks,
                    },
                );

                const saved =
                    await manager.save(plan);

                // ✅ history
                await this.saveHistory(
                    saved.id,
                    saved,
                    manager,
                );

                // ================= NOTIFICATION =================
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
                const employees =
                    await manager.createQueryBuilder(Employee, 'e')
                        .where(`e.roles && ARRAY[:...roles]::text[]`, {
                            roles: ['director', 'director_la'],
                        })
                        .getMany();

                const userIds = employees
                    .map((e) => e.id)
                    .filter(
                        (
                            id,
                        ): id is number =>
                            id !== undefined,
                    );

                const tokenEntities =
                    await this.employeeFcmTokenService.getTokens(
                        userIds,
                    );

                const tokens =
                    tokenEntities.map(
                        (x) => x.token,
                    );

                const message = `${employee.name} đã gửi kế hoạch tuần ${dto.startDate} - ${dto.endDate}`;

                // ===== PUSH =====

                if (tokens.length > 0) {
                    await this.fcmService.sendToMultiple(
                        tokens,
                        '📊 Báo cáo tuần mới',
                        message,
                        {
                            type: 'weekly_plan',

                            id: String(saved.id),

                            url: '/weekly-plan',
                        },
                    );
                }

                // ===== DATABASE NOTIFICATION =====

                const notifications =
                    await this.notificationService.createNotifications(
                        {
                            receiverIds:
                                userIds,

                            type:
                                NotificationType.WEEKLY_PLAN,

                            entityId:
                                saved.id,

                            message,

                            senderId:
                                dto.employeeId,

                            meta: {
                                startDate: saved.startDate,
                                endDate: saved.endDate,
                            },
                        },
                    );

                // ===== SOCKET REALTIME =====

                notifications.forEach(
                    (noti) => {
                        this.weeklyPlanGateway.server
                            .to(
                                `user_${noti.receiverId}`,
                            )
                            .emit(
                                'notification:new',
                                {
                                    id: noti.id,

                                    type: noti.type,

                                    entityId:
                                        noti.entityId,

                                    message:
                                        noti.message,

                                    isRead:
                                        noti.isRead,

                                    createdAt:
                                        noti.createdAt,

                                    createdBy:
                                        dto.employeeInfo
                                            ?.sub,

                                    meta: {
                                        meta: {
                                            startDate: saved.startDate,
                                            endDate: saved.endDate,
                                        },
                                    },
                                },
                            );
                    },
                );

                return saved;
            },
        );
    }

    // ================= UPDATE =================
    async update(
        id: number,
        dto: CreateWeeklyPlanDto,
    ) {
        return this.dataSource.transaction(
            async (manager) => {
                const plan =
                    await manager.findOne(
                        WeeklyPlan,
                        {
                            where: { id },
                            relations: [
                                'tasks',
                            ],
                        },
                    );

                if (!plan) {
                    throw new NotFoundException(
                        'Weekly plan không tồn tại',
                    );
                }

                // ✅ lưu history cũ
                await this.saveHistory(
                    id,
                    plan,
                    manager,
                );

                // xoá task cũ
                await manager.delete(
                    WeeklyPlanTask,
                    {
                        weeklyPlan: {
                            id,
                        },
                    },
                );

                // update plan
                const updated =
                    await manager.save(
                        WeeklyPlan,
                        {
                            id,
                            ...dto,
                            tasks: dto.tasks,
                        },
                    );

                // ================= NOTIFICATION =================

                const employees =
                    await manager.createQueryBuilder(Employee, 'e')
                        .where(`e.roles && ARRAY[:...roles]::text[]`, {
                            roles: ['director', 'director_la'],
                        })
                        .getMany();

                const userIds =
                    employees
                        .map((e) => e.id)
                        .filter(
                            (
                                id,
                            ): id is number =>
                                id !== undefined,
                        );

                const tokenEntities =
                    await this.employeeFcmTokenService.getTokens(
                        userIds,
                    );

                const tokens =
                    tokenEntities.map(
                        (x) => x.token,
                    );

                const message = `${dto.employeeInfo?.name} đã cập nhật báo cáo tuần`;

                // ===== PUSH =====

                if (tokens.length > 0) {
                    await this.fcmService.sendToMultiple(
                        tokens,
                        '📝 Báo cáo tuần đã cập nhật',
                        message,
                        {
                            type: 'weekly_plan',

                            id: String(
                                updated.id,
                            ),

                            url: '/weekly-plan',
                        },
                    );
                }

                // ===== DATABASE NOTIFICATION =====

                const notifications =
                    await this.notificationService.createNotifications(
                        {
                            receiverIds:
                                userIds,

                            type:
                                NotificationType.WEEKLY_PLAN,

                            entityId:
                                updated.id,

                            message,

                            senderId:
                                dto.employeeInfo
                                    ?.sub,

                            meta: {
                                startDate:
                                    updated.startDate,

                                endDate:
                                    updated.endDate,
                            },
                        },
                    );

                // ===== SOCKET REALTIME =====

                notifications.forEach(
                    (noti) => {
                        this.weeklyPlanGateway.server
                            .to(
                                `user_${noti.receiverId}`,
                            )
                            .emit(
                                'notification:new',
                                {
                                    id: noti.id,

                                    type: noti.type,

                                    entityId:
                                        noti.entityId,

                                    message:
                                        noti.message,

                                    isRead:
                                        noti.isRead,

                                    createdAt:
                                        noti.createdAt,

                                    createdBy:
                                        dto.employeeInfo
                                            ?.sub,

                                    meta: {
                                        startDate:
                                            updated.startDate,

                                        endDate:
                                            updated.endDate,
                                    },
                                },
                            );
                    },
                );

                return updated;
            },
        );
    }

    // ================= SAVE HISTORY =================
    async saveHistory(
        planId: number,
        data?: WeeklyPlan,
        manager?: any,
    ) {
        const historyRepo = manager
            ? manager.getRepository(WeeklyPlanHistory)
            : this.historyRepo;

        const planRepo = manager
            ? manager.getRepository(WeeklyPlan)
            : this.planRepo;

        // ❗ nếu không có data thì mới query
        if (!data) {
            data = await planRepo.findOne({
                where: { id: planId },
                relations: ['tasks'],
            });
        }

        // 🔥 CHẶN NULL (fix lỗi của bạn)
        if (!data) {
            throw new Error('Snapshot data is null');
        }

        // 🔥 clean snapshot (rất quan trọng)
        const snapshot = {
            id: data.id,
            startDate: data.startDate,
            endDate: data.endDate,
            employeeId: data.employeeId,
            status: data.status,
            tasks: data.tasks?.map((t) => ({
                id: t.id,
                title: t.title,
                content: t.content,
                dayOfWeek: t.dayOfWeek,
            })),
        };

        const last = await historyRepo.findOne({
            where: { weeklyPlanId: planId },
            order: { version: 'DESC' },
        });

        const version = last ? last.version + 1 : 1;

        await historyRepo.save({
            weeklyPlanId: planId,
            snapshot,
            version,
        });
    }

    // ================= READ =================
    async findAll() {
        return this.planRepo.find({
            relations: ['tasks'],
            order: { id: 'DESC' },
        });
    }

    async findOne(id: number) {
        const plan = await this.planRepo.findOne({
            where: { id },
            relations: ['tasks'],
        });

        if (!plan) throw new NotFoundException('Không tìm thấy');

        return plan;
    }

    async getByEmployee(employeeId: number) {
        return this.planRepo.find({
            where: { employeeId },
            relations: ['tasks'],
            order: { startDate: 'DESC' },
        });
    }

    async getHistory(planId: number) {
        return this.historyRepo.find({
            where: { weeklyPlanId: planId },
            order: { version: 'DESC' },
        });
    }

    // ================= DELETE =================
    async remove(id: number) {
        return this.planRepo.delete(id);
    }
}
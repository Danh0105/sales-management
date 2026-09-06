import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AnnualPolicy } from './entities/annual-policy.entity';
import { School } from '../school/schools.entity';
import { Employee } from '../employee/employee.entity';
import { CreateAnnualPolicyDto } from './dto/create-annual-policy.dto';
import { ReviewAnnualPolicyDto } from './dto/review-annual-policy.dto';
import { AnnualPolicyStatus } from './annual-policy.enum';
import { FcmService } from '../fcm/fcm.service';
import { EmployeeFcmTokenService } from '../employee-fcm-token/employee-fcm-token.service';
import { NotificationService } from '../notifications/services/notification.service';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import fixVietnamese from '../utils/fixVietnamese';

@Injectable()
export class AnnualPolicyService {
    constructor(
        @InjectRepository(AnnualPolicy)
        private readonly repo: Repository<AnnualPolicy>,

        @InjectRepository(School)
        private readonly schoolRepo: Repository<School>,

        @InjectRepository(Employee)
        private readonly employeeRepo: Repository<Employee>,

        private readonly fcmService: FcmService,
        private readonly employeeFcmTokenService: EmployeeFcmTokenService,
        private readonly notificationService: NotificationService,
    ) { }

    async create(dto: CreateAnnualPolicyDto, creator: { id: number; name?: string }) {
        const school = await this.schoolRepo.findOne({
            where: { id: dto.schoolId },
            relations: ['employee', 'ward', 'ward.province'],
        });

        if (!school) {
            throw new NotFoundException('School không tồn tại');
        }

        const saved = await this.repo.save(
            this.repo.create({
                schoolId: dto.schoolId,
                schoolYear: dto.schoolYear,
                amount: dto.amount,
                content: dto.content,
                status: AnnualPolicyStatus.PENDING,
                createdById: creator.id,
                createdByName: creator.name,
            }),
        );

        // ===== THÔNG BÁO ĐẾN DIRECTOR =====

        const directors = await this.employeeRepo.createQueryBuilder('e')
            .where(`e.roles && ARRAY[:...roles]::text[]`, {
                roles: ['director', 'director_la'],
            })
            .getMany();

        const directorIds = directors
            .map((d) => d.id)
            .filter((id): id is number => id !== undefined);

        const creatorName = fixVietnamese(creator.name || '');
        const message = `${creatorName} đã gửi yêu cầu duyệt chính sách năm cho trường ${school.name} năm học ${dto.schoolYear}`;

        const meta = {
            schoolName: school.name,
            schoolYear: dto.schoolYear,
            amount: dto.amount,
            regionName: school.ward?.province?.name,
        };

        const tokenEntities = await this.employeeFcmTokenService.getTokens(directorIds);
        const tokens = tokenEntities.map((x) => x.token);

        if (tokens.length > 0) {
            await this.fcmService.sendToMultiple(
                tokens,
                '📄 Có yêu cầu duyệt chính sách năm',
                message,
                {
                    type: 'annual-policy',
                    id: String(saved.id),
                    url: `/director/annual-policy/${saved.id}`,
                },
            );
        }

        await this.notificationService.createNotifications({
            receiverIds: directorIds,
            type: NotificationType.POLICY,
            entityId: saved.id,
            message,
            senderId: creator.id,
            meta,
        });

        return saved;
    }

    async review(
        id: number,
        dto: ReviewAnnualPolicyDto,
        director: { id: number; name?: string },
    ) {
        const policy = await this.repo.findOne({
            where: { id },
            relations: ['school'],
        });

        if (!policy) {
            throw new NotFoundException('Chính sách năm không tồn tại');
        }

        if (policy.status !== AnnualPolicyStatus.PENDING) {
            throw new BadRequestException('Chính sách năm này đã được duyệt/từ chối trước đó');
        }

        policy.status = dto.status;
        policy.note = dto.note;
        policy.reviewedById = director.id;
        policy.reviewedByName = director.name;

        const saved = await this.repo.save(policy);

        // Đã chốt duyệt/từ chối — thông báo "cần duyệt" cũ (gửi mọi giám đốc)
        // hết ý nghĩa với TẤT CẢ người nhận, kể cả người không phải là người
        // vừa thao tác (vd. director_la không cần thấy "cần duyệt" nữa khi
        // director đã duyệt). Đánh dấu trước khi tạo thông báo kết quả bên
        // dưới, vì cùng type+entityId nên phải tránh đánh dấu nhầm luôn cả
        // thông báo kết quả vừa tạo.
        await this.notificationService.markAllAsReadByTypeAndEntity(
            NotificationType.POLICY,
            policy.id,
        );

        // ===== THÔNG BÁO ĐẾN NGƯỜI TẠO =====

        const directorName = fixVietnamese(director.name || 'Giám đốc');
        const action = dto.status === AnnualPolicyStatus.APPROVED ? 'duyệt' : 'từ chối';
        const message = `${directorName} đã ${action} chính sách năm cho trường ${policy.school?.name} năm học ${policy.schoolYear}`;

        const meta = {
            schoolName: policy.school?.name,
            schoolYear: policy.schoolYear,
            amount: policy.amount,
            note: dto.note,
        };

        const tokenEntities = await this.employeeFcmTokenService.getTokens([policy.createdById]);
        const tokens = tokenEntities.map((x) => x.token);

        if (tokens.length > 0) {
            await this.fcmService.sendToMultiple(
                tokens,
                dto.status === AnnualPolicyStatus.APPROVED
                    ? '📄 Chính sách năm đã được duyệt'
                    : '📄 Chính sách năm bị từ chối',
                message,
                {
                    type: 'annual-policy',
                    id: String(policy.id),
                    url: `/employee/annual-policy/${policy.id}`,
                },
            );
        }

        await this.notificationService.createNotifications({
            receiverIds: [policy.createdById],
            type: NotificationType.POLICY,
            entityId: policy.id,
            message,
            senderId: director.id,
            meta,
        });

        return saved;
    }

    async findAll(filters: {
        employeeId?: number;
        schoolId?: number;
        status?: AnnualPolicyStatus;
        schoolYear?: string;
    }) {
        const where: any = {};

        if (filters.employeeId) where.createdById = filters.employeeId;
        if (filters.schoolId) where.schoolId = filters.schoolId;
        if (filters.status) where.status = filters.status;
        if (filters.schoolYear) where.schoolYear = filters.schoolYear;

        return this.repo.find({
            where,
            relations: ['school'],
            order: { createdAt: 'DESC' },
        });
    }

    async findOne(id: number) {
        const policy = await this.repo.findOne({
            where: { id },
            relations: ['school'],
        });

        if (!policy) {
            throw new NotFoundException('Chính sách năm không tồn tại');
        }

        return policy;
    }
}

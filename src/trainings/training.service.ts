
// training.service.ts

import {
    Injectable,
    NotFoundException,
} from "@nestjs/common";

import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";
import { Training } from "./trainings.entity";
import { TrainingProgress } from "./training-progress.entity";
import { UpdateTrainingProgressDto } from "./update-training-progress.dto";



@Injectable()
export class TrainingService {
    constructor(
        @InjectRepository(Training)
        private readonly trainingRepo: Repository<Training>,

        @InjectRepository(TrainingProgress)
        private readonly trainingProgressRepo: Repository<TrainingProgress>,
    ) { }

    // =========================
    // LIST TRAINING
    // =========================

    async findAll() {
        return this.trainingRepo.find({
            where: {
                isActive: true,
            },
            order: {
                id: "ASC",
            },
        });
    }

    // =========================
    // DETAIL TRAINING
    // =========================

    async findOne(id: number) {
        const training =
            await this.trainingRepo.findOne({
                where: { id },
            });

        if (!training) {
            throw new NotFoundException(
                "Training not found",
            );
        }

        return training;
    }

    // =========================
    // UPDATE PROGRESS
    // =========================

    async updateProgress(
        employeeId: number,
        dto: UpdateTrainingProgressDto,
    ) {
        const training =
            await this.trainingRepo.findOne({
                where: {
                    id: dto.trainingId,
                },
            });

        if (!training) {
            throw new NotFoundException(
                "Training not found",
            );
        }

        let progress =
            await this.trainingProgressRepo.findOne({
                where: {
                    employeeId,
                    trainingId: dto.trainingId,
                },
            });

        // KHÔNG CHO GIẢM WATCHED TIME
        const watchedSeconds = Math.max(
            progress?.watchedSeconds || 0,
            dto.watchedSeconds,
        );

        // TÍNH %
        const percent = Math.min(
            100,
            Math.floor(
                (watchedSeconds / dto.duration) * 100,
            ),
        );

        const completed = percent >= 90;

        if (!progress) {
            progress =
                this.trainingProgressRepo.create({
                    employeeId,
                    trainingId: dto.trainingId,
                });
        }

        progress.watchedSeconds =
            watchedSeconds;

        progress.percent = percent;

        progress.completed = completed;

        progress.lastVideoSecond =
            dto.lastVideoSecond;

        // GHI THỜI GIAN HOÀN THÀNH
        if (
            completed &&
            !progress.completedAt
        ) {
            progress.completedAt =
                new Date();
        }

        await this.trainingProgressRepo.save(
            progress,
        );

        return {
            success: true,
            data: progress,
        };
    }

    // =========================
    // MY PROGRESS
    // =========================

    async getMyProgress(
        employeeId: number,
    ) {
        const data =
            await this.trainingProgressRepo.find({
                where: {
                    employeeId,
                },
                relations: ["training"],
                order: {
                    id: "DESC",
                },
            });

        return data.map((item) => ({
            id: item.id,

            trainingId: item.trainingId,

            title: item.training?.title,

            watchedSeconds:
                item.watchedSeconds,

            percent: item.percent,

            completed: item.completed,

            completedAt:
                item.completedAt,

            status: item.completed
                ? "COMPLETED"
                : item.percent > 0
                    ? "IN_PROGRESS"
                    : "NOT_STARTED",
        }));
    }

    // =========================
    // RESET TRAINING
    // =========================

    async resetTraining(
        employeeId: number,
        trainingId: number,
    ) {
        const progress =
            await this.trainingProgressRepo.findOne({
                where: {
                    employeeId,
                    trainingId,
                },
            });

        if (!progress) {
            throw new NotFoundException(
                "Progress not found",
            );
        }

        progress.watchedSeconds = 0;

        progress.percent = 0;

        progress.completed = false;

        progress.completedAt = null;

        progress.lastVideoSecond = 0;

        await this.trainingProgressRepo.save(
            progress,
        );

        return {
            success: true,
            message:
                "Reset training success",
        };
    }
}


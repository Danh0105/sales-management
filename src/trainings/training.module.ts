// training.module.ts

import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";


import { TrainingController } from "./training.controller";
import { TrainingService } from "./training.service";
import { Training } from "./trainings.entity";
import { TrainingProgress } from "./training-progress.entity";

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Training,
            TrainingProgress,
        ]),
    ],

    controllers: [TrainingController],

    providers: [TrainingService],

    exports: [TrainingService],
})
export class TrainingModule { }


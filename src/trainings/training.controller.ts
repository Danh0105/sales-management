
// training.controller.ts

import {
    Body,
    Controller,
    Get,
    Param,
    ParseIntPipe,
    Post,
    Req,
    UseGuards,
} from "@nestjs/common";

import { TrainingService } from "./training.service";
import { UpdateTrainingProgressDto } from "./update-training-progress.dto";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@UseGuards(JwtAuthGuard)
@Controller("training")
export class TrainingController {
    constructor(
        private readonly trainingService: TrainingService,
    ) { }

    // DANH SÁCH TRAINING
    @Get()
    findAll() {
        return this.trainingService.findAll();
    }

    // CHI TIẾT TRAINING
    @Get(":id")
    findOne(
        @Param("id", ParseIntPipe)
        id: number,
    ) {
        return this.trainingService.findOne(id);
    }

    // UPDATE PROGRESS
    @Post("progress")
    updateProgress(
        @Req() req,
        @Body()
        dto: UpdateTrainingProgressDto,
    ) {
        return this.trainingService.updateProgress(
            req.user.id,
            dto,
        );
    }

    // LẤY PROGRESS CỦA USER
    @Get("my/progress")
    getMyProgress(@Req() req: any) {

        console.log(req.user);

        return this.trainingService.getMyProgress(
            req.user.id,
        );
    }


    // RESET TRAINING
    @Post(":id/reset")
    resetTraining(
        @Req() req,
        @Param("id", ParseIntPipe)
        trainingId: number,
    ) {
        return this.trainingService.resetTraining(
            req.user.id,
            trainingId,
        );
    }
}


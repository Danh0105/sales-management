
// update-training-progress.dto.ts

import {
    IsNumber,
    Min,
} from "class-validator";

export class UpdateTrainingProgressDto {
    @IsNumber()
    trainingId!: number;

    @IsNumber()
    @Min(0)
    watchedSeconds!: number;

    @IsNumber()
    @Min(0)
    lastVideoSecond!: number;

    @IsNumber()
    @Min(1)
    duration!: number;
}


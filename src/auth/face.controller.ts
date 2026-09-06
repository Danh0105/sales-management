import {
    Controller,
    Post,
    Body,
    UseGuards,
    Req,
} from '@nestjs/common';

import { FaceService } from './face.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('face')
export class FaceController {

    constructor(
        private readonly faceService: FaceService,
    ) { }

    // =====================================================
    // 📌 LOGIN BY FACE
    // =====================================================
    @Post('login')
    async loginByFace(

        @Body()
        body: {
            descriptor: number[];
        },

    ) {

        return this.faceService.loginByFace(
            body.descriptor,
        );
    }

    // =====================================================
    // 📌 REGISTER FACE
    // =====================================================
    @Post('register')
    async registerByFace(

        @Body()
        body: {

            // nhiều descriptors
            descriptors: number[][];

            name: string;
        },

    ) {

        return this.faceService.registerByFace(

            body.descriptors,

            body.name,
        );
    }
    @UseGuards(JwtAuthGuard)
    @Post('register-employee')
    async registerEmployeeFace(
        @Req() req,
        @Body()
        body: {
            descriptors: number[][];
        },
    ) {
        return this.faceService.registerEmployeeFace(
            req.user.id,
            body.descriptors,
        );
    }
}
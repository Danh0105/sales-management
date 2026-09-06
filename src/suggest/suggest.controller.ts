// suggest.controller.ts
import {
    Controller,
    Post,
    Body,
    Get,
    UseInterceptors,
    UploadedFile,
    Put,
    Param,
    Req,
    UnauthorizedException,
    UseGuards,
    Patch,
    ParseIntPipe,
    Delete,
} from '@nestjs/common';
import { SuggestService } from './suggest.service';
import { CreateSuggestDto } from './dto/create-suggest.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';

import { SuggestStatus } from './SuggestStatus.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
@Controller('suggest')
export class SuggestController {
    constructor(
        private readonly service: SuggestService,
    ) { }
    @Get('my-suggests')
    @UseGuards(JwtAuthGuard)
    findMySuggests(@Req() req) {
        if (!req.user) {
            throw new UnauthorizedException('Chưa đăng nhập');
        }

        return this.service.findByEmployee(req.user.id);
    }
    @UseGuards(JwtAuthGuard)
    @Post()
    @UseInterceptors(
        FileInterceptor('file', {
            storage: diskStorage({
                destination: './uploads/suggest',
                filename: (_, file, cb) => {
                    const unique = Date.now() + '-' + Math.random();
                    cb(null, unique + extname(file.originalname));
                },
            }),
        }),
    )
    async create(
        @Body() dto: CreateSuggestDto,
        @UploadedFile() file: Express.Multer.File,
        @Req() req: any,
    ) {
        const user = req.user;

        if (!user) {
            throw new UnauthorizedException('User chưa đăng nhập');
        }

        const fileUrl = file
            ? `/uploads/suggest/${file.filename}`
            : undefined;

        return this.service.create(dto, fileUrl, user);
    }

    /** Tạo đề xuất gắn trực tiếp với xã/phường mà người dùng phụ trách. */
    @UseGuards(JwtAuthGuard)
    @Post('wards/:wardId')
    @UseInterceptors(
        FileInterceptor('file', {
            storage: diskStorage({
                destination: './uploads/suggest',
                filename: (_, file, cb) => {
                    const unique = Date.now() + '-' + Math.random();
                    cb(null, unique + extname(file.originalname));
                },
            }),
        }),
    )
    createForWard(
        @Param('wardId', ParseIntPipe) wardId: number,
        @Body() dto: CreateSuggestDto,
        @UploadedFile() file: Express.Multer.File,
        @Req() req: any,
    ) {
        const fileUrl = file
            ? `/uploads/suggest/${file.filename}`
            : undefined;
        return this.service.create(
            { ...dto, wardId, type: undefined },
            fileUrl,
            req.user,
        );
    }
    @Get('employee/:employeeId')
    getByEmployeeId(
        @Param('employeeId', ParseIntPipe) employeeId: number
    ) {
        return this.service.findByEmployee(employeeId);
    }

    @Get('stats/by-policy')
    getStatsByPolicy() {
        return this.service.getStatsByPolicy();
    }

    @Get(':id')
    findOne(
        @Param('id', ParseIntPipe) id: number
    ) {
        return this.service.findOne(id);
    }

    @Put(':id')
    update(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: CreateSuggestDto,
        @UploadedFile() file: Express.Multer.File,
        @Req() req,
    ) {
        const fileUrl = file ? `/uploads/suggest/${file.filename}` : undefined;

        return this.service.update(
            id,
            dto,
            fileUrl,
            req.user,
        );
    }
    @UseGuards(JwtAuthGuard)
    @Patch(':id/review')
    review(
        @Param('id', ParseIntPipe) id: number,
        @Body() body: { status: SuggestStatus; rejectReason?: string },
        @Req() req,
    ) {
        return this.service.reviewBySaleAdmin(
            id,
            body.status,
            req.user,
            body.rejectReason,
        );
    }
    @UseGuards(JwtAuthGuard)
    @Patch(':id/approve')
    approve(
        @Param('id', ParseIntPipe) id: number,
        @Body() body: { status: SuggestStatus; rejectReason?: string },
        @Req() req,
    ) {
        return this.service.approveByDirector(
            id,
            body.status,
            req.user,
            body.rejectReason,
        );
    }
    @UseGuards(JwtAuthGuard)
    @Delete(':id')
    remove(
        @Param('id', ParseIntPipe) id: number,
        @Req() req,
    ) {
        return this.service.remove(id, req.user);
    }
}

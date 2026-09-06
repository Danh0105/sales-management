import { Body, Controller, Get, Post } from "@nestjs/common";
import { CreateDisplayDto } from "./create-display.dto";
import { DisplayService } from "./display.service";
@Controller('display')
export class DisplayController {
    constructor(
        private readonly service: DisplayService,
    ) { }

    @Post()
    submit(
        @Body() dto: CreateDisplayDto,
    ) {
        return this.service.submit(dto);
    }

    @Get()
    findAll() {
        return this.service.findAll();
    }
        @Post("reset")
    reset() {
        return this.service.reset();
    }
}
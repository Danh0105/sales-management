import { Module } from '@nestjs/common';

import { TypeOrmModule } from '@nestjs/typeorm';

import { Display } from './display.entity';

import { DisplayController } from './display.controller';

import { DisplayService } from './display.service';

@Module({
    imports: [
        TypeOrmModule.forFeature([
            Display,
        ]),
    ],

    controllers: [
        DisplayController,
    ],

    providers: [
        DisplayService,
    ],

    exports: [
        DisplayService,
    ],
})
export class DisplayModule { }
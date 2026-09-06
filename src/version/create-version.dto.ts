import { IsString, IsBoolean } from 'class-validator';

export class CreateVersionDto {
    @IsString()
    version!: string;

    @IsBoolean()
    force!: boolean;

    @IsString()
    note!: string;
}
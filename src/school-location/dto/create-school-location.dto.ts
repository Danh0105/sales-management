import {
    IsNotEmpty,
    IsString,
    IsNumber,
    IsInt,
    Min,
    Max,
    IsOptional,
    IsUrl,
    Matches,
    MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateSchoolLocationDto {
    @IsNotEmpty()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    schoolId!: number;

    @IsNotEmpty()
    @IsString()
    name!: string;

    @IsOptional()
    @IsString()
    address?: string | null;

    @IsOptional()
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 7 })
    @Min(-90)
    @Max(90)
    latitude?: number | null;

    @IsOptional()
    @Type(() => Number)
    @IsNumber({ maxDecimalPlaces: 7 })
    @Min(-180)
    @Max(180)
    longitude?: number | null;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    checkinRadius?: number | null;

    // Cùng bộ validator với CreateSchoolDto — phải nhận được link rút gọn
    // maps.app.goo.gl vì đó là dạng link app Google Maps đưa ra khi bấm "Chia sẻ".
    @IsOptional()
    @MaxLength(500)
    @IsUrl({ protocols: ['https'], require_protocol: true }, {
        message: 'Chỉ hỗ trợ link chia sẻ Google Maps',
    })
    @Matches(
        /^https:\/\/(?:maps\.app\.goo\.gl|goo\.gl|maps\.google\.com|www\.google\.com|google\.com)(?:[/:?#]|$)/i,
        { message: 'Chỉ hỗ trợ link chia sẻ Google Maps' },
    )
    googleMapsUrl?: string | null;

    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    wardId?: number | null;
}

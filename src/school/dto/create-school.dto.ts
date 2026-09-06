import { IsInt, IsNotEmpty, IsOptional, IsNumber, IsUrl, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreateSchoolDto {
    @IsNotEmpty()
    name!: string;

    @IsOptional()
    address?: string;

    @IsOptional()
    @IsNumber()
    @Min(-90)
    @Max(90)
    latitude?: number | null;

    @IsOptional()
    @IsNumber()
    @Min(-180)
    @Max(180)
    longitude?: number | null;

    @IsOptional()
    @IsInt()
    @Min(20)
    @Max(2000)
    checkinRadius?: number | null;

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
    representative?: string;

    @IsOptional()
    @IsNumber()
    scale?: number;

    @IsOptional()
    @IsNumber()
    classCount?: number;

    @IsOptional()
    taxCode?: string;

    @IsOptional()
    phone?: string;

    @IsOptional()
    employeeId?: number;

    @IsOptional()
    employeeRegionId?: number | null;

    @IsOptional()
    @IsNumber()
    wardId?: number;
}

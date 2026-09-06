import { IsNotEmpty, IsString, IsUrl, MaxLength } from 'class-validator';

export class ResolveGoogleMapsDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(2048)
    @IsUrl({ require_protocol: true }, { message: 'Link Google Maps không hợp lệ' })
    url!: string;
}

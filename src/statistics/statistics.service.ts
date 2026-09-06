import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class StatisticsService {
    constructor(private readonly dataSource: DataSource) { }

    async getStatisticsBySchoolYear(schoolYear: string) {
        const result = await this.dataSource.query(
            `
        SELECT 
            s.id,
            s.name,
            s.student_count,
            s.contract_number,
            s.contract_years,
            s.appendix_years,
            s.start_date,
            s.school_year,

            sc.id as school_id,
            sc.name as school_name,
            sc.address,
            sc.representative,
            sc.phone,
            sc.class_count,

            p.data,
            p.duration_months
        FROM subjects s
        LEFT JOIN schools sc ON sc.id = s.school_id
        LEFT JOIN policy p 
            ON p."subjectId" = s.id  
            AND p.status = 'DIRECTOR_APPROVED'

        WHERE s.school_year = $1;
        `,
            [schoolYear],
        );

        return result;
    }
}
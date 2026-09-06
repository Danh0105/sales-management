import {
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';

import { InjectRepository } from '@nestjs/typeorm';

import { Repository } from 'typeorm';

import { Employee } from '../employee/employee.entity';
import { EmployeeFace } from '../employee/employee-face.entity';



@Injectable()
export class FaceService {

    constructor(

        @InjectRepository(Employee)
        private readonly employeeRepository:
            Repository<Employee>,

        @InjectRepository(EmployeeFace)
        private readonly employeeFaceRepository:
            Repository<EmployeeFace>,

        private readonly jwtService: JwtService,

    ) { }
    private normalizeDescriptor(
        descriptor: number[],
    ): number[] {

        const magnitude = Math.sqrt(
            descriptor.reduce(
                (sum, value) =>
                    sum + value * value,
                0,
            ),
        );

        if (!magnitude) {

            return descriptor;
        }

        return descriptor.map(
            (value) => value / magnitude,
        );
    }
    private calculateCentroid(
        descriptors: number[][],
    ): number[] {

        if (!descriptors.length) {

            return [];
        }

        const centroid =
            new Array(
                descriptors[0].length,
            ).fill(0);

        for (const descriptor of descriptors) {

            for (
                let i = 0;
                i < descriptor.length;
                i++
            ) {

                centroid[i] += descriptor[i];
            }
        }

        for (
            let i = 0;
            i < centroid.length;
            i++
        ) {

            centroid[i] =
                centroid[i] /
                descriptors.length;
        }

        return centroid;
    }
    // =====================================================
    // 📌 VALIDATE DESCRIPTOR
    // =====================================================
    private validateDescriptor(
        descriptor: number[],
    ) {

        if (
            !descriptor ||
            descriptor.length !== 128
        ) {

            throw new UnauthorizedException(
                'Descriptor không hợp lệ',
            );
        }
    }
    private euclideanDistance(
        a: number[],
        b: number[],
    ): number {

        let sum = 0;

        for (let i = 0; i < a.length; i++) {

            const diff = a[i] - b[i];

            sum += diff * diff;
        }

        return Math.sqrt(sum);
    }


    // =====================================================
    // 📌 COSINE SIMILARITY
    // =====================================================
    private cosineSimilarity(
        a: number[],
        b: number[],
    ): number {

        const dot = a.reduce(
            (sum, val, i) =>
                sum + val * b[i],
            0,
        );

        const magA = Math.sqrt(
            a.reduce(
                (sum, val) =>
                    sum + val * val,
                0,
            ),
        );

        const magB = Math.sqrt(
            b.reduce(
                (sum, val) =>
                    sum + val * val,
                0,
            ),
        );

        return dot / (magA * magB);
    }

    // =====================================================
    // 📌 LOGIN BY FACE
    // =====================================================
    async loginByFace(
        descriptor: number[],
    ) {

        // =================================================
        // VALIDATE
        // =================================================
        this.validateDescriptor(
            descriptor,
        );

        // =================================================
        // LOAD ALL ACTIVE FACES
        // =================================================
        const faces =
            await this.employeeFaceRepository.find({

                where: {
                    isActive: true,
                },

                relations: [
                    'employee',
                ],
            });

        if (!faces.length) {

            throw new UnauthorizedException(
                'Hệ thống chưa có dữ liệu khuôn mặt',
            );
        }

        // =================================================
        // BEST MATCH
        // =================================================
        let bestUser: Employee | null = null;

        let bestSimilarity = -1;

        // =================================================
        // LOOP ALL FACE
        // =================================================
        for (const face of faces) {

            // validate saved descriptor
            if (
                !face.descriptor ||
                face.descriptor.length !== 128
            ) {

                continue;
            }

            const normalizedInput =
                this.normalizeDescriptor(
                    descriptor,
                );
            const similarity =
                this.cosineSimilarity(
                    normalizedInput,
                    face.descriptor,
                );
            // bigger = better
            if (similarity > bestSimilarity) {

                bestSimilarity = similarity;

                bestUser = face.employee;
            }
        }

        console.log(
            'FACE SIMILARITY:',
            bestSimilarity,
        );

        // =================================================
        // THRESHOLD
        // =================================================
        // 0.4 = banking level
        // 0.45 = enterprise
        // 0.5 = normal app
        // =================================================
        if (bestSimilarity < 0.82) {

            throw new UnauthorizedException(
                'Không nhận diện được khuôn mặt',
            );
        }

        if (!bestUser) {

            throw new UnauthorizedException(
                'Không tìm thấy người dùng',
            );
        }

        // =================================================
        // OPTIONAL AUTO LEARNING
        // =================================================
        // chỉ save nếu match cực tốt
        // tránh database phình
        // =================================================
        /*         if (bestSimilarity > 0.9) {
        
                    await this.employeeFaceRepository.save({
        
                        employeeId:
                            bestUser.id,
        
                        descriptor,
        
                        qualityScore:
                            bestSimilarity,
        
                        isActive: true,
                    });
                }
         */
        // =================================================
        // JWT
        // =================================================
        const payload = {

            sub: bestUser.id,

            roles: bestUser.roles ?? [],

            name: bestUser.name,
        };

        const access_token =
            this.jwtService.sign(
                payload,
            );

        // =================================================
        // RESPONSE
        // =================================================
        return {

            success: true,

            access_token,

            similarity: bestSimilarity,

            user: {

                id: bestUser.id,

                name: bestUser.name,

                roles: bestUser.roles ?? [],
            },
        };
    }

    // =====================================================
    // 📌 REGISTER FACE
    // =====================================================
    async registerByFace(
        descriptors: number[][],
        name: string,
    ) {

        // =================================================
        // VALIDATE INPUT
        // =================================================
        if (!name?.trim()) {

            throw new UnauthorizedException(
                'Tên không hợp lệ',
            );
        }

        if (!descriptors || descriptors.length < 15) {

            throw new UnauthorizedException(
                'Cần tối thiểu 15 mẫu khuôn mặt',
            );
        }

        // =================================================
        // VALIDATE DESCRIPTOR FORMAT
        // =================================================
        for (const descriptor of descriptors) {

            if (
                !Array.isArray(descriptor) ||
                descriptor.length !== 128
            ) {

                throw new UnauthorizedException(
                    'Descriptor không hợp lệ',
                );
            }

            for (const value of descriptor) {

                if (
                    typeof value !== 'number' ||
                    Number.isNaN(value)
                ) {

                    throw new UnauthorizedException(
                        'Descriptor chứa dữ liệu lỗi',
                    );
                }
            }
        }

        // =================================================
        // REMOVE DUPLICATE INPUT DESCRIPTORS
        // =================================================
        const uniqueDescriptors: number[][] = [];

        for (const descriptor of descriptors) {

            let isDuplicate = false;

            for (const saved of uniqueDescriptors) {

                const distance =
                    this.euclideanDistance(
                        descriptor,
                        saved,
                    );

                // giống nhau quá -> bỏ
                if (distance < 0.08) {

                    isDuplicate = true;

                    break;
                }
            }

            if (!isDuplicate) {

                uniqueDescriptors.push(
                    descriptor,
                );
            }
        }

        // =================================================
        // QUALITY CHECK
        // =================================================
        if (uniqueDescriptors.length < 10) {

            throw new UnauthorizedException(
                'Dữ liệu khuôn mặt không đủ đa dạng',
            );
        }

        // =================================================
        // LOAD ALL FACE VECTORS
        // =================================================
        const allFaces =
            await this.employeeFaceRepository.find({

                where: {
                    isActive: true,
                },

                select: [
                    'id',
                    'employeeId',
                    'descriptor',
                ],
            });

        // =================================================
        // DUPLICATE FACE CHECK
        // =================================================

        const normalizedDescriptors =
            descriptors.map(
                (d) =>
                    this.normalizeDescriptor(d),
            );

        // =================================================
        // DUPLICATE FACE CHECK
        // =================================================
        let matchedFrames = 0;

        for (const input of normalizedDescriptors) {

            let bestSimilarity = -1;

            for (const saved of allFaces) {

                // validate descriptor
                if (
                    !saved.descriptor ||
                    saved.descriptor.length !== 128
                ) {

                    continue;
                }

                const similarity =
                    this.cosineSimilarity(
                        input,
                        saved.descriptor,
                    );

                if (similarity > bestSimilarity) {

                    bestSimilarity = similarity;
                }
            }

            // BANKING LEVEL THRESHOLD
            if (bestSimilarity > 0.85) {

                matchedFrames++;
            }
        }

        // =================================================
        // FINAL DUPLICATE DECISION
        // =================================================
        // cần nhiều frame match mới reject
        if (matchedFrames >= 6) {

            throw new UnauthorizedException(
                'Khuôn mặt đã tồn tại',
            );
        }

        // =================================================
        // CREATE CENTROID
        // =================================================
        const centroid =
            this.calculateCentroid(
                uniqueDescriptors,
            );

        // =================================================
        // CREATE EMPLOYEE
        // =================================================
        const employee =
            this.employeeRepository.create({

                name: name.trim(),

                roles: ['employee'],
            });

        const savedEmployee =
            await this.employeeRepository.save(
                employee,
            );

        // =================================================
        // SAVE FACE EMBEDDINGS
        // =================================================
        const faceEntities =
            uniqueDescriptors.map(
                (descriptor) => {

                    return this.employeeFaceRepository.create({

                        employeeId:
                            savedEmployee.id,

                        descriptor,

                        centroid,

                        qualityScore: 1,

                        isActive: true,
                    });
                },
            );

        await this.employeeFaceRepository.save(
            faceEntities,
        );

        // =================================================
        // JWT
        // =================================================
        const payload = {

            sub: savedEmployee.id,

            roles: savedEmployee.roles ?? [],

            name: savedEmployee.name,
        };

        const access_token =
            this.jwtService.sign(payload);

        // =================================================
        // RESPONSE
        // =================================================
        return {

            success: true,

            message:
                'Đăng ký FaceID thành công',

            access_token,

            user: {

                id: savedEmployee.id,

                name: savedEmployee.name,

                roles: savedEmployee.roles ?? [],
            },
        };
    }
    async registerEmployeeFace(
        employeeId: number,
        descriptors: number[][],
    ) {
        // =================================================
        // VALIDATE EMPLOYEE
        // =================================================
        const employee = await this.employeeRepository.findOne({
            where: {
                id: employeeId,
            },
        });

        if (!employee) {
            throw new UnauthorizedException(
                'Nhân viên không tồn tại',
            );
        }

        // =================================================
        // VALIDATE DESCRIPTORS
        // =================================================
        if (!descriptors || descriptors.length < 15) {
            throw new UnauthorizedException(
                'Cần tối thiểu 15 mẫu khuôn mặt',
            );
        }

        for (const descriptor of descriptors) {
            if (
                !Array.isArray(descriptor) ||
                descriptor.length !== 128
            ) {
                throw new UnauthorizedException(
                    'Descriptor không hợp lệ',
                );
            }

            for (const value of descriptor) {
                if (
                    typeof value !== 'number' ||
                    Number.isNaN(value)
                ) {
                    throw new UnauthorizedException(
                        'Descriptor chứa dữ liệu lỗi',
                    );
                }
            }
        }

        // =================================================
        // NORMALIZE INPUT
        // =================================================
        const normalizedDescriptors = descriptors.map((d) =>
            this.normalizeDescriptor(d),
        );

        // =================================================
        // REMOVE DUPLICATE INPUT
        // =================================================
        const uniqueDescriptors: number[][] = [];

        for (const descriptor of normalizedDescriptors) {
            let isDuplicate = false;

            for (const saved of uniqueDescriptors) {
                const distance = this.euclideanDistance(
                    descriptor,
                    saved,
                );

                if (distance < 0.08) {
                    isDuplicate = true;
                    break;
                }
            }

            if (!isDuplicate) {
                uniqueDescriptors.push(descriptor);
            }
        }

        if (uniqueDescriptors.length < 10) {
            throw new UnauthorizedException(
                'Dữ liệu khuôn mặt không đủ đa dạng',
            );
        }

        // =================================================
        // CHECK EMPLOYEE ALREADY REGISTERED FACE
        // =================================================
        const existingFace =
            await this.employeeFaceRepository.count({
                where: {
                    employeeId,
                    isActive: true,
                },
            });

        if (existingFace > 0) {
            throw new UnauthorizedException(
                'Nhân viên đã đăng ký khuôn mặt',
            );
        }

        // =================================================
        // CHECK DUPLICATE WITH OTHER USERS
        // =================================================
        const allFaces =
            await this.employeeFaceRepository.find({
                where: {
                    isActive: true,
                },
                select: [
                    'id',
                    'employeeId',
                    'descriptor',
                ],
            });

        let matchedFrames = 0;

        for (const input of uniqueDescriptors) {
            let bestSimilarity = -1;

            for (const saved of allFaces) {
                if (
                    saved.employeeId === employeeId ||
                    !saved.descriptor ||
                    saved.descriptor.length !== 128
                ) {
                    continue;
                }

                const similarity = this.cosineSimilarity(
                    input,
                    saved.descriptor,
                );

                if (similarity > bestSimilarity) {
                    bestSimilarity = similarity;
                }
            }

            if (bestSimilarity > 0.85) {
                matchedFrames++;
            }
        }

        if (matchedFrames >= 6) {
            throw new UnauthorizedException(
                'Khuôn mặt đã tồn tại trong hệ thống',
            );
        }

        // =================================================
        // CREATE CENTROID
        // =================================================
        const centroid =
            this.calculateCentroid(uniqueDescriptors);

        // =================================================
        // SAVE FACE
        // =================================================
        const faceEntities = uniqueDescriptors.map(
            (descriptor) =>
                this.employeeFaceRepository.create({
                    employee,
                    descriptor,
                    centroid,
                    qualityScore: 1,
                    isActive: true,
                })
        );

        await this.employeeFaceRepository.save(faceEntities);

        return {
            success: true,
            message: 'Đăng ký khuôn mặt thành công',
            employee: {
                id: employee.id,
                name: employee.name,
                roles: employee.roles ?? [],
            },
        };
    }
    // =====================================================
    // 📌 ADD NEW FACE
    // =====================================================
    async addFaceDescriptor(
        employeeId: number,
        descriptor: number[],
    ) {

        this.validateDescriptor(
            descriptor,
        );

        const normalized =
            this.normalizeDescriptor(
                descriptor,
            );

        const employee =
            await this.employeeRepository.findOne({

                where: {
                    id: employeeId,
                },
            });

        if (!employee) {

            throw new UnauthorizedException(
                'Nhân viên không tồn tại',
            );
        }

        const face =
            this.employeeFaceRepository.create({

                employeeId,

                descriptor: normalized,

                qualityScore: 1,

                isActive: true,
            });

        return this.employeeFaceRepository.save(
            face,
        );
    }

    // =====================================================
    // 📌 REMOVE FACE
    // =====================================================
    async removeFace(
        faceId: number,
    ) {

        const face =
            await this.employeeFaceRepository.findOne({

                where: {
                    id: faceId,
                },
            });

        if (!face) {

            throw new UnauthorizedException(
                'Face không tồn tại',
            );
        }

        face.isActive = false;

        await this.employeeFaceRepository.save(
            face,
        );

        return {
            message:
                'Xóa khuôn mặt thành công',
        };
    }
}
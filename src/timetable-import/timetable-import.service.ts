import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SchoolClassService } from '../teaching/school-class.service';
import { TeachingBulkService } from '../teaching/teaching-bulk.service';
import {
    SlotSpec,
    TeacherMatchingService,
} from '../teaching/teacher-matching.service';
import {
  BulkScheduleItemDto,
  MAX_BULK_ITEMS,
} from '../teaching/dto/teaching-bulk.dto';

import {
  DraftResolution,
  TimetableDraft,
} from './entities/timetable-draft.entity';
import {
  ResolutionPatch,
  TimetableChatService,
} from './timetable-chat.service';
import { TimetableExtractService } from './timetable-extract.service';
import { Option, TimetableResolverService } from './timetable-resolver.service';
import {
  buildPreview,
  gradeLevelOf,
  TimetablePreview,
} from './timetable-preview';
import { normalizeTimeString } from './timetable-validate';
import { ExtractedEntry, ExtractedPeriodTime } from './timetable.types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Đưa giờ model trả về ("7h00", "7h", "7.30"…) về "HH:mm" rồi mới kiểm tra.
 *
 * Trước đây giờ sai định dạng bị lọc bỏ âm thầm hoặc lọt xuống tầng xếp lịch
 * và bị từ chối bằng thông báo khó hiểu "startTime phải nhỏ hơn endTime" —
 * vì giờ được so sánh dạng chuỗi nên "9h45" bị coi là lớn hơn "14h00".
 */
function normalizePeriodTimes(
  times: ExtractedPeriodTime[] | null | undefined,
): ExtractedPeriodTime[] {
  return (times ?? []).flatMap((time) => {
    const startTime = normalizeTimeString(time.startTime);
    const endTime = normalizeTimeString(time.endTime);
    if (!startTime || !endTime || startTime >= endTime) return [];
    return [{ ...time, startTime, endTime }];
  });
}

export interface DraftView {
  draftId: number;
  status: string;
  preview: TimetablePreview;
  messages: { role: string; text: string; at: string }[];
  commitResult?: unknown;
}

@Injectable()
export class TimetableImportService {
  constructor(
    @InjectRepository(TimetableDraft)
    private readonly drafts: Repository<TimetableDraft>,
    private readonly extractService: TimetableExtractService,
    private readonly chatService: TimetableChatService,
    private readonly resolver: TimetableResolverService,
    private readonly schoolClasses: SchoolClassService,
    private readonly bulk: TeachingBulkService,
    private readonly matching: TeacherMatchingService,
  ) {}

  async createFromImage(
    file: Express.Multer.File,
    employeeId: number,
  ): Promise<DraftView> {
    const { data } = await this.extractService.extract(file);

    const schools = await this.resolver.findSchools(data.schoolName);
    const teachers = data.teacherName
      ? await this.resolver.findTeachers(data.teacherName)
      : [];

    const resolution: DraftResolution = {
      // Chỉ tự chốt khi có đúng một ứng viên; còn mơ hồ thì để chatbot hỏi.
      schoolId: schools.length === 1 ? schools[0].id : null,
      schoolName: schools.length === 1 ? schools[0].name : data.schoolName,
      subjectId: null,
      subjectName: data.subjectName,
      teacherId: teachers.length === 1 ? teachers[0].id : null,
      teacherName: teachers.length === 1 ? teachers[0].name : data.teacherName,
      schoolYear: data.schoolYear,
      effectiveFrom: data.effectiveFrom,
      effectiveTo: data.effectiveTo,
      effectiveToUnbounded: false,
      periodTimes: normalizePeriodTimes(data.periodTimes),
    };

    if (resolution.schoolId) {
      const subjects = await this.resolver.findSubjects(
        resolution.schoolId,
        resolution.schoolYear,
        data.subjectName,
      );
      if (subjects.length === 1) {
        resolution.subjectId = subjects[0].id;
        resolution.subjectName = subjects[0].name;
      }
    }

    const draft = await this.drafts.save(
      this.drafts.create({
        createdById: employeeId,
        status: 'DRAFT',
        extracted: data,
        resolution,
        messages: [],
      }),
    );

    const initialView = await this.view(draft);
    const firstNeed = initialView.preview.needs[0]?.question;
    const assistantText = firstNeed
      ? `Mình đã đọc được ${initialView.preview.scheduleCount} tiết học và tạo bản nháp để bạn kiểm tra. ${firstNeed}`
      : `Mình đã đọc được ${initialView.preview.scheduleCount} tiết học. Bạn hãy kiểm tra bảng preview; nếu có ô nào sai, cứ nhắn mình sửa trước khi xác nhận tạo lịch.`;
    draft.messages = [
      {
        role: 'assistant',
        text: assistantText,
        at: new Date().toISOString(),
      },
    ];
    await this.drafts.save(draft);

    return { ...initialView, messages: draft.messages };
  }

  /**
   * Bắt đầu thẳng bằng chat, không cần ảnh: Nhân sự mô tả lịch cần xếp bằng
   * lời (VD: "xếp cô Hồng dạy lớp 1A môn Toán thứ 3 tiết 1, từ tuần sau").
   * Bản nháp khởi tạo trống rồi đi thẳng vào đúng luồng `chat()` — không cần
   * một bước "đọc ảnh" riêng vì không có gì để đọc.
   */
  async createFromText(message: string, employeeId: number): Promise<DraftView> {
    const emptyResolution: DraftResolution = {
      schoolId: null,
      schoolName: null,
      subjectId: null,
      subjectName: null,
      teacherId: null,
      teacherName: null,
      schoolYear: null,
      effectiveFrom: null,
      effectiveTo: null,
      effectiveToUnbounded: false,
      periodTimes: [],
    };

    const draft = await this.drafts.save(
      this.drafts.create({
        createdById: employeeId,
        status: 'DRAFT',
        extracted: {
          schoolName: null,
          subjectName: null,
          schoolYear: null,
          teacherName: null,
          effectiveFrom: null,
          effectiveTo: null,
          periodTimes: [],
          entries: [],
          missing: [],
          notes: null,
        },
        resolution: emptyResolution,
        messages: [],
      }),
    );

    return this.chat(draft.id, message);
  }

  async get(draftId: number): Promise<DraftView> {
    return this.view(await this.load(draftId));
  }

  async chat(draftId: number, message: string): Promise<DraftView> {
    const draft = await this.load(draftId);
    if (draft.status !== 'DRAFT') {
      throw new ConflictException({
        code: 'TIMETABLE_DRAFT_CLOSED',
        message: 'Bản nháp này đã chốt, không sửa được nữa',
      });
    }

    const { preview, options } = await this.buildView(draft);

    const turn = await this.chatService.reply({
      resolution: draft.resolution,
      needs: preview.needs,
      history: draft.messages,
      entries: draft.extracted.entries,
      message,
    });

    draft.resolution = await this.applyPatch(
      draft.resolution,
      turn.patch,
      options,
    );
    const entryResult = this.applyEntryChanges(
      draft.extracted.entries,
      turn.patch.entryChanges ?? [],
    );
    draft.extracted = {
      ...draft.extracted,
      entries: entryResult.entries,
    };
    // Người dùng nhắc tên trường/môn/giáo viên lần đầu qua lời nói (chưa có
    // trong danh sách lựa chọn của lượt này) — tra ngay để lượt sau (hoặc
    // ngay preview trả về lượt này) đã có lựa chọn cho họ chốt.
    await this.applyNameHints(draft, turn.patch);
    const now = new Date().toISOString();
    const assistantReply =
      entryResult.skipped > 0
        ? `${turn.reply} Có ${entryResult.skipped} chỉnh sửa ô lịch chưa áp dụng được vì không xác định được duy nhất một ô; vui lòng mô tả rõ thứ, buổi, tiết và tên lớp.`
        : turn.reply;
    draft.messages = [
      ...draft.messages,
      { role: 'user', text: message, at: now },
      { role: 'assistant', text: assistantReply, at: now },
    ];

    return this.view(await this.drafts.save(draft));
  }

  /**
   * Bước ghi dữ liệu — **không** gọi mô hình ngôn ngữ. Model chỉ đề xuất, còn
   * việc tạo bản ghi đi qua đúng các service sẵn có nên mọi quy tắc nghiệp vụ
   * (trùng giờ giáo viên, môn thuộc trường, lớp ngừng dùng) giữ nguyên.
   */
  async commit(draftId: number, employeeId: number): Promise<DraftView> {
    const draft = await this.load(draftId);
    if (draft.status !== 'DRAFT') {
      throw new ConflictException({
        code: 'TIMETABLE_DRAFT_CLOSED',
        message: 'Bản nháp này đã được chốt trước đó',
      });
    }

    const { preview } = await this.buildView(draft);
    if (!preview.canCommit) {
      throw new BadRequestException({
        code: 'TIMETABLE_DRAFT_INCOMPLETE',
        message: 'Bản nháp còn thiếu thông tin hoặc còn lỗi cần xử lý',
        blockers: preview.blockers,
        needs: preview.needs,
      });
    }

    const { schoolId, schoolYear, subjectId, teacherId } = draft.resolution;
    const createdClasses: { name: string; id: number }[] = [];

    for (const name of preview.newClassNames) {
      const created = await this.schoolClasses.create({
        schoolId: schoolId!,
        name,
        schoolYear: schoolYear!,
        gradeLevel: gradeLevelOf(name) ?? undefined,
      });
      createdClasses.push({ name, id: created.id });
    }

    // Lớp vừa tạo chưa có trong map cũ nên tra lại toàn bộ trước khi xếp lịch.
    const classes = await this.resolver.findClasses(schoolId!, schoolYear!);
    // Bản nháp tạo trước khi có bước chuẩn hoá vẫn giữ giờ dạng "7h00" trong
    // DB — chuẩn hoá lại tại đây để commit được thay vì báo lỗi khó hiểu.
    const { rows } = buildPreview(
      draft.extracted,
      {
        ...draft.resolution,
        periodTimes: normalizePeriodTimes(draft.resolution.periodTimes),
      },
      classes,
    );

    const items: BulkScheduleItemDto[] = rows.map((row) => ({
      classId: row.classId!,
      subjectId: subjectId!,
      dayOfWeek: row.dayOfWeek,
      startTime: row.startTime!,
      endTime: row.endTime!,
      periods: 1,
    }));

    const scheduleResults: unknown[] = [];
    for (let i = 0; i < items.length; i += MAX_BULK_ITEMS) {
      const result = await this.bulk.createSchedules({
        teacherId: teacherId!,
        effectiveFrom: draft.resolution.effectiveFrom!,
        effectiveTo: draft.resolution.effectiveTo ?? undefined,
        items: items.slice(i, i + MAX_BULK_ITEMS),
      });
      scheduleResults.push(result);
    }

    draft.status = 'COMMITTED';
    draft.committedAt = new Date();
    draft.commitResult = {
      committedById: employeeId,
      createdClasses,
      scheduleResults,
    };

    return this.view(await this.drafts.save(draft));
  }

  async cancel(draftId: number): Promise<{ ok: true }> {
    const draft = await this.load(draftId);
    if (draft.status === 'COMMITTED') {
      throw new ConflictException({
        code: 'TIMETABLE_DRAFT_COMMITTED',
        message: 'Bản nháp đã tạo lịch, không huỷ được',
      });
    }
    draft.status = 'CANCELLED';
    await this.drafts.save(draft);
    return { ok: true };
  }

  // ---- nội bộ ----

  private async load(draftId: number): Promise<TimetableDraft> {
    const draft = await this.drafts.findOne({ where: { id: draftId } });
    if (!draft) {
      throw new NotFoundException({
        code: 'TIMETABLE_DRAFT_NOT_FOUND',
        message: 'Không tìm thấy bản nháp thời khoá biểu',
      });
    }
    return draft;
  }

  private async view(draft: TimetableDraft): Promise<DraftView> {
    const { preview } = await this.buildView(draft);
    return {
      draftId: draft.id,
      status: draft.status,
      preview,
      messages: draft.messages,
      commitResult: draft.commitResult ?? undefined,
    };
  }

  /**
   * Dựng preview kèm danh sách lựa chọn cho từng thông tin còn thiếu. Danh
   * sách này vừa để hiển thị, vừa là tập ID hợp lệ khi áp patch của model.
   */
  private async buildView(draft: TimetableDraft): Promise<{
    preview: TimetablePreview;
    options: {
      schools: Option[];
      subjects: Option[];
      teachers: Option[];
    };
  }> {
    const { resolution, extracted } = draft;

    const schools = resolution.schoolId
      ? []
      : await this.resolver.findSchools(extracted.schoolName);

    const subjects =
      resolution.schoolId && !resolution.subjectId
        ? await this.resolver.findSubjects(
            resolution.schoolId,
            resolution.schoolYear,
            extracted.subjectName,
          )
        : [];

    // Ảnh hiếm khi ghi tên giáo viên (thường chỉ có nhãn chức danh), nên khi
    // tìm theo tên không ra thì xếp hạng theo tiêu chí trong hồ sơ.
    let teachers: Option[] = [];
    if (!resolution.teacherId) {
      teachers = await this.resolver.findTeachers(resolution.teacherName);
      if (teachers.length === 0) {
        teachers = await this.rankTeachers(draft);
      }
    }

    const classes =
      resolution.schoolId && resolution.schoolYear
        ? await this.resolver.findClasses(
            resolution.schoolId,
            resolution.schoolYear,
          )
        : new Map();

    // Chỉ tra được khi đã chốt giáo viên; trước đó chưa biết hỏi lịch của ai.
    const teacherConflicts = resolution.teacherId
      ? await this.matching.findConflictsForSlots(
          resolution.teacherId,
          this.toSlots(draft),
        )
      : [];

    return {
      preview: buildPreview(
        extracted,
        resolution,
        classes,
        teachers,
        schools,
        subjects,
        teacherConflicts,
      ),
      options: { schools, subjects, teachers },
    };
  }

  /**
   * Các ô lịch của bản nháp dưới dạng `SlotSpec`. Bỏ qua ô chưa có khung giờ —
   * chưa biết giờ thì chưa xét trùng được, và những ô đó đã bị chặn riêng bằng
   * `PERIOD_TIME_MISSING`.
   */
  private toSlots(draft: TimetableDraft): SlotSpec[] {
    const { schoolId, subjectId, effectiveFrom, effectiveTo } = draft.resolution;
    if (!schoolId || !subjectId || !effectiveFrom) return [];

    const times = new Map(
      draft.resolution.periodTimes.map((t) => [`${t.session}|${t.period}`, t]),
    );

    return (draft.extracted.entries ?? []).flatMap((entry) => {
      const time = times.get(`${entry.session}|${entry.period}`);
      if (!time) return [];
      return [
        {
          schoolId,
          subjectId,
          dayOfWeek: entry.dayOfWeek,
          startTime: time.startTime,
          endTime: time.endTime,
          effectiveFrom,
          effectiveTo: effectiveTo ?? undefined,
          periods: 1,
        },
      ];
    });
  }

  /**
   * Xếp hạng giáo viên cho toàn bộ thời khoá biểu theo tiêu chí trong hồ sơ:
   * trường được dạy, môn được dạy, khoảng cách, tải tuần, trùng lịch.
   *
   * Chỉ chạy khi đã chốt được trường + môn + giờ; thiếu thì lùi về danh sách
   * phẳng để Nhân sự vẫn chọn tay được. Xếp hạng sai vì thiếu dữ liệu còn tệ
   * hơn không xếp hạng.
   */
  private async rankTeachers(draft: TimetableDraft): Promise<Option[]> {
    const slots = this.toSlots(draft);
    if (slots.length === 0) return this.resolver.listTeachers();

    const { candidates } = await this.matching.findCandidatesForSlots(slots);

    return candidates.map((c) => ({
      id: c.teacherId,
      name: c.teacherName,
      // Lý do đi kèm để Nhân sự thấy vì sao người này được xếp trên, và vì
      // sao người kia bị loại — chọn mù theo thứ tự là mất luôn ý nghĩa.
      hint: c.eligible
        ? `${c.score} điểm · ${c.reasons
            .filter((r) => r.kind === 'PASS')
            .map((r) => r.message)
            .join(' · ')}`
        : `Không phù hợp: ${c.reasons
            .filter((r) => r.kind === 'FAIL')
            .map((r) => r.message)
            .join('; ')}`,
    }));
  }

  /**
   * Áp patch của model lên bản nháp, sau khi kiểm lại từng giá trị.
   *
   * ID phải nằm trong danh sách đã đưa cho model ở chính lượt đó; ngày giờ
   * phải đúng định dạng. Model đề xuất sai thì bị bỏ qua, không tạo được dữ
   * liệu rác.
   */
  private async applyPatch(
    current: DraftResolution,
    patch: ResolutionPatch,
    options: { schools: Option[]; subjects: Option[]; teachers: Option[] },
  ): Promise<DraftResolution> {
    const next: DraftResolution = { ...current };

    const school = options.schools.find((o) => o.id === patch.schoolId);
    if (school) {
      next.schoolId = school.id;
      next.schoolName = school.name;
      // Đổi trường thì môn cũ không còn thuộc trường mới nữa.
      next.subjectId = null;
    }

    const subject = options.subjects.find((o) => o.id === patch.subjectId);
    if (subject) {
      next.subjectId = subject.id;
      next.subjectName = subject.name;
    }

    const teacher = options.teachers.find((o) => o.id === patch.teacherId);
    if (teacher) {
      next.teacherId = teacher.id;
      next.teacherName = teacher.name;
    }

    if (patch.schoolYear?.trim()) {
      next.schoolYear = patch.schoolYear.trim();
    }

    if (patch.effectiveFrom && DATE_PATTERN.test(patch.effectiveFrom)) {
      next.effectiveFrom = patch.effectiveFrom;
    }

    if (patch.effectiveToUnbounded) {
      next.effectiveTo = null;
      next.effectiveToUnbounded = true;
    } else if (patch.effectiveTo && DATE_PATTERN.test(patch.effectiveTo)) {
      next.effectiveTo = patch.effectiveTo;
      next.effectiveToUnbounded = false;
    }

    const valid = normalizePeriodTimes(patch.periodTimes);
    if (valid.length > 0) {
      const merged = new Map<string, ExtractedPeriodTime>(
        next.periodTimes.map((t) => [`${t.session}|${t.period}`, t]),
      );
      for (const time of valid) {
        merged.set(`${time.session}|${time.period}`, time);
      }
      next.periodTimes = [...merged.values()];
    }

    return next;
  }

  /**
   * Tên trường/môn/giáo viên người dùng vừa nhắc qua lời — chưa khớp được ID
   * nào trong lượt này vì trước đó chưa có gì để tra theo. Ghi nhận nguyên
   * văn vào `extracted` để có cái tra cứu, và tra ngay: đúng một ứng viên thì
   * chốt luôn (giống cách đọc ảnh tự chốt khi chỉ có một kết quả khớp), mơ hồ
   * thì để `buildView()` lượt sau đưa ra danh sách cho người dùng chọn.
   */
  private async applyNameHints(
    draft: TimetableDraft,
    patch: ResolutionPatch,
  ): Promise<void> {
    let extracted = draft.extracted;

    const schoolHint = patch.schoolNameHint?.trim();
    if (schoolHint && !draft.resolution.schoolId) {
      extracted = { ...extracted, schoolName: schoolHint };
      const schools = await this.resolver.findSchools(schoolHint);
      if (schools.length === 1) {
        draft.resolution = {
          ...draft.resolution,
          schoolId: schools[0].id,
          schoolName: schools[0].name,
        };
      }
    }

    const teacherHint = patch.teacherNameHint?.trim();
    if (teacherHint && !draft.resolution.teacherId) {
      extracted = { ...extracted, teacherName: teacherHint };
      const teachers = await this.resolver.findTeachers(teacherHint);
      if (teachers.length === 1) {
        draft.resolution = {
          ...draft.resolution,
          teacherId: teachers[0].id,
          teacherName: teachers[0].name,
        };
      }
    }

    const subjectHint = patch.subjectNameHint?.trim();
    if (subjectHint && !draft.resolution.subjectId) {
      extracted = { ...extracted, subjectName: subjectHint };
      if (draft.resolution.schoolId) {
        const subjects = await this.resolver.findSubjects(
          draft.resolution.schoolId,
          draft.resolution.schoolYear,
          subjectHint,
        );
        if (subjects.length === 1) {
          draft.resolution = {
            ...draft.resolution,
            subjectId: subjects[0].id,
            subjectName: subjects[0].name,
          };
        }
      }
    }

    draft.extracted = extracted;
  }

  /**
   * Áp các thao tác sửa ô lịch do AI đề xuất. UPDATE/DELETE chỉ chạy khi bộ
   * selector khớp đúng một ô, tránh một câu mơ hồ làm đổi hàng loạt lịch.
   */
  private applyEntryChanges(
    current: ExtractedEntry[],
    changes: ResolutionPatch['entryChanges'],
  ): { entries: ExtractedEntry[]; skipped: number } {
    let entries = [...(current ?? [])];
    let skipped = 0;

    const validDay = (value: number | null) =>
      value !== null && Number.isInteger(value) && value >= 2 && value <= 8;
    const validPeriod = (value: number | null) =>
      value !== null && Number.isInteger(value) && value >= 1 && value <= 10;
    const sameName = (left: string, right: string) =>
      left.trim().toLocaleLowerCase('vi') ===
      right.trim().toLocaleLowerCase('vi');

    for (const change of changes) {
      if (change.action === 'ADD') {
        if (
          !validDay(change.dayOfWeek) ||
          !change.session ||
          !validPeriod(change.period) ||
          !change.className?.trim()
        ) {
          skipped++;
          continue;
        }
        entries.push({
          dayOfWeek: change.dayOfWeek!,
          session: change.session,
          period: change.period!,
          className: change.className.trim(),
          confidence: 'high',
        });
        continue;
      }

      const matches = entries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => {
          const hasSelector =
            change.matchDayOfWeek !== null ||
            change.matchSession !== null ||
            change.matchPeriod !== null ||
            Boolean(change.matchClassName?.trim());
          return (
            hasSelector &&
            (change.matchDayOfWeek === null ||
              entry.dayOfWeek === change.matchDayOfWeek) &&
            (change.matchSession === null ||
              entry.session === change.matchSession) &&
            (change.matchPeriod === null ||
              entry.period === change.matchPeriod) &&
            (!change.matchClassName?.trim() ||
              sameName(entry.className, change.matchClassName))
          );
        });

      if (matches.length !== 1) {
        skipped++;
        continue;
      }

      const index = matches[0].index;
      if (change.action === 'DELETE') {
        entries = entries.filter((_, entryIndex) => entryIndex !== index);
        continue;
      }

      const previous = entries[index];
      const nextDay = change.dayOfWeek ?? previous.dayOfWeek;
      const nextPeriod = change.period ?? previous.period;
      const nextClassName = change.className?.trim() || previous.className;
      if (!validDay(nextDay) || !validPeriod(nextPeriod) || !nextClassName) {
        skipped++;
        continue;
      }
      entries[index] = {
        dayOfWeek: nextDay,
        session: change.session ?? previous.session,
        period: nextPeriod,
        className: nextClassName,
        confidence: 'high',
      };
    }

    return { entries, skipped };
  }
}

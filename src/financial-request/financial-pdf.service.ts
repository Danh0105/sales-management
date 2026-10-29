import { Injectable, Logger } from '@nestjs/common';
import PdfPrinter from 'pdfmake';
import vfsFonts from 'pdfmake/build/vfs_fonts';

import { AuthUser } from '../type/auth-user.type';
import {
  ApprovalStatus,
  FinancialRequestType,
  PAYMENT_METHOD_LABELS,
  PaymentMethod,
  PaymentStatus,
  RecoveryStatus,
  REQUEST_TYPE_TITLES,
  SIGNATURE_SLOT_LABELS,
  SignatureSlot,
  StepStatus,
} from './financial-request.constants';
import { FinancialRequestService } from './financial-request.service';
import { formatVnd, vndToWords } from './financial-money';
import { readStoredFile } from './financial-storage';

type Detail = Awaited<ReturnType<FinancialRequestService['detail']>>;

const WATERMARKS: Partial<Record<ApprovalStatus, string>> = {
  [ApprovalStatus.DRAFT]: 'BẢN NHÁP',
  [ApprovalStatus.PENDING]: 'CHỜ DUYỆT',
  [ApprovalStatus.RETURNED]: 'CHỜ BỔ SUNG',
  [ApprovalStatus.REJECTED]: 'ĐÃ TỪ CHỐI',
  [ApprovalStatus.CANCELLED]: 'ĐÃ HUỶ',
};

const SLOTS: SignatureSlot[] = [
  SignatureSlot.MANAGER,
  SignatureSlot.CONTROLLER,
  SignatureSlot.ACCOUNTANT,
  SignatureSlot.DIRECTOR,
];

function vnDate(value?: string | Date | null) {
  if (!value) return '';
  const date =
    typeof value === 'string' && value.length === 10
      ? new Date(`${value}T00:00:00+07:00`)
      : new Date(value);
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date);
}

function vnDateTime(value?: string | Date | null) {
  if (!value) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function quantityText(value: string) {
  const [whole, fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${formatVnd(Number(whole))}${trimmed ? `,${trimmed}` : ''}`;
}

/**
 * PDF chứng từ theo bố cục mẫu giấy (A4). Dữ liệu lấy từ `detail()` nên tôn
 * trọng đúng quyền xem của người tải (số tài khoản đã che nếu không đủ quyền).
 * Ô xác nhận chỉ ghi nhận phê duyệt điện tử — không giả lập chữ ký tay.
 */
@Injectable()
export class FinancialPdfService {
  private readonly logger = new Logger(FinancialPdfService.name);
  private printer?: InstanceType<typeof PdfPrinter>;

  constructor(private readonly requests: FinancialRequestService) {}

  private getPrinter() {
    if (!this.printer) {
      const font = (name: string) => Buffer.from(vfsFonts[name], 'base64');
      this.printer = new PdfPrinter({
        Roboto: {
          normal: font('Roboto-Regular.ttf'),
          bold: font('Roboto-Medium.ttf'),
          italics: font('Roboto-Italic.ttf'),
          bolditalics: font('Roboto-MediumItalic.ttf'),
        },
      });
    }
    return this.printer!;
  }

  async render(
    user: AuthUser,
    id: number,
  ): Promise<{ buffer: Buffer; fileName: string }> {
    const { detail, company } = await this.requests.loadForExport(user, id);
    let logo: string | null = null;
    if (company?.logoPath) {
      try {
        const buffer = await readStoredFile(company.logoPath);
        const mime = /\.png$/i.test(company.logoPath)
          ? 'image/png'
          : 'image/jpeg';
        logo = `data:${mime};base64,${buffer.toString('base64')}`;
      } catch (error) {
        this.logger.warn(
          `Không đọc được logo công ty #${company.id}: ${(error as Error).message}`,
        );
      }
    }
    const definition = this.buildDefinition(detail, logo);
    const buffer = await this.toBuffer(definition);
    return { buffer, fileName: `${detail.code}.pdf` };
  }

  private toBuffer(definition: Record<string, unknown>): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = this.getPrinter().createPdfKitDocument(definition);
      const chunks: Buffer[] = [];
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });
  }

  buildDefinition(
    detail: Detail,
    logo: string | null,
  ): Record<string, unknown> {
    const company = detail.company;
    const formCode = company?.formCodes?.[detail.type] ?? '';
    const [year, month, day] = detail.requestDate.split('-');
    const isSettlement = detail.type === FinancialRequestType.SETTLEMENT;
    const isApproved = detail.approvalStatus === ApprovalStatus.APPROVED;
    const showApproved = detail.items.some(
      (i) => i.approvedAmount !== null && i.approvedAmount !== i.amount,
    );

    const header = {
      columns: [
        ...(logo ? [{ image: logo, fit: [64, 64], width: 70 }] : []),
        {
          width: '*',
          stack: [
            { text: company?.name ?? '', bold: true, fontSize: 11 },
            company?.address
              ? { text: `Địa chỉ: ${company.address}`, fontSize: 8.5 }
              : '',
            company?.taxCode
              ? { text: `MST: ${company.taxCode}`, fontSize: 8.5 }
              : '',
          ],
        },
        {
          width: 150,
          alignment: 'right',
          stack: [
            formCode
              ? { text: `Mẫu số: ${formCode}`, fontSize: 8.5, bold: true }
              : '',
            { text: `Số: ${detail.code}`, fontSize: 9 },
          ],
        },
      ],
      columnGap: 8,
    };

    const info: [string, string][] = [
      [
        'Người đề nghị',
        `${detail.requesterName}${detail.requesterCode ? `  (Mã NV: ${detail.requesterCode})` : ''}`,
      ],
      [
        'Bộ phận',
        [detail.departmentName, detail.requesterPosition]
          .filter(Boolean)
          .join(' — '),
      ],
      ...(detail.directManagerName
        ? ([['Quản lý trực tiếp', detail.directManagerName]] as [
            string,
            string,
          ][])
        : []),
      ['Nội dung', detail.title],
    ];
    if (detail.purpose) info.push(['Mục đích', detail.purpose]);
    if (detail.projectName) info.push(['Dự án/Sự kiện', detail.projectName]);
    if (detail.type === FinancialRequestType.ADVANCE) {
      if (detail.expectedUseDate)
        info.push(['Ngày dự kiến sử dụng', vnDate(detail.expectedUseDate)]);
      if (detail.settlementDueDate)
        info.push(['Hạn hoàn ứng', vnDate(detail.settlementDueDate)]);
    }
    if (detail.type === FinancialRequestType.SALARY_ADVANCE) {
      info.push([
        'Kỳ lương',
        `Tháng ${detail.salaryMonth}/${detail.salaryYear}`,
      ]);
      if (detail.expectedSalary)
        info.push(['Lương dự kiến', `${formatVnd(detail.expectedSalary)} đ`]);
      if (detail.deductionStartMonth) {
        info.push([
          'Khấu trừ',
          `Từ tháng ${detail.deductionStartMonth}/${detail.deductionStartYear}, ${detail.deductionPeriods ?? 1} kỳ`,
        ]);
      }
    }
    if (detail.type === FinancialRequestType.EXPENSE_PAYMENT) {
      if (detail.location) info.push(['Địa điểm công tác', detail.location]);
      if (detail.tripStartDate || detail.tripEndDate) {
        info.push([
          'Thời gian công tác',
          `${vnDate(detail.tripStartDate)} – ${vnDate(detail.tripEndDate)}`,
        ]);
      }
    }
    info.push(['Người thụ hưởng', detail.payeeName ?? '']);
    if (detail.paymentMethod) {
      info.push([
        'Hình thức nhận',
        PAYMENT_METHOD_LABELS[detail.paymentMethod],
      ]);
    }
    if (detail.paymentMethod === PaymentMethod.BANK_TRANSFER) {
      info.push(['Ngân hàng', detail.bankName ?? '']);
      info.push([
        'Số tài khoản',
        `${detail.bankAccountNumber ?? ''}${detail.bankAccountHolder ? `  —  Chủ TK: ${detail.bankAccountHolder}` : ''}`,
      ]);
    }

    const infoTable = {
      table: {
        widths: [110, '*'],
        body: info.map(([label, value]) => [
          { text: `${label}:`, bold: true },
          { text: value || '' },
        ]),
      },
      layout: 'noBorders',
      fontSize: 9.5,
      margin: [0, 6, 0, 8],
    };

    const itemHeader = [
      'STT',
      'Nội dung',
      'ĐVT',
      'Số lượng',
      'Đơn giá',
      'Thành tiền',
      ...(showApproved ? ['Được duyệt'] : []),
      'Ghi chú',
    ].map((text) => ({
      text,
      bold: true,
      alignment: 'center',
      fillColor: '#eef2f7',
    }));
    const itemRows = detail.items.map((item) => {
      const notes = [
        item.categoryName,
        item.incurredDate ? `Ngày: ${vnDate(item.incurredDate)}` : null,
        item.invoiceNumber ? `HĐ: ${item.invoiceNumber}` : null,
        item.supplierName,
        item.note,
        item.adjustmentReason ? `Điều chỉnh: ${item.adjustmentReason}` : null,
      ].filter(Boolean);
      return [
        { text: String(item.lineNo), alignment: 'center' },
        item.description,
        { text: item.unit ?? '', alignment: 'center' },
        { text: quantityText(item.quantity), alignment: 'right' },
        { text: quantityText(item.unitPrice), alignment: 'right' },
        { text: formatVnd(item.amount), alignment: 'right' },
        ...(showApproved
          ? [
              {
                text: formatVnd(item.approvedAmount ?? item.amount),
                alignment: 'right',
              },
            ]
          : []),
        { text: notes.join('; '), fontSize: 8 },
      ];
    });
    const totalRow = [
      { text: 'Tổng cộng', bold: true, colSpan: 5, alignment: 'right' },
      {},
      {},
      {},
      {},
      { text: formatVnd(detail.totalAmount), bold: true, alignment: 'right' },
      ...(showApproved
        ? [
            {
              text: formatVnd(detail.summary.approvedTotal),
              bold: true,
              alignment: 'right',
            },
          ]
        : []),
      '',
    ];
    const itemsTable = {
      table: {
        headerRows: 1,
        dontBreakRows: true,
        widths: showApproved
          ? [20, '*', 30, 40, 58, 62, 62, 80]
          : [22, '*', 34, 44, 64, 70, 100],
        body: [itemHeader, ...itemRows, totalRow],
      },
      fontSize: 8.5,
      layout: { hLineColor: '#9aa5b1', vLineColor: '#9aa5b1' },
    };

    const blocks: unknown[] = [];
    if (isSettlement && detail.allocations.length) {
      blocks.push(
        {
          text: 'Tạm ứng được đối trừ',
          bold: true,
          margin: [0, 10, 0, 4],
          fontSize: 10,
        },
        {
          table: {
            headerRows: 1,
            dontBreakRows: true,
            widths: [80, 60, '*', 70, 70],
            body: [
              ['Mã tạm ứng', 'Ngày', 'Nội dung', 'Đã chi', 'Đối trừ'].map(
                (text) => ({
                  text,
                  bold: true,
                  alignment: 'center',
                  fillColor: '#eef2f7',
                }),
              ),
              ...detail.allocations.map((a) => [
                a.code,
                vnDate(a.requestDate),
                a.title,
                { text: formatVnd(a.paidAmount), alignment: 'right' },
                { text: formatVnd(a.amount), alignment: 'right' },
              ]),
            ],
          },
          fontSize: 8.5,
        },
      );
    }

    const summaryRows: [string, string][] = [
      ['Tổng cộng', `${formatVnd(detail.totalAmount)} đ`],
    ];
    if (detail.summary.approvedTotal !== detail.totalAmount) {
      summaryRows.push([
        'Số tiền được duyệt',
        `${formatVnd(detail.summary.approvedTotal)} đ`,
      ]);
    }
    if (isSettlement) {
      const difference = detail.summary.difference ?? 0;
      summaryRows.push([
        'Số tiền đã tạm ứng',
        `${formatVnd(detail.offsetAmount || detail.allocations.reduce((s, a) => s + a.amount, 0))} đ`,
      ]);
      summaryRows.push([
        'Số còn phải thanh toán thêm',
        `${formatVnd(Math.max(difference, 0))} đ`,
      ]);
      summaryRows.push([
        'Số phải hoàn lại',
        `${formatVnd(Math.max(-difference, 0))} đ`,
      ]);
    }
    if (detail.paidAmount > 0)
      summaryRows.push(['Đã chi', `${formatVnd(detail.paidAmount)} đ`]);
    if (detail.recoveredAmount > 0)
      summaryRows.push([
        'Đã thu hồi',
        `${formatVnd(detail.recoveredAmount)} đ`,
      ]);
    const wordsAmount = isApproved
      ? detail.summary.approvedTotal
      : detail.totalAmount;

    const paidStamp =
      (detail.paymentStatus === PaymentStatus.PAID &&
        detail.summary.payableDue > 0) ||
      (isSettlement && detail.recoveryStatus === RecoveryStatus.RECOVERED);
    const stampText =
      isSettlement &&
      detail.recoveryStatus === RecoveryStatus.RECOVERED &&
      detail.summary.payableDue === 0
        ? 'ĐÃ THU HỒI'
        : 'ĐÃ CHI TIỀN';

    blocks.push({
      columns: [
        {
          width: '*',
          stack: [
            {
              table: {
                widths: [150, '*'],
                body: summaryRows.map(([label, value]) => [
                  { text: `${label}:`, bold: true },
                  { text: value, alignment: 'right' },
                ]),
              },
              layout: 'noBorders',
              fontSize: 9.5,
            },
            {
              text: [
                { text: 'Bằng chữ: ', bold: true },
                { text: vndToWords(wordsAmount), italics: true },
              ],
              fontSize: 9.5,
              margin: [0, 4, 0, 0],
            },
            ...(isSettlement && detail.summary.difference
              ? [
                  {
                    text: [
                      {
                        text:
                          detail.summary.difference > 0
                            ? 'Thanh toán thêm bằng chữ: '
                            : 'Hoàn lại bằng chữ: ',
                        bold: true,
                      },
                      {
                        text: vndToWords(Math.abs(detail.summary.difference)),
                        italics: true,
                      },
                    ],
                    fontSize: 9.5,
                  },
                ]
              : []),
          ],
        },
        paidStamp
          ? {
              width: 120,
              table: {
                widths: ['*'],
                body: [
                  [
                    {
                      text: stampText,
                      color: '#c62828',
                      bold: true,
                      fontSize: 13,
                      alignment: 'center',
                      margin: [0, 6, 0, 6],
                    },
                  ],
                ],
              },
              layout: {
                hLineColor: '#c62828',
                vLineColor: '#c62828',
                hLineWidth: () => 2,
                vLineWidth: () => 2,
              },
              margin: [8, 4, 0, 0],
            }
          : { width: 0, text: '' },
      ],
      margin: [0, 10, 0, 0],
    });

    // ---- Khối xác nhận 5 vị trí (không cắt ngang trang) ----
    const latestRound = Math.max(0, ...detail.steps.map((s) => s.round));
    const roundSteps = detail.steps.filter((s) => s.round === latestRound);
    const slotCell = (slot: SignatureSlot) => {
      const step = roundSteps.find((s) => s.signatureSlot === slot);
      if (!step) return '—';
      switch (step.status) {
        case StepStatus.APPROVED:
          return `Đã duyệt\n${vnDateTime(step.actedAt)}\n${step.actedByName ?? ''}${step.onBehalfOfName ? `\n(thay ${step.onBehalfOfName})` : ''}`;
        case StepStatus.SKIPPED:
          return 'Không áp dụng';
        case StepStatus.PENDING:
          return 'Đang chờ duyệt';
        case StepStatus.REJECTED:
          return `Từ chối\n${vnDateTime(step.actedAt)}\n${step.actedByName ?? ''}`;
        case StepStatus.RETURNED:
          return `Yêu cầu bổ sung\n${vnDateTime(step.actedAt)}`;
        default:
          return 'Chưa tới lượt';
      }
    };
    const signatureHeader = [
      'Người đề nghị',
      ...SLOTS.map((slot) => SIGNATURE_SLOT_LABELS[slot]),
    ];
    const signatureValues = [
      detail.submittedAt
        ? `Đã gửi duyệt\n${vnDateTime(detail.submittedAt)}\n${detail.requesterName}`
        : detail.requesterName,
      ...SLOTS.map(slotCell),
    ];
    const extraSteps = roundSteps.filter(
      (s) => !s.signatureSlot && s.status === StepStatus.APPROVED,
    );

    const approvalBlock = {
      unbreakable: true,
      margin: [0, 16, 0, 0],
      stack: [
        {
          table: {
            widths: ['*', '*', '*', '*', '*'],
            body: [
              signatureHeader.map((text) => ({
                text,
                bold: true,
                alignment: 'center',
                fontSize: 9,
              })),
              signatureValues.map((text) => ({
                text,
                alignment: 'center',
                fontSize: 8,
                margin: [0, 4, 0, 34],
              })),
            ],
          },
          layout: 'noBorders',
        },
        ...(extraSteps.length
          ? [
              {
                text: extraSteps
                  .map(
                    (s) =>
                      `${s.name}: đã duyệt ${vnDateTime(s.actedAt)} — ${s.actedByName ?? ''}`,
                  )
                  .join('\n'),
                fontSize: 8,
                margin: [0, 2, 0, 0],
              },
            ]
          : []),
        {
          columns: [
            {
              width: '*',
              text: 'Thông tin phê duyệt là xác nhận điện tử trên hệ thống Kido Office (người duyệt, thời điểm); không phải chữ ký số.',
              fontSize: 7.5,
              italics: true,
              color: '#555555',
              margin: [0, 18, 8, 0],
            },
            {
              width: 80,
              stack: [
                { qr: this.verifyUrl(detail.id), fit: 70, alignment: 'right' },
                {
                  text: 'Quét để kiểm tra',
                  fontSize: 7,
                  alignment: 'right',
                  color: '#555555',
                },
              ],
            },
          ],
        },
      ],
    };

    const watermark = WATERMARKS[detail.approvalStatus];
    return {
      pageSize: 'A4',
      pageMargins: [36, 36, 36, 44],
      info: {
        title: `${REQUEST_TYPE_TITLES[detail.type]} ${detail.code}`,
        author: company?.name ?? '',
      },
      defaultStyle: { font: 'Roboto', fontSize: 9.5, lineHeight: 1.15 },
      ...(watermark
        ? {
            watermark: {
              text: watermark,
              color: '#c62828',
              opacity: 0.12,
              bold: true,
            },
          }
        : {}),
      footer: (currentPage: number, pageCount: number) => ({
        columns: [
          { text: `${detail.code}`, fontSize: 7.5, color: '#666666' },
          {
            text: `Trang ${currentPage}/${pageCount}`,
            alignment: 'right',
            fontSize: 7.5,
            color: '#666666',
          },
        ],
        margin: [36, 12, 36, 0],
      }),
      content: [
        header,
        {
          text: REQUEST_TYPE_TITLES[detail.type],
          bold: true,
          fontSize: 15,
          alignment: 'center',
          margin: [0, 14, 0, 2],
        },
        {
          text: `Ngày ${day} tháng ${month} năm ${year}`,
          italics: true,
          alignment: 'center',
          fontSize: 9.5,
        },
        infoTable,
        itemsTable,
        ...blocks,
        approvalBlock,
      ],
      // Không để tiêu đề nhóm/ghi chú đứng một mình cuối trang.
      pageBreakBefore: (node: {
        headlineLevel?: number;
        startPosition?: { verticalRatio: number };
      }) =>
        node.headlineLevel === 1 &&
        (node.startPosition?.verticalRatio ?? 0) > 0.85,
    };
  }

  private verifyUrl(id: number) {
    const base = (
      process.env.FINANCIAL_APP_URL || 'https://kidoapp.kidoedu.vn'
    ).replace(/\/$/, '');
    return `${base}/#/finance/requests/${id}`;
  }
}

import {
  hasMeaningfulRecruitmentHtml,
  sanitizeRecruitmentHtml,
} from './job-html';

describe('rich text tin tuyển dụng', () => {
  it('giữ định dạng allowlist và loại nội dung có thể thực thi', () => {
    const input =
      '<script>alert(1)</script><p style="text-align:center;color:red" onclick="x()"><strong>Mô tả</strong></p><img src=x onerror=x>';

    expect(sanitizeRecruitmentHtml(input)).toBe(
      '<p style="text-align:center"><strong>Mô tả</strong></p>',
    );
  });

  it('nhận biết HTML rỗng và nội dung thật', () => {
    expect(hasMeaningfulRecruitmentHtml('<p><br></p>')).toBe(false);
    expect(hasMeaningfulRecruitmentHtml('<p>&nbsp;</p>')).toBe(false);
    expect(
      hasMeaningfulRecruitmentHtml('<ul><li>Kỹ năng bán hàng</li></ul>'),
    ).toBe(true);
  });

  it('giữ text thuần của dữ liệu cũ', () => {
    expect(sanitizeRecruitmentHtml('Mô tả công việc\nDòng 2')).toBe(
      'Mô tả công việc\nDòng 2',
    );
  });
});

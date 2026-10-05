/**
 * Tay Nguyen University academic taxonomy, 2026 admission structure.
 *
 * This file is DATA, not code. The frontend never hard-codes any of it — the
 * UI reads faculty and program lists from the API, so an administrator can add
 * a program or move one between faculties at runtime without a deployment.
 *
 * The MOET program codes below are the join key that any future admission-data
 * import will rely on, and a wrong code is worse than a missing one because it
 * silently mismatches. Verify this list against the current official catalog
 * before loading it into a production database; corrections propagate cleanly
 * because the seed upserts on `code`.
 */

export interface FacultySeed {
  code: string;
  name: string;
  nameEn: string;
  shortName: string;
  icon: string;
  sortOrder: number;
}

export interface ProgramSeed {
  code: string;
  name: string;
  nameEn: string;
  facultyCode: string;
  durationYears: number;
  sortOrder: number;
}

export const FACULTIES: FacultySeed[] = [
  {
    code: 'YD',
    name: 'Khoa Y Dược',
    nameEn: 'Faculty of Medicine and Pharmacy',
    shortName: 'Y Dược',
    icon: 'Stethoscope',
    sortOrder: 1,
  },
  {
    code: 'SP',
    name: 'Khoa Sư phạm',
    nameEn: 'Faculty of Education',
    shortName: 'Sư phạm',
    icon: 'GraduationCap',
    sortOrder: 2,
  },
  {
    code: 'LLCT',
    name: 'Khoa Lý luận chính trị',
    nameEn: 'Faculty of Political Theory',
    shortName: 'LLCT',
    icon: 'Landmark',
    sortOrder: 3,
  },
  {
    code: 'NN',
    name: 'Khoa Ngoại ngữ',
    nameEn: 'Faculty of Foreign Languages',
    shortName: 'Ngoại ngữ',
    icon: 'Languages',
    sortOrder: 4,
  },
  {
    code: 'KT',
    name: 'Khoa Kinh tế',
    nameEn: 'Faculty of Economics',
    shortName: 'Kinh tế',
    icon: 'TrendingUp',
    sortOrder: 5,
  },
  {
    code: 'KHTNCN',
    name: 'Khoa Khoa học Tự nhiên và Công nghệ',
    nameEn: 'Faculty of Natural Sciences and Technology',
    shortName: 'KHTN & CN',
    icon: 'Atom',
    sortOrder: 6,
  },
  {
    code: 'NNg',
    name: 'Khoa Nông nghiệp',
    nameEn: 'Faculty of Agriculture',
    shortName: 'Nông nghiệp',
    icon: 'Sprout',
    sortOrder: 7,
  },
];

export const PROGRAMS: ProgramSeed[] = [
  // --- Khoa Y Dược ---------------------------------------------------------
  { code: '7720101', name: 'Y khoa', nameEn: 'Medicine', facultyCode: 'YD', durationYears: 6, sortOrder: 1 },
  { code: '7720301', name: 'Điều dưỡng', nameEn: 'Nursing', facultyCode: 'YD', durationYears: 4, sortOrder: 2 },
  {
    code: '7720601',
    name: 'Kỹ thuật xét nghiệm y học',
    nameEn: 'Medical Laboratory Technology',
    facultyCode: 'YD',
    durationYears: 4,
    sortOrder: 3,
  },

  // --- Khoa Sư phạm --------------------------------------------------------
  {
    code: '7140201',
    name: 'Giáo dục Mầm non',
    nameEn: 'Early Childhood Education',
    facultyCode: 'SP',
    durationYears: 4,
    sortOrder: 1,
  },
  {
    code: '7140202',
    name: 'Giáo dục Tiểu học',
    nameEn: 'Primary Education',
    facultyCode: 'SP',
    durationYears: 4,
    sortOrder: 2,
  },
  {
    code: '7140202JR',
    name: 'Giáo dục Tiểu học – Tiếng Jrai',
    nameEn: 'Primary Education – Jrai Language',
    facultyCode: 'SP',
    durationYears: 4,
    sortOrder: 3,
  },
  {
    code: '7140206',
    name: 'Giáo dục Thể chất',
    nameEn: 'Physical Education',
    facultyCode: 'SP',
    durationYears: 4,
    sortOrder: 4,
  },
  {
    code: '7140217',
    name: 'Sư phạm Ngữ văn',
    nameEn: 'Vietnamese Language and Literature Education',
    facultyCode: 'SP',
    durationYears: 4,
    sortOrder: 5,
  },
  {
    code: '7310403',
    name: 'Tâm lý học giáo dục',
    nameEn: 'Educational Psychology',
    facultyCode: 'SP',
    durationYears: 4,
    sortOrder: 6,
  },
  { code: '7229030', name: 'Văn học', nameEn: 'Literature', facultyCode: 'SP', durationYears: 4, sortOrder: 7 },

  // --- Khoa Lý luận chính trị ---------------------------------------------
  {
    code: '7140205',
    name: 'Giáo dục Chính trị',
    nameEn: 'Political Education',
    facultyCode: 'LLCT',
    durationYears: 4,
    sortOrder: 1,
  },
  { code: '7229001', name: 'Triết học', nameEn: 'Philosophy', facultyCode: 'LLCT', durationYears: 4, sortOrder: 2 },

  // --- Khoa Ngoại ngữ ------------------------------------------------------
  {
    code: '7140231',
    name: 'Sư phạm Tiếng Anh',
    nameEn: 'English Language Teaching',
    facultyCode: 'NN',
    durationYears: 4,
    sortOrder: 1,
  },
  {
    code: '7220201',
    name: 'Ngôn ngữ Anh',
    nameEn: 'English Language',
    facultyCode: 'NN',
    durationYears: 4,
    sortOrder: 2,
  },

  // --- Khoa Kinh tế --------------------------------------------------------
  { code: '7310101', name: 'Kinh tế học', nameEn: 'Economics', facultyCode: 'KT', durationYears: 4, sortOrder: 1 },
  {
    code: '7310105',
    name: 'Kinh tế phát triển',
    nameEn: 'Development Economics',
    facultyCode: 'KT',
    durationYears: 4,
    sortOrder: 2,
  },
  {
    code: '7620115',
    name: 'Kinh tế nông nghiệp',
    nameEn: 'Agricultural Economics',
    facultyCode: 'KT',
    durationYears: 4,
    sortOrder: 3,
  },
  {
    code: '7340101',
    name: 'Quản trị kinh doanh',
    nameEn: 'Business Administration',
    facultyCode: 'KT',
    durationYears: 4,
    sortOrder: 4,
  },
  {
    code: '7340121',
    name: 'Kinh doanh thương mại',
    nameEn: 'Commercial Business',
    facultyCode: 'KT',
    durationYears: 4,
    sortOrder: 5,
  },
  {
    code: '7340201',
    name: 'Tài chính – Ngân hàng',
    nameEn: 'Finance and Banking',
    facultyCode: 'KT',
    durationYears: 4,
    sortOrder: 6,
  },
  { code: '7340205', name: 'Công nghệ tài chính', nameEn: 'Fintech', facultyCode: 'KT', durationYears: 4, sortOrder: 7 },
  { code: '7340301', name: 'Kế toán', nameEn: 'Accounting', facultyCode: 'KT', durationYears: 4, sortOrder: 8 },

  // --- Khoa Khoa học Tự nhiên và Công nghệ ---------------------------------
  {
    code: '7140209',
    name: 'Sư phạm Toán học',
    nameEn: 'Mathematics Teacher Education',
    facultyCode: 'KHTNCN',
    durationYears: 4,
    sortOrder: 1,
  },
  {
    code: '7140211',
    name: 'Sư phạm Vật lí',
    nameEn: 'Physics Teacher Education',
    facultyCode: 'KHTNCN',
    durationYears: 4,
    sortOrder: 2,
  },
  {
    code: '7140212',
    name: 'Sư phạm Hóa học',
    nameEn: 'Chemistry Teacher Education',
    facultyCode: 'KHTNCN',
    durationYears: 4,
    sortOrder: 3,
  },
  {
    code: '7140213',
    name: 'Sư phạm Sinh học',
    nameEn: 'Biology Teacher Education',
    facultyCode: 'KHTNCN',
    durationYears: 4,
    sortOrder: 4,
  },
  {
    code: '7140247',
    name: 'Sư phạm Khoa học tự nhiên',
    nameEn: 'Natural Science Teacher Education',
    facultyCode: 'KHTNCN',
    durationYears: 4,
    sortOrder: 5,
  },
  {
    code: '7420201',
    name: 'Công nghệ sinh học',
    nameEn: 'Biotechnology',
    facultyCode: 'KHTNCN',
    durationYears: 4,
    sortOrder: 6,
  },
  {
    code: '7420201YD',
    name: 'Công nghệ sinh học Y dược',
    nameEn: 'Biomedical Biotechnology',
    facultyCode: 'KHTNCN',
    durationYears: 4,
    sortOrder: 7,
  },
  {
    code: '7480201',
    name: 'Công nghệ thông tin',
    nameEn: 'Information Technology',
    facultyCode: 'KHTNCN',
    durationYears: 4,
    sortOrder: 8,
  },

  // --- Khoa Nông nghiệp ----------------------------------------------------
  {
    code: '7540101',
    name: 'Công nghệ thực phẩm',
    nameEn: 'Food Technology',
    facultyCode: 'NNg',
    durationYears: 4,
    sortOrder: 1,
  },
  { code: '7620105', name: 'Chăn nuôi', nameEn: 'Animal Science', facultyCode: 'NNg', durationYears: 4, sortOrder: 2 },
  {
    code: '7640101',
    name: 'Thú y',
    nameEn: 'Veterinary Medicine',
    facultyCode: 'NNg',
    durationYears: 5,
    sortOrder: 3,
  },
  {
    code: '7620110',
    name: 'Khoa học cây trồng',
    nameEn: 'Crop Science',
    facultyCode: 'NNg',
    durationYears: 4,
    sortOrder: 4,
  },
  {
    code: '7620112',
    name: 'Bảo vệ thực vật',
    nameEn: 'Plant Protection',
    facultyCode: 'NNg',
    durationYears: 4,
    sortOrder: 5,
  },
  { code: '7620205', name: 'Lâm nghiệp', nameEn: 'Forestry', facultyCode: 'NNg', durationYears: 4, sortOrder: 6 },
  {
    code: '7850103',
    name: 'Quản lý đất đai',
    nameEn: 'Land Management',
    facultyCode: 'NNg',
    durationYears: 4,
    sortOrder: 7,
  },
];

/**
 * Document categories from the brief. A table rather than an enum so an
 * administrator can add one without a deployment.
 *
 * `moderationPolicy` seeds the default review behaviour per category: exam
 * papers and answer keys historically attract copyright complaints, so they
 * default to review rather than auto-publish.
 */
export interface DocumentTypeSeed {
  code: string;
  name: string;
  nameEn: string;
  moderationPolicy: 'allowed' | 'review_required' | 'blocked';
  sortOrder: number;
}

export const DOCUMENT_TYPES: DocumentTypeSeed[] = [
  { code: 'textbook', name: 'Giáo trình', nameEn: 'Textbook', moderationPolicy: 'review_required', sortOrder: 1 },
  { code: 'syllabus', name: 'Đề cương môn học', nameEn: 'Course syllabus', moderationPolicy: 'allowed', sortOrder: 2 },
  { code: 'lecture', name: 'Bài giảng', nameEn: 'Lecture notes', moderationPolicy: 'allowed', sortOrder: 3 },
  { code: 'slides', name: 'Slide bài giảng', nameEn: 'Slides', moderationPolicy: 'allowed', sortOrder: 4 },
  { code: 'assignment', name: 'Bài tập', nameEn: 'Assignments', moderationPolicy: 'allowed', sortOrder: 5 },
  { code: 'exercise', name: 'Bài tập thực hành', nameEn: 'Exercises', moderationPolicy: 'allowed', sortOrder: 6 },
  { code: 'lab', name: 'Bài thực hành', nameEn: 'Labs', moderationPolicy: 'allowed', sortOrder: 7 },
  { code: 'exam', name: 'Đề thi', nameEn: 'Exams', moderationPolicy: 'review_required', sortOrder: 8 },
  { code: 'midterm', name: 'Đề thi giữa kỳ', nameEn: 'Midterm exams', moderationPolicy: 'review_required', sortOrder: 9 },
  { code: 'final', name: 'Đề thi cuối kỳ', nameEn: 'Final exams', moderationPolicy: 'review_required', sortOrder: 10 },
  { code: 'answer_key', name: 'Đáp án', nameEn: 'Answer keys', moderationPolicy: 'review_required', sortOrder: 11 },
  { code: 'project', name: 'Đồ án', nameEn: 'Projects', moderationPolicy: 'allowed', sortOrder: 12 },
  { code: 'thesis', name: 'Khóa luận tốt nghiệp', nameEn: 'Thesis', moderationPolicy: 'allowed', sortOrder: 13 },
  { code: 'graduation_project', name: 'Đồ án tốt nghiệp', nameEn: 'Graduation projects', moderationPolicy: 'allowed', sortOrder: 14 },
  { code: 'research_paper', name: 'Bài báo khoa học', nameEn: 'Research papers', moderationPolicy: 'allowed', sortOrder: 15 },
  { code: 'scientific_research', name: 'Nghiên cứu khoa học', nameEn: 'Scientific research', moderationPolicy: 'allowed', sortOrder: 16 },
  { code: 'reference', name: 'Tài liệu tham khảo', nameEn: 'References', moderationPolicy: 'allowed', sortOrder: 17 },
  { code: 'source_code', name: 'Mã nguồn', nameEn: 'Source code', moderationPolicy: 'allowed', sortOrder: 18 },
  { code: 'dataset', name: 'Bộ dữ liệu', nameEn: 'Datasets', moderationPolicy: 'allowed', sortOrder: 19 },
  { code: 'other', name: 'Khác', nameEn: 'Other', moderationPolicy: 'allowed', sortOrder: 20 },
];

/**
 * Starter tags chosen to match what students actually search for. Tags are
 * user-creatable; these just prevent an empty tag cloud on day one.
 */
export const TAG_SEEDS: string[] = [
  'C++', 'Java', 'Python', 'JavaScript', 'Cơ sở dữ liệu', 'Cấu trúc dữ liệu',
  'Giải thuật', 'Lập trình hướng đối tượng', 'Mạng máy tính', 'Hệ điều hành',
  'Trí tuệ nhân tạo', 'Học máy', 'Toán cao cấp', 'Xác suất thống kê', 'Vật lý đại cương',
  'Hóa học đại cương', 'Sinh học đại cương', 'Tiếng Anh', 'Kế toán', 'Tài chính',
  'Marketing', 'Luật kinh tế', 'Triết học', 'Tư tưởng Hồ Chí Minh', 'Ôn thi cuối kỳ',
  'Ôn thi giữa kỳ', 'Đề cương', 'Đồ án', 'Khóa luận', 'Thực tập',
];

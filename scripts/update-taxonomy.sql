-- Update and insert modern, student-centric taxonomy
-- 1. Insert new categories if not exist
INSERT INTO document_types (code, name, name_en, moderation_policy, sort_order, is_active)
VALUES
  ('student_notes', 'Ghi chép sinh viên', 'Student notes', 'allowed', 1, true),
  ('summary', 'Đề cương tóm tắt', 'Study summary & cheatsheet', 'allowed', 2, true),
  ('mindmap', 'Sơ đồ tư duy', 'Mindmaps', 'allowed', 3, true),
  ('practice_exam', 'Đề ôn tập tham khảo', 'Practice tests', 'review_required', 9, true)
ON CONFLICT (code) WHERE deleted_at IS NULL DO NOTHING;

-- 2. Update existing categories to safe naming and policies
UPDATE document_types SET
  name = 'Ghi chú bài học',
  name_en = 'Lecture notes',
  moderation_policy = 'allowed',
  sort_order = 4
WHERE code = 'lecture' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Đề cương môn học',
  name_en = 'Course syllabus',
  moderation_policy = 'allowed',
  sort_order = 5
WHERE code = 'syllabus' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Bài tập & Câu hỏi ôn tập',
  name_en = 'Assignments & review',
  moderation_policy = 'allowed',
  sort_order = 6
WHERE code = 'assignment' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Bài tập thực hành',
  name_en = 'Practice exercises',
  moderation_policy = 'allowed',
  sort_order = 7
WHERE code = 'exercise' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Báo cáo thực hành',
  name_en = 'Lab reports',
  moderation_policy = 'allowed',
  sort_order = 8
WHERE code = 'lab' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Bộ câu hỏi luyện thi',
  name_en = 'Exam review questions',
  moderation_policy = 'review_required',
  sort_order = 10
WHERE code = 'exam' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Câu hỏi ôn tập giữa kỳ',
  name_en = 'Midterm review',
  moderation_policy = 'review_required',
  sort_order = 11
WHERE code = 'midterm' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Câu hỏi ôn tập cuối kỳ',
  name_en = 'Final review',
  moderation_policy = 'review_required',
  sort_order = 12
WHERE code = 'final' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Lời giải & Hướng dẫn',
  name_en = 'Sample solutions',
  moderation_policy = 'review_required',
  sort_order = 13
WHERE code = 'answer_key' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Đồ án môn học',
  name_en = 'Course projects',
  moderation_policy = 'allowed',
  sort_order = 14
WHERE code = 'project' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Khóa luận tham khảo',
  name_en = 'Thesis reference',
  moderation_policy = 'allowed',
  sort_order = 15
WHERE code = 'thesis' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Đồ án tốt nghiệp',
  name_en = 'Graduation projects',
  moderation_policy = 'allowed',
  sort_order = 16
WHERE code = 'graduation_project' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Bài báo khoa học mở',
  name_en = 'Open research papers',
  moderation_policy = 'allowed',
  sort_order = 17
WHERE code = 'research_paper' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Nghiên cứu khoa học',
  name_en = 'Scientific research',
  moderation_policy = 'allowed',
  sort_order = 18
WHERE code = 'scientific_research' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Tài liệu tham khảo mở',
  name_en = 'Open references',
  moderation_policy = 'allowed',
  sort_order = 19
WHERE code = 'reference' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Mã nguồn & Dự án mẫu',
  name_en = 'Source code',
  moderation_policy = 'allowed',
  sort_order = 20
WHERE code = 'source_code' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Bộ dữ liệu học tập',
  name_en = 'Datasets',
  moderation_policy = 'allowed',
  sort_order = 21
WHERE code = 'dataset' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Slide thuyết trình sinh viên',
  name_en = 'Student presentation slides',
  moderation_policy = 'review_required',
  sort_order = 22
WHERE code = 'slides' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Sách & Giáo trình xuất bản (Tạm khóa)',
  name_en = 'Published textbooks (Blocked)',
  moderation_policy = 'blocked',
  sort_order = 23,
  is_active = false
WHERE code = 'textbook' AND deleted_at IS NULL;

UPDATE document_types SET
  name = 'Khác',
  name_en = 'Other',
  moderation_policy = 'allowed',
  sort_order = 24
WHERE code = 'other' AND deleted_at IS NULL;

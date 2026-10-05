/**
 * Permission catalog and role definitions — the single source of truth.
 *
 * The database mirrors this file; it does not define it. Seeding reads from
 * here, so a permission can never exist in the database without existing in
 * the `PermissionKey` union, and `authorize('typo.here')` is a compile error
 * rather than a silent 403 at runtime.
 *
 * That direction of truth matters: if the database were authoritative, the
 * TypeScript type would have to be `string`, every permission check would be
 * an unverifiable string comparison, and a typo would disable a security
 * control without failing any test.
 */

export const PERMISSIONS = {
  // --- Users ---------------------------------------------------------------
  'users.read': 'View user profiles and account details',
  'users.write': 'Edit user accounts',
  'users.delete': 'Delete or anonymise user accounts',
  'users.verify': 'Approve or reject student and lecturer verification',
  'users.change_role': 'Grant and revoke roles',
  'users.suspend': 'Suspend or ban user accounts',
  'users.force_logout': 'Revoke all sessions for a user',
  'users.read_sessions': 'View active sessions and login history',

  // --- Documents -----------------------------------------------------------
  'documents.read': 'View published documents',
  'documents.read_private': 'View documents that are not publicly visible',
  'documents.upload': 'Upload new documents',
  'documents.update': 'Edit document metadata',
  'documents.delete': 'Delete documents',
  'documents.moderate': 'Approve, reject or archive documents awaiting review',
  'documents.delete_any': 'Delete documents owned by other users',
  'documents.download': 'Download document files',
  'documents.rate': 'Rate and review documents',

  // --- Social (M2, defined now so grants can be assigned early) -------------
  'posts.create': 'Create posts',
  'posts.moderate': 'Moderate posts',
  'comments.create': 'Comment on documents and posts',
  'comments.moderate': 'Moderate comments',
  'collections.create': 'Create document collections',
  'collections.moderate': 'Hide or delete collections owned by other users',
  'groups.create': 'Create community groups',
  'groups.moderate': 'Moderate community groups',

  // --- Q&A (M3) ------------------------------------------------------------
  'questions.create': 'Ask questions',
  'questions.moderate': 'Moderate questions',
  'answers.create': 'Answer questions',
  'answers.moderate': 'Moderate answers',

  // --- Moderation ----------------------------------------------------------
  'reports.create': 'Report content',
  'reports.read': 'View the moderation report queue',
  'reports.resolve': 'Resolve or dismiss reports',
  'moderation.actions.read': 'View moderation history',

  // --- Taxonomy ------------------------------------------------------------
  // Read is effectively public; it is a permission rather than an open route
  // so that a read-only maintenance mode can revoke it centrally.
  'taxonomy.read': 'Browse faculties, programs, subjects and semesters',
  'faculties.manage': 'Create, edit and deactivate faculties',
  'programs.manage': 'Create, edit and move academic programs',
  'subjects.manage': 'Create and edit subjects',
  'courses.manage': 'Create and edit course offerings',
  'academic_years.manage': 'Manage academic years and semesters',
  'document_types.manage': 'Manage document categories',

  // --- Tags ----------------------------------------------------------------
  'tags.manage': 'Create, merge and delete tags',

  // --- Platform administration --------------------------------------------
  'settings.manage': 'Change platform settings',
  'badges.manage': 'Create and edit badges',
  'reputation.manage': 'Adjust reputation and ranking weights',
  'analytics.read': 'View platform analytics',
  'storage.manage': 'Manage storage, quotas and orphaned files',
  'search.reindex': 'Rebuild the search index',
  'ai.manage': 'Configure AI providers and features',
  'backups.manage': 'Run and restore backups',
  'audit.read': 'Read the audit log',
  'roles.manage': 'Create and edit roles and permission grants',
  'api_keys.manage': 'Manage API keys',

  // --- System states -------------------------------------------------------
  'system.maintenance_mode': 'Toggle maintenance and read-only modes',

  // --- Super admin ---------------------------------------------------------
  'superadmin.all': 'Unrestricted access to every feature',
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionKey[];

/** Split "documents.moderate" into its resource and action halves. */
export function parsePermissionKey(key: PermissionKey): { resource: string; action: string } {
  const index = key.indexOf('.');
  if (index === -1) return { resource: key, action: key };
  return { resource: key.slice(0, index), action: key.slice(index + 1) };
}

// =============================================================================
// ROLES
// =============================================================================

export const ROLE_KEYS = [
  'student',
  'verified_student',
  'lecturer',
  'faculty_moderator',
  'moderator',
  'admin',
  'super_admin',
] as const;

export type RoleKey = (typeof ROLE_KEYS)[number];

export interface RoleDefinition {
  key: RoleKey;
  name: string;
  description: string;
  /**
   * Higher rank outranks lower. Used for "may this actor act on that user?"
   * checks — without it an admin could ban a super admin, or a moderator could
   * ban the administrator who is investigating them.
   */
  rank: number;
  /** Faculty-scoped roles must be granted with a faculty_id. */
  scopedToFaculty: boolean;
  /** The role every registered account receives automatically. */
  isDefault?: boolean;
  permissions: PermissionKey[];
}

/**
 * Permissions shared by every signed-in account, regardless of role. Defined
 * once so the role list below reads as a description of what each role adds.
 */
const BASE_USER_PERMISSIONS: PermissionKey[] = [
  'taxonomy.read',
  'documents.read',
  'documents.download',
  'documents.rate',
  'documents.upload',
  'documents.update',
  'documents.delete',
  'posts.create',
  'comments.create',
  'collections.create',
  'groups.create',
  'questions.create',
  'answers.create',
  'reports.create',
];

/** Moderation capabilities shared by every moderator tier. */
const MODERATION_PERMISSIONS: PermissionKey[] = [
  'documents.read_private',
  'documents.moderate',
  'posts.moderate',
  'comments.moderate',
  'collections.moderate',
  'questions.moderate',
  'answers.moderate',
  'groups.moderate',
  'reports.read',
  'reports.resolve',
  'moderation.actions.read',
  'documents.delete_any',
];

export const ROLES: Record<RoleKey, RoleDefinition> = {
  student: {
    key: 'student',
    name: 'Sinh viên',
    description: 'Registered student. The default role for every new account.',
    rank: 10,
    scopedToFaculty: false,
    isDefault: true,
    permissions: BASE_USER_PERMISSIONS,
  },

  // NOTE: `student` and `verified_student` are two points on ONE axis (has this
  // person proven their academic identity?), not two independent roles. A user
  // holds exactly one of them. They are separate keys because the brief names
  // them separately and badges read from the role key; the seed and the
  // verification flow enforce mutual exclusivity.
  verified_student: {
    key: 'verified_student',
    name: 'Sinh viên đã xác minh',
    description:
      'Student whose academic identity was verified by a moderator. Granted only via student_verifications, never self-assigned.',
    rank: 15,
    scopedToFaculty: false,
    permissions: BASE_USER_PERMISSIONS,
  },

  lecturer: {
    key: 'lecturer',
    name: 'Giảng viên',
    description: 'Verified lecturer. May upload teaching materials and answer questions authoritatively.',
    rank: 20,
    scopedToFaculty: false,
    permissions: [...BASE_USER_PERMISSIONS],
  },

  faculty_moderator: {
    key: 'faculty_moderator',
    name: 'Kiểm duyệt viên khoa',
    description:
      'Moderates content within ONE faculty. Must be granted with a faculty_id; the scope is enforced in SQL, not by hiding UI.',
    rank: 40,
    scopedToFaculty: true,
    permissions: [...BASE_USER_PERMISSIONS, ...MODERATION_PERMISSIONS],
  },

  moderator: {
    key: 'moderator',
    name: 'Kiểm duyệt viên',
    description: 'Moderates content across the whole platform.',
    rank: 50,
    scopedToFaculty: false,
    permissions: [...BASE_USER_PERMISSIONS, ...MODERATION_PERMISSIONS, 'users.suspend', 'tags.manage'],
  },

  admin: {
    key: 'admin',
    name: 'Quản trị viên',
    description: 'Full administrative access except destructive platform-level operations.',
    rank: 80,
    scopedToFaculty: false,
    permissions: [
      ...BASE_USER_PERMISSIONS,
      ...MODERATION_PERMISSIONS,
      'users.read',
      'users.write',
      'users.verify',
      'users.change_role',
      'users.suspend',
      'users.force_logout',
      'users.read_sessions',
      'tags.manage',
      'faculties.manage',
      'programs.manage',
      'subjects.manage',
      'courses.manage',
      'academic_years.manage',
      'document_types.manage',
      'settings.manage',
      'badges.manage',
      'reputation.manage',
      'analytics.read',
      'storage.manage',
      'search.reindex',
      'audit.read',
      'roles.manage',
    ],
  },

  super_admin: {
    key: 'super_admin',
    name: 'Quản trị tối cao',
    description:
      'Unrestricted access. Reserved for the platform owner; cannot be created through the admin API.',
    rank: 100,
    scopedToFaculty: false,
    // `superadmin.all` short-circuits every check, so the explicit list is for
    // display in the admin UI rather than for enforcement.
    permissions: ['superadmin.all', ...ALL_PERMISSIONS],
  },
};

/** The role assigned to a newly registered account. */
export const DEFAULT_ROLE: RoleKey = 'student';

/**
 * Roles a normal administrator may grant. `super_admin` is excluded so that
 * privilege can never be escalated through the admin API — only by direct
 * database action by the operator.
 */
export const ADMIN_GRANTABLE_ROLES: RoleKey[] = ROLE_KEYS.filter((k) => k !== 'super_admin');

/** Expand a role into its effective permission set. */
export function permissionsForRole(role: RoleKey): PermissionKey[] {
  return [...new Set(ROLES[role].permissions)];
}

/** Roles that require a faculty scope when granted. */
export function requiresFacultyScope(role: RoleKey): boolean {
  return ROLES[role].scopedToFaculty;
}

/** Rank lookup used by acting-on-user checks. */
export function rankOf(role: RoleKey): number {
  return ROLES[role].rank;
}

/** Highest rank among a set of roles — 0 for an account with no roles. */
export function highestRank(roles: readonly RoleKey[]): number {
  return roles.reduce((max, role) => Math.max(max, rankOf(role)), 0);
}

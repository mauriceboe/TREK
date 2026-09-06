import { createZodDto } from 'nestjs-zod';
import {
  adminUserCreateRequestSchema,
  adminUserUpdateRequestSchema,
  adminPermissionsRequestSchema,
  adminInviteCreateRequestSchema,
  adminFeatureToggleRequestSchema,
  adminTemplateNameRequestSchema,
  adminOidcUpdateRequestSchema,
  adminAddonUpdateRequestSchema,
  adminCollabFeaturesRequestSchema,
  adminNotificationPreferencesRequestSchema,
  adminDefaultUserSettingsRequestSchema,
  adminTestNotificationRequestSchema,
  adminTransitProviderRequestSchema,
} from '@trek/shared';

/**
 * Server-side createZodDto wrappers over the @trek/shared admin contracts. The
 * global ZodValidationPipe (APP_PIPE in app.module.ts) validates any @Body()
 * parameter typed with one of these classes by metatype — the Zod schemas in
 * shared/ remain the single source of truth for the wire contract.
 *
 * Thirteen classes cover the AdminController body contracts:
 * the four feature toggles share AdminFeatureToggleDto and the six
 * packing-template create/update routes share AdminTemplateNameDto.
 */
export class AdminUserCreateDto extends createZodDto(adminUserCreateRequestSchema) {}
export class AdminUserUpdateDto extends createZodDto(adminUserUpdateRequestSchema) {}
export class AdminPermissionsDto extends createZodDto(adminPermissionsRequestSchema) {}
export class AdminInviteCreateDto extends createZodDto(adminInviteCreateRequestSchema) {}
export class AdminFeatureToggleDto extends createZodDto(adminFeatureToggleRequestSchema) {}
export class AdminTemplateNameDto extends createZodDto(adminTemplateNameRequestSchema) {}
export class AdminOidcUpdateDto extends createZodDto(adminOidcUpdateRequestSchema) {}
export class AdminAddonUpdateDto extends createZodDto(adminAddonUpdateRequestSchema) {}
export class AdminCollabFeaturesDto extends createZodDto(adminCollabFeaturesRequestSchema) {}
export class AdminNotificationPreferencesDto extends createZodDto(adminNotificationPreferencesRequestSchema) {}
export class AdminDefaultUserSettingsDto extends createZodDto(adminDefaultUserSettingsRequestSchema) {}
export class AdminTestNotificationDto extends createZodDto(adminTestNotificationRequestSchema) {}
export class AdminTransitProviderDto extends createZodDto(adminTransitProviderRequestSchema) {}

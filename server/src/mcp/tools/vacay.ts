import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { z } from 'zod';
import { isDemoUser, getCurrentUser } from '../../services/authService';
import {
  getOwnPlan, getActivePlan, getActivePlanId, getPlanData,
  updatePlan, setUserColor,
  sendInvite as sendVacayInvite, acceptInvite, declineInvite, cancelInvite, dissolvePlan,
  getAvailableUsers,
  listYears, addYear, deleteYear,
  getEntries as getVacayEntries, toggleEntry, toggleCompanyHoliday,
  getStats as getVacayStats, updateStats as updateVacayStats,
  addHolidayCalendar, updateHolidayCalendar, deleteHolidayCalendar,
  getCountries as getHolidayCountries, getHolidays,
} from '../../services/vacayService';
import { isAddonEnabled } from '../../services/adminService';
import {
  TOOL_ANNOTATIONS_READONLY, TOOL_ANNOTATIONS_WRITE,
  TOOL_ANNOTATIONS_DELETE, TOOL_ANNOTATIONS_NON_IDEMPOTENT,
  demoDenied, ok,
} from './_shared';

export function registerVacayTools(server: McpServer, userId: number): void {
  if (isAddonEnabled('vacay')) {
    server.registerTool(
      'get_vacay_plan',
      {
        description: "Get the current user's active vacation plan (own or joined).",
        inputSchema: {},
        annotations: TOOL_ANNOTATIONS_READONLY,
      },
      async () => {
        const plan = getPlanData(userId);
        return ok({ plan });
      }
    );

    server.registerTool(
      'update_vacay_plan',
      {
        description: 'Update vacation plan settings (weekends blocking, holidays, carry-over).',
        inputSchema: {
          block_weekends: z.boolean().optional(),
          holidays_enabled: z.boolean().optional(),
          holidays_region: z.string().nullable().optional(),
          company_holidays_enabled: z.boolean().optional(),
          carry_over_enabled: z.boolean().optional(),
        },
        annotations: TOOL_ANNOTATIONS_WRITE,
      },
      async ({ block_weekends, holidays_enabled, holidays_region, company_holidays_enabled, carry_over_enabled }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        await updatePlan(planId, { block_weekends, holidays_enabled, holidays_region, company_holidays_enabled, carry_over_enabled }, undefined);
        return ok({ success: true });
      }
    );

    server.registerTool(
      'set_vacay_color',
      {
        description: "Set the current user's color in the vacation plan calendar.",
        inputSchema: {
          color: z.string().describe('Hex color e.g. #6366f1'),
        },
        annotations: TOOL_ANNOTATIONS_WRITE,
      },
      async ({ color }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        setUserColor(userId, planId, color, undefined);
        return ok({ success: true });
      }
    );

    server.registerTool(
      'get_available_vacay_users',
      {
        description: 'List users who can be invited to the current vacation plan.',
        inputSchema: {},
        annotations: TOOL_ANNOTATIONS_READONLY,
      },
      async () => {
        const planId = getActivePlanId(userId);
        const users = getAvailableUsers(userId, planId);
        return ok({ users });
      }
    );

    server.registerTool(
      'send_vacay_invite',
      {
        description: 'Invite a user to join the vacation plan by their user ID.',
        inputSchema: {
          targetUserId: z.number().int().positive(),
        },
        annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
      },
      async ({ targetUserId }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        const me = getCurrentUser(userId);
        if (!me) return { content: [{ type: 'text' as const, text: 'User not found.' }], isError: true };
        const result = sendVacayInvite(planId, userId, me.username, me.email, targetUserId);
        if (result.error) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        return ok({ success: true });
      }
    );

    server.registerTool(
      'accept_vacay_invite',
      {
        description: 'Accept a pending invitation to join another user\'s vacation plan.',
        inputSchema: {
          planId: z.number().int().positive(),
        },
        annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
      },
      async ({ planId }) => {
        if (isDemoUser(userId)) return demoDenied();
        const result = acceptInvite(userId, planId, undefined);
        if (result.error) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        return ok({ success: true });
      }
    );

    server.registerTool(
      'decline_vacay_invite',
      {
        description: 'Decline a pending vacation plan invitation.',
        inputSchema: {
          planId: z.number().int().positive(),
        },
        annotations: TOOL_ANNOTATIONS_WRITE,
      },
      async ({ planId }) => {
        declineInvite(userId, planId, undefined);
        return ok({ success: true });
      }
    );

    server.registerTool(
      'cancel_vacay_invite',
      {
        description: 'Cancel an outgoing invitation (owner cancels invite they sent).',
        inputSchema: {
          targetUserId: z.number().int().positive(),
        },
        annotations: TOOL_ANNOTATIONS_WRITE,
      },
      async ({ targetUserId }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        cancelInvite(planId, targetUserId);
        return ok({ success: true });
      }
    );

    server.registerTool(
      'dissolve_vacay_plan',
      {
        description: 'Dissolve the shared plan — all members are removed and everyone returns to their own individual plan.',
        inputSchema: {},
        annotations: TOOL_ANNOTATIONS_DELETE,
      },
      async () => {
        if (isDemoUser(userId)) return demoDenied();
        dissolvePlan(userId, undefined);
        return ok({ success: true });
      }
    );

    server.registerTool(
      'list_vacay_years',
      {
        description: 'List calendar years tracked in the current vacation plan.',
        inputSchema: {},
        annotations: TOOL_ANNOTATIONS_READONLY,
      },
      async () => {
        const planId = getActivePlanId(userId);
        const years = listYears(planId);
        return ok({ years });
      }
    );

    server.registerTool(
      'add_vacay_year',
      {
        description: 'Add a calendar year to the vacation plan.',
        inputSchema: {
          year: z.number().int().min(2000).max(2100),
        },
        annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
      },
      async ({ year }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        const years = addYear(planId, year, undefined);
        return ok({ years });
      }
    );

    server.registerTool(
      'delete_vacay_year',
      {
        description: 'Remove a calendar year from the vacation plan.',
        inputSchema: {
          year: z.number().int(),
        },
        annotations: TOOL_ANNOTATIONS_DELETE,
      },
      async ({ year }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        const years = deleteYear(planId, year, undefined);
        return ok({ years });
      }
    );

    server.registerTool(
      'get_vacay_entries',
      {
        description: 'Get all vacation day entries for a plan and year.',
        inputSchema: {
          year: z.number().int(),
        },
        annotations: TOOL_ANNOTATIONS_READONLY,
      },
      async ({ year }) => {
        const planId = getActivePlanId(userId);
        const entries = getVacayEntries(planId, String(year));
        return ok({ entries });
      }
    );

    server.registerTool(
      'toggle_vacay_entry',
      {
        description: 'Toggle a day on or off as a vacation day for the current user.',
        inputSchema: {
          date: z.string().describe('ISO date YYYY-MM-DD'),
        },
        annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
      },
      async ({ date }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        const result = toggleEntry(userId, planId, date, undefined);
        return ok(result);
      }
    );

    server.registerTool(
      'toggle_company_holiday',
      {
        description: 'Toggle a date as a company holiday for the whole plan.',
        inputSchema: {
          date: z.string(),
          note: z.string().optional(),
        },
        annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
      },
      async ({ date, note }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        const result = toggleCompanyHoliday(planId, date, note, undefined);
        return ok(result);
      }
    );

    server.registerTool(
      'get_vacay_stats',
      {
        description: 'Get vacation statistics for a specific year (days used, remaining, carried over).',
        inputSchema: {
          year: z.number().int(),
        },
        annotations: TOOL_ANNOTATIONS_READONLY,
      },
      async ({ year }) => {
        const planId = getActivePlanId(userId);
        const stats = getVacayStats(planId, year);
        return ok({ stats });
      }
    );

    server.registerTool(
      'update_vacay_stats',
      {
        description: 'Update the vacation day allowance for a specific user and year.',
        inputSchema: {
          year: z.number().int(),
          vacationDays: z.number().int().min(0),
        },
        annotations: TOOL_ANNOTATIONS_WRITE,
      },
      async ({ year, vacationDays }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        updateVacayStats(userId, planId, year, vacationDays, undefined);
        return ok({ success: true });
      }
    );

    server.registerTool(
      'add_holiday_calendar',
      {
        description: 'Add a public holiday calendar (by region code) to the vacation plan.',
        inputSchema: {
          region: z.string().describe('Country/region code e.g. US, GB, DE'),
          label: z.string().nullable().optional(),
          color: z.string().optional(),
          sortOrder: z.number().int().optional(),
        },
        annotations: TOOL_ANNOTATIONS_NON_IDEMPOTENT,
      },
      async ({ region, label, color, sortOrder }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        const calendar = addHolidayCalendar(planId, region, label ?? null, color, sortOrder, undefined);
        return ok({ calendar });
      }
    );

    server.registerTool(
      'update_holiday_calendar',
      {
        description: 'Update label or color for a holiday calendar.',
        inputSchema: {
          calendarId: z.number().int().positive(),
          label: z.string().nullable().optional(),
          color: z.string().optional(),
        },
        annotations: TOOL_ANNOTATIONS_WRITE,
      },
      async ({ calendarId, label, color }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        const cal = updateHolidayCalendar(calendarId, planId, { label, color }, undefined);
        if (!cal) return { content: [{ type: 'text' as const, text: 'Holiday calendar not found.' }], isError: true };
        return ok({ calendar: cal });
      }
    );

    server.registerTool(
      'delete_holiday_calendar',
      {
        description: 'Remove a holiday calendar from the vacation plan.',
        inputSchema: {
          calendarId: z.number().int().positive(),
        },
        annotations: TOOL_ANNOTATIONS_DELETE,
      },
      async ({ calendarId }) => {
        if (isDemoUser(userId)) return demoDenied();
        const planId = getActivePlanId(userId);
        deleteHolidayCalendar(calendarId, planId, undefined);
        return ok({ success: true });
      }
    );

    server.registerTool(
      'list_holiday_countries',
      {
        description: 'List countries available for public holiday calendars.',
        inputSchema: {},
        annotations: TOOL_ANNOTATIONS_READONLY,
      },
      async () => {
        const result = await getHolidayCountries();
        if (result.error) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        return ok({ countries: result.data });
      }
    );

    server.registerTool(
      'list_holidays',
      {
        description: 'List public holidays for a country and year.',
        inputSchema: {
          country: z.string().describe('ISO 3166-1 alpha-2 code'),
          year: z.number().int(),
        },
        annotations: TOOL_ANNOTATIONS_READONLY,
      },
      async ({ country, year }) => {
        const result = await getHolidays(String(year), country);
        if (result.error) return { content: [{ type: 'text' as const, text: result.error }], isError: true };
        return ok({ holidays: result.data });
      }
    );
  }
}

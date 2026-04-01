import nodemailer from 'nodemailer';
import fetch from 'node-fetch';
import { db } from '../db/database';
import { decrypt_api_key } from './apiKeyCrypto';
import { logInfo, logDebug, logError } from './auditLog';

// ── Types ──────────────────────────────────────────────────────────────────

type EventType = 'trip_invite' | 'booking_change' | 'trip_reminder' | 'vacay_invite' | 'photos_shared' | 'collab_message' | 'packing_tagged';

interface NotificationPayload {
  userId: number;
  event: EventType;
  params: Record<string, string>;
}

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
}

// ── Settings helpers ───────────────────────────────────────────────────────

function getAppSetting(key: string): string | null {
  return (db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined)?.value || null;
}

function getSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST || getAppSetting('smtp_host');
  const port = process.env.SMTP_PORT || getAppSetting('smtp_port');
  const user = process.env.SMTP_USER || getAppSetting('smtp_user');
  const pass = process.env.SMTP_PASS || decrypt_api_key(getAppSetting('smtp_pass')) || '';
  const from = process.env.SMTP_FROM || getAppSetting('smtp_from');
  if (!host || !port || !from) return null;
  return { host, port: parseInt(port, 10), user: user || '', pass: pass || '', from, secure: parseInt(port, 10) === 465 };
}

function getWebhookUrl(): string | null {
  return process.env.NOTIFICATION_WEBHOOK_URL || getAppSetting('notification_webhook_url');
}

function getAppUrl(): string {
  const origins = process.env.ALLOWED_ORIGINS;
  if (origins) {
    const first = origins.split(',')[0]?.trim();
    if (first) return first.replace(/\/+$/, '');
  }
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}`;
}

function getUserEmail(userId: number): string | null {
  return (db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string } | undefined)?.email || null;
}

function getUserLanguage(userId: number): string {
  return (db.prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'language'").get(userId) as { value: string } | undefined)?.value || 'en';
}

function getAdminEventEnabled(event: EventType): boolean {
  const prefKey = EVENT_PREF_MAP[event];
  if (!prefKey) return true;
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(prefKey) as { value: string } | undefined;
  return !row || row.value !== 'false';
}

// Event → preference column mapping
const EVENT_PREF_MAP: Record<EventType, string> = {
  trip_invite: 'notify_trip_invite',
  booking_change: 'notify_booking_change',
  trip_reminder: 'notify_trip_reminder',
  vacay_invite: 'notify_vacay_invite',
  photos_shared: 'notify_photos_shared',
  collab_message: 'notify_collab_message',
  packing_tagged: 'notify_packing_tagged',
};

// ── Email i18n strings ─────────────────────────────────────────────────────

interface EmailStrings { footer: string; manage: string; madeWith: string; openTrek: string }

const I18N: Record<string, EmailStrings> = {
  en: { footer: 'You received this because you have notifications enabled in TREK.', manage: 'Manage preferences in Settings', madeWith: 'Made with', openTrek: 'Open TREK' },
  de: { footer: 'Du erhältst diese E-Mail, weil du Benachrichtigungen in TREK aktiviert hast.', manage: 'Einstellungen verwalten', madeWith: 'Made with', openTrek: 'TREK öffnen' },
  fr: { footer: 'Vous recevez cet e-mail car les notifications sont activées dans TREK.', manage: 'Gérer les préférences', madeWith: 'Made with', openTrek: 'Ouvrir TREK' },
  es: { footer: 'Recibiste esto porque tienes las notificaciones activadas en TREK.', manage: 'Gestionar preferencias', madeWith: 'Made with', openTrek: 'Abrir TREK' },
  nl: { footer: 'Je ontvangt dit omdat je meldingen hebt ingeschakeld in TREK.', manage: 'Voorkeuren beheren', madeWith: 'Made with', openTrek: 'TREK openen' },
  ru: { footer: 'Вы получили это, потому что у вас включены уведомления в TREK.', manage: 'Управление настройками', madeWith: 'Made with', openTrek: 'Открыть TREK' },
  zh: { footer: '您收到此邮件是因为您在 TREK 中启用了通知。', manage: '管理偏好设置', madeWith: 'Made with', openTrek: '打开 TREK' },
  ar: { footer: 'تلقيت هذا لأنك قمت بتفعيل الإشعارات في TREK.', manage: 'إدارة التفضيلات', madeWith: 'Made with', openTrek: 'فتح TREK' },
};

// Translated notification texts per event type
interface EventText { title: string; body: string }
type EventTextFn = (params: Record<string, string>) => EventText

const EVENT_TEXTS: Record<string, Record<EventType, EventTextFn>> = {
  en: {
    trip_invite: p => ({ title: `Trip invite: "${p.trip}"`, body: `${p.actor} invited ${p.invitee || 'a member'} to the trip "${p.trip}".` }),
    booking_change: p => ({ title: `New booking: ${p.booking}`, body: `${p.actor} added a new ${p.type} "${p.booking}" to "${p.trip}".` }),
    trip_reminder: p => ({ title: `Trip reminder: ${p.trip}`, body: `Your trip "${p.trip}" is coming up soon!` }),
    vacay_invite: p => ({ title: 'Vacay Fusion Invite', body: `${p.actor} invited you to fuse vacation plans. Open TREK to accept or decline.` }),
    photos_shared: p => ({ title: `${p.count} photos shared`, body: `${p.actor} shared ${p.count} photo(s) in "${p.trip}".` }),
    collab_message: p => ({ title: `New message in "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `Packing: ${p.category}`, body: `${p.actor} assigned you to the "${p.category}" packing category in "${p.trip}".` }),
  },
  de: {
    trip_invite: p => ({ title: `Einladung zu "${p.trip}"`, body: `${p.actor} hat ${p.invitee || 'ein Mitglied'} zur Reise "${p.trip}" eingeladen.` }),
    booking_change: p => ({ title: `Neue Buchung: ${p.booking}`, body: `${p.actor} hat eine neue Buchung "${p.booking}" (${p.type}) zu "${p.trip}" hinzugefügt.` }),
    trip_reminder: p => ({ title: `Reiseerinnerung: ${p.trip}`, body: `Deine Reise "${p.trip}" steht bald an!` }),
    vacay_invite: p => ({ title: 'Vacay Fusion-Einladung', body: `${p.actor} hat dich eingeladen, Urlaubspläne zu fusionieren. Öffne TREK um anzunehmen oder abzulehnen.` }),
    photos_shared: p => ({ title: `${p.count} Fotos geteilt`, body: `${p.actor} hat ${p.count} Foto(s) in "${p.trip}" geteilt.` }),
    collab_message: p => ({ title: `Neue Nachricht in "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `Packliste: ${p.category}`, body: `${p.actor} hat dich der Kategorie "${p.category}" in der Packliste von "${p.trip}" zugewiesen.` }),
  },
  fr: {
    trip_invite: p => ({ title: `Invitation à "${p.trip}"`, body: `${p.actor} a invité ${p.invitee || 'un membre'} au voyage "${p.trip}".` }),
    booking_change: p => ({ title: `Nouvelle réservation : ${p.booking}`, body: `${p.actor} a ajouté une réservation "${p.booking}" (${p.type}) à "${p.trip}".` }),
    trip_reminder: p => ({ title: `Rappel de voyage : ${p.trip}`, body: `Votre voyage "${p.trip}" approche !` }),
    vacay_invite: p => ({ title: 'Invitation Vacay Fusion', body: `${p.actor} vous invite à fusionner les plans de vacances. Ouvrez TREK pour accepter ou refuser.` }),
    photos_shared: p => ({ title: `${p.count} photos partagées`, body: `${p.actor} a partagé ${p.count} photo(s) dans "${p.trip}".` }),
    collab_message: p => ({ title: `Nouveau message dans "${p.trip}"`, body: `${p.actor} : ${p.preview}` }),
    packing_tagged: p => ({ title: `Bagages : ${p.category}`, body: `${p.actor} vous a assigné à la catégorie "${p.category}" dans "${p.trip}".` }),
  },
  es: {
    trip_invite: p => ({ title: `Invitación a "${p.trip}"`, body: `${p.actor} invitó a ${p.invitee || 'un miembro'} al viaje "${p.trip}".` }),
    booking_change: p => ({ title: `Nueva reserva: ${p.booking}`, body: `${p.actor} añadió una reserva "${p.booking}" (${p.type}) a "${p.trip}".` }),
    trip_reminder: p => ({ title: `Recordatorio: ${p.trip}`, body: `¡Tu viaje "${p.trip}" se acerca!` }),
    vacay_invite: p => ({ title: 'Invitación Vacay Fusion', body: `${p.actor} te invitó a fusionar planes de vacaciones. Abre TREK para aceptar o rechazar.` }),
    photos_shared: p => ({ title: `${p.count} fotos compartidas`, body: `${p.actor} compartió ${p.count} foto(s) en "${p.trip}".` }),
    collab_message: p => ({ title: `Nuevo mensaje en "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `Equipaje: ${p.category}`, body: `${p.actor} te asignó a la categoría "${p.category}" en "${p.trip}".` }),
  },
  nl: {
    trip_invite: p => ({ title: `Uitnodiging voor "${p.trip}"`, body: `${p.actor} heeft ${p.invitee || 'een lid'} uitgenodigd voor de reis "${p.trip}".` }),
    booking_change: p => ({ title: `Nieuwe boeking: ${p.booking}`, body: `${p.actor} heeft een boeking "${p.booking}" (${p.type}) toegevoegd aan "${p.trip}".` }),
    trip_reminder: p => ({ title: `Reisherinnering: ${p.trip}`, body: `Je reis "${p.trip}" komt eraan!` }),
    vacay_invite: p => ({ title: 'Vacay Fusion uitnodiging', body: `${p.actor} nodigt je uit om vakantieplannen te fuseren. Open TREK om te accepteren of af te wijzen.` }),
    photos_shared: p => ({ title: `${p.count} foto's gedeeld`, body: `${p.actor} heeft ${p.count} foto('s) gedeeld in "${p.trip}".` }),
    collab_message: p => ({ title: `Nieuw bericht in "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `Paklijst: ${p.category}`, body: `${p.actor} heeft je toegewezen aan de categorie "${p.category}" in "${p.trip}".` }),
  },
  ru: {
    trip_invite: p => ({ title: `Приглашение в "${p.trip}"`, body: `${p.actor} пригласил ${p.invitee || 'участника'} в поездку "${p.trip}".` }),
    booking_change: p => ({ title: `Новое бронирование: ${p.booking}`, body: `${p.actor} добавил бронирование "${p.booking}" (${p.type}) в "${p.trip}".` }),
    trip_reminder: p => ({ title: `Напоминание: ${p.trip}`, body: `Ваша поездка "${p.trip}" скоро начнётся!` }),
    vacay_invite: p => ({ title: 'Приглашение Vacay Fusion', body: `${p.actor} приглашает вас объединить планы отпуска. Откройте TREK для подтверждения.` }),
    photos_shared: p => ({ title: `${p.count} фото`, body: `${p.actor} поделился ${p.count} фото в "${p.trip}".` }),
    collab_message: p => ({ title: `Новое сообщение в "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `Список вещей: ${p.category}`, body: `${p.actor} назначил вас в категорию "${p.category}" в "${p.trip}".` }),
  },
  zh: {
    trip_invite: p => ({ title: `邀请加入"${p.trip}"`, body: `${p.actor} 邀请了 ${p.invitee || '成员'} 加入旅行"${p.trip}"。` }),
    booking_change: p => ({ title: `新预订：${p.booking}`, body: `${p.actor} 在"${p.trip}"中添加了预订"${p.booking}"（${p.type}）。` }),
    trip_reminder: p => ({ title: `旅行提醒：${p.trip}`, body: `你的旅行"${p.trip}"即将开始！` }),
    vacay_invite: p => ({ title: 'Vacay 融合邀请', body: `${p.actor} 邀请你合并假期计划。打开 TREK 接受或拒绝。` }),
    photos_shared: p => ({ title: `${p.count} 张照片已分享`, body: `${p.actor} 在"${p.trip}"中分享了 ${p.count} 张照片。` }),
    collab_message: p => ({ title: `"${p.trip}"中的新消息`, body: `${p.actor}：${p.preview}` }),
    packing_tagged: p => ({ title: `行李清单：${p.category}`, body: `${p.actor} 将你分配到"${p.trip}"中的"${p.category}"类别。` }),
  },
  ar: {
    trip_invite: p => ({ title: `دعوة إلى "${p.trip}"`, body: `${p.actor} دعا ${p.invitee || 'عضو'} إلى الرحلة "${p.trip}".` }),
    booking_change: p => ({ title: `حجز جديد: ${p.booking}`, body: `${p.actor} أضاف حجز "${p.booking}" (${p.type}) إلى "${p.trip}".` }),
    trip_reminder: p => ({ title: `تذكير: ${p.trip}`, body: `رحلتك "${p.trip}" تقترب!` }),
    vacay_invite: p => ({ title: 'دعوة دمج الإجازة', body: `${p.actor} يدعوك لدمج خطط الإجازة. افتح TREK للقبول أو الرفض.` }),
    photos_shared: p => ({ title: `${p.count} صور مشتركة`, body: `${p.actor} شارك ${p.count} صورة في "${p.trip}".` }),
    collab_message: p => ({ title: `رسالة جديدة في "${p.trip}"`, body: `${p.actor}: ${p.preview}` }),
    packing_tagged: p => ({ title: `قائمة التعبئة: ${p.category}`, body: `${p.actor} عيّنك في فئة "${p.category}" في "${p.trip}".` }),
  },
};

// Get localized event text
function getEventText(lang: string, event: EventType, params: Record<string, string>): EventText {
  const texts = EVENT_TEXTS[lang] || EVENT_TEXTS.en;
  return texts[event](params);
}

// ── Email HTML builder ─────────────────────────────────────────────────────

function buildEmailHtml(subject: string, body: string, lang: string): string {
  const s = I18N[lang] || I18N.en;
  const appUrl = getAppUrl();
  const ctaHref = appUrl || '#';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 480px; background: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06);">
        <!-- Header -->
        <tr><td style="background: linear-gradient(135deg, #000000 0%, #1a1a2e 100%); padding: 32px 32px 28px; text-align: center;">
          <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA1MTIgNTEyIj4NCiAgPGRlZnM+DQogICAgPGxpbmVhckdyYWRpZW50IGlkPSJiZyIgeDE9IjAiIHkxPSIwIiB4Mj0iMSIgeTI9IjEiPg0KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzFlMjkzYiIvPg0KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIjMGYxNzJhIi8+DQogICAgPC9saW5lYXJHcmFkaWVudD4NCiAgICA8Y2xpcFBhdGggaWQ9Imljb24iPg0KICAgICAgPHBhdGggZD0iTSA4NTUuNjM2NzE5IDY5OS4yMDMxMjUgTCAyMjIuMjQ2MDk0IDY5OS4yMDMxMjUgQyAxOTcuNjc5Njg4IDY5OS4yMDMxMjUgMTc5LjkwNjI1IDY3NS43NSAxODYuNTM5MDYyIDY1Mi4xMDE1NjIgTCAzNjAuNDI5Njg4IDMyLjM5MDYyNSBDIDM2NC45MjE4NzUgMTYuMzg2NzE5IDM3OS41MTE3MTkgNS4zMjgxMjUgMzk2LjEzMjgxMiA1LjMyODEyNSBMIDEwMjkuNTI3MzQ0IDUuMzI4MTI1IEMgMTA1NC4wODk4NDQgNS4zMjgxMjUgMTA3MS44NjcxODggMjguNzc3MzQ0IDEwNjUuMjMwNDY5IDUyLjQyOTY4OCBMIDg5MS4zMzk4NDQgNjcyLjEzNjcxOSBDIDg4Ni44NTE1NjIgNjg4LjE0MDYyNSA4NzIuMjU3ODEyIDY5OS4yMDMxMjUgODU1LjYzNjcxOSA2OTkuMjAzMTI1IFogTSA0NDQuMjM4MjgxIDExNjYuOTgwNDY5IEwgNTMzLjc3MzQzOCA4NDcuODk4NDM4IEMgNTQwLjQxMDE1NiA4MjQuMjQ2MDk0IDUyMi42MzI4MTIgODAwLjc5Njg3NSA0OTguMDcwMzEyIDgwMC43OTY4NzUgTCAxNzIuNDcyNjU2IDgwMC43OTY4NzUgQyAxNTUuODUxNTYyIDgwMC43OTY4NzUgMTQxLjI2MTcxOSA4MTEuODU1NDY5IDEzNi43Njk1MzEgODI3Ljg1OTM3NSBMIDQ3LjIzNDM3NSAxMTQ2Ljk0MTQwNiBDIDQwLjU5NzY1NiAxMTcwLjU5Mzc1IDU4LjM3NSAxMTk0LjA0Mjk2OSA4Mi45Mzc1IDExOTQuMDQyOTY5IEwgNDA4LjUzNTE1NiAxMTk0LjA0Mjk2OSBDIDQyNS4xNTYyNSAxMTk0LjA0Mjk2OSA0MzkuNzUgMTE4Mi45ODQzNzUgNDQ0LjIzODI4MSAxMTY2Ljk4MDQ2OSBaIE0gNjA5LjAwMzkwNiA4MjcuODU5Mzc1IEwgNDM1LjExMzI4MSAxNDQ3LjU3MDMxMiBDIDQyOC40NzY1NjIgMTQ3MS4yMTg3NSA0NDYuMjUzOTA2IDE0OTQuNjcxODc1IDQ3MC44MTY0MDYgMTQ5NC42NzE4NzUgTCAxMTA0LjIxMDkzOCAxNDk0LjY3MTg3NSBDIDExMjAuODMyMDMxIDE0OTQuNjcxODc1IDExMzUuNDIxODc1IDE0ODMuNjA5Mzc1IDExMzkuOTE0MDYyIDE0NjcuNjA1NDY5IEwgMTMxMy44MDQ2ODggODQ3Ljg5ODQzOCBDIDEzMjAuNDQxNDA2IDgyNC4yNDYwOTQgMTMwMi42NjQwNjIgODAwLjc5Njg3NSAxMjc4LjEwMTU2MiA4MDAuNzk2ODc1IEwgNjQ0LjcwNzAzMSA4MDAuNzk2ODc1IEMgNjI4LjA4NTkzOCA4MDAuNzk2ODc1IDYxMy40OTIxODggODExLjg1NTQ2OSA2MDkuMDAzOTA2IDgyNy44NTkzNzUgWiBNIDEwNTYuMTA1NDY5IDMzMy4wMTk1MzEgTCA5NjYuNTcwMzEyIDY1Mi4xMDE1NjIgQyA5NTkuOTMzNTk0IDY3NS43NSA5NzcuNzEwOTM4IDY5OS4yMDMxMjUgMTAwMi4yNzM0MzggNjk5LjIwMzEyNSBMIDEzMjcuODcxMDk0IDY5OS4yMDMxMjUgQyAxMzQ0LjQ5MjE4OCA2OTkuMjAzMTI1IDEzNTkuMDg1OTM4IDY4OC4xNDA2MjUgMTM2My41NzQyMTkgNjcyLjEzNjcxOSBMIDE0NTMuMTA5Mzc1IDM1My4wNTQ2ODggQyAxNDU5Ljc0NjA5NCAzMjkuNDA2MjUgMTQ0MS45Njg3NSAzMDUuOTUzMTI1IDE0MTcuNDA2MjUgMzA1Ljk1MzEyNSBMIDEwOTEuODA4NTk0IDMwNS45NTMxMjUgQyAxMDc1LjE4NzUgMzA1Ljk1MzEyNSAxMDYwLjU5NzY1NiAzMTcuMDE1NjI1IDEwNTYuMTA1NDY5IDMzMy4wMTk1MzEgWiIvPg0KICAgIDwvY2xpcFBhdGg+DQogIDwvZGVmcz4NCiAgPHJlY3Qgd2lkdGg9IjUxMiIgaGVpZ2h0PSI1MTIiIGZpbGw9InVybCgjYmcpIi8+DQogIDxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDU2LDUxKSBzY2FsZSgwLjI2NykiPg0KICAgIDxyZWN0IHdpZHRoPSIxNTAwIiBoZWlnaHQ9IjE1MDAiIGZpbGw9IiNmZmZmZmYiIGNsaXAtcGF0aD0idXJsKCNpY29uKSIvPg0KICA8L2c+DQo8L3N2Zz4NCg==" alt="TREK" width="48" height="48" style="border-radius: 14px; margin-bottom: 14px; display: block; margin-left: auto; margin-right: auto;" />
          <div style="color: #ffffff; font-size: 24px; font-weight: 700; letter-spacing: -0.5px;">TREK</div>
          <div style="color: rgba(255,255,255,0.4); font-size: 10px; font-weight: 500; letter-spacing: 2px; text-transform: uppercase; margin-top: 4px;">Travel Resource &amp; Exploration Kit</div>
        </td></tr>
        <!-- Content -->
        <tr><td style="padding: 32px 32px 16px;">
          <h1 style="margin: 0 0 8px; font-size: 18px; font-weight: 700; color: #111827; line-height: 1.3;">${subject}</h1>
          <div style="width: 32px; height: 3px; background: #111827; border-radius: 2px; margin-bottom: 20px;"></div>
          <p style="margin: 0; font-size: 14px; color: #4b5563; line-height: 1.7; white-space: pre-wrap;">${body}</p>
        </td></tr>
        <!-- CTA -->
        ${appUrl ? `<tr><td style="padding: 8px 32px 32px; text-align: center;">
          <a href="${ctaHref}" style="display: inline-block; padding: 12px 28px; background: #111827; color: #ffffff; font-size: 13px; font-weight: 600; text-decoration: none; border-radius: 10px; letter-spacing: 0.2px;">${s.openTrek}</a>
        </td></tr>` : ''}
        <!-- Footer -->
        <tr><td style="padding: 20px 32px; background: #f9fafb; border-top: 1px solid #f3f4f6; text-align: center;">
          <p style="margin: 0 0 8px; font-size: 11px; color: #9ca3af; line-height: 1.5;">${s.footer}<br>${s.manage}</p>
          <p style="margin: 0; font-size: 10px; color: #d1d5db;">${s.madeWith} <span style="color: #ef4444;">&hearts;</span> by Maurice &middot; <a href="https://github.com/mauriceboe/TREK" style="color: #9ca3af; text-decoration: none;">GitHub</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Send functions ─────────────────────────────────────────────────────────

async function sendEmail(to: string, subject: string, body: string, userId?: number): Promise<boolean> {
  const config = getSmtpConfig();
  if (!config) return false;

  const lang = userId ? getUserLanguage(userId) : 'en';

  try {
    const skipTls = process.env.SMTP_SKIP_TLS_VERIFY === 'true' || getAppSetting('smtp_skip_tls_verify') === 'true';
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      ...(skipTls ? { tls: { rejectUnauthorized: false } } : {}),
    });

    await transporter.sendMail({
      from: config.from,
      to,
      subject: `TREK — ${subject}`,
      text: body,
      html: buildEmailHtml(subject, body, lang),
    });
    logInfo(`Email sent to=${to} subject="${subject}"`);
    logDebug(`Email smtp=${config.host}:${config.port} from=${config.from} to=${to}`);
    return true;
  } catch (err) {
    logError(`Email send failed to=${to}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

function buildWebhookBody(url: string, payload: { event: string; title: string; body: string; tripName?: string }): string {
  const isDiscord = /discord(?:app)?\.com\/api\/webhooks\//.test(url);
  const isSlack = /hooks\.slack\.com\//.test(url);

  if (isDiscord) {
    return JSON.stringify({
      embeds: [{
        title: `📍 ${payload.title}`,
        description: payload.body,
        color: 0x3b82f6,
        footer: { text: payload.tripName ? `Trip: ${payload.tripName}` : 'TREK' },
        timestamp: new Date().toISOString(),
      }],
    });
  }

  if (isSlack) {
    const trip = payload.tripName ? `  •  _${payload.tripName}_` : '';
    return JSON.stringify({
      text: `*${payload.title}*\n${payload.body}${trip}`,
    });
  }

  return JSON.stringify({ ...payload, timestamp: new Date().toISOString(), source: 'TREK' });
}

async function sendWebhook(payload: { event: string; title: string; body: string; tripName?: string }): Promise<boolean> {
  const url = getWebhookUrl();
  if (!url) return false;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: buildWebhookBody(url, payload),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      logError(`Webhook HTTP ${res.status}: ${errBody}`);
      return false;
    }

    logInfo(`Webhook sent event=${payload.event} trip=${payload.tripName || '-'}`);
    logDebug(`Webhook url=${url} payload=${buildWebhookBody(url, payload).substring(0, 500)}`);
    return true;
  } catch (err) {
    logError(`Webhook failed event=${payload.event}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

function getNotificationChannel(): string {
  return getAppSetting('notification_channel') || 'none';
}

export async function notify(payload: NotificationPayload): Promise<void> {
  const channel = getNotificationChannel();
  if (channel === 'none') return;

  if (!getAdminEventEnabled(payload.event)) return;

  const lang = getUserLanguage(payload.userId);
  const { title, body } = getEventText(lang, payload.event, payload.params);

  logDebug(`Notification event=${payload.event} channel=${channel} userId=${payload.userId} params=${JSON.stringify(payload.params)}`);

  if (channel === 'email') {
    const email = getUserEmail(payload.userId);
    if (email) await sendEmail(email, title, body, payload.userId);
  } else if (channel === 'webhook') {
    await sendWebhook({ event: payload.event, title, body, tripName: payload.params.trip });
  }
}

export async function notifyTripMembers(tripId: number, actorUserId: number, event: EventType, params: Record<string, string>): Promise<void> {
  const channel = getNotificationChannel();
  if (channel === 'none') return;
  if (!getAdminEventEnabled(event)) return;

  const trip = db.prepare('SELECT user_id FROM trips WHERE id = ?').get(tripId) as { user_id: number } | undefined;
  if (!trip) return;

  if (channel === 'webhook') {
    const lang = getUserLanguage(actorUserId);
    const { title, body } = getEventText(lang, event, params);
    logDebug(`notifyTripMembers event=${event} channel=webhook tripId=${tripId} actor=${actorUserId}`);
    await sendWebhook({ event, title, body, tripName: params.trip });
    return;
  }

  const members = db.prepare('SELECT user_id FROM trip_members WHERE trip_id = ?').all(tripId) as { user_id: number }[];
  const allIds = [trip.user_id, ...members.map(m => m.user_id)].filter(id => id !== actorUserId);
  const unique = [...new Set(allIds)];

  for (const userId of unique) {
    await notify({ userId, event, params });
  }
}

export async function testSmtp(to: string): Promise<{ success: boolean; error?: string }> {
  try {
    const sent = await sendEmail(to, 'Test Notification', 'This is a test email from TREK. If you received this, your SMTP configuration is working correctly.');
    return sent ? { success: true } : { success: false, error: 'SMTP not configured' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

export async function testWebhook(): Promise<{ success: boolean; error?: string }> {
  try {
    const sent = await sendWebhook({ event: 'test', title: 'Test Notification', body: 'This is a test webhook from TREK. If you received this, your webhook configuration is working correctly.' });
    return sent ? { success: true } : { success: false, error: 'Webhook URL not configured' };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

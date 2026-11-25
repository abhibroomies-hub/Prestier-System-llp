import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { getApps, initializeApp } from 'firebase/app';
import {
  get,
  getDatabase,
  onDisconnect,
  onValue,
  ref,
  remove,
  set,
  type Database,
} from 'firebase/database';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import {
  buildWhatsAppConfirmationMessage,
  DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY,
  DEFAULT_PRESTAIR_WHATSAPP_REPLY,
  formatLeadForSheetRow,
  generateLeadId,
  hasAnyLeadContent,
  LEAD_FIELD_LIMITS,
  normalizeLeadRecord,
  normalizePhoneForWhatsApp,
  PRESTAIR_REPLY_IMAGES,
  PRESTAIR_SECOND_REPLY_IMAGES,
  sanitizeField,
  sanitizeLeadInput,
  type LeadRecord,
  type LeadStatus,
} from './src/utils/leadLogic.ts';

const PORT = Number(process.env.PORT) || 3000;
const SERVER_START_MS = Date.now();
const SERVER_INSTANCE_ID = crypto.randomBytes(6).toString('hex');

const isProduction =
  process.env.NODE_ENV === 'production' ||
  process.env.npm_lifecycle_event === 'start' ||
  Boolean(process.env.RAILWAY_ENVIRONMENT);

// Support Railway Persistent Volumes & custom DATA_DIR seamlessly
const DATA_DIR = path.resolve(
  process.env.DATA_DIR ||
    process.env.RAILWAY_VOLUME_MOUNT_PATH ||
    path.join(process.cwd(), 'data')
);
const WHATSAPP_AUTH_DIR = path.resolve(
  process.env.WHATSAPP_AUTH_DIR || path.join(DATA_DIR, 'whatsapp_auth')
);

const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const DELETED_LEADS_FILE = path.join(DATA_DIR, 'deleted-leads.json');
const ADMIN_AUTH_FILE = path.join(DATA_DIR, 'admin-auth.json');
const ADMIN_SESSIONS_FILE = path.join(DATA_DIR, 'admin-sessions.json');
const WA_SETTINGS_FILE = path.join(DATA_DIR, 'whatsapp-settings.json');
const WA_REPLY_IMAGE_FILE = path.join(DATA_DIR, 'whatsapp-reply-image.json');
const WA_REPLY_IMAGE_2_FILE = path.join(DATA_DIR, 'whatsapp-reply-image-2.json');
const SHOWCASE_SETTINGS_FILE = path.join(DATA_DIR, 'showcase-settings.json');
const SHEET_SYNC_FILE = path.join(DATA_DIR, 'sheet-sync-settings.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });

// ============================================================================
// Persistent Helpers & In-Memory State
// ============================================================================

function readJsonFileSafe<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFileSafe(filePath: string, data: unknown, mode?: number): void {
  try {
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      tmpPath,
      JSON.stringify(data, null, 2),
      mode !== undefined ? { encoding: 'utf8', mode } : 'utf8'
    );
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.warn(`[storage] Failed writing ${path.basename(filePath)}:`, (err as Error)?.message);
  }
}

function sanitizeRtdbKey(rawId: string): string {
  return String(rawId || '')
    .trim()
    .replace(/[.#$[\]/]/g, '_')
    .slice(0, 128);
}

// 1. Deleted Lead Tombstones (never resurrect deleted leads across restarts/deploys)
const DEFAULT_DELETED_IDS = [
  'lead_seed_101',
  'lead_seed_102',
  'lead_seed_103',
  'lead_seed_104',
];
const deletedLeadIds = new Set<string>(DEFAULT_DELETED_IDS);
for (const id of readJsonFileSafe<string[]>(DELETED_LEADS_FILE, [])) {
  if (typeof id === 'string' && id.trim()) {
    deletedLeadIds.add(id.trim());
  }
}

function persistDeletedLeadsLocal(): void {
  writeJsonFileSafe(DELETED_LEADS_FILE, Array.from(deletedLeadIds));
}

// 2. Leads Store
const leadsStore = new Map<string, LeadRecord>();
const initialDiskLeads = readJsonFileSafe<unknown[]>(LEADS_FILE, []);
if (Array.isArray(initialDiskLeads)) {
  for (const item of initialDiskLeads) {
    const norm = normalizeLeadRecord(item);
    if (norm.leadId && !deletedLeadIds.has(norm.leadId)) {
      leadsStore.set(norm.leadId, norm);
    }
  }
}

function persistLeadsLocal(): void {
  const sorted = getSortedLeads();
  writeJsonFileSafe(LEADS_FILE, sorted);
}

function getSortedLeads(): LeadRecord[] {
  return Array.from(leadsStore.values())
    .filter((l) => !deletedLeadIds.has(l.leadId))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// 3. Admin Auth & Hashed Bearer Sessions (never store plaintext passwords or raw session tokens)
interface AdminAuthRecord {
  salt: string;
  passwordHash: string;
  updatedAt: number;
}

let adminAuth: AdminAuthRecord | null = (() => {
  const loaded = readJsonFileSafe<Partial<AdminAuthRecord> | null>(ADMIN_AUTH_FILE, null);
  if (
    loaded &&
    typeof loaded.salt === 'string' &&
    loaded.salt.length >= 16 &&
    typeof loaded.passwordHash === 'string' &&
    loaded.passwordHash.length >= 32
  ) {
    return {
      salt: loaded.salt,
      passwordHash: loaded.passwordHash,
      updatedAt: typeof loaded.updatedAt === 'number' ? loaded.updatedAt : 1,
    };
  }
  return null;
})();

function persistAdminAuthLocal(): void {
  if (adminAuth) {
    writeJsonFileSafe(ADMIN_AUTH_FILE, adminAuth, 0o600);
  }
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const adminSessions = new Map<string, number>();

(() => {
  const rawSessions = readJsonFileSafe<Record<string, unknown>>(ADMIN_SESSIONS_FILE, {});
  const now = Date.now();
  if (rawSessions && typeof rawSessions === 'object') {
    for (const [hashKey, exp] of Object.entries(rawSessions)) {
      if (
        /^[a-f0-9]{64}$/.test(hashKey) &&
        typeof exp === 'number' &&
        exp > now
      ) {
        adminSessions.set(hashKey, exp);
      }
    }
  }
})();

function persistAdminSessionsLocal(): void {
  const now = Date.now();
  const obj: Record<string, number> = {};
  for (const [hashKey, exp] of adminSessions.entries()) {
    if (exp > now) {
      obj[hashKey] = exp;
    } else {
      adminSessions.delete(hashKey);
    }
  }
  writeJsonFileSafe(ADMIN_SESSIONS_FILE, obj, 0o600);
}

function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function hashPasswordScrypt(password: string, saltHex: string): string {
  return crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex');
}

function verifyConstantTimeStrings(a: string, b: string): boolean {
  const digestA = crypto.createHash('sha256').update(a).digest();
  const digestB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(digestA, digestB) && a.length === b.length;
}

// Brute-force rate limiter for /api/admin/login and /api/admin/setup
const authAttemptTracker = new Map<string, { count: number; resetAt: number }>();
const MAX_AUTH_ATTEMPTS = 8;
const AUTH_WINDOW_MS = 10 * 60 * 1000;

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimitAllowed(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const entry = authAttemptTracker.get(ip);
  if (!entry || now >= entry.resetAt) {
    return { allowed: true, retryAfterSec: 0 };
  }
  if (entry.count >= MAX_AUTH_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function recordFailedAuthAttempt(ip: string): void {
  const now = Date.now();
  const entry = authAttemptTracker.get(ip);
  if (!entry || now >= entry.resetAt) {
    authAttemptTracker.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearFailedAuthAttempts(ip: string): void {
  authAttemptTracker.delete(ip);
}

// 4. WhatsApp Automation Settings (2 Separate Image + Text Confirmation Messages)
interface WhatsAppSettings {
  autoReplyEnabled: boolean;
  messageTemplate: string;
  secondMessageEnabled: boolean;
  secondMessageTemplate: string;
  adminNotifyPhone: string;
  updatedAt: number;
}

let waSettings: WhatsAppSettings = (() => {
  const raw = readJsonFileSafe<Partial<WhatsAppSettings>>(WA_SETTINGS_FILE, {});
  return {
    autoReplyEnabled:
      typeof raw.autoReplyEnabled === 'boolean' ? raw.autoReplyEnabled : true,
    messageTemplate:
      typeof raw.messageTemplate === 'string' && raw.messageTemplate.trim()
        ? raw.messageTemplate.slice(0, 4000)
        : DEFAULT_PRESTAIR_WHATSAPP_REPLY,
    secondMessageEnabled:
      typeof raw.secondMessageEnabled === 'boolean' ? raw.secondMessageEnabled : true,
    secondMessageTemplate:
      typeof raw.secondMessageTemplate === 'string' && raw.secondMessageTemplate.trim()
        ? raw.secondMessageTemplate.slice(0, 4000)
        : DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY,
    adminNotifyPhone:
      typeof raw.adminNotifyPhone === 'string'
        ? sanitizeField(raw.adminNotifyPhone, 32)
        : '',
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
})();

function persistWaSettingsLocal(): void {
  writeJsonFileSafe(WA_SETTINGS_FILE, waSettings);
}

type WaReplyImageMode = 'default' | 'custom' | 'none';

interface WhatsAppReplyImageState {
  mode: WaReplyImageMode;
  mimeType: string;
  base64Data: string;
  updatedAt: number;
}

const MAX_REPLY_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB

function validateImageBinaryMagic(mimeType: string, buf: Buffer): boolean {
  if (buf.length < 32 || buf.length > MAX_REPLY_IMAGE_BYTES) return false;
  if (mimeType === 'image/jpeg') {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    );
  }
  if (mimeType === 'image/webp') {
    return (
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }
  return false;
}

function parseAndValidateReplyImageDataUrl(
  rawDataUrl: string
):
  | { valid: true; mimeType: string; base64Data: string }
  | { valid: false; error: string } {
  const trimmed = rawDataUrl.trim();
  const match = trimmed.match(
    /^data:(image\/jpeg|image\/png|image\/webp);base64,([A-Za-z0-9+/=\s]+)$/
  );
  if (!match) {
    return {
      valid: false,
      error: 'Only JPG, PNG, or WebP images are supported.',
    };
  }
  const mimeType = match[1];
  const cleanBase64 = match[2].replace(/\s+/g, '');
  const buf = Buffer.from(cleanBase64, 'base64');
  if (buf.length > MAX_REPLY_IMAGE_BYTES) {
    return {
      valid: false,
      error: 'Image size must be under 2 MB.',
    };
  }
  if (!validateImageBinaryMagic(mimeType, buf)) {
    return {
      valid: false,
      error: 'Invalid or corrupted image file.',
    };
  }
  return { valid: true, mimeType, base64Data: cleanBase64 };
}

function loadReplyImageStateFromDisk(filePath: string): WhatsAppReplyImageState {
  const raw = readJsonFileSafe<Partial<WhatsAppReplyImageState>>(filePath, {});
  const mode: WaReplyImageMode =
    raw.mode === 'custom' || raw.mode === 'none' ? raw.mode : 'default';
  if (
    mode === 'custom' &&
    typeof raw.mimeType === 'string' &&
    typeof raw.base64Data === 'string'
  ) {
    const buf = Buffer.from(raw.base64Data, 'base64');
    if (validateImageBinaryMagic(raw.mimeType, buf)) {
      return {
        mode: 'custom',
        mimeType: raw.mimeType,
        base64Data: raw.base64Data,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 1,
      };
    }
  }
  return {
    mode: mode === 'none' ? 'none' : 'default',
    mimeType: '',
    base64Data: '',
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

let waReplyImage: WhatsAppReplyImageState = loadReplyImageStateFromDisk(WA_REPLY_IMAGE_FILE);
let waReplyImage2: WhatsAppReplyImageState = loadReplyImageStateFromDisk(WA_REPLY_IMAGE_2_FILE);

function persistWaReplyImageLocal(): void {
  writeJsonFileSafe(WA_REPLY_IMAGE_FILE, waReplyImage);
}

function persistWaReplyImage2Local(): void {
  writeJsonFileSafe(WA_REPLY_IMAGE_2_FILE, waReplyImage2);
}

function getReplyImageStatusPayload(imgState: WhatsAppReplyImageState = waReplyImage) {
  return {
    mode: imgState.mode,
    customDataUrl:
      imgState.mode === 'custom' && imgState.mimeType && imgState.base64Data
        ? `data:${imgState.mimeType};base64,${imgState.base64Data}`
        : null,
    updatedAt: imgState.updatedAt,
  };
}

// 4b. Customer Thank-You Popup Showcase Image Settings (synced across AI Studio & Railway)
type ShowcaseImageSource = 'wa1' | 'wa2' | 'custom' | 'none';

interface ShowcaseSettingsState {
  source: ShowcaseImageSource;
  mimeType: string;
  base64Data: string;
  updatedAt: number;
}

function isValidShowcaseSource(val: unknown): val is ShowcaseImageSource {
  return val === 'wa1' || val === 'wa2' || val === 'custom' || val === 'none';
}

function loadShowcaseSettingsFromDisk(): ShowcaseSettingsState {
  const raw = readJsonFileSafe<Partial<ShowcaseSettingsState>>(SHOWCASE_SETTINGS_FILE, {});
  const source: ShowcaseImageSource = isValidShowcaseSource(raw.source) ? raw.source : 'wa1';
  let mimeType = '';
  let base64Data = '';
  if (typeof raw.mimeType === 'string' && typeof raw.base64Data === 'string' && raw.base64Data) {
    const buf = Buffer.from(raw.base64Data, 'base64');
    if (validateImageBinaryMagic(raw.mimeType, buf)) {
      mimeType = raw.mimeType;
      base64Data = raw.base64Data;
    }
  }
  return {
    source: source === 'custom' && !base64Data ? 'wa1' : source,
    mimeType,
    base64Data,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

let showcaseSettings: ShowcaseSettingsState = loadShowcaseSettingsFromDisk();

function persistShowcaseSettingsLocal(): void {
  writeJsonFileSafe(SHOWCASE_SETTINGS_FILE, showcaseSettings);
}

function getShowcaseStatusPayload() {
  const wa1DataUrl =
    waReplyImage.mode === 'custom' && waReplyImage.mimeType && waReplyImage.base64Data
      ? `data:${waReplyImage.mimeType};base64,${waReplyImage.base64Data}`
      : null;
  const wa2DataUrl =
    waReplyImage2.mode === 'custom' && waReplyImage2.mimeType && waReplyImage2.base64Data
      ? `data:${waReplyImage2.mimeType};base64,${waReplyImage2.base64Data}`
      : null;
  const customDataUrl =
    showcaseSettings.mimeType && showcaseSettings.base64Data
      ? `data:${showcaseSettings.mimeType};base64,${showcaseSettings.base64Data}`
      : null;

  let activeImageSrc: string | null = null;
  if (showcaseSettings.source === 'none') {
    activeImageSrc = null;
  } else if (showcaseSettings.source === 'custom') {
    activeImageSrc = customDataUrl || wa1DataUrl || wa2DataUrl || PRESTAIR_REPLY_IMAGES[0];
  } else if (showcaseSettings.source === 'wa2') {
    activeImageSrc = wa2DataUrl || wa1DataUrl || customDataUrl || PRESTAIR_SECOND_REPLY_IMAGES[0];
  } else {
    activeImageSrc = wa1DataUrl || wa2DataUrl || customDataUrl || PRESTAIR_REPLY_IMAGES[0];
  }

  return {
    source: showcaseSettings.source,
    activeImageSrc,
    customDataUrl,
    wa1DataUrl,
    wa2DataUrl,
    updatedAt: Math.max(
      showcaseSettings.updatedAt,
      waReplyImage.updatedAt,
      waReplyImage2.updatedAt
    ),
  };
}

// 5. Google Sheet Apps Script Settings
interface SheetSyncSettings {
  enabled: boolean;
  webhookUrl: string;
  spreadsheetName: string;
  sheetName: string;
  spreadsheetUrl: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  updatedAt: number;
}

function getEnvAppsScriptWebhook(): string {
  const raw = (process.env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL || '').trim();
  if (!raw) return '';
  const check = validateAppsScriptUrl(raw);
  return check.valid ? check.normalizedUrl : '';
}

let sheetSyncSettings: SheetSyncSettings = (() => {
  const raw = readJsonFileSafe<Partial<SheetSyncSettings>>(SHEET_SYNC_FILE, {});
  const envUrl = getEnvAppsScriptWebhook();
  const savedUrl = typeof raw.webhookUrl === 'string' ? raw.webhookUrl.trim() : '';
  const validSavedUrl = savedUrl && validateAppsScriptUrl(savedUrl).valid ? savedUrl : '';
  const effectiveUrl = envUrl || validSavedUrl;
  return {
    enabled: envUrl
      ? true
      : typeof raw.enabled === 'boolean'
        ? raw.enabled && Boolean(effectiveUrl)
        : Boolean(effectiveUrl),
    webhookUrl: effectiveUrl,
    spreadsheetName:
      typeof raw.spreadsheetName === 'string' ? raw.spreadsheetName.slice(0, 200) : '',
    sheetName:
      typeof raw.sheetName === 'string' && raw.sheetName.trim()
        ? raw.sheetName.slice(0, 120)
        : 'Prestier Leads',
    spreadsheetUrl:
      typeof raw.spreadsheetUrl === 'string' &&
      raw.spreadsheetUrl.startsWith('https://docs.google.com/spreadsheets/')
        ? raw.spreadsheetUrl.slice(0, 500)
        : '',
    lastSyncedAt: typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : null,
    lastError: null,
    updatedAt:
      typeof raw.updatedAt === 'number'
        ? raw.updatedAt
        : effectiveUrl
          ? 1
          : 0,
  };
})();

function persistSheetSyncSettingsLocal(): void {
  writeJsonFileSafe(SHEET_SYNC_FILE, sheetSyncSettings);
}

// ============================================================================
// SSRF-Safe Google Apps Script Webhook Validation & Live Sync
// ============================================================================

function validateAppsScriptUrl(
  rawUrl: string
): { valid: true; normalizedUrl: string } | { valid: false; error: string } {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') {
      return { valid: false, error: 'Google Apps Script URL must use https://' };
    }
    if (parsed.username || parsed.password || parsed.port) {
      return { valid: false, error: 'Invalid credentials or port in Apps Script URL.' };
    }
    if (parsed.hostname !== 'script.google.com') {
      return {
        valid: false,
        error: 'Only official https://script.google.com/macros/... Web App URLs are allowed.',
      };
    }
    if (!parsed.pathname.startsWith('/macros/')) {
      return {
        valid: false,
        error: 'Apps Script Web App URL must start with https://script.google.com/macros/...',
      };
    }
    return { valid: true, normalizedUrl: parsed.toString() };
  } catch {
    return { valid: false, error: 'Invalid URL format.' };
  }
}

function isAllowedGoogleScriptRedirect(rawRedirectUrl: string): boolean {
  try {
    const parsed = new URL(rawRedirectUrl);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password || parsed.port) return false;
    return (
      parsed.hostname === 'script.google.com' ||
      parsed.hostname === 'script.googleusercontent.com'
    );
  } catch {
    return false;
  }
}

interface AppsScriptResponsePayload {
  ok?: boolean;
  synced?: number;
  spreadsheetName?: string;
  sheetName?: string;
  spreadsheetUrl?: string;
  error?: string;
}

async function postToAppsScriptWebhook(
  webhookUrl: string,
  payload: Record<string, unknown>
): Promise<AppsScriptResponsePayload> {
  const check = validateAppsScriptUrl(webhookUrl);
  if (!check.valid) {
    throw new Error(check.error);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const initialRes = await fetch(check.normalizedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: controller.signal,
    });

    let finalRes = initialRes;
    if (
      initialRes.status >= 300 &&
      initialRes.status < 400 &&
      initialRes.headers.get('location')
    ) {
      const redirectLocation = initialRes.headers.get('location')!;
      const resolvedRedirect = new URL(redirectLocation, check.normalizedUrl).toString();
      if (!isAllowedGoogleScriptRedirect(resolvedRedirect)) {
        throw new Error('Blocked unexpected redirect host from Apps Script.');
      }
      finalRes = await fetch(resolvedRedirect, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      });
    }

    const rawText = await finalRes.text();
    let parsed: AppsScriptResponsePayload;
    try {
      parsed = JSON.parse(rawText) as AppsScriptResponsePayload;
    } catch {
      throw new Error(
        'Apps Script did not return valid JSON. Ensure Deployment "Who has access" is set to "Anyone".'
      );
    }

    if (!parsed.ok) {
      throw new Error(parsed.error || 'Apps Script reported an error.');
    }

    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

const perLeadSheetTimers = new Map<string, ReturnType<typeof setTimeout>>();

function updateSheetSyncMetadataFromResponse(resp: AppsScriptResponsePayload): void {
  const nowIso = new Date().toISOString();
  let metaChanged = false;
  if (typeof resp.spreadsheetName === 'string' && resp.spreadsheetName) {
    if (sheetSyncSettings.spreadsheetName !== resp.spreadsheetName) metaChanged = true;
    sheetSyncSettings.spreadsheetName = resp.spreadsheetName.slice(0, 200);
  }
  if (typeof resp.sheetName === 'string' && resp.sheetName) {
    if (sheetSyncSettings.sheetName !== resp.sheetName) metaChanged = true;
    sheetSyncSettings.sheetName = resp.sheetName.slice(0, 120);
  }
  if (
    typeof resp.spreadsheetUrl === 'string' &&
    resp.spreadsheetUrl.startsWith('https://docs.google.com/spreadsheets/')
  ) {
    if (sheetSyncSettings.spreadsheetUrl !== resp.spreadsheetUrl) metaChanged = true;
    sheetSyncSettings.spreadsheetUrl = resp.spreadsheetUrl.slice(0, 500);
  }
  sheetSyncSettings.lastSyncedAt = nowIso;
  sheetSyncSettings.lastError = null;
  if (metaChanged) {
    sheetSyncSettings.updatedAt = Date.now();
    void pushSheetSyncMetaToRtdb();
  }
  persistSheetSyncSettingsLocal();
}

function queueLeadForAppsScriptSync(lead: LeadRecord, immediate = false): void {
  const activeUrl = getEnvAppsScriptWebhook() || sheetSyncSettings.webhookUrl;
  if (!sheetSyncSettings.enabled || !activeUrl) return;
  if (deletedLeadIds.has(lead.leadId)) return;

  const existingTimer = perLeadSheetTimers.get(lead.leadId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const runSync = async () => {
    perLeadSheetTimers.delete(lead.leadId);
    const latest = leadsStore.get(lead.leadId);
    if (!latest || deletedLeadIds.has(lead.leadId)) return;
    try {
      const resp = await postToAppsScriptWebhook(activeUrl, {
        action: 'upsert',
        leadId: latest.leadId,
        row: formatLeadForSheetRow(latest),
      });
      updateSheetSyncMetadataFromResponse(resp);
      const current = leadsStore.get(latest.leadId);
      if (current && !current.sheetSynced) {
        const updatedLead: LeadRecord = {
          ...current,
          sheetSynced: true,
        };
        leadsStore.set(updatedLead.leadId, updatedLead);
        persistLeadsLocal();
        void pushLeadToRtdb(updatedLead);
        broadcastSseSnapshot();
      }
    } catch (err) {
      sheetSyncSettings.lastError = (err as Error)?.message || 'Live Google Sheet sync failed.';
    }
  };

  if (immediate) {
    void runSync();
  } else {
    perLeadSheetTimers.set(lead.leadId, setTimeout(() => void runSync(), 350));
  }
}

async function deleteLeadFromAppsScriptWebhook(leadId: string): Promise<void> {
  const activeUrl = getEnvAppsScriptWebhook() || sheetSyncSettings.webhookUrl;
  if (!sheetSyncSettings.enabled || !activeUrl) return;
  try {
    const resp = await postToAppsScriptWebhook(activeUrl, {
      action: 'delete',
      leadId,
    });
    updateSheetSyncMetadataFromResponse(resp);
  } catch (err) {
    sheetSyncSettings.lastError = (err as Error)?.message || 'Failed deleting row from Google Sheet.';
  }
}

async function syncAllLeadsToAppsScript(): Promise<number> {
  const activeUrl = getEnvAppsScriptWebhook() || sheetSyncSettings.webhookUrl;
  if (!activeUrl) {
    throw new Error('Google Apps Script Web App URL is not configured.');
  }
  const currentLeads = getSortedLeads();
  const rows = currentLeads.map((l) => formatLeadForSheetRow(l));
  const resp = await postToAppsScriptWebhook(activeUrl, {
    action: 'bulk_sync',
    rows,
  });
  updateSheetSyncMetadataFromResponse(resp);

  let updatedAny = false;
  for (const lead of currentLeads) {
    if (!lead.sheetSynced) {
      const updatedLead: LeadRecord = { ...lead, sheetSynced: true };
      leadsStore.set(updatedLead.leadId, updatedLead);
      void pushLeadToRtdb(updatedLead);
      updatedAny = true;
    }
  }
  if (updatedAny) {
    persistLeadsLocal();
    broadcastSseSnapshot();
  }

  return typeof resp.synced === 'number' ? resp.synced : currentLeads.length;
}

function getSheetScriptStatusPayload() {
  const envUrl = getEnvAppsScriptWebhook();
  const activeUrl = envUrl || sheetSyncSettings.webhookUrl;
  const allLeads = getSortedLeads();
  const syncedLeads = allLeads.filter((l) => l.sheetSynced).length;
  return {
    enabled: Boolean(envUrl ? true : sheetSyncSettings.enabled && activeUrl),
    webhookUrl: activeUrl,
    isEnvConfigured: Boolean(envUrl),
    spreadsheetName: sheetSyncSettings.spreadsheetName,
    sheetName: sheetSyncSettings.sheetName || 'Prestier Leads',
    spreadsheetUrl: sheetSyncSettings.spreadsheetUrl,
    lastSyncedAt: sheetSyncSettings.lastSyncedAt,
    lastError: sheetSyncSettings.lastError,
    totalLeads: allLeads.length,
    syncedLeads,
  };
}

// ============================================================================
// Firebase Realtime Database (prestier-final) 24x7 Multi-Deployment Sync
// ============================================================================

interface RtdbConfigFile {
  apiKey?: string;
  authDomain?: string;
  databaseURL?: string;
  projectId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
}

const rtdbConfigDisk = readJsonFileSafe<RtdbConfigFile>(
  path.join(process.cwd(), 'firebase-rtdb-config.json'),
  {}
);

const DEFAULT_RTDB_ROOT_URL =
  'https://prestier-final-default-rtdb.asia-southeast1.firebasedatabase.app';

function normalizeRtdbRootUrl(
  rawUrl: string | undefined | null,
  fallbackUrl: string
): string {
  const cleaned = String(rawUrl || '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .trim();
  const safeFallback = fallbackUrl || DEFAULT_RTDB_ROOT_URL;
  if (!cleaned) return safeFallback;
  try {
    const withProtocol = /^https?:\/\//i.test(cleaned)
      ? cleaned
      : `https://${cleaned}`;
    const parsed = new URL(withProtocol);
    if (parsed.hostname === 'console.firebase.google.com') {
      return safeFallback;
    }
    if (
      !parsed.hostname.endsWith('.firebasedatabase.app') &&
      !parsed.hostname.endsWith('.firebaseio.com') &&
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '127.0.0.1'
    ) {
      return safeFallback;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return safeFallback;
  }
}

const diskRtdbRootUrl = normalizeRtdbRootUrl(
  rtdbConfigDisk.databaseURL,
  DEFAULT_RTDB_ROOT_URL
);
const RTDB_DATABASE_URL = normalizeRtdbRootUrl(
  process.env.FIREBASE_RTDB_DATABASE_URL,
  diskRtdbRootUrl
);
const RTDB_PROJECT_ID = (rtdbConfigDisk.projectId || 'prestier-final').trim();

let rtdbInstance: Database | null = null;
const rtdbState = {
  connected: false,
  writeVerified: false,
  projectId: RTDB_PROJECT_ID,
  databaseUrl: RTDB_DATABASE_URL,
  lastSyncedAt: null as string | null,
  lastError: null as string | null,
  remoteLeadCount: 0,
};

interface RemoteWaRuntimeStatus {
  instanceId: string;
  status: string;
  connectedNumber: string | null;
  updatedAt: number;
}

let remoteWaRuntime: RemoteWaRuntimeStatus | null = null;

function isRemoteCloudWorkerActive(): boolean {
  if (!remoteWaRuntime) return false;
  if (remoteWaRuntime.instanceId === SERVER_INSTANCE_ID) return false;
  if (remoteWaRuntime.status !== 'connected') return false;
  return Date.now() - remoteWaRuntime.updatedAt < 45_000;
}

function getRtdbStatusPayload() {
  return {
    connected: rtdbState.connected,
    writeVerified: rtdbState.writeVerified,
    projectId: rtdbState.projectId,
    databaseUrl: rtdbState.databaseUrl,
    lastSyncedAt: rtdbState.lastSyncedAt,
    lastError: rtdbState.lastError,
    remoteLeadCount: rtdbState.remoteLeadCount,
  };
}

async function pushLeadToRtdb(lead: LeadRecord): Promise<void> {
  if (!rtdbInstance || deletedLeadIds.has(lead.leadId)) return;
  const safeKey = sanitizeRtdbKey(lead.leadId);
  if (!safeKey) return;
  try {
    await set(ref(rtdbInstance, `leads/${safeKey}`), normalizeLeadRecord(lead));
    rtdbState.writeVerified = true;
    rtdbState.lastSyncedAt = new Date().toISOString();
    rtdbState.lastError = null;
  } catch (err) {
    rtdbState.lastError = (err as Error)?.message || 'RTDB lead write failed.';
  }
}

async function pushDeletedLeadToRtdb(leadId: string): Promise<void> {
  if (!rtdbInstance) return;
  const safeKey = sanitizeRtdbKey(leadId);
  if (!safeKey) return;
  try {
    await Promise.all([
      remove(ref(rtdbInstance, `leads/${safeKey}`)),
      set(ref(rtdbInstance, `deletedLeads/${safeKey}`), {
        leadId,
        deletedAt: new Date().toISOString(),
      }),
    ]);
    rtdbState.writeVerified = true;
    rtdbState.lastSyncedAt = new Date().toISOString();
    rtdbState.lastError = null;
  } catch (err) {
    rtdbState.lastError = (err as Error)?.message || 'RTDB delete sync failed.';
  }
}

async function pushAdminAuthToRtdb(): Promise<void> {
  if (!rtdbInstance || !adminAuth) return;
  try {
    await set(ref(rtdbInstance, 'meta/adminAuth'), adminAuth);
  } catch {
    // ignore if rules restrict meta
  }
}

async function pushAdminSessionToRtdb(tokenHash: string, expiresAt: number): Promise<void> {
  if (!rtdbInstance || !/^[a-f0-9]{64}$/.test(tokenHash)) return;
  try {
    await set(ref(rtdbInstance, `meta/adminSessions/${tokenHash}`), expiresAt);
  } catch {
    // ignore
  }
}

async function removeAdminSessionFromRtdb(tokenHash: string): Promise<void> {
  if (!rtdbInstance || !/^[a-f0-9]{64}$/.test(tokenHash)) return;
  try {
    await remove(ref(rtdbInstance, `meta/adminSessions/${tokenHash}`));
  } catch {
    // ignore
  }
}

async function pushWaSettingsToRtdb(): Promise<void> {
  if (!rtdbInstance) return;
  try {
    await set(ref(rtdbInstance, 'meta/waSettings'), waSettings);
  } catch {
    // ignore
  }
}

async function pushWaReplyImageToRtdb(): Promise<void> {
  if (!rtdbInstance) return;
  try {
    await set(ref(rtdbInstance, 'meta/waReplyImage'), waReplyImage);
  } catch {
    // ignore
  }
}

async function pushWaReplyImage2ToRtdb(): Promise<void> {
  if (!rtdbInstance) return;
  try {
    await set(ref(rtdbInstance, 'meta/waReplyImage2'), waReplyImage2);
  } catch {
    // ignore
  }
}

async function pushShowcaseSettingsToRtdb(): Promise<void> {
  if (!rtdbInstance) return;
  try {
    await set(ref(rtdbInstance, 'meta/showcaseSettings'), showcaseSettings);
  } catch {
    // ignore
  }
}

async function pushSheetSyncMetaToRtdb(): Promise<void> {
  if (!rtdbInstance) return;
  try {
    await set(ref(rtdbInstance, 'meta/sheetSync'), {
      enabled: sheetSyncSettings.enabled,
      webhookUrl: sheetSyncSettings.webhookUrl,
      spreadsheetName: sheetSyncSettings.spreadsheetName,
      sheetName: sheetSyncSettings.sheetName,
      spreadsheetUrl: sheetSyncSettings.spreadsheetUrl,
      lastSyncedAt: sheetSyncSettings.lastSyncedAt,
      updatedAt: sheetSyncSettings.updatedAt,
    });
  } catch {
    // ignore
  }
}

async function publishLocalWaRuntimeStatusToRtdb(): Promise<void> {
  if (!rtdbInstance || waState.status !== 'connected') return;
  try {
    const statusRef = ref(rtdbInstance, 'meta/waRuntimeStatus');
    void onDisconnect(statusRef).remove().catch(() => {});
    await set(statusRef, {
      instanceId: SERVER_INSTANCE_ID,
      status: 'connected',
      connectedNumber: waState.connectedNumber,
      updatedAt: Date.now(),
    });
  } catch {
    // ignore
  }
}

interface WaDispatchJob {
  jobId: string;
  phone: string;
  text: string;
  sendSecond?: boolean;
  secondText?: string | null;
  leadId?: string | null;
  requestedBy: string;
  requestedAt: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

const processedRelayJobs = new Set<string>();

async function enqueueCloudWaDispatchJob(params: {
  phone: string;
  text: string;
  sendSecond?: boolean;
  secondText?: string | null;
  leadId?: string | null;
}): Promise<boolean> {
  if (!rtdbInstance || !isRemoteCloudWorkerActive()) return false;
  const jobId = `wajob_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const job: WaDispatchJob = {
    jobId,
    phone: sanitizeField(params.phone, 32),
    text: String(params.text || '').slice(0, 4000),
    sendSecond:
      typeof params.sendSecond === 'boolean'
        ? params.sendSecond
        : waSettings.secondMessageEnabled,
    secondText:
      typeof params.secondText === 'string' && params.secondText.trim()
        ? params.secondText.slice(0, 4000)
        : waSettings.secondMessageTemplate.slice(0, 4000),
    leadId: params.leadId ? sanitizeField(params.leadId, 128) : null,
    requestedBy: SERVER_INSTANCE_ID,
    requestedAt: Date.now(),
    status: 'pending',
  };
  try {
    await set(ref(rtdbInstance, `meta/waDispatchQueue/${jobId}`), job);
    return true;
  } catch {
    return false;
  }
}

function initServerRealtimeDbSync(): void {
  if (!RTDB_DATABASE_URL) return;
  try {
    const appName = 'prestier-server-rtdb';
    const existing = getApps().find((a) => a.name === appName);
    const app =
      existing ||
      initializeApp(
        {
          ...rtdbConfigDisk,
          databaseURL: RTDB_DATABASE_URL,
          projectId: RTDB_PROJECT_ID,
        },
        appName
      );
    rtdbInstance = getDatabase(app, RTDB_DATABASE_URL);

    // Track live RTDB WebSocket connection state
    onValue(ref(rtdbInstance, '.info/connected'), (snap) => {
      rtdbState.connected = Boolean(snap.val());
      broadcastSseSnapshot();
    });

    // Verify write permission & push initial local tombstones/leads/meta
    void (async () => {
      if (!rtdbInstance) return;
      try {
        await set(ref(rtdbInstance, `meta/serverHeartbeat/${SERVER_INSTANCE_ID}`), {
          onlineAt: new Date().toISOString(),
          mode: isProduction ? 'production' : 'development',
        });
        rtdbState.writeVerified = true;
        rtdbState.lastError = null;
        rtdbState.lastSyncedAt = new Date().toISOString();

        for (const delId of deletedLeadIds) {
          const safeKey = sanitizeRtdbKey(delId);
          if (safeKey) {
            void set(ref(rtdbInstance, `deletedLeads/${safeKey}`), {
              leadId: delId,
              deletedAt: new Date().toISOString(),
            }).catch(() => {});
          }
        }
        for (const lead of leadsStore.values()) {
          if (!deletedLeadIds.has(lead.leadId)) {
            void pushLeadToRtdb(lead);
          }
        }
      } catch (err) {
        rtdbState.lastError = (err as Error)?.message || 'RTDB write verification failed.';
      }
      broadcastSseSnapshot();
    })();

    // 1. Subscribe to deletedLeads tombstones across all deployments
    onValue(
      ref(rtdbInstance, 'deletedLeads'),
      (snap) => {
        const val = snap.val();
        if (!val || typeof val !== 'object') return;
        let changed = false;
        for (const [key, item] of Object.entries(val as Record<string, unknown>)) {
          const rawId =
            item && typeof item === 'object' && typeof (item as { leadId?: unknown }).leadId === 'string'
              ? String((item as { leadId: string }).leadId).trim()
              : key.trim();
          if (rawId && !deletedLeadIds.has(rawId)) {
            deletedLeadIds.add(rawId);
            changed = true;
          }
          if (rawId && leadsStore.has(rawId)) {
            leadsStore.delete(rawId);
            changed = true;
          }
        }
        if (changed) {
          persistDeletedLeadsLocal();
          persistLeadsLocal();
          broadcastSseSnapshot();
        }
      },
      (err) => {
        rtdbState.lastError = err?.message || 'RTDB deletedLeads listener error.';
      }
    );

    // 2. Subscribe to live leads across AI Studio Preview, AI Studio Published, and Railway
    onValue(
      ref(rtdbInstance, 'leads'),
      (snap) => {
        const val = snap.val();
        if (!val || typeof val !== 'object') {
          rtdbState.remoteLeadCount = 0;
          broadcastSseSnapshot();
          return;
        }
        const entries = Object.values(val as Record<string, unknown>);
        let remoteValidCount = 0;
        let storeChanged = false;

        for (const rawItem of entries) {
          const norm = normalizeLeadRecord(rawItem);
          if (!norm.leadId) continue;
          if (deletedLeadIds.has(norm.leadId)) {
            const safeKey = sanitizeRtdbKey(norm.leadId);
            if (safeKey && rtdbInstance) {
              void remove(ref(rtdbInstance, `leads/${safeKey}`)).catch(() => {});
            }
            continue;
          }
          remoteValidCount += 1;
          const existing = leadsStore.get(norm.leadId);
          if (!existing) {
            leadsStore.set(norm.leadId, norm);
            storeChanged = true;
          } else {
            const incomingTime = new Date(norm.updatedAt).getTime();
            const existingTime = new Date(existing.updatedAt).getTime();
            if (incomingTime > existingTime) {
              leadsStore.set(norm.leadId, {
                ...norm,
                createdAt: existing.createdAt || norm.createdAt,
                whatsappSent: existing.whatsappSent || norm.whatsappSent,
                sheetSynced: existing.sheetSynced && norm.updatedAt === existing.updatedAt
                  ? true
                  : norm.sheetSynced,
              });
              storeChanged = true;
            } else if (
              (norm.whatsappSent && !existing.whatsappSent) ||
              (norm.sheetSynced && !existing.sheetSynced)
            ) {
              leadsStore.set(norm.leadId, {
                ...existing,
                whatsappSent: existing.whatsappSent || norm.whatsappSent,
                sheetSynced: existing.sheetSynced || norm.sheetSynced,
              });
              storeChanged = true;
            }
          }
        }

        rtdbState.remoteLeadCount = remoteValidCount;
        rtdbState.lastSyncedAt = new Date().toISOString();
        if (storeChanged) {
          persistLeadsLocal();
        }
        broadcastSseSnapshot();
      },
      (err) => {
        rtdbState.lastError = err?.message || 'RTDB leads listener error.';
      }
    );

    // 3. Sync Admin Password Verifier (scrypt salt + hash) across all deployments
    onValue(ref(rtdbInstance, 'meta/adminAuth'), (snap) => {
      const val = snap.val() as Partial<AdminAuthRecord> | null;
      if (
        val &&
        typeof val.salt === 'string' &&
        val.salt.length >= 16 &&
        typeof val.passwordHash === 'string' &&
        val.passwordHash.length >= 32
      ) {
        const remoteUpdatedAt = typeof val.updatedAt === 'number' ? val.updatedAt : 1;
        if (!adminAuth || remoteUpdatedAt > adminAuth.updatedAt) {
          adminAuth = {
            salt: val.salt,
            passwordHash: val.passwordHash,
            updatedAt: remoteUpdatedAt,
          };
          persistAdminAuthLocal();
        } else if (adminAuth && adminAuth.updatedAt > remoteUpdatedAt) {
          void pushAdminAuthToRtdb();
        }
      } else if (adminAuth) {
        void pushAdminAuthToRtdb();
      }
    });

    // 4. Sync Hashed Admin Sessions (SHA-256 digests only) across all deployments
    onValue(ref(rtdbInstance, 'meta/adminSessions'), (snap) => {
      const val = snap.val() as Record<string, unknown> | null;
      const now = Date.now();
      let changed = false;
      if (val && typeof val === 'object') {
        for (const [hashKey, exp] of Object.entries(val)) {
          if (/^[a-f0-9]{64}$/.test(hashKey) && typeof exp === 'number') {
            if (exp > now) {
              const cur = adminSessions.get(hashKey) || 0;
              if (exp > cur) {
                adminSessions.set(hashKey, exp);
                changed = true;
              }
            } else if (rtdbInstance) {
              void remove(ref(rtdbInstance, `meta/adminSessions/${hashKey}`)).catch(() => {});
            }
          }
        }
      }
      if (changed) {
        persistAdminSessionsLocal();
      }
      // Push any valid local sessions missing remotely
      for (const [hashKey, exp] of adminSessions.entries()) {
        if (exp > now && (!val || typeof val[hashKey] !== 'number')) {
          void pushAdminSessionToRtdb(hashKey, exp);
        }
      }
    });

    // 5. Sync WhatsApp Auto-Reply Settings across all deployments
    onValue(ref(rtdbInstance, 'meta/waSettings'), (snap) => {
      const val = snap.val() as Partial<WhatsAppSettings> | null;
      if (val && typeof val === 'object') {
        const remoteUpdatedAt = typeof val.updatedAt === 'number' ? val.updatedAt : 1;
        if (remoteUpdatedAt > waSettings.updatedAt) {
          waSettings = {
            autoReplyEnabled:
              typeof val.autoReplyEnabled === 'boolean'
                ? val.autoReplyEnabled
                : waSettings.autoReplyEnabled,
            messageTemplate:
              typeof val.messageTemplate === 'string' && val.messageTemplate.trim()
                ? val.messageTemplate.slice(0, 4000)
                : DEFAULT_PRESTAIR_WHATSAPP_REPLY,
            secondMessageEnabled:
              typeof val.secondMessageEnabled === 'boolean'
                ? val.secondMessageEnabled
                : waSettings.secondMessageEnabled,
            secondMessageTemplate:
              typeof val.secondMessageTemplate === 'string' && val.secondMessageTemplate.trim()
                ? val.secondMessageTemplate.slice(0, 4000)
                : DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY,
            adminNotifyPhone:
              typeof val.adminNotifyPhone === 'string'
                ? sanitizeField(val.adminNotifyPhone, 32)
                : '',
            updatedAt: remoteUpdatedAt,
          };
          persistWaSettingsLocal();
        } else if (waSettings.updatedAt > remoteUpdatedAt) {
          void pushWaSettingsToRtdb();
        }
      } else if (waSettings.updatedAt > 0) {
        void pushWaSettingsToRtdb();
      }
    });

    // 5b. Sync WhatsApp Attached Reply Image #1 across all deployments
    onValue(ref(rtdbInstance, 'meta/waReplyImage'), (snap) => {
      const val = snap.val() as Partial<WhatsAppReplyImageState> | null;
      if (val && typeof val === 'object') {
        const remoteUpdatedAt = typeof val.updatedAt === 'number' ? val.updatedAt : 1;
        if (remoteUpdatedAt > waReplyImage.updatedAt) {
          const remoteMode: WaReplyImageMode =
            val.mode === 'custom' || val.mode === 'none' ? val.mode : 'default';
          if (
            remoteMode === 'custom' &&
            typeof val.mimeType === 'string' &&
            typeof val.base64Data === 'string'
          ) {
            const buf = Buffer.from(val.base64Data, 'base64');
            if (validateImageBinaryMagic(val.mimeType, buf)) {
              waReplyImage = {
                mode: 'custom',
                mimeType: val.mimeType,
                base64Data: val.base64Data,
                updatedAt: remoteUpdatedAt,
              };
              persistWaReplyImageLocal();
            }
          } else {
            waReplyImage = {
              mode: remoteMode === 'none' ? 'none' : 'default',
              mimeType: '',
              base64Data: '',
              updatedAt: remoteUpdatedAt,
            };
            persistWaReplyImageLocal();
          }
        } else if (waReplyImage.updatedAt > remoteUpdatedAt) {
          void pushWaReplyImageToRtdb();
        }
      } else if (waReplyImage.updatedAt > 0) {
        void pushWaReplyImageToRtdb();
      }
    });

    // 5c. Sync WhatsApp Attached Reply Image #2 across all deployments
    onValue(ref(rtdbInstance, 'meta/waReplyImage2'), (snap) => {
      const val = snap.val() as Partial<WhatsAppReplyImageState> | null;
      if (val && typeof val === 'object') {
        const remoteUpdatedAt = typeof val.updatedAt === 'number' ? val.updatedAt : 1;
        if (remoteUpdatedAt > waReplyImage2.updatedAt) {
          const remoteMode: WaReplyImageMode =
            val.mode === 'custom' || val.mode === 'none' ? val.mode : 'default';
          if (
            remoteMode === 'custom' &&
            typeof val.mimeType === 'string' &&
            typeof val.base64Data === 'string'
          ) {
            const buf = Buffer.from(val.base64Data, 'base64');
            if (validateImageBinaryMagic(val.mimeType, buf)) {
              waReplyImage2 = {
                mode: 'custom',
                mimeType: val.mimeType,
                base64Data: val.base64Data,
                updatedAt: remoteUpdatedAt,
              };
              persistWaReplyImage2Local();
            }
          } else {
            waReplyImage2 = {
              mode: remoteMode === 'none' ? 'none' : 'default',
              mimeType: '',
              base64Data: '',
              updatedAt: remoteUpdatedAt,
            };
            persistWaReplyImage2Local();
          }
        } else if (waReplyImage2.updatedAt > remoteUpdatedAt) {
          void pushWaReplyImage2ToRtdb();
        }
      } else if (waReplyImage2.updatedAt > 0) {
        void pushWaReplyImage2ToRtdb();
      }
    });

    // 5d. Sync Customer Thank-You Showcase Image Settings across all deployments
    onValue(ref(rtdbInstance, 'meta/showcaseSettings'), (snap) => {
      const val = snap.val() as Partial<ShowcaseSettingsState> | null;
      if (val && typeof val === 'object') {
        const remoteUpdatedAt = typeof val.updatedAt === 'number' ? val.updatedAt : 1;
        if (remoteUpdatedAt > showcaseSettings.updatedAt) {
          const remoteSource: ShowcaseImageSource = isValidShowcaseSource(val.source)
            ? val.source
            : 'wa1';
          let mimeType = '';
          let base64Data = '';
          if (
            typeof val.mimeType === 'string' &&
            typeof val.base64Data === 'string' &&
            val.base64Data
          ) {
            const buf = Buffer.from(val.base64Data, 'base64');
            if (validateImageBinaryMagic(val.mimeType, buf)) {
              mimeType = val.mimeType;
              base64Data = val.base64Data;
            }
          }
          showcaseSettings = {
            source: remoteSource === 'custom' && !base64Data ? 'wa1' : remoteSource,
            mimeType,
            base64Data,
            updatedAt: remoteUpdatedAt,
          };
          persistShowcaseSettingsLocal();
        } else if (showcaseSettings.updatedAt > remoteUpdatedAt) {
          void pushShowcaseSettingsToRtdb();
        }
      } else if (showcaseSettings.updatedAt > 0) {
        void pushShowcaseSettingsToRtdb();
      }
    });

    // 6. Sync Google Sheet Apps Script Configuration across all deployments
    onValue(ref(rtdbInstance, 'meta/sheetSync'), (snap) => {
      const val = snap.val() as Partial<SheetSyncSettings> | null;
      const envUrl = getEnvAppsScriptWebhook();
      if (val && typeof val === 'object') {
        const remoteUpdatedAt = typeof val.updatedAt === 'number' ? val.updatedAt : 1;
        if (remoteUpdatedAt > sheetSyncSettings.updatedAt) {
          const remoteUrl =
            typeof val.webhookUrl === 'string' && validateAppsScriptUrl(val.webhookUrl).valid
              ? val.webhookUrl.trim()
              : '';
          sheetSyncSettings = {
            enabled: envUrl
              ? true
              : typeof val.enabled === 'boolean'
                ? val.enabled && Boolean(remoteUrl)
                : Boolean(remoteUrl),
            webhookUrl: envUrl || remoteUrl,
            spreadsheetName:
              typeof val.spreadsheetName === 'string'
                ? val.spreadsheetName.slice(0, 200)
                : sheetSyncSettings.spreadsheetName,
            sheetName:
              typeof val.sheetName === 'string' && val.sheetName.trim()
                ? val.sheetName.slice(0, 120)
                : 'Prestier Leads',
            spreadsheetUrl:
              typeof val.spreadsheetUrl === 'string' &&
              val.spreadsheetUrl.startsWith('https://docs.google.com/spreadsheets/')
                ? val.spreadsheetUrl.slice(0, 500)
                : sheetSyncSettings.spreadsheetUrl,
            lastSyncedAt:
              typeof val.lastSyncedAt === 'string'
                ? val.lastSyncedAt
                : sheetSyncSettings.lastSyncedAt,
            lastError: null,
            updatedAt: remoteUpdatedAt,
          };
          persistSheetSyncSettingsLocal();
        } else if (sheetSyncSettings.updatedAt > remoteUpdatedAt) {
          void pushSheetSyncMetaToRtdb();
        }
      } else if (sheetSyncSettings.updatedAt > 0) {
        void pushSheetSyncMetaToRtdb();
      }
    });

    // 7. Track active 24x7 Cloud/Railway WhatsApp worker status
    onValue(ref(rtdbInstance, 'meta/waRuntimeStatus'), (snap) => {
      const val = snap.val() as Partial<RemoteWaRuntimeStatus> | null;
      if (
        val &&
        typeof val.instanceId === 'string' &&
        typeof val.status === 'string' &&
        typeof val.updatedAt === 'number'
      ) {
        remoteWaRuntime = {
          instanceId: val.instanceId,
          status: val.status,
          connectedNumber:
            typeof val.connectedNumber === 'string' ? val.connectedNumber : null,
          updatedAt: val.updatedAt,
        };
      } else {
        remoteWaRuntime = null;
      }
    });

    // 8. Process relayed WhatsApp send jobs if THIS server holds the active WhatsApp connection
    onValue(ref(rtdbInstance, 'meta/waDispatchQueue'), (snap) => {
      processWaDispatchQueueSnapshot(
        snap.val() as Record<string, Partial<WaDispatchJob>> | null
      );
    });
  } catch (err) {
    rtdbState.lastError = (err as Error)?.message || 'Failed initializing Firebase RTDB.';
  }
}

function processWaDispatchQueueSnapshot(
  val: Record<string, Partial<WaDispatchJob>> | null
): void {
  if (!val || typeof val !== 'object') return;
  const now = Date.now();

  for (const [key, rawJob] of Object.entries(val)) {
    if (!rawJob || typeof rawJob !== 'object') continue;
    const requestedAt = typeof rawJob.requestedAt === 'number' ? rawJob.requestedAt : 0;
    // Clean up stale jobs older than 5 minutes (even if WhatsApp is not connected here)
    if (now - requestedAt > 5 * 60 * 1000) {
      if (rtdbInstance) {
        void remove(ref(rtdbInstance, `meta/waDispatchQueue/${key}`)).catch(() => {});
      }
      continue;
    }

    if (waState.status !== 'connected' || !waSocket) continue;
    if (rawJob.status !== 'pending') continue;
    if (processedRelayJobs.has(key)) continue;
    processedRelayJobs.add(key);

    const phone = typeof rawJob.phone === 'string' ? rawJob.phone : '';
    const text = typeof rawJob.text === 'string' ? rawJob.text : '';
    const sendSecond =
      typeof rawJob.sendSecond === 'boolean'
        ? rawJob.sendSecond
        : waSettings.secondMessageEnabled;
    const secondText =
      typeof rawJob.secondText === 'string' && rawJob.secondText.trim()
        ? rawJob.secondText
        : waSettings.secondMessageTemplate;
    const leadId = typeof rawJob.leadId === 'string' ? rawJob.leadId : '';

    void (async () => {
      try {
        if (rtdbInstance) {
          await set(ref(rtdbInstance, `meta/waDispatchQueue/${key}/status`), 'processing');
        }
        await sendPrestairWhatsAppReplyWithSingleImage(phone, text, {
          sendSecond,
          secondCaptionText: secondText,
        });
        if (leadId && !deletedLeadIds.has(leadId)) {
          const existingLead = leadsStore.get(leadId);
          if (existingLead) {
            const marked: LeadRecord = {
              ...existingLead,
              whatsappSent: true,
              updatedAt: new Date().toISOString(),
            };
            leadsStore.set(leadId, marked);
            persistLeadsLocal();
            await pushLeadToRtdb(marked);
            queueLeadForAppsScriptSync(marked, true);
            broadcastSseSnapshot();
          }
        }
        if (rtdbInstance) {
          await remove(ref(rtdbInstance, `meta/waDispatchQueue/${key}`));
        }
      } catch {
        processedRelayJobs.delete(key);
        if (rtdbInstance) {
          await remove(ref(rtdbInstance, `meta/waDispatchQueue/${key}`)).catch(() => {});
        }
      }
    })();
  }
}

async function drainPendingWaDispatchQueueFromRtdb(): Promise<void> {
  if (!rtdbInstance || waState.status !== 'connected' || !waSocket) return;
  try {
    const snap = await get(ref(rtdbInstance, 'meta/waDispatchQueue'));
    processWaDispatchQueueSnapshot(
      snap.val() as Record<string, Partial<WaDispatchJob>> | null
    );
  } catch {
    // ignore transient read error
  }
}

// ============================================================================
// Server-Sent Events (SSE) Instant Admin Stream
// ============================================================================

const sseClients = new Set<Response>();

function buildSnapshotFrame(): string {
  const payload = {
    type: 'snapshot',
    leads: getSortedLeads(),
    deletedIds: Array.from(deletedLeadIds),
    rtdb: getRtdbStatusPayload(),
  };
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function broadcastSseSnapshot(): void {
  if (sseClients.size === 0) return;
  const frame = buildSnapshotFrame();
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': keepalive\n\n');
    } catch {
      sseClients.delete(client);
    }
  }
}, 15_000).unref();

// ============================================================================
// 24x7 Logout-Safe Baileys WhatsApp Multi-Device Automation Engine
// ============================================================================

type WaConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_ready'
  | 'pairing_ready'
  | 'connected';

const waState: {
  status: WaConnectionStatus;
  qrDataUrl: string | null;
  pairingCode: string | null;
  connectedNumber: string | null;
  lastError: string | null;
} = {
  status: 'disconnected',
  qrDataUrl: null,
  pairingCode: null,
  connectedNumber: null,
  lastError: null,
};

let waSocket: WASocket | null = null;
let waReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let waConnectLock = false;
let explicitUnlinkRequested = false;
let isShuttingDown = false;
const inFlightLeadWaDispatches = new Set<string>();

interface ResolvedReplyImage {
  buffer: Buffer;
  mimeType: string;
}

function detectImageMimeFromBuffer(buf: Buffer): string | null {
  if (validateImageBinaryMagic('image/jpeg', buf)) return 'image/jpeg';
  if (validateImageBinaryMagic('image/png', buf)) return 'image/png';
  if (validateImageBinaryMagic('image/webp', buf)) return 'image/webp';
  return null;
}

function resolveStaticAssetImage(assetWebPath: string): ResolvedReplyImage | null {
  const relPath = assetWebPath.replace(/^\/+/, '');
  const candidates = [
    path.resolve(process.cwd(), 'public', relPath),
    path.resolve(process.cwd(), 'dist', relPath),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const buf = fs.readFileSync(candidate);
        const detectedMime = detectImageMimeFromBuffer(buf);
        if (detectedMime) {
          return { buffer: buf, mimeType: detectedMime };
        }
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

function resolveFirstPrestairReplyImage(): ResolvedReplyImage | null {
  if (waReplyImage.mode === 'none') {
    return null;
  }
  if (waReplyImage.mode === 'custom' && waReplyImage.base64Data) {
    try {
      const customBuf = Buffer.from(waReplyImage.base64Data, 'base64');
      if (validateImageBinaryMagic(waReplyImage.mimeType, customBuf)) {
        return { buffer: customBuf, mimeType: waReplyImage.mimeType };
      }
    } catch {
      // fallback to default image if decoding fails
    }
  }
  return resolveStaticAssetImage(PRESTAIR_REPLY_IMAGES[0]);
}

function resolveSecondPrestairReplyImage(): ResolvedReplyImage | null {
  if (waReplyImage2.mode === 'none') {
    return null;
  }
  if (waReplyImage2.mode === 'custom' && waReplyImage2.base64Data) {
    try {
      const customBuf = Buffer.from(waReplyImage2.base64Data, 'base64');
      if (validateImageBinaryMagic(waReplyImage2.mimeType, customBuf)) {
        return { buffer: customBuf, mimeType: waReplyImage2.mimeType };
      }
    } catch {
      // fallback below
    }
  }
  const secondDefaultImg = resolveStaticAssetImage(PRESTAIR_SECOND_REPLY_IMAGES[0]);
  if (secondDefaultImg) {
    return secondDefaultImg;
  }
  // Reuse active Message #1 showcase image if custom Image #2 hasn't been uploaded yet
  return resolveFirstPrestairReplyImage();
}

async function ensureWaMetaHydratedFromRtdb(): Promise<void> {
  if (!rtdbInstance) return;
  try {
    if (waSettings.updatedAt === 0) {
      const snap = await get(ref(rtdbInstance, 'meta/waSettings'));
      const val = snap.val() as Partial<WhatsAppSettings> | null;
      if (val && typeof val === 'object') {
        waSettings = {
          autoReplyEnabled:
            typeof val.autoReplyEnabled === 'boolean'
              ? val.autoReplyEnabled
              : waSettings.autoReplyEnabled,
          messageTemplate:
            typeof val.messageTemplate === 'string' && val.messageTemplate.trim()
              ? val.messageTemplate.slice(0, 4000)
              : DEFAULT_PRESTAIR_WHATSAPP_REPLY,
          secondMessageEnabled:
            typeof val.secondMessageEnabled === 'boolean'
              ? val.secondMessageEnabled
              : true,
          secondMessageTemplate:
            typeof val.secondMessageTemplate === 'string' && val.secondMessageTemplate.trim()
              ? val.secondMessageTemplate.slice(0, 4000)
              : DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY,
          adminNotifyPhone:
            typeof val.adminNotifyPhone === 'string'
              ? sanitizeField(val.adminNotifyPhone, 32)
              : '',
          updatedAt: typeof val.updatedAt === 'number' ? val.updatedAt : 1,
        };
        persistWaSettingsLocal();
      }
    }

    if (waReplyImage.updatedAt === 0) {
      const snap1 = await get(ref(rtdbInstance, 'meta/waReplyImage'));
      const val1 = snap1.val() as Partial<WhatsAppReplyImageState> | null;
      if (
        val1 &&
        val1.mode === 'custom' &&
        typeof val1.mimeType === 'string' &&
        typeof val1.base64Data === 'string'
      ) {
        const buf1 = Buffer.from(val1.base64Data, 'base64');
        if (validateImageBinaryMagic(val1.mimeType, buf1)) {
          waReplyImage = {
            mode: 'custom',
            mimeType: val1.mimeType,
            base64Data: val1.base64Data,
            updatedAt: typeof val1.updatedAt === 'number' ? val1.updatedAt : 1,
          };
          persistWaReplyImageLocal();
        }
      }
    }

    if (waReplyImage2.updatedAt === 0) {
      const snap2 = await get(ref(rtdbInstance, 'meta/waReplyImage2'));
      const val2 = snap2.val() as Partial<WhatsAppReplyImageState> | null;
      if (
        val2 &&
        val2.mode === 'custom' &&
        typeof val2.mimeType === 'string' &&
        typeof val2.base64Data === 'string'
      ) {
        const buf2 = Buffer.from(val2.base64Data, 'base64');
        if (validateImageBinaryMagic(val2.mimeType, buf2)) {
          waReplyImage2 = {
            mode: 'custom',
            mimeType: val2.mimeType,
            base64Data: val2.base64Data,
            updatedAt: typeof val2.updatedAt === 'number' ? val2.updatedAt : 1,
          };
          persistWaReplyImage2Local();
        }
      }
    }

    if (showcaseSettings.updatedAt === 0) {
      const snapShow = await get(ref(rtdbInstance, 'meta/showcaseSettings'));
      const valShow = snapShow.val() as Partial<ShowcaseSettingsState> | null;
      if (valShow && typeof valShow === 'object') {
        const remoteSource: ShowcaseImageSource = isValidShowcaseSource(valShow.source)
          ? valShow.source
          : 'wa1';
        let mimeType = '';
        let base64Data = '';
        if (
          typeof valShow.mimeType === 'string' &&
          typeof valShow.base64Data === 'string' &&
          valShow.base64Data
        ) {
          const buf = Buffer.from(valShow.base64Data, 'base64');
          if (validateImageBinaryMagic(valShow.mimeType, buf)) {
            mimeType = valShow.mimeType;
            base64Data = valShow.base64Data;
          }
        }
        showcaseSettings = {
          source: remoteSource === 'custom' && !base64Data ? 'wa1' : remoteSource,
          mimeType,
          base64Data,
          updatedAt: typeof valShow.updatedAt === 'number' ? valShow.updatedAt : 1,
        };
        persistShowcaseSettingsLocal();
      }
    }
  } catch {
    // ignore transient RTDB read failure
  }
}

let connectionReplacedAtMs = 0;

function ensureValidWhatsAppCredsFile(): boolean {
  const credsPath = path.join(WHATSAPP_AUTH_DIR, 'creds.json');
  const backupPath = path.join(WHATSAPP_AUTH_DIR, 'creds.backup.json');
  try {
    if (fs.existsSync(credsPath)) {
      const raw = fs.readFileSync(credsPath, 'utf8').trim();
      if (raw.length > 20) {
        JSON.parse(raw);
        return true;
      }
    }
  } catch {
    // Attempt recovery from backup if creds.json was truncated during container restart
  }

  try {
    if (fs.existsSync(backupPath)) {
      const backupRaw = fs.readFileSync(backupPath, 'utf8').trim();
      if (backupRaw.length > 20) {
        JSON.parse(backupRaw);
        fs.writeFileSync(credsPath, backupRaw, 'utf8');
        return true;
      }
    }
  } catch {
    // ignore invalid backup
  }
  return false;
}

function backupWhatsAppCredsSafe(): void {
  const credsPath = path.join(WHATSAPP_AUTH_DIR, 'creds.json');
  const backupPath = path.join(WHATSAPP_AUTH_DIR, 'creds.backup.json');
  try {
    if (!fs.existsSync(credsPath)) return;
    const raw = fs.readFileSync(credsPath, 'utf8').trim();
    if (raw.length > 20) {
      JSON.parse(raw);
      const tmpPath = `${backupPath}.tmp`;
      fs.writeFileSync(tmpPath, raw, 'utf8');
      fs.renameSync(tmpPath, backupPath);
    }
  } catch {
    // ignore transient read/parse race
  }
}

function hasSavedWhatsAppCreds(): boolean {
  return ensureValidWhatsAppCredsFile();
}

function cleanupActiveSocketOnly(): void {
  if (waReconnectTimer) {
    clearTimeout(waReconnectTimer);
    waReconnectTimer = null;
  }
  if (waSocket) {
    try {
      waSocket.ev.removeAllListeners('connection.update');
      waSocket.ev.removeAllListeners('creds.update');
      waSocket.end(undefined);
    } catch {
      // ignore socket close errors
    }
    waSocket = null;
  }
}

async function startWhatsAppConnection(pairingPhoneRaw = ''): Promise<void> {
  if (waConnectLock || isShuttingDown) return;
  const cleanPairingDigits = normalizePhoneForWhatsApp(pairingPhoneRaw);
  if (waState.status === 'connected' && waSocket && !cleanPairingDigits) {
    return;
  }

  waConnectLock = true;
  explicitUnlinkRequested = false;
  cleanupActiveSocketOnly();

  waState.status = 'connecting';
  waState.qrDataUrl = null;
  waState.pairingCode = null;
  waState.lastError = null;

  try {
    fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
    ensureValidWhatsAppCredsFile();
    const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_AUTH_DIR);

    let version: [number, number, number] | undefined;
    try {
      const fetched = await fetchLatestBaileysVersion();
      version = fetched.version;
    } catch {
      version = undefined;
    }

    const sock = makeWASocket({
      ...(version ? { version } : {}),
      auth: state,
      logger: pino({ level: 'silent' }) as any,
      browser: Browsers.ubuntu('Chrome'),
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      keepAliveIntervalMs: 20_000,
      connectTimeoutMs: 45_000,
      defaultQueryTimeoutMs: 45_000,
    });

    waSocket = sock;
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      backupWhatsAppCredsSafe();
    });

    if (cleanPairingDigits && !state.creds.registered) {
      setTimeout(async () => {
        if (waSocket !== sock || waState.status === 'connected') return;
        try {
          const code = await sock.requestPairingCode(cleanPairingDigits);
          waState.pairingCode = code;
          waState.status = 'pairing_ready';
        } catch (err) {
          waState.lastError =
            (err as Error)?.message || 'Could not generate pairing code. Try scanning QR instead.';
        }
      }, 1800);
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !cleanPairingDigits) {
        try {
          waState.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 300 });
          waState.status = 'qr_ready';
        } catch {
          // ignore QR render error
        }
      }

      if (connection === 'open') {
        const rawUserId = sock.user?.id || '';
        const connectedPhone = rawUserId.split(':')[0].split('@')[0] || 'Linked';
        connectionReplacedAtMs = 0;
        waState.status = 'connected';
        waState.qrDataUrl = null;
        waState.pairingCode = null;
        waState.connectedNumber = `+${connectedPhone}`;
        waState.lastError = null;
        backupWhatsAppCredsSafe();
        void publishLocalWaRuntimeStatusToRtdb();
        void drainPendingWaDispatchQueueFromRtdb();
      }

      if (connection === 'close') {
        const statusCode = Number(
          (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode || 0
        );

        waSocket = null;
        waState.qrDataUrl = null;
        waState.pairingCode = null;

        if (isShuttingDown) {
          // Graceful container update / restart — NEVER touch WHATSAPP_AUTH_DIR
          waState.status = 'disconnected';
          return;
        }

        if (explicitUnlinkRequested) {
          // Admin explicitly clicked "Unlink WhatsApp Device"
          waState.status = 'disconnected';
          waState.connectedNumber = null;
          return;
        }

        if (statusCode === DisconnectReason.connectionReplaced) {
          // Another active deployment (e.g. 24x7 Railway server) took over the WhatsApp socket.
          // NEVER delete local creds.json, and do NOT fight it in a reconnect loop!
          connectionReplacedAtMs = Date.now();
          waState.status = 'disconnected';
          waState.lastError = null;
          return;
        }

        if (statusCode === DisconnectReason.loggedOut) {
          // Phone explicitly unlinked device from WhatsApp mobile app
          waState.status = 'disconnected';
          waState.connectedNumber = null;
          waState.lastError =
            'WhatsApp session was unlinked from phone. Scan QR code once to relink.';
          try {
            fs.rmSync(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
          } catch {
            // ignore
          }
          return;
        }

        // Transient network reset / restartRequired (515) / timeout — auto-reconnect preserving creds!
        waState.status = 'connecting';
        const delayMs = statusCode === DisconnectReason.restartRequired ? 1200 : 4000;
        if (waReconnectTimer) clearTimeout(waReconnectTimer);
        waReconnectTimer = setTimeout(() => {
          if (!isShuttingDown && !explicitUnlinkRequested && !isRemoteCloudWorkerActive()) {
            void startWhatsAppConnection();
          } else if (isRemoteCloudWorkerActive()) {
            waState.status = 'disconnected';
          }
        }, delayMs);
      }
    });
  } catch (err) {
    waState.status = 'disconnected';
    waState.lastError = (err as Error)?.message || 'Failed starting WhatsApp connection.';
  } finally {
    waConnectLock = false;
  }
}

// Publish WhatsApp 24x7 heartbeat every 15s when locally connected,
// drain any pending relay jobs, and auto-resume saved credentials if no remote worker is active.
setInterval(() => {
  if (waState.status === 'connected' && waSocket) {
    void publishLocalWaRuntimeStatusToRtdb();
    void drainPendingWaDispatchQueueFromRtdb();
    return;
  }
  const recentlyReplaced =
    connectionReplacedAtMs > 0 && Date.now() - connectionReplacedAtMs < 90_000;
  if (
    waState.status === 'disconnected' &&
    !waSocket &&
    !waConnectLock &&
    hasSavedWhatsAppCreds() &&
    !isShuttingDown &&
    !explicitUnlinkRequested &&
    !recentlyReplaced &&
    !isRemoteCloudWorkerActive()
  ) {
    void startWhatsAppConnection();
  }
}, 15_000).unref();

async function waitForActiveWaSocket(maxWaitMs = 8000): Promise<WASocket> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (waSocket && waState.status === 'connected') {
      return waSocket;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  if (waSocket && waState.status === 'connected') {
    return waSocket;
  }
  throw new Error('WhatsApp device is not linked yet.');
}

async function resolveWhatsAppJid(rawPhone: string): Promise<string> {
  const sock = await waitForActiveWaSocket(5000);
  const digits = normalizePhoneForWhatsApp(rawPhone);
  if (!digits || digits.length < 8) {
    throw new Error('Invalid recipient WhatsApp number.');
  }
  try {
    const results = await sock.onWhatsApp(digits);
    if (Array.isArray(results) && results[0]?.exists && results[0]?.jid) {
      return results[0].jid;
    }
  } catch {
    // fallback to standard s.whatsapp.net JID
  }
  return `${digits}@s.whatsapp.net`;
}

async function sendSingleWhatsAppMediaOrText(
  jid: string,
  caption: string,
  imagePayload: ResolvedReplyImage | null
): Promise<void> {
  const sock = await waitForActiveWaSocket(8000);
  if (!imagePayload) {
    await sock.sendMessage(jid, { text: caption });
    return;
  }

  try {
    await sock.sendMessage(jid, {
      image: imagePayload.buffer,
      mimetype: imagePayload.mimeType,
      caption,
    });
  } catch {
    // Retry media upload once after brief pause, then fallback to text so delivery never drops
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const retrySock = await waitForActiveWaSocket(8000);
    try {
      await retrySock.sendMessage(jid, {
        image: imagePayload.buffer,
        mimetype: imagePayload.mimeType,
        caption,
      });
    } catch {
      await retrySock.sendMessage(jid, { text: caption });
    }
  }
}

async function sendPrestairWhatsAppReplyWithSingleImage(
  rawPhone: string,
  captionText: string,
  options?: {
    sendSecond?: boolean;
    secondCaptionText?: string;
  }
): Promise<void> {
  await ensureWaMetaHydratedFromRtdb();
  const jid = await resolveWhatsAppJid(rawPhone);

  // Message 1: First Separate Image + Text Confirmation
  const firstImage = resolveFirstPrestairReplyImage();
  const cleanFirstCaption = captionText.trim() || DEFAULT_PRESTAIR_WHATSAPP_REPLY;
  await sendSingleWhatsAppMediaOrText(jid, cleanFirstCaption, firstImage);

  // Message 2: Second Separate Image + Text Confirmation
  const shouldSendSecond =
    typeof options?.sendSecond === 'boolean'
      ? options.sendSecond
      : waSettings.secondMessageEnabled !== false;

  if (shouldSendSecond) {
    // Wait 1.4s so Message 2 always gets a distinct >1s Unix timestamp in Baileys and arrives as a clean 2nd bubble
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const secondImage = resolveSecondPrestairReplyImage();
    const cleanSecondCaption =
      (options?.secondCaptionText ?? waSettings.secondMessageTemplate).trim() ||
      DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY;
    await sendSingleWhatsAppMediaOrText(jid, cleanSecondCaption, secondImage);
  }
}

async function notifyAdminPhoneOnNewLead(lead: LeadRecord): Promise<void> {
  const adminPhone = waSettings.adminNotifyPhone.trim();
  if (!adminPhone || !waSocket || waState.status !== 'connected') return;
  const digits = normalizePhoneForWhatsApp(adminPhone);
  if (digits.length < 8) return;
  try {
    const jid = await resolveWhatsAppJid(adminPhone);
    const summary = [
      '🔔 *New Prestier Lead Confirmed*',
      `• *Name:* ${lead.name || '—'}`,
      `• *Designation:* ${lead.designation || '—'}`,
      `• *Phone:* ${lead.phone || '—'}`,
      `• *Company:* ${lead.companyName || '—'}`,
      `• *City:* ${lead.city || '—'}`,
      `• *Email:* ${lead.emailAddress || '—'}`,
      `• *Outlets:* ${lead.outletsCount || '—'}`,
      `• *Equipment:* ${lead.productInterest.join(', ') || '—'}`,
    ].join('\n');
    await waSocket.sendMessage(jid, { text: summary });
  } catch {
    // non-fatal admin alert failure
  }
}

function dispatchLeadAutoReplyInBackground(lead: LeadRecord): boolean {
  const digits = normalizePhoneForWhatsApp(lead.phone);
  if (!digits || digits === '91' || digits.length < 8) return false;
  if (inFlightLeadWaDispatches.has(lead.leadId)) return true;

  const messageText = buildWhatsAppConfirmationMessage(lead, waSettings.messageTemplate);
  const secondMessageText = buildWhatsAppConfirmationMessage(
    lead,
    waSettings.secondMessageTemplate
  );

  if (waState.status === 'connected' && waSocket) {
    inFlightLeadWaDispatches.add(lead.leadId);
    void (async () => {
      try {
        await sendPrestairWhatsAppReplyWithSingleImage(lead.phone, messageText, {
          sendSecond: waSettings.secondMessageEnabled,
          secondCaptionText: secondMessageText,
        });
        const latest = leadsStore.get(lead.leadId);
        if (latest && !deletedLeadIds.has(lead.leadId)) {
          const updated: LeadRecord = {
            ...latest,
            whatsappSent: true,
            updatedAt: new Date().toISOString(),
          };
          leadsStore.set(updated.leadId, updated);
          persistLeadsLocal();
          await pushLeadToRtdb(updated);
          queueLeadForAppsScriptSync(updated, true);
          broadcastSseSnapshot();
        }
        await notifyAdminPhoneOnNewLead(lead);
      } catch (err) {
        waState.lastError = (err as Error)?.message || 'Auto-reply send failed.';
      } finally {
        inFlightLeadWaDispatches.delete(lead.leadId);
      }
    })();
    return true;
  }

  if (isRemoteCloudWorkerActive()) {
    void enqueueCloudWaDispatchJob({
      phone: lead.phone,
      text: messageText,
      sendSecond: waSettings.secondMessageEnabled,
      secondText: secondMessageText,
      leadId: lead.leadId,
    });
    return true;
  }

  return false;
}

// ============================================================================
// Express Server & API Routes
// ============================================================================

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length >= 32 ? token : null;
}

function isValidAdminRequest(req: Request): boolean {
  const rawToken = extractBearerToken(req);
  if (!rawToken) return false;
  const tokenHash = hashSessionToken(rawToken);
  const exp = adminSessions.get(tokenHash);
  if (!exp) return false;
  if (Date.now() >= exp) {
    adminSessions.delete(tokenHash);
    persistAdminSessionsLocal();
    void removeAdminSessionFromRtdb(tokenHash);
    return false;
  }
  return true;
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isValidAdminRequest(req)) {
    res.status(401).json({ error: 'Unauthorized. Please unlock Admin with your password.' });
    return;
  }
  next();
}

function issueNewAdminSessionToken(): string {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  adminSessions.set(tokenHash, expiresAt);
  persistAdminSessionsLocal();
  void pushAdminSessionToRtdb(tokenHash, expiresAt);
  return rawToken;
}

function getEnvAdminPasscode(): string {
  return (process.env.ADMIN_PASSCODE || '').trim();
}

async function startServer(): Promise<void> {
  initServerRealtimeDbSync();

  // Auto-resume saved WhatsApp credentials after checking whether a remote 24x7 worker is already live
  setTimeout(() => {
    if (
      hasSavedWhatsAppCreds() &&
      !isShuttingDown &&
      !explicitUnlinkRequested &&
      !isRemoteCloudWorkerActive()
    ) {
      void startWhatsAppConnection();
    }
  }, 2500).unref();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '4mb' }));

  // --------------------------------------------------------------------------
  // Health Check (Railway / Cloud Run / AI Studio)
  // --------------------------------------------------------------------------
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: 'prestier-lead-capture',
      uptimeSec: Math.floor((Date.now() - SERVER_START_MS) / 1000),
      rtdbConnected: rtdbState.connected,
      rtdbWriteVerified: rtdbState.writeVerified,
      rtdbHasError: Boolean(rtdbState.lastError),
      sheetSyncEnabled: Boolean(
        getEnvAppsScriptWebhook() || (sheetSyncSettings.enabled && sheetSyncSettings.webhookUrl)
      ),
      waConnected: waState.status === 'connected' || isRemoteCloudWorkerActive(),
    });
  });

  // --------------------------------------------------------------------------
  // Admin Auth & Cross-Deployment Session Sync
  // --------------------------------------------------------------------------
  app.get('/api/admin/auth-status', async (req: Request, res: Response) => {
    const envPass = getEnvAdminPasscode();
    if (!envPass && !adminAuth && rtdbInstance) {
      try {
        const snap = await get(ref(rtdbInstance, 'meta/adminAuth'));
        const remote = snap.val() as Partial<AdminAuthRecord> | null;
        if (
          remote &&
          typeof remote.salt === 'string' &&
          remote.salt.length >= 16 &&
          typeof remote.passwordHash === 'string' &&
          remote.passwordHash.length >= 32
        ) {
          adminAuth = {
            salt: remote.salt,
            passwordHash: remote.passwordHash,
            updatedAt: typeof remote.updatedAt === 'number' ? remote.updatedAt : 1,
          };
          persistAdminAuthLocal();
        }
      } catch {
        // ignore transient read failure
      }
    }

    res.json({
      isConfigured: Boolean(envPass || adminAuth),
      usesEnvPasscode: Boolean(envPass),
      authenticated: isValidAdminRequest(req),
    });
  });

  app.post('/api/admin/setup', async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const limit = checkRateLimitAllowed(ip);
    if (!limit.allowed) {
      res.status(429).json({
        error: `Too many attempts. Please wait ${limit.retryAfterSec}s before trying again.`,
      });
      return;
    }

    const envPass = getEnvAdminPasscode();
    if (envPass || adminAuth) {
      res.status(409).json({
        error: 'Admin password is already configured. Please sign in with your password.',
      });
      return;
    }

    // Check RTDB to prevent cross-deployment setup race condition
    if (rtdbInstance) {
      try {
        const snap = await get(ref(rtdbInstance, 'meta/adminAuth'));
        const remote = snap.val() as Partial<AdminAuthRecord> | null;
        if (
          remote &&
          typeof remote.salt === 'string' &&
          remote.salt.length >= 16 &&
          typeof remote.passwordHash === 'string' &&
          remote.passwordHash.length >= 32
        ) {
          adminAuth = {
            salt: remote.salt,
            passwordHash: remote.passwordHash,
            updatedAt: typeof remote.updatedAt === 'number' ? remote.updatedAt : 1,
          };
          persistAdminAuthLocal();
          res.status(409).json({
            error: 'Admin password was already set on another deployment. Please unlock with that password.',
          });
          return;
        }
      } catch {
        // continue local setup if RTDB unreachable
      }
    }

    const rawPassword =
      typeof req.body?.password === 'string' ? req.body.password.trim() : '';
    if (rawPassword.length < 4 || rawPassword.length > 128) {
      recordFailedAuthAttempt(ip);
      res.status(400).json({
        error: 'Admin PIN / password must be between 4 and 128 characters.',
      });
      return;
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPasswordScrypt(rawPassword, salt);
    adminAuth = {
      salt,
      passwordHash,
      updatedAt: Date.now(),
    };
    persistAdminAuthLocal();
    await pushAdminAuthToRtdb();
    clearFailedAuthAttempts(ip);

    const token = issueNewAdminSessionToken();
    res.json({
      ok: true,
      token,
      leads: getSortedLeads(),
      deletedIds: Array.from(deletedLeadIds),
      rtdb: getRtdbStatusPayload(),
    });
  });

  app.post('/api/admin/login', async (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const limit = checkRateLimitAllowed(ip);
    if (!limit.allowed) {
      res.status(429).json({
        error: `Too many failed attempts. Try again in ${limit.retryAfterSec}s.`,
      });
      return;
    }

    const rawPassword =
      typeof req.body?.password === 'string' ? req.body.password.trim() : '';
    if (!rawPassword || rawPassword.length > 128) {
      recordFailedAuthAttempt(ip);
      res.status(401).json({ error: 'Incorrect password. Please try again.' });
      return;
    }

    const envPass = getEnvAdminPasscode();
    if (envPass) {
      if (!verifyConstantTimeStrings(rawPassword, envPass)) {
        recordFailedAuthAttempt(ip);
        res.status(401).json({ error: 'Incorrect password. Please try again.' });
        return;
      }
    } else {
      if (!adminAuth && rtdbInstance) {
        try {
          const snap = await get(ref(rtdbInstance, 'meta/adminAuth'));
          const remote = snap.val() as Partial<AdminAuthRecord> | null;
          if (
            remote &&
            typeof remote.salt === 'string' &&
            remote.salt.length >= 16 &&
            typeof remote.passwordHash === 'string' &&
            remote.passwordHash.length >= 32
          ) {
            adminAuth = {
              salt: remote.salt,
              passwordHash: remote.passwordHash,
              updatedAt: typeof remote.updatedAt === 'number' ? remote.updatedAt : 1,
            };
            persistAdminAuthLocal();
          }
        } catch {
          // ignore
        }
      }

      if (!adminAuth) {
        res.status(409).json({
          error: 'No admin password configured yet. Please set your Admin PIN.',
        });
        return;
      }

      const candidateHash = hashPasswordScrypt(rawPassword, adminAuth.salt);
      const expectedBuf = Buffer.from(adminAuth.passwordHash, 'hex');
      const candidateBuf = Buffer.from(candidateHash, 'hex');
      if (
        expectedBuf.length !== candidateBuf.length ||
        !crypto.timingSafeEqual(expectedBuf, candidateBuf)
      ) {
        recordFailedAuthAttempt(ip);
        res.status(401).json({ error: 'Incorrect password. Please try again.' });
        return;
      }
    }

    clearFailedAuthAttempts(ip);
    const token = issueNewAdminSessionToken();
    res.json({
      ok: true,
      token,
      leads: getSortedLeads(),
      deletedIds: Array.from(deletedLeadIds),
      rtdb: getRtdbStatusPayload(),
    });
  });

  app.post('/api/admin/logout', (req: Request, res: Response) => {
    const rawToken = extractBearerToken(req);
    if (rawToken) {
      const tokenHash = hashSessionToken(rawToken);
      adminSessions.delete(tokenHash);
      persistAdminSessionsLocal();
      void removeAdminSessionFromRtdb(tokenHash);
    }
    res.json({ ok: true });
  });

  // --------------------------------------------------------------------------
  // Leads Capture, Real-Time SSE, Admin Edit & Delete
  // --------------------------------------------------------------------------
  app.get('/api/leads', requireAdminAuth, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      leads: getSortedLeads(),
      deletedIds: Array.from(deletedLeadIds),
      rtdb: getRtdbStatusPayload(),
    });
  });

  app.get('/api/leads/stream', requireAdminAuth, (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    sseClients.add(res);
    res.write(buildSnapshotFrame());

    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  app.post('/api/rtdb/sync-all', requireAdminAuth, async (_req: Request, res: Response) => {
    if (!rtdbInstance) {
      res.status(503).json({
        error: 'Firebase Realtime Database is not configured.',
        rtdb: getRtdbStatusPayload(),
      });
      return;
    }

    try {
      const allLeads = getSortedLeads();
      for (const delId of deletedLeadIds) {
        const safeKey = sanitizeRtdbKey(delId);
        if (safeKey) {
          await Promise.all([
            remove(ref(rtdbInstance, `leads/${safeKey}`)),
            set(ref(rtdbInstance, `deletedLeads/${safeKey}`), {
              leadId: delId,
              deletedAt: new Date().toISOString(),
            }),
          ]);
        }
      }
      for (const lead of allLeads) {
        const safeKey = sanitizeRtdbKey(lead.leadId);
        if (safeKey) {
          await set(ref(rtdbInstance, `leads/${safeKey}`), normalizeLeadRecord(lead));
        }
      }
      rtdbState.writeVerified = true;
      rtdbState.lastError = null;
      rtdbState.lastSyncedAt = new Date().toISOString();
      rtdbState.remoteLeadCount = allLeads.length;
      broadcastSseSnapshot();

      res.json({
        ok: true,
        count: allLeads.length,
        rtdb: getRtdbStatusPayload(),
      });
    } catch (err) {
      rtdbState.lastError = (err as Error)?.message || 'RTDB sync failed.';
      res.status(500).json({
        error:
          'Firebase Realtime Database write denied. Paste the recommended RTDB rules in Firebase Console and click Publish.',
        rtdb: getRtdbStatusPayload(),
      });
    }
  });

  // Public Customer Inquiry Live Auto-Save & Submit Endpoint
  app.post('/api/leads/upsert', (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
      string,
      unknown
    >;
    const rawLeadId = sanitizeField(body.leadId, LEAD_FIELD_LIMITS.leadId) || generateLeadId();

    if (deletedLeadIds.has(rawLeadId)) {
      res.status(200).json({ ignoredDeleted: true });
      return;
    }

    const sanitized = sanitizeLeadInput(body);
    const phoneDigits = sanitized.phone.replace(/\D/g, '');
    const cleanedPhone = phoneDigits === '91' ? '' : sanitized.phone;
    const status: LeadStatus = body.status === 'confirmed' ? 'confirmed' : 'partial';

    if (status === 'confirmed') {
      const effectiveDigits = cleanedPhone.replace(/\D/g, '');
      const localDigits =
        effectiveDigits.length === 12 && effectiveDigits.startsWith('91')
          ? effectiveDigits.slice(2)
          : effectiveDigits.length === 11 && effectiveDigits.startsWith('0')
            ? effectiveDigits.slice(1)
            : effectiveDigits;
      if (!localDigits || localDigits.length < 10 || effectiveDigits.length > 15) {
        res.status(400).json({ error: 'Valid 10-digit Phone / WhatsApp number is required.' });
        return;
      }
    }

    if (status === 'partial' && !hasAnyLeadContent({ ...sanitized, phone: cleanedPhone })) {
      res.status(200).json({ skippedEmptyDraft: true });
      return;
    }

    const nowIso = new Date().toISOString();
    const existing = leadsStore.get(rawLeadId);
    const record: LeadRecord = {
      leadId: rawLeadId,
      name: sanitized.name,
      designation: sanitized.designation,
      phone: cleanedPhone,
      companyName: sanitized.companyName,
      city: sanitized.city,
      emailAddress: sanitized.emailAddress,
      outletsCount: sanitized.outletsCount,
      productInterest: sanitized.productInterest,
      status: existing?.status === 'confirmed' ? 'confirmed' : status,
      whatsappSent: existing?.whatsappSent || false,
      sheetSynced: false,
      sheetRowNumber: existing?.sheetRowNumber ?? null,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    leadsStore.set(record.leadId, record);
    persistLeadsLocal();
    void pushLeadToRtdb(record);
    queueLeadForAppsScriptSync(record, record.status === 'confirmed');
    broadcastSseSnapshot();

    let whatsappQueuedInBackground = false;
    if (
      record.status === 'confirmed' &&
      !record.whatsappSent &&
      waSettings.autoReplyEnabled
    ) {
      whatsappQueuedInBackground = dispatchLeadAutoReplyInBackground(record);
    }

    res.json({
      lead: record,
      whatsappQueuedInBackground,
      whatsappConnected: waState.status === 'connected' || isRemoteCloudWorkerActive(),
    });
  });

  // Admin Edit Lead (syncs immediately to RTDB + Google Sheet in IST)
  app.patch('/api/leads/:leadId', requireAdminAuth, (req: Request, res: Response) => {
    const leadId = sanitizeField(String(req.params.leadId || ''), LEAD_FIELD_LIMITS.leadId);
    if (!leadId || deletedLeadIds.has(leadId)) {
      res.status(404).json({ error: 'Lead not found.' });
      return;
    }

    const existing = leadsStore.get(leadId);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
      string,
      unknown
    >;
    const sanitized = sanitizeLeadInput(body);
    const phoneDigits = sanitized.phone.replace(/\D/g, '');
    const cleanedPhone = phoneDigits === '91' ? '' : sanitized.phone;
    const status: LeadStatus =
      body.status === 'confirmed'
        ? 'confirmed'
        : body.status === 'partial'
          ? 'partial'
          : existing?.status || 'partial';

    const nowIso = new Date().toISOString();
    const editedLead: LeadRecord = {
      leadId,
      name: sanitized.name,
      designation: sanitized.designation,
      phone: cleanedPhone,
      companyName: sanitized.companyName,
      city: sanitized.city,
      emailAddress: sanitized.emailAddress,
      outletsCount: sanitized.outletsCount,
      productInterest: sanitized.productInterest,
      status,
      whatsappSent: existing?.whatsappSent || false,
      sheetSynced: false,
      sheetRowNumber: existing?.sheetRowNumber ?? null,
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    leadsStore.set(leadId, editedLead);
    persistLeadsLocal();
    void pushLeadToRtdb(editedLead);
    queueLeadForAppsScriptSync(editedLead, true);
    broadcastSseSnapshot();

    res.json({ ok: true, lead: editedLead });
  });

  // Admin Delete Lead (tombstones locally + RTDB + deletes row from Google Sheet)
  app.delete('/api/leads/:leadId', requireAdminAuth, (req: Request, res: Response) => {
    const leadId = sanitizeField(String(req.params.leadId || ''), LEAD_FIELD_LIMITS.leadId);
    if (!leadId) {
      res.status(400).json({ error: 'Invalid lead ID.' });
      return;
    }

    const timer = perLeadSheetTimers.get(leadId);
    if (timer) {
      clearTimeout(timer);
      perLeadSheetTimers.delete(leadId);
    }

    deletedLeadIds.add(leadId);
    leadsStore.delete(leadId);
    persistDeletedLeadsLocal();
    persistLeadsLocal();

    void pushDeletedLeadToRtdb(leadId);
    void deleteLeadFromAppsScriptWebhook(leadId);
    broadcastSseSnapshot();

    res.json({
      ok: true,
      leadId,
      deletedIds: Array.from(deletedLeadIds),
    });
  });

  app.post('/api/leads/mark-synced', requireAdminAuth, (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.leadIds) ? req.body.leadIds : [];
    let updatedCount = 0;
    for (const rawId of ids) {
      if (typeof rawId === 'string') {
        const cur = leadsStore.get(rawId);
        if (cur && !cur.sheetSynced) {
          const next: LeadRecord = { ...cur, sheetSynced: true };
          leadsStore.set(rawId, next);
          void pushLeadToRtdb(next);
          updatedCount += 1;
        }
      }
    }
    if (updatedCount > 0) {
      persistLeadsLocal();
      broadcastSseSnapshot();
    }
    res.json({ ok: true, updatedCount });
  });

  app.post(
    '/api/leads/:leadId/resend-whatsapp',
    requireAdminAuth,
    async (req: Request, res: Response) => {
      const leadId = sanitizeField(String(req.params.leadId || ''), LEAD_FIELD_LIMITS.leadId);
      const lead = leadsStore.get(leadId);
      if (!lead || deletedLeadIds.has(leadId)) {
        res.status(404).json({ error: 'Lead not found.' });
        return;
      }

      const digits = normalizePhoneForWhatsApp(lead.phone);
      if (!digits || digits === '91' || digits.length < 8) {
        res.status(400).json({ error: 'Lead does not have a valid WhatsApp phone number.' });
        return;
      }

      const messageText = buildWhatsAppConfirmationMessage(lead, waSettings.messageTemplate);
      const secondMessageText = buildWhatsAppConfirmationMessage(
        lead,
        waSettings.secondMessageTemplate
      );

      if (waState.status === 'connected' && waSocket) {
        void (async () => {
          try {
            await sendPrestairWhatsAppReplyWithSingleImage(lead.phone, messageText, {
              sendSecond: waSettings.secondMessageEnabled,
              secondCaptionText: secondMessageText,
            });
            const cur = leadsStore.get(leadId);
            if (cur && !deletedLeadIds.has(leadId)) {
              const next: LeadRecord = {
                ...cur,
                whatsappSent: true,
                updatedAt: new Date().toISOString(),
              };
              leadsStore.set(leadId, next);
              persistLeadsLocal();
              await pushLeadToRtdb(next);
              queueLeadForAppsScriptSync(next, true);
              broadcastSseSnapshot();
            }
          } catch (err) {
            waState.lastError = (err as Error)?.message || 'Failed sending WhatsApp reply.';
          }
        })();
        res.json({ ok: true, relayedViaCloud: false });
        return;
      }

      if (isRemoteCloudWorkerActive()) {
        const queued = await enqueueCloudWaDispatchJob({
          phone: lead.phone,
          text: messageText,
          sendSecond: waSettings.secondMessageEnabled,
          secondText: secondMessageText,
          leadId: lead.leadId,
        });
        if (queued) {
          res.json({ ok: true, relayedViaCloud: true });
          return;
        }
      }

      res.status(409).json({
        error: 'WhatsApp is not linked yet. Open the WhatsApp tab in Admin to scan QR once.',
      });
    }
  );

  // --------------------------------------------------------------------------
  // Google Sheet Apps Script 24x7 Sync Endpoints
  // --------------------------------------------------------------------------
  app.get('/api/sheets-script/status', requireAdminAuth, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(getSheetScriptStatusPayload());
  });

  app.post(
    '/api/sheets-script/config',
    requireAdminAuth,
    async (req: Request, res: Response) => {
      const rawUrl = typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl.trim() : '';
      const check = validateAppsScriptUrl(rawUrl);
      if (!check.valid) {
        res.status(400).json({ error: check.error });
        return;
      }

      sheetSyncSettings.webhookUrl = check.normalizedUrl;
      sheetSyncSettings.enabled = req.body?.enabled !== false;
      sheetSyncSettings.lastError = null;
      sheetSyncSettings.updatedAt = Date.now();
      persistSheetSyncSettingsLocal();
      await pushSheetSyncMetaToRtdb();

      try {
        const synced = await syncAllLeadsToAppsScript();
        await pushSheetSyncMetaToRtdb();
        res.json({
          ok: true,
          synced,
          status: getSheetScriptStatusPayload(),
        });
      } catch (err) {
        sheetSyncSettings.lastError =
          (err as Error)?.message || 'Could not verify Apps Script deployment.';
        res.status(400).json({
          error: sheetSyncSettings.lastError,
          status: getSheetScriptStatusPayload(),
        });
      }
    }
  );

  app.post(
    '/api/sheets-script/sync-all',
    requireAdminAuth,
    async (_req: Request, res: Response) => {
      try {
        const synced = await syncAllLeadsToAppsScript();
        await pushSheetSyncMetaToRtdb();
        res.json({
          ok: true,
          synced,
          status: getSheetScriptStatusPayload(),
        });
      } catch (err) {
        res.status(400).json({
          error: (err as Error)?.message || 'Failed syncing leads to Google Sheet.',
          status: getSheetScriptStatusPayload(),
        });
      }
    }
  );

  app.post(
    '/api/sheets-script/disconnect',
    requireAdminAuth,
    async (_req: Request, res: Response) => {
      if (getEnvAppsScriptWebhook()) {
        res.status(400).json({
          error: 'Webhook URL is set via GOOGLE_APPS_SCRIPT_WEBHOOK_URL environment variable.',
        });
        return;
      }
      sheetSyncSettings.enabled = false;
      sheetSyncSettings.webhookUrl = '';
      sheetSyncSettings.spreadsheetName = '';
      sheetSyncSettings.spreadsheetUrl = '';
      sheetSyncSettings.lastError = null;
      sheetSyncSettings.updatedAt = Date.now();
      persistSheetSyncSettingsLocal();
      await pushSheetSyncMetaToRtdb();
      res.json({ ok: true, status: getSheetScriptStatusPayload() });
    }
  );

  // --------------------------------------------------------------------------
  // WhatsApp 24x7 Automation Endpoints
  // --------------------------------------------------------------------------
  app.get('/api/whatsapp/status', requireAdminAuth, (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const cloudActive = isRemoteCloudWorkerActive();
    res.json({
      status: waState.status,
      qrDataUrl: waState.qrDataUrl,
      pairingCode: waState.pairingCode,
      connectedNumber: waState.connectedNumber,
      cloudWorkerConnected: cloudActive,
      cloudConnectedNumber: cloudActive ? remoteWaRuntime?.connectedNumber ?? null : null,
      lastError: waState.lastError,
      settings: {
        autoReplyEnabled: waSettings.autoReplyEnabled,
        messageTemplate: waSettings.messageTemplate,
        secondMessageEnabled: waSettings.secondMessageEnabled,
        secondMessageTemplate: waSettings.secondMessageTemplate,
        adminNotifyPhone: waSettings.adminNotifyPhone,
      },
      replyImage: getReplyImageStatusPayload(waReplyImage),
      replyImage2: getReplyImageStatusPayload(waReplyImage2),
    });
  });

  app.post('/api/whatsapp/connect', requireAdminAuth, async (req: Request, res: Response) => {
    const pairingPhone =
      typeof req.body?.pairingPhone === 'string' ? req.body.pairingPhone.trim() : '';
    void startWhatsAppConnection(pairingPhone);
    res.json({ ok: true });
  });

  app.post('/api/whatsapp/disconnect', requireAdminAuth, async (_req: Request, res: Response) => {
    explicitUnlinkRequested = true;
    if (waReconnectTimer) {
      clearTimeout(waReconnectTimer);
      waReconnectTimer = null;
    }
    if (waSocket) {
      try {
        await waSocket.logout();
      } catch {
        // ignore logout error if socket already closed
      }
      cleanupActiveSocketOnly();
    }
    try {
      fs.rmSync(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
    } catch {
      // ignore
    }
    waState.status = 'disconnected';
    waState.qrDataUrl = null;
    waState.pairingCode = null;
    waState.connectedNumber = null;
    waState.lastError = null;
    if (rtdbInstance && remoteWaRuntime?.instanceId === SERVER_INSTANCE_ID) {
      void remove(ref(rtdbInstance, 'meta/waRuntimeStatus')).catch(() => {});
    }
    res.json({ ok: true });
  });

  app.post('/api/whatsapp/settings', requireAdminAuth, async (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
      string,
      unknown
    >;
    waSettings = {
      autoReplyEnabled:
        typeof body.autoReplyEnabled === 'boolean'
          ? body.autoReplyEnabled
          : waSettings.autoReplyEnabled,
      messageTemplate:
        typeof body.messageTemplate === 'string' && body.messageTemplate.trim()
          ? body.messageTemplate.slice(0, 4000)
          : DEFAULT_PRESTAIR_WHATSAPP_REPLY,
      secondMessageEnabled:
        typeof body.secondMessageEnabled === 'boolean'
          ? body.secondMessageEnabled
          : waSettings.secondMessageEnabled,
      secondMessageTemplate:
        typeof body.secondMessageTemplate === 'string' && body.secondMessageTemplate.trim()
          ? body.secondMessageTemplate.slice(0, 4000)
          : DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY,
      adminNotifyPhone:
        typeof body.adminNotifyPhone === 'string'
          ? sanitizeField(body.adminNotifyPhone, 32)
          : '',
      updatedAt: Date.now(),
    };
    persistWaSettingsLocal();
    await pushWaSettingsToRtdb();
    res.json({ ok: true, settings: waSettings });
  });

  app.post(
    '/api/whatsapp/reply-image',
    requireAdminAuth,
    async (req: Request, res: Response) => {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
        string,
        unknown
      >;
      const slot = body.slot === 2 ? 2 : 1;
      const rawMode = body.mode;
      if (rawMode !== 'default' && rawMode !== 'custom' && rawMode !== 'none') {
        res.status(400).json({ error: 'Invalid image mode.' });
        return;
      }

      let nextState: WhatsAppReplyImageState;
      if (rawMode === 'custom') {
        const rawDataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
        const validated = parseAndValidateReplyImageDataUrl(rawDataUrl);
        if (!validated.valid) {
          res.status(400).json({ error: validated.error });
          return;
        }
        nextState = {
          mode: 'custom',
          mimeType: validated.mimeType,
          base64Data: validated.base64Data,
          updatedAt: Date.now(),
        };
      } else {
        nextState = {
          mode: rawMode,
          mimeType: '',
          base64Data: '',
          updatedAt: Date.now(),
        };
      }

      if (slot === 2) {
        waReplyImage2 = nextState;
        persistWaReplyImage2Local();
        await pushWaReplyImage2ToRtdb();
      } else {
        waReplyImage = nextState;
        persistWaReplyImageLocal();
        await pushWaReplyImageToRtdb();
      }

      res.json({
        ok: true,
        slot,
        replyImage: getReplyImageStatusPayload(waReplyImage),
        replyImage2: getReplyImageStatusPayload(waReplyImage2),
      });
    }
  );

  app.post(
    '/api/whatsapp/test-message',
    requireAdminAuth,
    async (req: Request, res: Response) => {
      const phone = typeof req.body?.phone === 'string' ? req.body.phone.trim() : '';
      const text =
        typeof req.body?.text === 'string' && req.body.text.trim()
          ? req.body.text.slice(0, 4000)
          : waSettings.messageTemplate;
      const sendSecond =
        typeof req.body?.sendSecond === 'boolean'
          ? req.body.sendSecond
          : waSettings.secondMessageEnabled;
      const secondText =
        typeof req.body?.secondText === 'string' && req.body.secondText.trim()
          ? req.body.secondText.slice(0, 4000)
          : waSettings.secondMessageTemplate;

      const digits = normalizePhoneForWhatsApp(phone);
      if (!digits || digits.length < 8) {
        res.status(400).json({ error: 'Please enter a valid WhatsApp phone number.' });
        return;
      }

      if (waState.status === 'connected' && waSocket) {
        try {
          await sendPrestairWhatsAppReplyWithSingleImage(phone, text, {
            sendSecond,
            secondCaptionText: secondText,
          });
          res.json({ ok: true, relayedViaCloud: false });
        } catch (err) {
          res.status(500).json({
            error: (err as Error)?.message || 'Failed delivering WhatsApp test messages.',
          });
        }
        return;
      }

      if (isRemoteCloudWorkerActive()) {
        const queued = await enqueueCloudWaDispatchJob({
          phone,
          text,
          sendSecond,
          secondText,
        });
        if (queued) {
          res.json({ ok: true, relayedViaCloud: true });
          return;
        }
      }

      res.status(409).json({
        error: 'WhatsApp device is not linked yet. Scan QR code above first.',
      });
    }
  );

  // --------------------------------------------------------------------------
  // Customer Thank-You Showcase Image Endpoints (Public Display + Admin Control)
  // --------------------------------------------------------------------------
  app.get('/api/public/showcase', async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    await ensureWaMetaHydratedFromRtdb();
    const status = getShowcaseStatusPayload();
    res.json({
      source: status.source,
      imageSrc: status.activeImageSrc,
      updatedAt: status.updatedAt,
    });
  });

  app.get('/api/showcase/status', requireAdminAuth, async (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    await ensureWaMetaHydratedFromRtdb();
    res.json(getShowcaseStatusPayload());
  });

  app.post('/api/showcase/settings', requireAdminAuth, async (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
      string,
      unknown
    >;
    const rawSource = body.source;
    if (!isValidShowcaseSource(rawSource)) {
      res.status(400).json({ error: 'Invalid showcase image option.' });
      return;
    }

    let nextMime = showcaseSettings.mimeType;
    let nextBase64 = showcaseSettings.base64Data;

    if (typeof body.dataUrl === 'string' && body.dataUrl.trim()) {
      const validated = parseAndValidateReplyImageDataUrl(body.dataUrl);
      if (!validated.valid) {
        res.status(400).json({ error: validated.error });
        return;
      }
      nextMime = validated.mimeType;
      nextBase64 = validated.base64Data;
    } else if (rawSource === 'custom' && !nextBase64) {
      res.status(400).json({
        error: 'Please upload a custom image first to use Custom Showcase Image.',
      });
      return;
    }

    showcaseSettings = {
      source: rawSource,
      mimeType: nextMime,
      base64Data: nextBase64,
      updatedAt: Date.now(),
    };
    persistShowcaseSettingsLocal();
    await pushShowcaseSettingsToRtdb();

    res.json({
      ok: true,
      ...getShowcaseStatusPayload(),
    });
  });

  // --------------------------------------------------------------------------
  // Frontend Serving: Production Static Assets (Railway / Cloud Run) vs Vite Dev
  // --------------------------------------------------------------------------
  if (isProduction) {
    const distDir = path.resolve(process.cwd(), 'dist');
    const publicDir = path.resolve(process.cwd(), 'public');
    app.use(express.static(distDir, { index: false }));
    app.use(express.static(publicDir, { index: false }));

    // Serve /src/assets/images/* cleanly in production so static path references never 404
    app.use(
      '/src/assets/images',
      express.static(path.resolve(process.cwd(), 'src/assets/images'))
    );

    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) {
        next();
        return;
      }
      const indexHtml = path.join(distDir, 'index.html');
      if (fs.existsSync(indexHtml)) {
        res.sendFile(indexHtml);
      } else {
        res.status(503).send('Application build not found. Run npm run build first.');
      }
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[Prestier System LLP] Server listening on http://0.0.0.0:${PORT} (${
        isProduction ? 'production' : 'development'
      })`
    );
  });

  const handleGracefulShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const wasConnectedHere = waState.status === 'connected';
    backupWhatsAppCredsSafe();
    cleanupActiveSocketOnly();
    void (async () => {
      if (rtdbInstance && wasConnectedHere) {
        await remove(ref(rtdbInstance, 'meta/waRuntimeStatus')).catch(() => {});
      }
      httpServer.close(() => {
        process.exit(0);
      });
    })();
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGTERM', handleGracefulShutdown);
  process.on('SIGINT', handleGracefulShutdown);
}

void startServer();

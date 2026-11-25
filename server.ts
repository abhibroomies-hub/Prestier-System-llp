import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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
  DEFAULT_PRESTAIR_THIRD_WHATSAPP_REPLY,
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
const WA_REPLY_VIDEO_3_FILE = path.join(DATA_DIR, 'whatsapp-reply-video-3.json');
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

// 4. WhatsApp Automation Settings (Up to 3 Separate Messages: Image 1 + Image 2 + Video 3)
interface WhatsAppSettings {
  autoReplyEnabled: boolean;
  firstMessageEnabled: boolean;
  messageTemplate: string;
  secondMessageEnabled: boolean;
  secondMessageTemplate: string;
  thirdMessageEnabled: boolean;
  thirdMessageTemplate: string;
  adminNotifyPhone: string;
  updatedAt: number;
}

let waSettings: WhatsAppSettings = (() => {
  const raw = readJsonFileSafe<Partial<WhatsAppSettings>>(WA_SETTINGS_FILE, {});
  return {
    autoReplyEnabled:
      typeof raw.autoReplyEnabled === 'boolean' ? raw.autoReplyEnabled : true,
    firstMessageEnabled:
      typeof raw.firstMessageEnabled === 'boolean' ? raw.firstMessageEnabled : true,
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
    thirdMessageEnabled:
      typeof raw.thirdMessageEnabled === 'boolean' ? raw.thirdMessageEnabled : true,
    thirdMessageTemplate:
      typeof raw.thirdMessageTemplate === 'string' && raw.thirdMessageTemplate.trim()
        ? raw.thirdMessageTemplate.slice(0, 4000)
        : DEFAULT_PRESTAIR_THIRD_WHATSAPP_REPLY,
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

// 4a-video. Message #3 Attached Video State (MP4 / WebM / MOV up to 15 MB, chunked RTDB sync)
type WaReplyVideoMode = 'custom' | 'none';

interface WhatsAppReplyVideoState {
  mode: WaReplyVideoMode;
  mimeType: string;
  fileName: string;
  byteLength: number;
  base64Data: string;
  updatedAt: number;
}

interface WhatsAppReplyVideoRtdbMeta {
  mode: WaReplyVideoMode;
  mimeType: string;
  fileName: string;
  byteLength: number;
  chunkCount: number;
  updatedAt: number;
}

const MAX_REPLY_VIDEO_BYTES = 15 * 1024 * 1024; // 15 MB
const VIDEO_RTDB_CHUNK_CHARS = 1_000_000; // ~1 MB per RTDB chunk (well below 10 MB string limit)

function sanitizeVideoFileName(rawName: unknown): string {
  if (typeof rawName !== 'string') return 'prestair-showcase.mp4';
  const cleaned = sanitizeField(rawName, 120).replace(/[/\\:*?"<>|]/g, '_').trim();
  return cleaned || 'prestair-showcase.mp4';
}

function validateVideoBinaryMagic(mimeType: string, buf: Buffer): boolean {
  if (buf.length < 64 || buf.length > MAX_REPLY_VIDEO_BYTES) return false;
  if (mimeType === 'video/mp4' || mimeType === 'video/quicktime') {
    const boxType = buf.subarray(4, 8).toString('ascii');
    return (
      boxType === 'ftyp' ||
      boxType === 'moov' ||
      boxType === 'mdat' ||
      boxType === 'wide' ||
      boxType === 'free' ||
      boxType === 'skip' ||
      boxType === 'styp'
    );
  }
  if (mimeType === 'video/webm') {
    return (
      buf[0] === 0x1a &&
      buf[1] === 0x45 &&
      buf[2] === 0xdf &&
      buf[3] === 0xa3
    );
  }
  return false;
}

function parseAndValidateReplyVideoDataUrl(
  rawDataUrl: string
):
  | { valid: true; mimeType: string; base64Data: string; byteLength: number }
  | { valid: false; error: string } {
  const trimmed = rawDataUrl.trim();
  const match = trimmed.match(
    /^data:(video\/mp4|video\/webm|video\/quicktime);base64,([A-Za-z0-9+/=\s]+)$/
  );
  if (!match) {
    return {
      valid: false,
      error: 'Only MP4, WebM, or MOV video files are supported.',
    };
  }
  const mimeType = match[1];
  const cleanBase64 = match[2].replace(/\s+/g, '');
  const buf = Buffer.from(cleanBase64, 'base64');
  if (buf.length > MAX_REPLY_VIDEO_BYTES) {
    return {
      valid: false,
      error: 'Video size must be under 15 MB for reliable WhatsApp delivery.',
    };
  }
  if (!validateVideoBinaryMagic(mimeType, buf)) {
    return {
      valid: false,
      error: 'Invalid or corrupted video file. Please upload a standard MP4, WebM, or MOV video.',
    };
  }
  return {
    valid: true,
    mimeType,
    base64Data: cleanBase64,
    byteLength: buf.length,
  };
}

function loadReplyVideoStateFromDisk(filePath: string): WhatsAppReplyVideoState {
  const raw = readJsonFileSafe<Partial<WhatsAppReplyVideoState>>(filePath, {});
  if (
    raw.mode === 'custom' &&
    typeof raw.mimeType === 'string' &&
    typeof raw.base64Data === 'string' &&
    raw.base64Data
  ) {
    const buf = Buffer.from(raw.base64Data, 'base64');
    if (validateVideoBinaryMagic(raw.mimeType, buf)) {
      return {
        mode: 'custom',
        mimeType: raw.mimeType,
        fileName: sanitizeVideoFileName(raw.fileName),
        byteLength: buf.length,
        base64Data: raw.base64Data,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 1,
      };
    }
  }
  return {
    mode: 'none',
    mimeType: '',
    fileName: '',
    byteLength: 0,
    base64Data: '',
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

let waReplyVideo3: WhatsAppReplyVideoState = loadReplyVideoStateFromDisk(WA_REPLY_VIDEO_3_FILE);

function persistWaReplyVideo3Local(): void {
  writeJsonFileSafe(WA_REPLY_VIDEO_3_FILE, waReplyVideo3);
}

function getReplyVideoStatusPayload(vidState: WhatsAppReplyVideoState = waReplyVideo3) {
  const hasVideo =
    vidState.mode === 'custom' && Boolean(vidState.mimeType && vidState.base64Data);
  return {
    mode: hasVideo ? ('custom' as const) : ('none' as const),
    hasVideo,
    mimeType: hasVideo ? vidState.mimeType : null,
    fileName: hasVideo ? vidState.fileName : null,
    byteLength: hasVideo ? vidState.byteLength : 0,
    updatedAt: vidState.updatedAt,
  };
}

// 4a-universal. Unified 3-Slot Universal Attachment Engine (Any File Format: PDF, Image, Video, Doc up to 25 MB)
type WaSlotNumber = 1 | 2 | 3;
type WaSlotMode = 'default' | 'custom' | 'none';
type WaSlotCategory = 'image' | 'video' | 'pdf' | 'document';

interface WaSlotMediaMeta {
  mode: WaSlotMode;
  mimeType: string;
  fileName: string;
  byteLength: number;
  category: WaSlotCategory;
  updatedAt: number;
}

interface WaSlotMediaRtdbMeta extends WaSlotMediaMeta {
  chunkCount: number;
}

const MAX_SLOT_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB universal limit
const SLOT_RTDB_CHUNK_CHARS = 1_000_000; // ~1 MB base64 per chunk

const BLOCKED_DANGEROUS_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.bat',
  '.cmd',
  '.com',
  '.scr',
  '.msi',
  '.pif',
  '.sh',
  '.bash',
  '.ps1',
  '.vbs',
  '.vbe',
  '.wsf',
  '.hta',
  '.jar',
  '.js',
  '.mjs',
  '.cjs',
  '.html',
  '.htm',
  '.xhtml',
  '.svg',
  '.svgz',
]);

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.3gp': 'video/3gpp',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.rtf': 'application/rtf',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.cdr': 'application/cdr',
  '.dwg': 'application/acad',
  '.dxf': 'application/dxf',
  '.psd': 'image/vnd.adobe.photoshop',
  '.ai': 'application/postscript',
  '.eps': 'application/postscript',
};

function parseValidSlotNumber(raw: unknown): WaSlotNumber | null {
  const num = Number(raw);
  if (num === 1 || num === 2 || num === 3) return num;
  return null;
}

function getSlotPaths(slot: WaSlotNumber): { metaPath: string; binPath: string } {
  const metaPath = path.resolve(DATA_DIR, `wa-slot-${slot}-meta.json`);
  const binPath = path.resolve(DATA_DIR, `wa-slot-${slot}.bin`);
  const safePrefix = DATA_DIR.endsWith(path.sep) ? DATA_DIR : DATA_DIR + path.sep;
  if (!metaPath.startsWith(safePrefix) || !binPath.startsWith(safePrefix)) {
    throw new Error('Invalid slot storage path.');
  }
  return { metaPath, binPath };
}

function sanitizeAttachmentFileName(rawName: unknown, fallbackExt = ''): string {
  let decoded = '';
  if (typeof rawName === 'string' && rawName.trim()) {
    try {
      decoded = decodeURIComponent(rawName.trim());
    } catch {
      decoded = rawName.trim();
    }
  }
  const baseOnly = path.basename(decoded).replace(/[\u0000-\u001f/\\:*?"<>|]/g, '_').trim();
  const collapsed = baseOnly.replace(/^\.+/, '').slice(0, 120).trim();
  if (collapsed) return collapsed;
  return `prestair-attachment${fallbackExt || '.bin'}`;
}

function classifySlotCategory(mimeType: string, buf: Buffer): WaSlotCategory {
  if (mimeType === 'application/pdf') return 'pdf';
  if (
    (mimeType === 'image/jpeg' && buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) ||
    (mimeType === 'image/png' &&
      buf.length >= 4 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47) ||
    (mimeType === 'image/webp' &&
      buf.length >= 12 &&
      buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buf.subarray(8, 12).toString('ascii') === 'WEBP') ||
    (mimeType === 'image/gif' && buf.length >= 6 && buf.subarray(0, 4).toString('ascii') === 'GIF8')
  ) {
    return 'image';
  }
  if (
    mimeType === 'video/mp4' ||
    mimeType === 'video/quicktime' ||
    mimeType === 'video/webm' ||
    mimeType === 'video/3gpp'
  ) {
    return 'video';
  }
  return 'document';
}

function detectAndValidateAttachment(
  buf: Buffer,
  rawHeaderMime: unknown,
  rawFileName: unknown
):
  | {
      valid: true;
      mimeType: string;
      fileName: string;
      category: WaSlotCategory;
      byteLength: number;
    }
  | { valid: false; error: string } {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { valid: false, error: 'Selected file is empty. Please choose a valid file.' };
  }
  if (buf.length > MAX_SLOT_ATTACHMENT_BYTES) {
    return {
      valid: false,
      error: 'File size exceeds 25 MB. Please upload a file under 25 MB for WhatsApp delivery.',
    };
  }

  const cleanFileName = sanitizeAttachmentFileName(rawFileName);
  const ext = path.extname(cleanFileName).toLowerCase();
  if (ext && BLOCKED_DANGEROUS_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      error: `Executable or script files (${ext}) are blocked for security. Please upload PDF, Image, Video, Office, or ZIP files.`,
    };
  }

  // Block Windows PE executables ('MZ') and active HTML/Script/SVG payloads regardless of extension
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
    return { valid: false, error: 'Executable binary files are not allowed.' };
  }
  const headAscii = buf.subarray(0, Math.min(buf.length, 256)).toString('utf8').trimStart().toLowerCase();
  if (
    headAscii.startsWith('<!doctype html') ||
    headAscii.startsWith('<html') ||
    headAscii.startsWith('<script') ||
    headAscii.startsWith('<svg')
  ) {
    return {
      valid: false,
      error: 'HTML, SVG, and script files are blocked for security. Please upload a PDF, PNG/JPG image, video, or document.',
    };
  }

  // Detect accurate MIME type from binary magic bytes first, then extension, then client header
  let detectedMime = '';
  if (buf.length >= 5 && buf.subarray(0, 5).toString('ascii') === '%PDF-') {
    detectedMime = 'application/pdf';
  } else if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    detectedMime = 'image/jpeg';
  } else if (
    buf.length >= 4 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    detectedMime = 'image/png';
  } else if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    detectedMime = 'image/webp';
  } else if (buf.length >= 6 && buf.subarray(0, 4).toString('ascii') === 'GIF8') {
    detectedMime = 'image/gif';
  } else if (buf.length >= 12 && buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii').toLowerCase();
    if (brand.startsWith('hei') || brand.startsWith('mif1') || brand.startsWith('msf1')) {
      detectedMime = 'image/heic';
    } else if (brand.startsWith('avif')) {
      detectedMime = 'image/avif';
    } else if (brand === 'qt  ') {
      detectedMime = 'video/quicktime';
    } else if (brand.startsWith('3gp')) {
      detectedMime = 'video/3gpp';
    } else if (brand.startsWith('m4a')) {
      detectedMime = 'audio/mp4';
    } else {
      detectedMime = 'video/mp4';
    }
  } else if (
    buf.length >= 4 &&
    buf[0] === 0x1a &&
    buf[1] === 0x45 &&
    buf[2] === 0xdf &&
    buf[3] === 0xa3
  ) {
    detectedMime = ext === '.mkv' ? 'video/x-matroska' : 'video/webm';
  }

  if (!detectedMime && ext && EXTENSION_MIME_MAP[ext]) {
    detectedMime = EXTENSION_MIME_MAP[ext];
  }

  if (!detectedMime && typeof rawHeaderMime === 'string') {
    const candidate = rawHeaderMime.split(';')[0].trim().toLowerCase();
    if (
      /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(candidate) &&
      candidate !== 'text/html' &&
      candidate !== 'application/xhtml+xml' &&
      candidate !== 'image/svg+xml' &&
      candidate !== 'text/javascript' &&
      candidate !== 'application/javascript'
    ) {
      detectedMime = candidate;
    }
  }

  if (!detectedMime) {
    detectedMime = 'application/octet-stream';
  }

  // Ensure filename has a sensible extension for WhatsApp document bubble display
  let finalFileName = cleanFileName;
  if (!ext) {
    const fallbackExt =
      detectedMime === 'application/pdf'
        ? '.pdf'
        : detectedMime === 'image/jpeg'
          ? '.jpg'
          : detectedMime === 'image/png'
            ? '.png'
            : detectedMime === 'image/webp'
              ? '.webp'
              : detectedMime === 'video/mp4'
                ? '.mp4'
                : detectedMime === 'video/quicktime'
                  ? '.mov'
                  : detectedMime === 'video/webm'
                    ? '.webm'
                    : '';
    finalFileName = sanitizeAttachmentFileName(`${cleanFileName}${fallbackExt}`, fallbackExt);
  }

  const category = classifySlotCategory(detectedMime, buf);
  return {
    valid: true,
    mimeType: detectedMime,
    fileName: finalFileName,
    category,
    byteLength: buf.length,
  };
}

function writeBinaryFileSafe(filePath: string, buf: Buffer): void {
  try {
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    console.warn(`[storage] Failed writing ${path.basename(filePath)}:`, (err as Error)?.message);
  }
}

function readSlotBinarySafe(slot: WaSlotNumber): Buffer | null {
  try {
    const { binPath } = getSlotPaths(slot);
    if (!fs.existsSync(binPath)) return null;
    const buf = fs.readFileSync(binPath);
    return buf.length > 0 && buf.length <= MAX_SLOT_ATTACHMENT_BYTES ? buf : null;
  } catch {
    return null;
  }
}

function removeSlotBinarySafe(slot: WaSlotNumber): void {
  try {
    const { binPath } = getSlotPaths(slot);
    if (fs.existsSync(binPath)) {
      fs.unlinkSync(binPath);
    }
  } catch {
    // ignore
  }
}

function persistWaSlotMetaLocal(slot: WaSlotNumber, meta: WaSlotMediaMeta): void {
  const { metaPath } = getSlotPaths(slot);
  writeJsonFileSafe(metaPath, meta);
}

function loadInitialWaSlotMedia(slot: WaSlotNumber): WaSlotMediaMeta {
  const { metaPath } = getSlotPaths(slot);
  const raw = readJsonFileSafe<Partial<WaSlotMediaMeta>>(metaPath, {});
  const defaultModeForSlot: WaSlotMode = slot === 3 ? 'none' : 'default';

  if (typeof raw.updatedAt === 'number' && raw.updatedAt > 0) {
    const mode: WaSlotMode =
      raw.mode === 'custom'
        ? 'custom'
        : raw.mode === 'none'
          ? 'none'
          : slot === 3
            ? 'none'
            : 'default';
    if (mode === 'custom') {
      const buf = readSlotBinarySafe(slot);
      if (buf && typeof raw.mimeType === 'string' && raw.mimeType) {
        const check = detectAndValidateAttachment(buf, raw.mimeType, raw.fileName);
        if (check.valid) {
          return {
            mode: 'custom',
            mimeType: check.mimeType,
            fileName: check.fileName,
            byteLength: check.byteLength,
            category: check.category,
            updatedAt: raw.updatedAt,
          };
        }
      }
    }
    return {
      mode: mode === 'custom' ? defaultModeForSlot : mode,
      mimeType: '',
      fileName: '',
      byteLength: 0,
      category: 'document',
      updatedAt: raw.updatedAt,
    };
  }

  // Seamless migration from existing legacy Image #1 / Image #2 / Video #3 files so zero user uploads are lost
  if (slot === 1 && waReplyImage.updatedAt > 0) {
    if (waReplyImage.mode === 'custom' && waReplyImage.base64Data) {
      const buf = Buffer.from(waReplyImage.base64Data, 'base64');
      const ext = waReplyImage.mimeType === 'image/png' ? '.png' : waReplyImage.mimeType === 'image/webp' ? '.webp' : '.jpg';
      const check = detectAndValidateAttachment(buf, waReplyImage.mimeType, `prestair-message-1${ext}`);
      if (check.valid) {
        writeBinaryFileSafe(getSlotPaths(1).binPath, buf);
        const migrated: WaSlotMediaMeta = {
          mode: 'custom',
          mimeType: check.mimeType,
          fileName: check.fileName,
          byteLength: check.byteLength,
          category: check.category,
          updatedAt: waReplyImage.updatedAt,
        };
        persistWaSlotMetaLocal(1, migrated);
        return migrated;
      }
    }
    const migratedMode: WaSlotMediaMeta = {
      mode: waReplyImage.mode === 'none' ? 'none' : 'default',
      mimeType: '',
      fileName: '',
      byteLength: 0,
      category: 'image',
      updatedAt: waReplyImage.updatedAt,
    };
    persistWaSlotMetaLocal(1, migratedMode);
    return migratedMode;
  }

  if (slot === 2 && waReplyImage2.updatedAt > 0) {
    if (waReplyImage2.mode === 'custom' && waReplyImage2.base64Data) {
      const buf = Buffer.from(waReplyImage2.base64Data, 'base64');
      const ext = waReplyImage2.mimeType === 'image/png' ? '.png' : waReplyImage2.mimeType === 'image/webp' ? '.webp' : '.jpg';
      const check = detectAndValidateAttachment(buf, waReplyImage2.mimeType, `prestair-message-2${ext}`);
      if (check.valid) {
        writeBinaryFileSafe(getSlotPaths(2).binPath, buf);
        const migrated: WaSlotMediaMeta = {
          mode: 'custom',
          mimeType: check.mimeType,
          fileName: check.fileName,
          byteLength: check.byteLength,
          category: check.category,
          updatedAt: waReplyImage2.updatedAt,
        };
        persistWaSlotMetaLocal(2, migrated);
        return migrated;
      }
    }
    const migratedMode: WaSlotMediaMeta = {
      mode: waReplyImage2.mode === 'none' ? 'none' : 'default',
      mimeType: '',
      fileName: '',
      byteLength: 0,
      category: 'image',
      updatedAt: waReplyImage2.updatedAt,
    };
    persistWaSlotMetaLocal(2, migratedMode);
    return migratedMode;
  }

  if (slot === 3 && waReplyVideo3.updatedAt > 0) {
    if (waReplyVideo3.mode === 'custom' && waReplyVideo3.base64Data) {
      const buf = Buffer.from(waReplyVideo3.base64Data, 'base64');
      const check = detectAndValidateAttachment(
        buf,
        waReplyVideo3.mimeType,
        waReplyVideo3.fileName || 'prestair-showcase.mp4'
      );
      if (check.valid) {
        writeBinaryFileSafe(getSlotPaths(3).binPath, buf);
        const migrated: WaSlotMediaMeta = {
          mode: 'custom',
          mimeType: check.mimeType,
          fileName: check.fileName,
          byteLength: check.byteLength,
          category: check.category,
          updatedAt: waReplyVideo3.updatedAt,
        };
        persistWaSlotMetaLocal(3, migrated);
        return migrated;
      }
    }
    const migratedNone: WaSlotMediaMeta = {
      mode: 'none',
      mimeType: '',
      fileName: '',
      byteLength: 0,
      category: 'video',
      updatedAt: waReplyVideo3.updatedAt,
    };
    persistWaSlotMetaLocal(3, migratedNone);
    return migratedNone;
  }

  return {
    mode: defaultModeForSlot,
    mimeType: '',
    fileName: '',
    byteLength: 0,
    category: slot === 3 ? 'document' : 'image',
    updatedAt: 0,
  };
}

const waSlotMedia: Record<WaSlotNumber, WaSlotMediaMeta> = {
  1: loadInitialWaSlotMedia(1),
  2: loadInitialWaSlotMedia(2),
  3: loadInitialWaSlotMedia(3),
};

function getSlotStatusPayload(slot: WaSlotNumber) {
  const meta = waSlotMedia[slot];
  const hasCustomFile = meta.mode === 'custom' && meta.byteLength > 0 && Boolean(meta.mimeType);
  const effectiveMode: WaSlotMode =
    meta.mode === 'custom' && !hasCustomFile
      ? slot === 3
        ? 'none'
        : 'default'
      : meta.mode;
  return {
    slot,
    mode: effectiveMode,
    hasDefault: slot === 1 || slot === 2,
    hasCustomFile,
    mimeType: hasCustomFile ? meta.mimeType : null,
    fileName: hasCustomFile ? meta.fileName : null,
    byteLength: hasCustomFile ? meta.byteLength : 0,
    category: hasCustomFile ? meta.category : slot === 3 ? ('document' as const) : ('image' as const),
    updatedAt: meta.updatedAt,
  };
}

function getAllSlotsStatusPayload() {
  return {
    1: getSlotStatusPayload(1),
    2: getSlotStatusPayload(2),
    3: getSlotStatusPayload(3),
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

async function pushWaReplyVideo3ToRtdb(): Promise<void> {
  if (!rtdbInstance) return;
  try {
    if (waReplyVideo3.mode === 'custom' && waReplyVideo3.base64Data && waReplyVideo3.mimeType) {
      const totalChars = waReplyVideo3.base64Data.length;
      const chunkCount = Math.ceil(totalChars / VIDEO_RTDB_CHUNK_CHARS);
      await remove(ref(rtdbInstance, 'meta/waReplyVideo3Chunks')).catch(() => {});
      for (let i = 0; i < chunkCount; i++) {
        const slice = waReplyVideo3.base64Data.slice(
          i * VIDEO_RTDB_CHUNK_CHARS,
          (i + 1) * VIDEO_RTDB_CHUNK_CHARS
        );
        await set(ref(rtdbInstance, `meta/waReplyVideo3Chunks/${i}`), slice);
      }
      const metaPayload: WhatsAppReplyVideoRtdbMeta = {
        mode: 'custom',
        mimeType: waReplyVideo3.mimeType,
        fileName: waReplyVideo3.fileName,
        byteLength: waReplyVideo3.byteLength,
        chunkCount,
        updatedAt: waReplyVideo3.updatedAt,
      };
      await set(ref(rtdbInstance, 'meta/waReplyVideo3Meta'), metaPayload);
    } else {
      await remove(ref(rtdbInstance, 'meta/waReplyVideo3Chunks')).catch(() => {});
      const metaPayload: WhatsAppReplyVideoRtdbMeta = {
        mode: 'none',
        mimeType: '',
        fileName: '',
        byteLength: 0,
        chunkCount: 0,
        updatedAt: waReplyVideo3.updatedAt,
      };
      await set(ref(rtdbInstance, 'meta/waReplyVideo3Meta'), metaPayload);
    }
  } catch {
    // ignore transient RTDB write failure
  }
}

let isHydratingVideo3FromRtdb = false;

async function syncWaReplyVideo3FromRtdbMeta(
  metaVal: Partial<WhatsAppReplyVideoRtdbMeta> | null
): Promise<void> {
  if (!rtdbInstance || !metaVal || typeof metaVal !== 'object') return;
  const remoteUpdatedAt = typeof metaVal.updatedAt === 'number' ? metaVal.updatedAt : 1;
  if (remoteUpdatedAt <= waReplyVideo3.updatedAt) {
    if (waReplyVideo3.updatedAt > remoteUpdatedAt) {
      void pushWaReplyVideo3ToRtdb();
    }
    return;
  }

  if (metaVal.mode !== 'custom' || !metaVal.chunkCount || metaVal.chunkCount <= 0) {
    waReplyVideo3 = {
      mode: 'none',
      mimeType: '',
      fileName: '',
      byteLength: 0,
      base64Data: '',
      updatedAt: remoteUpdatedAt,
    };
    persistWaReplyVideo3Local();
    return;
  }

  if (isHydratingVideo3FromRtdb) return;
  isHydratingVideo3FromRtdb = true;
  try {
    const chunkCount = Math.min(32, Math.max(1, Math.floor(metaVal.chunkCount)));
    const chunksSnap = await get(ref(rtdbInstance, 'meta/waReplyVideo3Chunks'));
    const rawChunks = chunksSnap.val() as Record<string, unknown> | unknown[] | null;
    if (!rawChunks || typeof rawChunks !== 'object') return;
    const parts: string[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const part = Array.isArray(rawChunks)
        ? rawChunks[i]
        : (rawChunks as Record<string, unknown>)[String(i)];
      if (typeof part !== 'string' || !part) {
        return;
      }
      parts.push(part);
    }
    const joinedBase64 = parts.join('');
    const mimeType = typeof metaVal.mimeType === 'string' ? metaVal.mimeType : '';
    const buf = Buffer.from(joinedBase64, 'base64');
    if (validateVideoBinaryMagic(mimeType, buf)) {
      waReplyVideo3 = {
        mode: 'custom',
        mimeType,
        fileName: sanitizeVideoFileName(metaVal.fileName),
        byteLength: buf.length,
        base64Data: joinedBase64,
        updatedAt: remoteUpdatedAt,
      };
      persistWaReplyVideo3Local();
      // Mirror legacy RTDB video into unified Slot 3 if Slot 3 is older
      if (remoteUpdatedAt > waSlotMedia[3].updatedAt) {
        writeBinaryFileSafe(getSlotPaths(3).binPath, buf);
        waSlotMedia[3] = {
          mode: 'custom',
          mimeType,
          fileName: sanitizeAttachmentFileName(metaVal.fileName, '.mp4'),
          byteLength: buf.length,
          category: 'video',
          updatedAt: remoteUpdatedAt,
        };
        persistWaSlotMetaLocal(3, waSlotMedia[3]);
      }
    }
  } catch {
    // ignore transient chunk fetch error
  } finally {
    isHydratingVideo3FromRtdb = false;
  }
}

const hydratingSlotLocks: Record<WaSlotNumber, boolean> = {
  1: false,
  2: false,
  3: false,
};

async function pushWaSlotMediaToRtdb(slot: WaSlotNumber): Promise<void> {
  if (!rtdbInstance) return;
  const meta = waSlotMedia[slot];
  try {
    if (meta.mode === 'custom') {
      const buf = readSlotBinarySafe(slot);
      if (buf && buf.length > 0 && meta.mimeType) {
        const base64Str = buf.toString('base64');
        const chunkCount = Math.ceil(base64Str.length / SLOT_RTDB_CHUNK_CHARS);
        await remove(ref(rtdbInstance, `meta/waSlotMediaChunks/${slot}`)).catch(() => {});
        const BATCH_SIZE = 6;
        for (let start = 0; start < chunkCount; start += BATCH_SIZE) {
          const writes: Promise<void>[] = [];
          for (let i = start; i < Math.min(chunkCount, start + BATCH_SIZE); i++) {
            const slice = base64Str.slice(
              i * SLOT_RTDB_CHUNK_CHARS,
              (i + 1) * SLOT_RTDB_CHUNK_CHARS
            );
            writes.push(set(ref(rtdbInstance, `meta/waSlotMediaChunks/${slot}/${i}`), slice));
          }
          await Promise.all(writes);
        }
        const rtdbMeta: WaSlotMediaRtdbMeta = {
          ...meta,
          byteLength: buf.length,
          chunkCount,
        };
        await set(ref(rtdbInstance, `meta/waSlotMediaMeta/${slot}`), rtdbMeta);
        return;
      }
    }

    await remove(ref(rtdbInstance, `meta/waSlotMediaChunks/${slot}`)).catch(() => {});
    const rtdbMeta: WaSlotMediaRtdbMeta = {
      mode: meta.mode === 'custom' ? (slot === 3 ? 'none' : 'default') : meta.mode,
      mimeType: '',
      fileName: '',
      byteLength: 0,
      category: meta.category,
      chunkCount: 0,
      updatedAt: meta.updatedAt,
    };
    await set(ref(rtdbInstance, `meta/waSlotMediaMeta/${slot}`), rtdbMeta);
  } catch {
    // ignore transient RTDB write failure
  }
}

async function syncWaSlotMediaFromRtdbMeta(
  slot: WaSlotNumber,
  metaVal: Partial<WaSlotMediaRtdbMeta> | null
): Promise<void> {
  if (!rtdbInstance || !metaVal || typeof metaVal !== 'object') return;
  const remoteUpdatedAt = typeof metaVal.updatedAt === 'number' ? metaVal.updatedAt : 1;
  if (remoteUpdatedAt <= waSlotMedia[slot].updatedAt) {
    if (waSlotMedia[slot].updatedAt > remoteUpdatedAt) {
      void pushWaSlotMediaToRtdb(slot);
    }
    return;
  }

  const remoteMode: WaSlotMode =
    metaVal.mode === 'custom'
      ? 'custom'
      : metaVal.mode === 'none'
        ? 'none'
        : slot === 3
          ? 'none'
          : 'default';

  if (remoteMode !== 'custom' || !metaVal.chunkCount || metaVal.chunkCount <= 0) {
    removeSlotBinarySafe(slot);
    waSlotMedia[slot] = {
      mode: remoteMode === 'custom' ? (slot === 3 ? 'none' : 'default') : remoteMode,
      mimeType: '',
      fileName: '',
      byteLength: 0,
      category: slot === 3 ? 'document' : 'image',
      updatedAt: remoteUpdatedAt,
    };
    persistWaSlotMetaLocal(slot, waSlotMedia[slot]);
    return;
  }

  if (hydratingSlotLocks[slot]) return;
  hydratingSlotLocks[slot] = true;
  try {
    const chunkCount = Math.min(48, Math.max(1, Math.floor(metaVal.chunkCount)));
    const chunksSnap = await get(ref(rtdbInstance, `meta/waSlotMediaChunks/${slot}`));
    const rawChunks = chunksSnap.val() as Record<string, unknown> | unknown[] | null;
    if (!rawChunks || typeof rawChunks !== 'object') return;
    const parts: string[] = [];
    for (let i = 0; i < chunkCount; i++) {
      const part = Array.isArray(rawChunks)
        ? rawChunks[i]
        : (rawChunks as Record<string, unknown>)[String(i)];
      if (typeof part !== 'string' || !part) {
        return;
      }
      parts.push(part);
    }
    const buf = Buffer.from(parts.join(''), 'base64');
    const validated = detectAndValidateAttachment(buf, metaVal.mimeType, metaVal.fileName);
    if (validated.valid) {
      writeBinaryFileSafe(getSlotPaths(slot).binPath, buf);
      waSlotMedia[slot] = {
        mode: 'custom',
        mimeType: validated.mimeType,
        fileName: validated.fileName,
        byteLength: validated.byteLength,
        category: validated.category,
        updatedAt: remoteUpdatedAt,
      };
      persistWaSlotMetaLocal(slot, waSlotMedia[slot]);

      // Mirror standard <= 2MB images into legacy waReplyImage / waReplyImage2 for Showcase tab compatibility
      if (
        (slot === 1 || slot === 2) &&
        (validated.mimeType === 'image/jpeg' ||
          validated.mimeType === 'image/png' ||
          validated.mimeType === 'image/webp') &&
        buf.length <= MAX_REPLY_IMAGE_BYTES
      ) {
        const legacyImgState: WhatsAppReplyImageState = {
          mode: 'custom',
          mimeType: validated.mimeType,
          base64Data: buf.toString('base64'),
          updatedAt: remoteUpdatedAt,
        };
        if (slot === 1) {
          waReplyImage = legacyImgState;
          persistWaReplyImageLocal();
        } else {
          waReplyImage2 = legacyImgState;
          persistWaReplyImage2Local();
        }
      }
    }
  } catch {
    // ignore transient chunk read error
  } finally {
    hydratingSlotLocks[slot] = false;
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
  sendFirst?: boolean;
  text: string;
  sendSecond?: boolean;
  secondText?: string | null;
  sendThird?: boolean;
  thirdText?: string | null;
  leadId?: string | null;
  requestedBy: string;
  requestedAt: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
}

const processedRelayJobs = new Set<string>();

async function enqueueCloudWaDispatchJob(params: {
  phone: string;
  sendFirst?: boolean;
  text: string;
  sendSecond?: boolean;
  secondText?: string | null;
  sendThird?: boolean;
  thirdText?: string | null;
  leadId?: string | null;
}): Promise<boolean> {
  if (!rtdbInstance || !isRemoteCloudWorkerActive()) return false;
  const jobId = `wajob_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const job: WaDispatchJob = {
    jobId,
    phone: sanitizeField(params.phone, 32),
    sendFirst:
      typeof params.sendFirst === 'boolean'
        ? params.sendFirst
        : waSettings.firstMessageEnabled,
    text: String(params.text || '').slice(0, 4000),
    sendSecond:
      typeof params.sendSecond === 'boolean'
        ? params.sendSecond
        : waSettings.secondMessageEnabled,
    secondText:
      typeof params.secondText === 'string' && params.secondText.trim()
        ? params.secondText.slice(0, 4000)
        : waSettings.secondMessageTemplate.slice(0, 4000),
    sendThird:
      typeof params.sendThird === 'boolean'
        ? params.sendThird
        : waSettings.thirdMessageEnabled,
    thirdText:
      typeof params.thirdText === 'string' && params.thirdText.trim()
        ? params.thirdText.slice(0, 4000)
        : waSettings.thirdMessageTemplate.slice(0, 4000),
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
            firstMessageEnabled:
              typeof val.firstMessageEnabled === 'boolean'
                ? val.firstMessageEnabled
                : waSettings.firstMessageEnabled,
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
            thirdMessageEnabled:
              typeof val.thirdMessageEnabled === 'boolean'
                ? val.thirdMessageEnabled
                : waSettings.thirdMessageEnabled,
            thirdMessageTemplate:
              typeof val.thirdMessageTemplate === 'string' && val.thirdMessageTemplate.trim()
                ? val.thirdMessageTemplate.slice(0, 4000)
                : DEFAULT_PRESTAIR_THIRD_WHATSAPP_REPLY,
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
              if (remoteUpdatedAt > waSlotMedia[1].updatedAt) {
                const ext = val.mimeType === 'image/png' ? '.png' : val.mimeType === 'image/webp' ? '.webp' : '.jpg';
                writeBinaryFileSafe(getSlotPaths(1).binPath, buf);
                waSlotMedia[1] = {
                  mode: 'custom',
                  mimeType: val.mimeType,
                  fileName: `prestair-message-1${ext}`,
                  byteLength: buf.length,
                  category: 'image',
                  updatedAt: remoteUpdatedAt,
                };
                persistWaSlotMetaLocal(1, waSlotMedia[1]);
              }
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
              if (remoteUpdatedAt > waSlotMedia[2].updatedAt) {
                const ext = val.mimeType === 'image/png' ? '.png' : val.mimeType === 'image/webp' ? '.webp' : '.jpg';
                writeBinaryFileSafe(getSlotPaths(2).binPath, buf);
                waSlotMedia[2] = {
                  mode: 'custom',
                  mimeType: val.mimeType,
                  fileName: `prestair-message-2${ext}`,
                  byteLength: buf.length,
                  category: 'image',
                  updatedAt: remoteUpdatedAt,
                };
                persistWaSlotMetaLocal(2, waSlotMedia[2]);
              }
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

    // 5c-video. Sync WhatsApp Attached Reply Video #3 across all deployments
    onValue(ref(rtdbInstance, 'meta/waReplyVideo3Meta'), (snap) => {
      const val = snap.val() as Partial<WhatsAppReplyVideoRtdbMeta> | null;
      if (val && typeof val === 'object') {
        void syncWaReplyVideo3FromRtdbMeta(val);
      } else if (waReplyVideo3.updatedAt > 0) {
        void pushWaReplyVideo3ToRtdb();
      }
    });

    // 5c-universal. Sync Unified 3-Slot Universal Attachments (PDF / Image / Video / Any File) across all deployments
    for (const slot of [1, 2, 3] as WaSlotNumber[]) {
      onValue(ref(rtdbInstance, `meta/waSlotMediaMeta/${slot}`), (snap) => {
        const val = snap.val() as Partial<WaSlotMediaRtdbMeta> | null;
        if (val && typeof val === 'object') {
          void syncWaSlotMediaFromRtdbMeta(slot, val);
        } else if (waSlotMedia[slot].updatedAt > 0) {
          void pushWaSlotMediaToRtdb(slot);
        }
      });
    }

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
    const sendFirst =
      typeof rawJob.sendFirst === 'boolean'
        ? rawJob.sendFirst
        : waSettings.firstMessageEnabled;
    const text = typeof rawJob.text === 'string' ? rawJob.text : '';
    const sendSecond =
      typeof rawJob.sendSecond === 'boolean'
        ? rawJob.sendSecond
        : waSettings.secondMessageEnabled;
    const secondText =
      typeof rawJob.secondText === 'string' && rawJob.secondText.trim()
        ? rawJob.secondText
        : waSettings.secondMessageTemplate;
    const sendThird =
      typeof rawJob.sendThird === 'boolean'
        ? rawJob.sendThird
        : waSettings.thirdMessageEnabled;
    const thirdText =
      typeof rawJob.thirdText === 'string' && rawJob.thirdText.trim()
        ? rawJob.thirdText
        : waSettings.thirdMessageTemplate;
    const leadId = typeof rawJob.leadId === 'string' ? rawJob.leadId : '';

    void (async () => {
      try {
        if (rtdbInstance) {
          await set(ref(rtdbInstance, `meta/waDispatchQueue/${key}/status`), 'processing');
        }
        await sendPrestairWhatsAppReplyWithSingleImage(phone, text, {
          sendFirst,
          sendSecond,
          secondCaptionText: secondText,
          sendThird,
          thirdCaptionText: thirdText,
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

interface ResolvedReplyVideo {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
}

function resolveThirdPrestairReplyVideo(): ResolvedReplyVideo | null {
  if (waReplyVideo3.mode !== 'custom' || !waReplyVideo3.base64Data) {
    return null;
  }
  try {
    const customBuf = Buffer.from(waReplyVideo3.base64Data, 'base64');
    if (validateVideoBinaryMagic(waReplyVideo3.mimeType, customBuf)) {
      return {
        buffer: customBuf,
        mimeType: waReplyVideo3.mimeType,
        fileName: waReplyVideo3.fileName || 'prestair-showcase.mp4',
      };
    }
  } catch {
    // fallback to null if decoding fails
  }
  return null;
}

interface ResolvedSlotAttachment {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  category: WaSlotCategory;
}

function resolveSlotAttachment(slot: WaSlotNumber): ResolvedSlotAttachment | null {
  const meta = waSlotMedia[slot];
  if (meta.mode === 'none') {
    return null;
  }

  if (meta.mode === 'custom') {
    const customBuf = readSlotBinarySafe(slot);
    if (customBuf) {
      const check = detectAndValidateAttachment(customBuf, meta.mimeType, meta.fileName);
      if (check.valid) {
        return {
          buffer: customBuf,
          mimeType: check.mimeType,
          fileName: check.fileName,
          category: check.category,
        };
      }
    }
  }

  // Fallback to legacy in-memory state if waSlotMedia was not yet populated
  if (slot === 1) {
    const legacy1 = resolveFirstPrestairReplyImage();
    if (!legacy1) return null;
    const ext = legacy1.mimeType === 'image/png' ? '.png' : '.jpg';
    return {
      buffer: legacy1.buffer,
      mimeType: legacy1.mimeType,
      fileName: `prestair-showcase-1${ext}`,
      category: 'image',
    };
  }

  if (slot === 2) {
    const legacy2 = resolveSecondPrestairReplyImage();
    if (!legacy2) return null;
    const ext = legacy2.mimeType === 'image/png' ? '.png' : '.jpg';
    return {
      buffer: legacy2.buffer,
      mimeType: legacy2.mimeType,
      fileName: `prestair-showcase-2${ext}`,
      category: 'image',
    };
  }

  const legacy3 = resolveThirdPrestairReplyVideo();
  if (!legacy3) return null;
  return {
    buffer: legacy3.buffer,
    mimeType: legacy3.mimeType,
    fileName: legacy3.fileName,
    category: 'video',
  };
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
          firstMessageEnabled:
            typeof val.firstMessageEnabled === 'boolean'
              ? val.firstMessageEnabled
              : true,
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
          thirdMessageEnabled:
            typeof val.thirdMessageEnabled === 'boolean'
              ? val.thirdMessageEnabled
              : true,
          thirdMessageTemplate:
            typeof val.thirdMessageTemplate === 'string' && val.thirdMessageTemplate.trim()
              ? val.thirdMessageTemplate.slice(0, 4000)
              : DEFAULT_PRESTAIR_THIRD_WHATSAPP_REPLY,
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

    if (waReplyVideo3.updatedAt === 0) {
      const snapVid = await get(ref(rtdbInstance, 'meta/waReplyVideo3Meta'));
      const valVid = snapVid.val() as Partial<WhatsAppReplyVideoRtdbMeta> | null;
      if (valVid && typeof valVid === 'object') {
        await syncWaReplyVideo3FromRtdbMeta(valVid);
      }
    }

    for (const slot of [1, 2, 3] as WaSlotNumber[]) {
      if (waSlotMedia[slot].updatedAt === 0) {
        const snapSlot = await get(ref(rtdbInstance, `meta/waSlotMediaMeta/${slot}`));
        const valSlot = snapSlot.val() as Partial<WaSlotMediaRtdbMeta> | null;
        if (valSlot && typeof valSlot === 'object') {
          await syncWaSlotMediaFromRtdbMeta(slot, valSlot);
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
let localWaVaultSyncedAt = 0;
let waVaultPushTimer: ReturnType<typeof setTimeout> | null = null;
let isPushingWaVault = false;

interface WaAuthVaultRtdbRecord {
  v: 1;
  iv: string;
  tag: string;
  data: string;
  connectedNumber: string | null;
  writerId: string;
  updatedAt: number;
}

async function ensureAdminAuthHydratedFromRtdb(): Promise<void> {
  if (adminAuth || !rtdbInstance) return;
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
    // ignore transient RTDB read failure
  }
}

function getCandidateWaVaultKeys(): Buffer[] {
  const keys: Buffer[] = [];
  const customSecret = (process.env.WA_SESSION_SECRET || '').trim();
  if (customSecret) {
    keys.push(crypto.scryptSync(customSecret, 'prestier-wa-vault-v1', 32));
  }
  const envPass = (process.env.ADMIN_PASSCODE || '').trim();
  if (envPass) {
    keys.push(crypto.scryptSync(envPass, 'prestier-wa-vault-pass-v1', 32));
  }
  if (adminAuth?.passwordHash && adminAuth?.salt) {
    keys.push(
      crypto.scryptSync(adminAuth.passwordHash, `${adminAuth.salt}:prestier-wa-vault-v1`, 32)
    );
  }
  keys.push(
    crypto.scryptSync(RTDB_DATABASE_URL || 'prestier-final', 'prestier-wa-vault-boot-v1', 32)
  );
  return keys;
}

async function refreshRemoteWaRuntimeFromRtdb(): Promise<void> {
  if (!rtdbInstance) return;
  try {
    const snap = await get(ref(rtdbInstance, 'meta/waRuntimeStatus'));
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
        connectedNumber: typeof val.connectedNumber === 'string' ? val.connectedNumber : null,
        updatedAt: val.updatedAt,
      };
    } else {
      remoteWaRuntime = null;
    }
  } catch {
    // ignore transient RTDB read failure
  }
}

function parseCredsRegistrationInfo(rawJson: string): { valid: boolean; registered: boolean } {
  try {
    const trimmed = rawJson.trim();
    if (trimmed.length <= 20) return { valid: false, registered: false };
    const parsed = JSON.parse(trimmed) as {
      registered?: boolean;
      me?: { id?: string };
    };
    const isReg = Boolean(parsed?.registered || parsed?.me?.id);
    return { valid: true, registered: isReg };
  } catch {
    return { valid: false, registered: false };
  }
}

function ensureValidWhatsAppCredsFile(): boolean {
  const credsPath = path.join(WHATSAPP_AUTH_DIR, 'creds.json');
  const backupPath = path.join(WHATSAPP_AUTH_DIR, 'creds.backup.json');
  try {
    if (fs.existsSync(credsPath)) {
      const raw = fs.readFileSync(credsPath, 'utf8');
      const info = parseCredsRegistrationInfo(raw);
      if (info.valid) {
        return true;
      }
    }
  } catch {
    // Attempt recovery from backup if creds.json was truncated during container restart
  }

  try {
    if (fs.existsSync(backupPath)) {
      const backupRaw = fs.readFileSync(backupPath, 'utf8');
      const info = parseCredsRegistrationInfo(backupRaw);
      if (info.valid) {
        fs.writeFileSync(credsPath, backupRaw, 'utf8');
        return true;
      }
    }
  } catch {
    // ignore invalid backup
  }
  return false;
}

function hasRegisteredWhatsAppCreds(): boolean {
  if (!ensureValidWhatsAppCredsFile()) return false;
  try {
    const credsPath = path.join(WHATSAPP_AUTH_DIR, 'creds.json');
    const raw = fs.readFileSync(credsPath, 'utf8');
    return parseCredsRegistrationInfo(raw).registered;
  } catch {
    return false;
  }
}

function backupWhatsAppCredsSafe(): void {
  const credsPath = path.join(WHATSAPP_AUTH_DIR, 'creds.json');
  const backupPath = path.join(WHATSAPP_AUTH_DIR, 'creds.backup.json');
  try {
    if (!fs.existsSync(credsPath)) return;
    const raw = fs.readFileSync(credsPath, 'utf8').trim();
    if (parseCredsRegistrationInfo(raw).valid) {
      const tmpPath = `${backupPath}.tmp`;
      fs.writeFileSync(tmpPath, raw, 'utf8');
      fs.renameSync(tmpPath, backupPath);
    }
  } catch {
    // ignore transient read/parse race
  }
}

function hasSavedWhatsAppCreds(): boolean {
  return hasRegisteredWhatsAppCreds();
}

async function pushWaAuthVaultToRtdbImmediate(): Promise<void> {
  if (!rtdbInstance || explicitUnlinkRequested || isPushingWaVault) return;
  if (!hasRegisteredWhatsAppCreds()) return;

  isPushingWaVault = true;
  try {
    await ensureAdminAuthHydratedFromRtdb();
    const primaryKey = getCandidateWaVaultKeys()[0];
    const safeDirPrefix = WHATSAPP_AUTH_DIR.endsWith(path.sep)
      ? WHATSAPP_AUTH_DIR
      : WHATSAPP_AUTH_DIR + path.sep;

    const entries = fs.readdirSync(WHATSAPP_AUTH_DIR);
    const filesMap: Record<string, string> = {};
    for (const name of entries) {
      if (
        !name.endsWith('.json') ||
        name === 'creds.backup.json' ||
        name.endsWith('.tmp') ||
        !/^[A-Za-z0-9._@-]+\.json$/.test(name)
      ) {
        continue;
      }
      const fullPath = path.resolve(WHATSAPP_AUTH_DIR, name);
      if (!fullPath.startsWith(safeDirPrefix)) continue;
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.trim()) {
          JSON.parse(content);
          filesMap[name] = content;
        }
      } catch {
        // skip mid-write file
      }
    }

    if (!filesMap['creds.json'] || !parseCredsRegistrationInfo(filesMap['creds.json']).registered) {
      return;
    }

    const compressed = zlib.gzipSync(Buffer.from(JSON.stringify({ files: filesMap }), 'utf8'));
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', primaryKey, iv);
    const encrypted = Buffer.concat([cipher.update(compressed), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const now = Date.now();

    const record: WaAuthVaultRtdbRecord = {
      v: 1,
      iv: iv.toString('base64'),
      tag: authTag.toString('base64'),
      data: encrypted.toString('base64'),
      connectedNumber: waState.connectedNumber,
      writerId: SERVER_INSTANCE_ID,
      updatedAt: now,
    };

    await set(ref(rtdbInstance, 'meta/waAuthVault'), record);
    localWaVaultSyncedAt = now;
  } catch {
    // ignore transient RTDB vault write error
  } finally {
    isPushingWaVault = false;
  }
}

function schedulePushWaAuthVaultToRtdb(delayMs = 900): void {
  if (explicitUnlinkRequested || isShuttingDown) return;
  if (waVaultPushTimer) {
    clearTimeout(waVaultPushTimer);
  }
  waVaultPushTimer = setTimeout(() => {
    waVaultPushTimer = null;
    void pushWaAuthVaultToRtdbImmediate();
  }, delayMs);
}

async function restoreWaAuthVaultFromRtdbIfNeeded(): Promise<boolean> {
  if (!rtdbInstance || explicitUnlinkRequested) return false;
  if (waState.status === 'connected' && waSocket) return true;

  try {
    await ensureAdminAuthHydratedFromRtdb();
    const snap = await get(ref(rtdbInstance, 'meta/waAuthVault'));
    const vault = snap.val() as Partial<WaAuthVaultRtdbRecord> | null;
    if (
      !vault ||
      vault.v !== 1 ||
      typeof vault.iv !== 'string' ||
      typeof vault.tag !== 'string' ||
      typeof vault.data !== 'string'
    ) {
      return hasRegisteredWhatsAppCreds();
    }

    const remoteUpdatedAt = typeof vault.updatedAt === 'number' ? vault.updatedAt : 1;
    const localHasRegistered = hasRegisteredWhatsAppCreds();
    if (localHasRegistered && remoteUpdatedAt <= localWaVaultSyncedAt) {
      return true;
    }

    const ivBuf = Buffer.from(vault.iv, 'base64');
    const tagBuf = Buffer.from(vault.tag, 'base64');
    const cipherBuf = Buffer.from(vault.data, 'base64');
    if (ivBuf.length !== 12 || tagBuf.length !== 16 || cipherBuf.length === 0) {
      return localHasRegistered;
    }

    let decryptedCompressed: Buffer | null = null;
    for (const candidateKey of getCandidateWaVaultKeys()) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', candidateKey, ivBuf);
        decipher.setAuthTag(tagBuf);
        decryptedCompressed = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
        break;
      } catch {
        // try next key candidate
      }
    }
    if (!decryptedCompressed) {
      return localHasRegistered;
    }

    const unzippedStr = zlib.gunzipSync(decryptedCompressed).toString('utf8');
    const parsed = JSON.parse(unzippedStr) as { files?: Record<string, unknown> };
    if (!parsed?.files || typeof parsed.files !== 'object') {
      return localHasRegistered;
    }

    const rawCreds = parsed.files['creds.json'];
    if (typeof rawCreds !== 'string' || !parseCredsRegistrationInfo(rawCreds).registered) {
      return localHasRegistered;
    }

    fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
    const safeDirPrefix = WHATSAPP_AUTH_DIR.endsWith(path.sep)
      ? WHATSAPP_AUTH_DIR
      : WHATSAPP_AUTH_DIR + path.sep;

    for (const [name, content] of Object.entries(parsed.files)) {
      if (
        typeof content !== 'string' ||
        !name.endsWith('.json') ||
        !/^[A-Za-z0-9._@-]+\.json$/.test(name)
      ) {
        continue;
      }
      const targetPath = path.resolve(WHATSAPP_AUTH_DIR, name);
      if (!targetPath.startsWith(safeDirPrefix)) continue;
      const tmpPath = `${targetPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpPath, targetPath);
    }

    backupWhatsAppCredsSafe();
    localWaVaultSyncedAt = remoteUpdatedAt;
    return true;
  } catch {
    return hasRegisteredWhatsAppCreds();
  }
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
  const rawPairingDigits = normalizePhoneForWhatsApp(pairingPhoneRaw);
  const cleanPairingDigits =
    rawPairingDigits.length >= 8 && rawPairingDigits.length <= 15 ? rawPairingDigits : '';
  if (pairingPhoneRaw.trim() && !cleanPairingDigits) {
    waState.lastError =
      'Please enter a valid WhatsApp number with country code (e.g. 917428545777).';
    return;
  }
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
    if (cleanPairingDigits) {
      // If local creds are absent or unregistered from an old expired QR/pairing attempt,
      // reset WHATSAPP_AUTH_DIR so Baileys starts a clean Noise/Signal registration for pairing code.
      if (!hasRegisteredWhatsAppCreds()) {
        try {
          fs.rmSync(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
        } catch {
          // ignore cleanup error
        }
      }
    } else {
      await restoreWaAuthVaultFromRtdbIfNeeded();
    }
    ensureValidWhatsAppCredsFile();
    const { state, saveCreds } = await useMultiFileAuthState(WHATSAPP_AUTH_DIR);

    // Wrap Signal key mutations so rotated sessions/pre-keys stay synced to encrypted Cloud Vault across Railway deploys
    const origKeysSet = state.keys.set.bind(state.keys);
    state.keys.set = async (data) => {
      await origKeysSet(data);
      if (state.creds.registered || waState.status === 'connected') {
        schedulePushWaAuthVaultToRtdb(1400);
      }
    };

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
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
    });

    waSocket = sock;
    sock.ev.on('creds.update', async () => {
      await saveCreds();
      backupWhatsAppCredsSafe();
      if (state.creds.registered || Boolean(state.creds.me?.id)) {
        schedulePushWaAuthVaultToRtdb(700);
      }
    });

    let pairingCodeRequested = false;
    const issuePairingCodeOnce = async () => {
      if (
        pairingCodeRequested ||
        !cleanPairingDigits ||
        state.creds.registered ||
        waSocket !== sock ||
        waState.status === 'connected'
      ) {
        return;
      }
      pairingCodeRequested = true;
      try {
        const rawCode = (await sock.requestPairingCode(cleanPairingDigits)).trim();
        const formattedCode =
          rawCode.length === 8 && !rawCode.includes('-')
            ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}`
            : rawCode;
        waState.pairingCode = formattedCode;
        waState.qrDataUrl = null;
        waState.status = 'pairing_ready';
        waState.lastError = null;
      } catch (err) {
        pairingCodeRequested = false;
        waState.lastError =
          (err as Error)?.message || 'Could not generate pairing code. Try scanning QR instead.';
      }
    };

    if (cleanPairingDigits && !state.creds.registered) {
      // Fallback timer if socket finishes handshake without emitting QR first
      setTimeout(() => {
        void issuePairingCodeOnce();
      }, 3200);
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (cleanPairingDigits && !state.creds.registered) {
          void issuePairingCodeOnce();
        } else if (!cleanPairingDigits) {
          try {
            waState.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 300 });
            waState.status = 'qr_ready';
          } catch {
            // ignore QR render error
          }
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
        void pushWaAuthVaultToRtdbImmediate();
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
          // Graceful container update / restart — NEVER touch WHATSAPP_AUTH_DIR or Cloud Vault
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
          // NEVER delete local creds.json or Cloud Vault, and do NOT fight it in a reconnect loop!
          connectionReplacedAtMs = Date.now();
          waState.status = 'disconnected';
          waState.lastError = null;
          return;
        }

        if (statusCode === DisconnectReason.loggedOut) {
          // Verify whether another deployment is actively connected or rotated the Cloud Vault before wiping!
          await refreshRemoteWaRuntimeFromRtdb();
          if (isRemoteCloudWorkerActive()) {
            connectionReplacedAtMs = Date.now();
            waState.status = 'disconnected';
            waState.lastError = null;
            return;
          }
          if (rtdbInstance) {
            try {
              const vaultSnap = await get(ref(rtdbInstance, 'meta/waAuthVault'));
              const remoteVault = vaultSnap.val() as Partial<WaAuthVaultRtdbRecord> | null;
              if (
                remoteVault &&
                typeof remoteVault.updatedAt === 'number' &&
                remoteVault.updatedAt > localWaVaultSyncedAt
              ) {
                // Newer session exists in Cloud Vault — restore and reconnect instead of wiping!
                waState.status = 'connecting';
                setTimeout(() => {
                  if (!isShuttingDown && !explicitUnlinkRequested && !isRemoteCloudWorkerActive()) {
                    void startWhatsAppConnection();
                  }
                }, 2000);
                return;
              }
            } catch {
              // ignore
            }
          }

          // Phone genuinely unlinked device from WhatsApp mobile app
          waState.status = 'disconnected';
          waState.connectedNumber = null;
          waState.lastError =
            'WhatsApp session was unlinked from phone. Scan QR code once to relink.';
          localWaVaultSyncedAt = 0;
          try {
            fs.rmSync(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
          } catch {
            // ignore
          }
          if (rtdbInstance) {
            void remove(ref(rtdbInstance, 'meta/waAuthVault')).catch(() => {});
          }
          return;
        }

        // If an unregistered phone-pairing code timed out before the user typed it on their phone,
        // stop quietly and prompt for a fresh code instead of overwriting with background QR reconnects.
        if (
          cleanPairingDigits &&
          statusCode !== DisconnectReason.restartRequired &&
          !hasRegisteredWhatsAppCreds()
        ) {
          waState.status = 'disconnected';
          waState.lastError =
            'Pairing code window expired before entry on phone. Click "Get Pairing Code" for a fresh code.';
          return;
        }

        // Transient network reset / restartRequired (515 right after QR or Pairing Code acceptance!) — auto-reconnect preserving creds!
        waState.status = 'connecting';
        const delayMs = statusCode === DisconnectReason.restartRequired ? 1000 : 4000;
        if (waReconnectTimer) clearTimeout(waReconnectTimer);
        waReconnectTimer = setTimeout(() => {
          void (async () => {
            await refreshRemoteWaRuntimeFromRtdb();
            if (!isShuttingDown && !explicitUnlinkRequested && !isRemoteCloudWorkerActive()) {
              void startWhatsAppConnection();
            } else if (isRemoteCloudWorkerActive()) {
              waState.status = 'disconnected';
            }
          })();
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

async function tryAutoResumeWhatsAppSafely(): Promise<void> {
  if (
    isShuttingDown ||
    explicitUnlinkRequested ||
    waConnectLock ||
    waSocket ||
    waState.status !== 'disconnected'
  ) {
    return;
  }
  const recentlyReplaced =
    connectionReplacedAtMs > 0 && Date.now() - connectionReplacedAtMs < 90_000;
  if (recentlyReplaced) return;

  await refreshRemoteWaRuntimeFromRtdb();
  if (isRemoteCloudWorkerActive()) {
    return;
  }

  const hasAuthReady = await restoreWaAuthVaultFromRtdbIfNeeded();
  if (!hasAuthReady || isShuttingDown || explicitUnlinkRequested) {
    return;
  }

  // Re-check right before opening socket so two servers booting together never collide
  await refreshRemoteWaRuntimeFromRtdb();
  if (!isRemoteCloudWorkerActive()) {
    await startWhatsAppConnection();
  }
}

// Publish WhatsApp 24x7 heartbeat every 14s when locally connected,
// drain any pending relay jobs, and auto-resume encrypted Cloud Vault credentials if no remote worker is active.
setInterval(
  () => {
    if (waState.status === 'connected' && waSocket) {
      void publishLocalWaRuntimeStatusToRtdb();
      void drainPendingWaDispatchQueueFromRtdb();
      return;
    }
    void tryAutoResumeWhatsAppSafely();
  },
  isProduction ? 12_000 : 18_000
).unref();

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

async function sendSingleWhatsAppAttachmentOrText(
  jid: string,
  caption: string,
  attachment: ResolvedSlotAttachment | null
): Promise<void> {
  const sock = await waitForActiveWaSocket(8000);
  if (!attachment) {
    await sock.sendMessage(jid, { text: caption });
    return;
  }

  const sendPrimaryPayload = async (activeSock: WASocket) => {
    if (attachment.category === 'image') {
      await activeSock.sendMessage(jid, {
        image: attachment.buffer,
        mimetype: attachment.mimeType,
        caption,
      });
      return;
    }
    if (attachment.category === 'video') {
      await activeSock.sendMessage(jid, {
        video: attachment.buffer,
        mimetype: attachment.mimeType,
        caption,
      });
      return;
    }
    // PDFs ('pdf') and all other business/media files ('document') deliver as native WhatsApp document bubble with filename + caption
    await activeSock.sendMessage(jid, {
      document: attachment.buffer,
      mimetype: attachment.mimeType,
      fileName: attachment.fileName,
      caption,
    });
  };

  try {
    await sendPrimaryPayload(sock);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const retrySock = await waitForActiveWaSocket(8000);
    try {
      await sendPrimaryPayload(retrySock);
    } catch {
      // Fallback: try sending as WhatsApp document attachment with caption so large/unusual image or video codecs still deliver the file!
      try {
        await retrySock.sendMessage(jid, {
          document: attachment.buffer,
          mimetype: attachment.mimeType || 'application/octet-stream',
          fileName: attachment.fileName,
          caption,
        });
      } catch {
        await retrySock.sendMessage(jid, { text: caption });
      }
    }
  }
}

async function sendPrestairWhatsAppReplyWithSingleImage(
  rawPhone: string,
  captionText: string,
  options?: {
    sendFirst?: boolean;
    sendSecond?: boolean;
    secondCaptionText?: string;
    sendThird?: boolean;
    thirdCaptionText?: string;
  }
): Promise<void> {
  await ensureWaMetaHydratedFromRtdb();
  const shouldSendFirst =
    typeof options?.sendFirst === 'boolean'
      ? options.sendFirst
      : waSettings.firstMessageEnabled !== false;
  const shouldSendSecond =
    typeof options?.sendSecond === 'boolean'
      ? options.sendSecond
      : waSettings.secondMessageEnabled !== false;
  const shouldSendThird =
    typeof options?.sendThird === 'boolean'
      ? options.sendThird
      : Boolean(waSettings.thirdMessageEnabled);

  if (!shouldSendFirst && !shouldSendSecond && !shouldSendThird) {
    return;
  }

  const jid = await resolveWhatsAppJid(rawPhone);
  let sentCount = 0;

  // Message 1: First Separate Attachment (Image / PDF / Video / Any File) + Text Confirmation
  if (shouldSendFirst) {
    const firstAttachment = resolveSlotAttachment(1);
    const cleanFirstCaption = captionText.trim() || DEFAULT_PRESTAIR_WHATSAPP_REPLY;
    await sendSingleWhatsAppAttachmentOrText(jid, cleanFirstCaption, firstAttachment);
    sentCount += 1;
  }

  // Message 2: Second Separate Attachment (Image / PDF / Video / Any File) + Text Confirmation
  if (shouldSendSecond) {
    if (sentCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1400));
    }
    const secondAttachment = resolveSlotAttachment(2);
    const cleanSecondCaption =
      (options?.secondCaptionText ?? waSettings.secondMessageTemplate).trim() ||
      DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY;
    await sendSingleWhatsAppAttachmentOrText(jid, cleanSecondCaption, secondAttachment);
    sentCount += 1;
  }

  // Message 3: Third Separate Attachment (Video / PDF / Image / Any File) + Text Confirmation
  if (shouldSendThird) {
    if (sentCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1400));
    }
    const thirdAttachment = resolveSlotAttachment(3);
    const cleanThirdCaption =
      (options?.thirdCaptionText ?? waSettings.thirdMessageTemplate).trim() ||
      DEFAULT_PRESTAIR_THIRD_WHATSAPP_REPLY;
    await sendSingleWhatsAppAttachmentOrText(jid, cleanThirdCaption, thirdAttachment);
    sentCount += 1;
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
  if (
    !waSettings.firstMessageEnabled &&
    !waSettings.secondMessageEnabled &&
    !waSettings.thirdMessageEnabled
  ) {
    return false;
  }
  if (inFlightLeadWaDispatches.has(lead.leadId)) return true;

  const messageText = buildWhatsAppConfirmationMessage(lead, waSettings.messageTemplate);
  const secondMessageText = buildWhatsAppConfirmationMessage(
    lead,
    waSettings.secondMessageTemplate
  );
  const thirdMessageText = buildWhatsAppConfirmationMessage(
    lead,
    waSettings.thirdMessageTemplate
  );

  if (waState.status === 'connected' && waSocket) {
    inFlightLeadWaDispatches.add(lead.leadId);
    void (async () => {
      try {
        await sendPrestairWhatsAppReplyWithSingleImage(lead.phone, messageText, {
          sendFirst: waSettings.firstMessageEnabled,
          sendSecond: waSettings.secondMessageEnabled,
          secondCaptionText: secondMessageText,
          sendThird: waSettings.thirdMessageEnabled,
          thirdCaptionText: thirdMessageText,
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
      sendFirst: waSettings.firstMessageEnabled,
      text: messageText,
      sendSecond: waSettings.secondMessageEnabled,
      secondText: secondMessageText,
      sendThird: waSettings.thirdMessageEnabled,
      thirdText: thirdMessageText,
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

  // Auto-resume saved/cloud-encrypted WhatsApp session (Production/Railway gets priority at 2.5s; Dev waits 6.5s so Railway leads 24x7)
  setTimeout(
    () => {
      void tryAutoResumeWhatsAppSafely();
    },
    isProduction ? 2500 : 6500
  ).unref();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32mb' }));

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

      const activeCount =
        (waSettings.firstMessageEnabled ? 1 : 0) +
        (waSettings.secondMessageEnabled ? 1 : 0) +
        (waSettings.thirdMessageEnabled ? 1 : 0);
      if (activeCount === 0) {
        res.status(400).json({
          error: 'Please enable at least 1 message (1, 2, or 3) in the WhatsApp tab first.',
        });
        return;
      }

      const messageText = buildWhatsAppConfirmationMessage(lead, waSettings.messageTemplate);
      const secondMessageText = buildWhatsAppConfirmationMessage(
        lead,
        waSettings.secondMessageTemplate
      );
      const thirdMessageText = buildWhatsAppConfirmationMessage(
        lead,
        waSettings.thirdMessageTemplate
      );

      if (waState.status === 'connected' && waSocket) {
        void (async () => {
          try {
            await sendPrestairWhatsAppReplyWithSingleImage(lead.phone, messageText, {
              sendFirst: waSettings.firstMessageEnabled,
              sendSecond: waSettings.secondMessageEnabled,
              secondCaptionText: secondMessageText,
              sendThird: waSettings.thirdMessageEnabled,
              thirdCaptionText: thirdMessageText,
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
        res.json({ ok: true, relayedViaCloud: false, activeCount });
        return;
      }

      if (isRemoteCloudWorkerActive()) {
        const queued = await enqueueCloudWaDispatchJob({
          phone: lead.phone,
          sendFirst: waSettings.firstMessageEnabled,
          text: messageText,
          sendSecond: waSettings.secondMessageEnabled,
          secondText: secondMessageText,
          sendThird: waSettings.thirdMessageEnabled,
          thirdText: thirdMessageText,
          leadId: lead.leadId,
        });
        if (queued) {
          res.json({ ok: true, relayedViaCloud: true, activeCount });
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
        firstMessageEnabled: waSettings.firstMessageEnabled,
        messageTemplate: waSettings.messageTemplate,
        secondMessageEnabled: waSettings.secondMessageEnabled,
        secondMessageTemplate: waSettings.secondMessageTemplate,
        thirdMessageEnabled: waSettings.thirdMessageEnabled,
        thirdMessageTemplate: waSettings.thirdMessageTemplate,
        adminNotifyPhone: waSettings.adminNotifyPhone,
      },
      replyImage: getReplyImageStatusPayload(waReplyImage),
      replyImage2: getReplyImageStatusPayload(waReplyImage2),
      replyVideo3: getReplyVideoStatusPayload(waReplyVideo3),
      slotMedia: getAllSlotsStatusPayload(),
    });
  });

  app.post('/api/whatsapp/connect', requireAdminAuth, async (req: Request, res: Response) => {
    const pairingPhone =
      typeof req.body?.pairingPhone === 'string' ? req.body.pairingPhone.trim() : '';
    if (!pairingPhone) {
      await refreshRemoteWaRuntimeFromRtdb();
      if (isRemoteCloudWorkerActive()) {
        // Remote 24x7 server is already connected—do not steal or disrupt its socket!
        res.json({
          ok: true,
          cloudWorkerConnected: true,
          cloudConnectedNumber: remoteWaRuntime?.connectedNumber ?? null,
        });
        return;
      }
    }

    // Wait briefly if an earlier socket setup is finishing its lock
    const lockWaitDeadline = Date.now() + 2500;
    while (waConnectLock && Date.now() < lockWaitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    void startWhatsAppConnection(pairingPhone);

    // Wait up to 6s so QR or 8-char Pairing Code is returned immediately in this response
    const readyDeadline = Date.now() + 6000;
    while (Date.now() < readyDeadline) {
      if (
        waState.status === 'connected' ||
        (pairingPhone && Boolean(waState.pairingCode)) ||
        (!pairingPhone && Boolean(waState.qrDataUrl)) ||
        Boolean(waState.lastError)
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    res.json({
      ok: true,
      status: waState.status,
      qrDataUrl: waState.qrDataUrl,
      pairingCode: waState.pairingCode,
      connectedNumber: waState.connectedNumber,
      lastError: waState.lastError,
    });
  });

  app.post('/api/whatsapp/disconnect', requireAdminAuth, async (_req: Request, res: Response) => {
    explicitUnlinkRequested = true;
    localWaVaultSyncedAt = 0;
    if (waVaultPushTimer) {
      clearTimeout(waVaultPushTimer);
      waVaultPushTimer = null;
    }
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
    if (rtdbInstance) {
      void remove(ref(rtdbInstance, 'meta/waAuthVault')).catch(() => {});
      if (remoteWaRuntime?.instanceId === SERVER_INSTANCE_ID) {
        void remove(ref(rtdbInstance, 'meta/waRuntimeStatus')).catch(() => {});
      }
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
      firstMessageEnabled:
        typeof body.firstMessageEnabled === 'boolean'
          ? body.firstMessageEnabled
          : waSettings.firstMessageEnabled,
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
      thirdMessageEnabled:
        typeof body.thirdMessageEnabled === 'boolean'
          ? body.thirdMessageEnabled
          : waSettings.thirdMessageEnabled,
      thirdMessageTemplate:
        typeof body.thirdMessageTemplate === 'string' && body.thirdMessageTemplate.trim()
          ? body.thirdMessageTemplate.slice(0, 4000)
          : DEFAULT_PRESTAIR_THIRD_WHATSAPP_REPLY,
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

  app.get(
    '/api/whatsapp/reply-video',
    requireAdminAuth,
    async (_req: Request, res: Response) => {
      res.setHeader('Cache-Control', 'no-store');
      await ensureWaMetaHydratedFromRtdb();
      const status = getReplyVideoStatusPayload(waReplyVideo3);
      res.json({
        ok: true,
        ...status,
        dataUrl:
          status.hasVideo && waReplyVideo3.mimeType && waReplyVideo3.base64Data
            ? `data:${waReplyVideo3.mimeType};base64,${waReplyVideo3.base64Data}`
            : null,
      });
    }
  );

  app.post(
    '/api/whatsapp/reply-video',
    requireAdminAuth,
    async (req: Request, res: Response) => {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
        string,
        unknown
      >;
      const rawMode = body.mode;
      if (rawMode !== 'custom' && rawMode !== 'none') {
        res.status(400).json({ error: 'Invalid video mode.' });
        return;
      }

      if (rawMode === 'custom') {
        const rawDataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
        const validated = parseAndValidateReplyVideoDataUrl(rawDataUrl);
        if (!validated.valid) {
          res.status(400).json({ error: validated.error });
          return;
        }
        waReplyVideo3 = {
          mode: 'custom',
          mimeType: validated.mimeType,
          fileName: sanitizeVideoFileName(body.fileName),
          byteLength: validated.byteLength,
          base64Data: validated.base64Data,
          updatedAt: Date.now(),
        };
      } else {
        waReplyVideo3 = {
          mode: 'none',
          mimeType: '',
          fileName: '',
          byteLength: 0,
          base64Data: '',
          updatedAt: Date.now(),
        };
      }

      persistWaReplyVideo3Local();
      await pushWaReplyVideo3ToRtdb();

      res.json({
        ok: true,
        replyVideo3: getReplyVideoStatusPayload(waReplyVideo3),
      });
    }
  );

  // Unified 3-Slot Universal File Endpoints (Accepts PDF, Image, Video, Office, ZIP, CAD, or any valid file up to 25 MB)
  app.get(
    '/api/whatsapp/slot-media/:slot',
    requireAdminAuth,
    async (req: Request, res: Response) => {
      const slot = parseValidSlotNumber(req.params.slot);
      if (!slot) {
        res.status(400).json({ error: 'Invalid message slot. Use 1, 2, or 3.' });
        return;
      }

      await ensureWaMetaHydratedFromRtdb();
      const resolved = resolveSlotAttachment(slot);
      if (!resolved) {
        res.status(404).json({ error: `No file attached to Message ${slot}.` });
        return;
      }

      const safeDownloadName = sanitizeAttachmentFileName(resolved.fileName).replace(/"/g, '_');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      res.setHeader('Content-Type', resolved.mimeType || 'application/octet-stream');
      res.setHeader('Content-Length', String(resolved.buffer.length));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeDownloadName}"; filename*=UTF-8''${encodeURIComponent(
          safeDownloadName
        )}`
      );
      res.end(resolved.buffer);
    }
  );

  app.post(
    '/api/whatsapp/slot-media/:slot',
    requireAdminAuth,
    express.raw({ type: 'application/octet-stream', limit: '26mb' }),
    async (req: Request, res: Response) => {
      const slot = parseValidSlotNumber(req.params.slot);
      if (!slot) {
        res.status(400).json({ error: 'Invalid message slot. Use 1, 2, or 3.' });
        return;
      }

      const rawBuf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const rawFileNameHeader = req.headers['x-file-name'];
      const rawFileMimeHeader = req.headers['x-file-mime'];

      const validated = detectAndValidateAttachment(
        rawBuf,
        Array.isArray(rawFileMimeHeader) ? rawFileMimeHeader[0] : rawFileMimeHeader,
        Array.isArray(rawFileNameHeader) ? rawFileNameHeader[0] : rawFileNameHeader
      );
      if (!validated.valid) {
        res.status(400).json({ error: validated.error });
        return;
      }

      const now = Date.now();
      writeBinaryFileSafe(getSlotPaths(slot).binPath, rawBuf);
      waSlotMedia[slot] = {
        mode: 'custom',
        mimeType: validated.mimeType,
        fileName: validated.fileName,
        byteLength: validated.byteLength,
        category: validated.category,
        updatedAt: now,
      };
      persistWaSlotMetaLocal(slot, waSlotMedia[slot]);

      // Auto-enable this message slot in WhatsApp settings so the uploaded PDF/Image/Video/Doc is active immediately
      let settingsChanged = false;
      if (slot === 1 && !waSettings.firstMessageEnabled) {
        waSettings = { ...waSettings, firstMessageEnabled: true, updatedAt: now };
        settingsChanged = true;
      } else if (slot === 2 && !waSettings.secondMessageEnabled) {
        waSettings = { ...waSettings, secondMessageEnabled: true, updatedAt: now };
        settingsChanged = true;
      } else if (slot === 3 && !waSettings.thirdMessageEnabled) {
        waSettings = { ...waSettings, thirdMessageEnabled: true, updatedAt: now };
        settingsChanged = true;
      }
      if (settingsChanged) {
        persistWaSettingsLocal();
        void pushWaSettingsToRtdb();
      }

      // Mirror standard <= 2MB raster images into legacy waReplyImage / waReplyImage2 for Showcase tab compatibility
      if (
        (slot === 1 || slot === 2) &&
        (validated.mimeType === 'image/jpeg' ||
          validated.mimeType === 'image/png' ||
          validated.mimeType === 'image/webp') &&
        rawBuf.length <= MAX_REPLY_IMAGE_BYTES
      ) {
        const legacyState: WhatsAppReplyImageState = {
          mode: 'custom',
          mimeType: validated.mimeType,
          base64Data: rawBuf.toString('base64'),
          updatedAt: now,
        };
        if (slot === 1) {
          waReplyImage = legacyState;
          persistWaReplyImageLocal();
          void pushWaReplyImageToRtdb();
        } else {
          waReplyImage2 = legacyState;
          persistWaReplyImage2Local();
          void pushWaReplyImage2ToRtdb();
        }
      }

      // Sync chunked binary to Firebase RTDB (race with 1.2s so Admin UI responds fast even for 20 MB files)
      const syncPromise = pushWaSlotMediaToRtdb(slot);
      await Promise.race([
        syncPromise,
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);

      res.json({
        ok: true,
        slot,
        slotMedia: getAllSlotsStatusPayload(),
        settings: {
          autoReplyEnabled: waSettings.autoReplyEnabled,
          firstMessageEnabled: waSettings.firstMessageEnabled,
          messageTemplate: waSettings.messageTemplate,
          secondMessageEnabled: waSettings.secondMessageEnabled,
          secondMessageTemplate: waSettings.secondMessageTemplate,
          thirdMessageEnabled: waSettings.thirdMessageEnabled,
          thirdMessageTemplate: waSettings.thirdMessageTemplate,
          adminNotifyPhone: waSettings.adminNotifyPhone,
        },
        replyImage: getReplyImageStatusPayload(waReplyImage),
        replyImage2: getReplyImageStatusPayload(waReplyImage2),
      });
    }
  );

  app.post(
    '/api/whatsapp/slot-media/:slot/mode',
    requireAdminAuth,
    async (req: Request, res: Response) => {
      const slot = parseValidSlotNumber(req.params.slot);
      if (!slot) {
        res.status(400).json({ error: 'Invalid message slot. Use 1, 2, or 3.' });
        return;
      }

      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
        string,
        unknown
      >;
      const rawMode = body.mode;
      if (rawMode !== 'default' && rawMode !== 'none' && rawMode !== 'custom') {
        res.status(400).json({ error: 'Invalid slot mode.' });
        return;
      }

      if (rawMode === 'default' && slot === 3) {
        res.status(400).json({ error: 'Message 3 does not have a built-in default image. Upload any file or choose No File.' });
        return;
      }

      const now = Date.now();
      if (rawMode === 'custom') {
        // Used by built-in Canvas Image Editor ('Apply & Save Image')
        const rawDataUrl = typeof body.dataUrl === 'string' ? body.dataUrl : '';
        const parsedImg = parseAndValidateReplyImageDataUrl(rawDataUrl);
        if (!parsedImg.valid) {
          res.status(400).json({ error: parsedImg.error });
          return;
        }
        const imgBuf = Buffer.from(parsedImg.base64Data, 'base64');
        const ext = parsedImg.mimeType === 'image/png' ? '.png' : parsedImg.mimeType === 'image/webp' ? '.webp' : '.jpg';
        const cleanName = sanitizeAttachmentFileName(body.fileName || `prestair-edited-${slot}${ext}`, ext);

        writeBinaryFileSafe(getSlotPaths(slot).binPath, imgBuf);
        waSlotMedia[slot] = {
          mode: 'custom',
          mimeType: parsedImg.mimeType,
          fileName: cleanName,
          byteLength: imgBuf.length,
          category: 'image',
          updatedAt: now,
        };
        persistWaSlotMetaLocal(slot, waSlotMedia[slot]);

        if (slot === 1 || slot === 2) {
          const legacyState: WhatsAppReplyImageState = {
            mode: 'custom',
            mimeType: parsedImg.mimeType,
            base64Data: parsedImg.base64Data,
            updatedAt: now,
          };
          if (slot === 1) {
            waReplyImage = legacyState;
            persistWaReplyImageLocal();
            void pushWaReplyImageToRtdb();
          } else {
            waReplyImage2 = legacyState;
            persistWaReplyImage2Local();
            void pushWaReplyImage2ToRtdb();
          }
        }
      } else {
        removeSlotBinarySafe(slot);
        waSlotMedia[slot] = {
          mode: rawMode,
          mimeType: '',
          fileName: '',
          byteLength: 0,
          category: slot === 3 ? 'document' : 'image',
          updatedAt: now,
        };
        persistWaSlotMetaLocal(slot, waSlotMedia[slot]);

        if (slot === 1) {
          waReplyImage = {
            mode: rawMode,
            mimeType: '',
            base64Data: '',
            updatedAt: now,
          };
          persistWaReplyImageLocal();
          void pushWaReplyImageToRtdb();
        } else if (slot === 2) {
          waReplyImage2 = {
            mode: rawMode,
            mimeType: '',
            base64Data: '',
            updatedAt: now,
          };
          persistWaReplyImage2Local();
          void pushWaReplyImage2ToRtdb();
        } else if (slot === 3) {
          waReplyVideo3 = {
            mode: 'none',
            mimeType: '',
            fileName: '',
            byteLength: 0,
            base64Data: '',
            updatedAt: now,
          };
          persistWaReplyVideo3Local();
          void pushWaReplyVideo3ToRtdb();
        }
      }

      await Promise.race([
        pushWaSlotMediaToRtdb(slot),
        new Promise((resolve) => setTimeout(resolve, 1200)),
      ]);

      res.json({
        ok: true,
        slot,
        slotMedia: getAllSlotsStatusPayload(),
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
      const sendFirst =
        typeof req.body?.sendFirst === 'boolean'
          ? req.body.sendFirst
          : waSettings.firstMessageEnabled;
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
      const sendThird =
        typeof req.body?.sendThird === 'boolean'
          ? req.body.sendThird
          : waSettings.thirdMessageEnabled;
      const thirdText =
        typeof req.body?.thirdText === 'string' && req.body.thirdText.trim()
          ? req.body.thirdText.slice(0, 4000)
          : waSettings.thirdMessageTemplate;

      const digits = normalizePhoneForWhatsApp(phone);
      if (!digits || digits.length < 8) {
        res.status(400).json({ error: 'Please enter a valid WhatsApp phone number.' });
        return;
      }

      if (!sendFirst && !sendSecond && !sendThird) {
        res.status(400).json({
          error: 'Please select at least 1 message (1, 2, or 3) before sending a test.',
        });
        return;
      }

      const activeCount = (sendFirst ? 1 : 0) + (sendSecond ? 1 : 0) + (sendThird ? 1 : 0);

      if (waState.status === 'connected' && waSocket) {
        try {
          await sendPrestairWhatsAppReplyWithSingleImage(phone, text, {
            sendFirst,
            sendSecond,
            secondCaptionText: secondText,
            sendThird,
            thirdCaptionText: thirdText,
          });
          res.json({ ok: true, relayedViaCloud: false, activeCount });
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
          sendFirst,
          text,
          sendSecond,
          secondText,
          sendThird,
          thirdText,
        });
        if (queued) {
          res.json({ ok: true, relayedViaCloud: true, activeCount });
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
    if (waVaultPushTimer) {
      clearTimeout(waVaultPushTimer);
      waVaultPushTimer = null;
    }
    backupWhatsAppCredsSafe();
    cleanupActiveSocketOnly();
    void (async () => {
      if (rtdbInstance && wasConnectedHere) {
        await pushWaAuthVaultToRtdbImmediate().catch(() => {});
        await remove(ref(rtdbInstance, 'meta/waRuntimeStatus')).catch(() => {});
      }
      httpServer.close(() => {
        process.exit(0);
      });
    })();
    setTimeout(() => process.exit(0), 3500).unref();
  };

  process.on('SIGTERM', handleGracefulShutdown);
  process.on('SIGINT', handleGracefulShutdown);
}

void startServer();

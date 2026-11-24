import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import { initializeApp as initFirebaseServerApp } from 'firebase/app';
import {
  getDatabase as getServerRtdb,
  onValue as onServerRtdbValue,
  ref as serverRtdbRef,
  remove as removeServerRtdb,
  set as setServerRtdb,
  update as updateServerRtdb,
  type Database as FirebaseRtdbDatabase,
} from 'firebase/database';
import {
  buildWhatsAppConfirmationMessage,
  DEFAULT_PRESTAIR_WHATSAPP_REPLY,
  formatLeadForSheetRow,
  generateLeadId,
  hasAnyLeadContent,
  LEAD_FIELD_LIMITS,
  normalizeLeadRecord,
  normalizePhoneForWhatsApp,
  sanitizeField,
  sanitizeLeadInput,
  type LeadRecord,
} from './src/utils/leadLogic';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

const DATA_DIR = path.resolve(process.cwd(), './data');
const WHATSAPP_AUTH_DIR = path.resolve(process.cwd(), './data/whatsapp_auth');

// Guard process stability without ever wiping saved WhatsApp credentials on transient Signal errors
process.on('unhandledRejection', (reason: any) => {
  const msg = String(reason?.message || reason);
  if (msg.includes('Bad MAC') || msg.includes('decrypt') || msg.includes('Bad Decrypt')) {
    console.warn('Ignored transient Baileys Signal decryption warning (session preserved):', msg);
    return;
  }
  console.error('Unhandled Rejection:', reason);
});

const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const DELETED_LEADS_FILE = path.join(DATA_DIR, 'deleted-leads.json');
const ADMIN_AUTH_FILE = path.join(DATA_DIR, 'admin-auth.json');
const ADMIN_SESSIONS_FILE = path.join(DATA_DIR, 'admin-sessions.json');
const WA_SETTINGS_FILE = path.join(DATA_DIR, 'whatsapp-settings.json');
const SHEET_SYNC_FILE = path.join(DATA_DIR, 'sheet-sync-settings.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });

// --- Permanent Deleted Lead Tombstones (Prevents Deleted Leads From Resurrecting) ---
const LEGACY_SEED_IDS = [
  'lead_seed_101',
  'lead_seed_102',
  'lead_seed_103',
  'lead_seed_104',
];

function loadDeletedLeadIds(): Set<string> {
  const set = new Set<string>(LEGACY_SEED_IDS);
  try {
    if (fs.existsSync(DELETED_LEADS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DELETED_LEADS_FILE, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && id.trim()) {
            set.add(id.trim());
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return set;
}

function saveDeletedLeadIds(set: Set<string>): void {
  try {
    const tmp = `${DELETED_LEADS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Array.from(set), null, 2), 'utf8');
    fs.renameSync(tmp, DELETED_LEADS_FILE);
  } catch (err) {
    console.error('Failed to persist deleted-leads.json:', err);
  }
}

const deletedLeadIds: Set<string> = loadDeletedLeadIds();
saveDeletedLeadIds(deletedLeadIds);

function loadLeads(): LeadRecord[] {
  try {
    if (fs.existsSync(LEADS_FILE)) {
      const raw = fs.readFileSync(LEADS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const filtered = parsed
          .map((item) => normalizeLeadRecord(item))
          .filter((item) => !deletedLeadIds.has(item.leadId));
        if (filtered.length !== parsed.length) {
          saveLeads(filtered);
        }
        return filtered;
      }
    }
  } catch (err) {
    console.error('Failed to read leads.json:', err);
  }
  saveLeads([]);
  return [];
}

function saveLeads(leads: LeadRecord[]): void {
  try {
    const clean = leads.filter((l) => !deletedLeadIds.has(l.leadId));
    const tmpFile = `${LEADS_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(clean, null, 2), 'utf8');
    fs.renameSync(tmpFile, LEADS_FILE);
  } catch (err) {
    console.error('Failed to persist leads.json:', err);
  }
}

let leadsStore: LeadRecord[] = loadLeads();

// --- Sub-Millisecond Admin Server-Sent Events (SSE) Clients ---
const adminSseClients = new Set<Response>();

function getSortedLeadsSnapshot(): LeadRecord[] {
  return [...leadsStore]
    .filter((l) => !deletedLeadIds.has(l.leadId))
    .map((l) => normalizeLeadRecord(l))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

// --- Secure Admin Passcode & Persistent Server Session Management ---
interface AdminAuthRecord {
  salt: string;
  hash: string;
  createdAt: string;
}

interface PersistedSessionStore {
  tokenHashes: Record<string, { issuedAt: number; expiresAt: number }>;
}

function hashSessionToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

function loadSessionStore(): Map<string, { issuedAt: number; expiresAt: number }> {
  const map = new Map<string, { issuedAt: number; expiresAt: number }>();
  try {
    if (fs.existsSync(ADMIN_SESSIONS_FILE)) {
      const parsed = JSON.parse(
        fs.readFileSync(ADMIN_SESSIONS_FILE, 'utf8')
      ) as Partial<PersistedSessionStore>;
      const now = Date.now();
      if (parsed.tokenHashes && typeof parsed.tokenHashes === 'object') {
        for (const [tokenHash, meta] of Object.entries(parsed.tokenHashes)) {
          if (
            /^[0-9a-f]{64}$/i.test(tokenHash) &&
            meta &&
            typeof meta.expiresAt === 'number' &&
            meta.expiresAt > now
          ) {
            map.set(tokenHash.toLowerCase(), {
              issuedAt: meta.issuedAt || now,
              expiresAt: meta.expiresAt,
            });
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return map;
}

const activeAdminTokenHashes = loadSessionStore();

function saveSessionStore(): void {
  try {
    const now = Date.now();
    const tokenHashes: Record<string, { issuedAt: number; expiresAt: number }> = {};
    for (const [tokenHash, meta] of activeAdminTokenHashes.entries()) {
      if (meta.expiresAt > now) {
        tokenHashes[tokenHash] = meta;
      }
    }
    const tmp = `${ADMIN_SESSIONS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tokenHashes }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, ADMIN_SESSIONS_FILE);
  } catch {
    // ignore
  }
}
saveSessionStore();

const failedLoginAttempts = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;

function checkLoginRateLimit(ip: string): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const entry = failedLoginAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    return { allowed: true, retryAfterSec: 0 };
  }
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function recordFailedLogin(ip: string): void {
  const now = Date.now();
  const entry = failedLoginAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    failedLoginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearFailedLogins(ip: string): void {
  failedLoginAttempts.delete(ip);
}

function getEnvAdminPasscode(): string {
  const raw =
    typeof process.env.PRESTIER_ADMIN_PIN === 'string' ? process.env.PRESTIER_ADMIN_PIN.trim() : '';
  if (!raw || raw === 'MY_PRESTIER_ADMIN_PIN' || raw === 'YOUR_PRESTIER_ADMIN_PIN') {
    return '';
  }
  return raw;
}

function loadClaimedAdminAuth(): AdminAuthRecord | null {
  try {
    if (!fs.existsSync(ADMIN_AUTH_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(ADMIN_AUTH_FILE, 'utf8'));
    if (
      parsed &&
      typeof parsed.salt === 'string' &&
      /^[0-9a-f]{32}$/i.test(parsed.salt) &&
      typeof parsed.hash === 'string' &&
      /^[0-9a-f]{128}$/i.test(parsed.hash)
    ) {
      return {
        salt: parsed.salt,
        hash: parsed.hash,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      };
    }
  } catch {
    // ignore invalid file
  }
  return null;
}

function hasConfiguredAdminPasscode(): boolean {
  return Boolean(getEnvAdminPasscode()) || Boolean(loadClaimedAdminAuth());
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyAdminPassword(candidate: string): boolean {
  if (!candidate) return false;

  // Configured process.env.ADMIN_PASSCODE always overrides any claimed fallback hash
  const envPasscode = getEnvAdminPasscode();
  if (envPasscode) {
    const candidateDigest = crypto.createHash('sha256').update(candidate, 'utf8').digest();
    const expectedDigest = crypto.createHash('sha256').update(envPasscode, 'utf8').digest();
    return crypto.timingSafeEqual(candidateDigest, expectedDigest);
  }

  const claimed = loadClaimedAdminAuth();
  if (!claimed) return false;

  const candidateHashBuf = crypto.scryptSync(candidate, claimed.salt, 64);
  const expectedHashBuf = Buffer.from(claimed.hash, 'hex');
  if (candidateHashBuf.length !== expectedHashBuf.length) return false;
  return crypto.timingSafeEqual(candidateHashBuf, expectedHashBuf);
}

function issueAdminToken(): string {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const now = Date.now();
  activeAdminTokenHashes.set(tokenHash, {
    issuedAt: now,
    expiresAt: now + 1000 * 60 * 60 * 12, // 12 hours
  });
  saveSessionStore();
  return rawToken;
}

function verifyAdminToken(token: string | undefined): boolean {
  if (!token || typeof token !== 'string' || !/^[0-9a-f]{64}$/i.test(token)) {
    return false;
  }
  const tokenHash = hashSessionToken(token);
  const session = activeAdminTokenHashes.get(tokenHash);
  if (!session) return false;
  if (Date.now() >= session.expiresAt) {
    activeAdminTokenHashes.delete(tokenHash);
    saveSessionStore();
    return false;
  }
  return true;
}

function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!verifyAdminToken(token)) {
    return res.status(401).json({ error: 'Admin password required.' });
  }
  return next();
}

// --- 24x7 Persistent WhatsApp Engine (Baileys Multi-Device) ---
interface WhatsAppSettings {
  autoReplyEnabled: boolean;
  messageTemplate: string;
  adminNotifyPhone: string;
}

const DEFAULT_WA_SETTINGS: WhatsAppSettings = {
  autoReplyEnabled: true,
  messageTemplate: DEFAULT_PRESTAIR_WHATSAPP_REPLY,
  adminNotifyPhone: '',
};

function loadWhatsAppSettings(): WhatsAppSettings {
  try {
    if (fs.existsSync(WA_SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(WA_SETTINGS_FILE, 'utf8'));
      const rawTemplate = typeof parsed.messageTemplate === 'string' ? parsed.messageTemplate.trim() : '';
      const isLegacyTemplate =
        !rawTemplate || rawTemplate.includes('Precision Stainless Steel Manufacturing');
      const finalTemplate = isLegacyTemplate ? DEFAULT_WA_SETTINGS.messageTemplate : rawTemplate;
      const loaded: WhatsAppSettings = {
        autoReplyEnabled:
          typeof parsed.autoReplyEnabled === 'boolean' ? parsed.autoReplyEnabled : true,
        messageTemplate: finalTemplate,
        adminNotifyPhone: typeof parsed.adminNotifyPhone === 'string' ? parsed.adminNotifyPhone : '',
      };
      if (isLegacyTemplate) {
        saveWhatsAppSettings(loaded);
      }
      return loaded;
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_WA_SETTINGS };
}

function saveWhatsAppSettings(settings: WhatsAppSettings): void {
  try {
    fs.writeFileSync(WA_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist WhatsApp settings:', err);
  }
}

let waSettings: WhatsAppSettings = loadWhatsAppSettings();

type WAConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_ready'
  | 'pairing_ready'
  | 'connected';

interface WAState {
  status: WAConnectionStatus;
  qrDataUrl: string | null;
  pairingCode: string | null;
  connectedNumber: string | null;
  connectedName: string | null;
  lastConnectedAt: string | null;
  reconnectAttempts: number;
  lastError: string | null;
  hasSavedSession: boolean;
}

const waState: WAState = {
  status: 'disconnected',
  qrDataUrl: null,
  pairingCode: null,
  connectedNumber: null,
  connectedName: null,
  lastConnectedAt: null,
  reconnectAttempts: 0,
  lastError: null,
  hasSavedSession: fs.existsSync(path.join(WHATSAPP_AUTH_DIR, 'creds.json')),
};

let waSocket: WASocket | null = null;
let waReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let waKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
let waStarting = false;
let credSaveChain: Promise<void> = Promise.resolve();

const waLogger = pino({ level: 'silent' });

// Preload single Prestair showcase image for instant zero-latency background WhatsApp sending
const PRESTAIR_MEDIA_PATHS = [
  path.resolve(process.cwd(), 'public/assets/aistudio/image_667a0296.png'),
];

function getPrestairMediaBuffers(): Buffer[] {
  const buffers: Buffer[] = [];
  for (const p of PRESTAIR_MEDIA_PATHS) {
    try {
      if (fs.existsSync(p)) {
        buffers.push(fs.readFileSync(p));
      }
    } catch (err) {
      console.error('Failed reading WhatsApp attachment image:', p, err);
    }
  }
  return buffers;
}

async function startWhatsAppEngine(pairingPhone?: string): Promise<void> {
  if (waStarting) return;
  waStarting = true;

  if (waReconnectTimer) {
    clearTimeout(waReconnectTimer);
    waReconnectTimer = null;
  }

  try {
    waState.status = 'connecting';
    waState.lastError = null;
    waState.qrDataUrl = null;
    waState.pairingCode = null;

    fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
    const authStateResult = await useMultiFileAuthState(WHATSAPP_AUTH_DIR);
    const { state, saveCreds } = authStateResult;
    waState.hasSavedSession = fs.existsSync(path.join(WHATSAPP_AUTH_DIR, 'creds.json'));

    let version: [number, number, number] = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) {
        version = latest.version;
      }
    } catch {
      // Fallback to stable known WA Web version
    }

    const sock = makeWASocket({
      version,
      auth: state,
      logger: waLogger,
      printQRInTerminal: false,
      browser: ['Prestier System LLP', 'Chrome', '124.0.0'],
      markOnlineOnConnect: true,
      syncFullHistory: false,
      keepAliveIntervalMs: 20_000,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 45_000,
      retryRequestDelayMs: 1_500,
    });

    waSocket = sock;

    sock.ev.on('creds.update', () => {
      credSaveChain = credSaveChain
        .then(async () => {
          await saveCreds();
          waState.hasSavedSession = fs.existsSync(path.join(WHATSAPP_AUTH_DIR, 'creds.json'));
        })
        .catch((err) => {
          console.error('Failed saving WhatsApp creds:', err);
        });
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          waState.qrDataUrl = await QRCode.toDataURL(qr, {
            width: 280,
            margin: 2,
            color: { dark: '#0F172A', light: '#FFFFFF' },
          });
          waState.status = 'qr_ready';
          waState.lastError = null;
        } catch (err) {
          console.error('QR generation failed:', err);
        }
      }

      if (connection === 'open') {
        waState.status = 'connected';
        waState.qrDataUrl = null;
        waState.pairingCode = null;
        waState.reconnectAttempts = 0;
        waState.lastError = null;
        waState.lastConnectedAt = new Date().toISOString();
        waState.hasSavedSession = true;
        const userId = sock.user?.id || '';
        waState.connectedNumber = userId ? userId.split(':')[0].split('@')[0] : 'Linked Device';
        waState.connectedName = sock.user?.name || 'Prestier WhatsApp';

        if (waKeepaliveTimer) clearInterval(waKeepaliveTimer);
        waKeepaliveTimer = setInterval(async () => {
          try {
            if (waSocket && waState.status === 'connected') {
              await waSocket.sendPresenceUpdate('available');
            }
          } catch {
            // Transient presence ping error; connection.update handles reconnects
          }
        }, 3 * 60 * 1000);
      }

      if (connection === 'close') {
        if (waKeepaliveTimer) {
          clearInterval(waKeepaliveTimer);
          waKeepaliveTimer = null;
        }

        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const isExplicitLogout = statusCode === DisconnectReason.loggedOut;

        if (isExplicitLogout) {
          waState.status = 'disconnected';
          waState.connectedNumber = null;
          waState.connectedName = null;
          waState.qrDataUrl = null;
          waState.pairingCode = null;
          waState.lastError =
            'Device was explicitly unlinked from WhatsApp mobile. Scan QR to link again.';
          waSocket = null;
          try {
            fs.rmSync(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
          } catch {
            // ignore
          }
          waState.hasSavedSession = false;
        } else {
          // 24x7 persistent auto-reconnect without ever logging out
          waState.reconnectAttempts += 1;
          waState.status = 'connecting';
          const isRestartRequired = statusCode === DisconnectReason.restartRequired;
          const delayMs = isRestartRequired
            ? 500
            : Math.min(15_000, 1_500 * Math.pow(1.4, Math.min(waState.reconnectAttempts, 6)));
          waState.lastError = `Reconnecting 24x7 session automatically in ${Math.max(1, Math.round(delayMs / 1000))}s...`;
          waSocket = null;
          waReconnectTimer = setTimeout(() => {
            startWhatsAppEngine().catch(() => {});
          }, delayMs);
        }
      }
    });

    if (pairingPhone && !state.creds.registered) {
      const normalized = normalizePhoneForWhatsApp(pairingPhone);
      if (normalized.length >= 10) {
        setTimeout(async () => {
          try {
            if (waSocket && typeof waSocket.requestPairingCode === 'function') {
              const code = await waSocket.requestPairingCode(normalized);
              waState.pairingCode = code;
              waState.status = 'pairing_ready';
            }
          } catch (err: any) {
            waState.lastError =
              err?.message || 'Unable to generate pairing code right now. Use QR scan instead.';
          }
        }, 2500);
      }
    }
  } catch (err: any) {
    waState.status = 'disconnected';
    waState.lastError = err?.message || 'Unable to connect to WhatsApp servers right now.';
  } finally {
    waStarting = false;
  }
}

async function waitForWhatsAppConnected(maxWaitMs = 6000): Promise<boolean> {
  if (waSocket && waState.status === 'connected') return true;
  if (waState.hasSavedSession && waState.status !== 'connected' && !waStarting) {
    startWhatsAppEngine().catch(() => {});
  }
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 400));
    if (waSocket && waState.status === 'connected') return true;
  }
  return Boolean(waSocket && waState.status === 'connected');
}

async function sendWhatsAppCustomerReply(phone: string, captionText: string): Promise<boolean> {
  const ready = await waitForWhatsAppConnected(6000);
  if (!ready || !waSocket) {
    return false;
  }
  const normalized = normalizePhoneForWhatsApp(phone);
  if (!normalized) return false;

  try {
    const jid = `${normalized}@s.whatsapp.net`;
    const mediaBuffers = getPrestairMediaBuffers();

    if (mediaBuffers.length > 0) {
      // Send strictly 1 Prestair showcase image with the full inquiry thank-you message as caption
      await waSocket.sendMessage(jid, {
        image: mediaBuffers[0],
        caption: captionText,
      });
    } else {
      await waSocket.sendMessage(jid, { text: captionText });
    }
    return true;
  } catch (err) {
    console.error('WhatsApp customer reply error:', err);
    return false;
  }
}

async function sendWhatsAppPlainText(phone: string, text: string): Promise<boolean> {
  const ready = await waitForWhatsAppConnected(4000);
  if (!ready || !waSocket) return false;
  const normalized = normalizePhoneForWhatsApp(phone);
  if (!normalized) return false;
  try {
    const jid = `${normalized}@s.whatsapp.net`;
    await waSocket.sendMessage(jid, { text });
    return true;
  } catch (err) {
    console.error('WhatsApp plain text send error:', err);
    return false;
  }
}

const inFlightWhatsAppLeads = new Set<string>();

function dispatchLeadWhatsAppInBackground(lead: LeadRecord): void {
  if (!lead.phone || inFlightWhatsAppLeads.has(lead.leadId)) return;
  inFlightWhatsAppLeads.add(lead.leadId);

  setImmediate(async () => {
    try {
      const message = buildWhatsAppConfirmationMessage(lead, waSettings.messageTemplate);
      const sent = await sendWhatsAppCustomerReply(lead.phone, message);
      if (sent) {
        const idx = leadsStore.findIndex((item) => item.leadId === lead.leadId);
        if (idx >= 0) {
          const updated: LeadRecord = {
            ...leadsStore[idx],
            whatsappSent: true,
            updatedAt: new Date().toISOString(),
          };
          leadsStore[idx] = updated;
          saveLeads(leadsStore);
          broadcastAdminSnapshot();
          void syncLeadToRtdbServer(updated);
          queueLeadForAppsScriptSync(updated, true);
        }
      }

      if (waSettings.adminNotifyPhone.trim()) {
        const interestsStr =
          lead.productInterest.length > 0 ? lead.productInterest.join(', ') : 'None';
        const adminAlert = [
          `New Prestier Lead Confirmed`,
          `Name: ${lead.name || '-'}`,
          `Designation: ${lead.designation || '-'}`,
          `Phone: ${lead.phone || '-'}`,
          `Company: ${lead.companyName || '-'}`,
          `City: ${lead.city || '-'}`,
          `Email: ${lead.emailAddress || '-'}`,
          `Outlets: ${lead.outletsCount || '-'}`,
          `Equipment: ${interestsStr}`,
        ].join('\n');
        await sendWhatsAppPlainText(waSettings.adminNotifyPhone, adminAlert);
      }
    } catch (err) {
      console.error('Background WhatsApp dispatch failed:', err);
    } finally {
      inFlightWhatsAppLeads.delete(lead.leadId);
    }
  });
}

// --- 24x7 Google Apps Script Live Google Sheet Sync Engine ---
interface SheetSyncSettings {
  enabled: boolean;
  webhookUrl: string;
  spreadsheetName: string;
  sheetName: string;
  spreadsheetUrl: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}

function getEnvAppsScriptUrl(): string {
  const raw =
    typeof process.env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL === 'string'
      ? process.env.GOOGLE_APPS_SCRIPT_WEBHOOK_URL.trim()
      : '';
  if (!raw) return '';
  return validateAppsScriptWebhookUrl(raw) || '';
}

function validateAppsScriptWebhookUrl(rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.hostname !== 'script.google.com') return null;
    if (!parsed.pathname.startsWith('/macros/s/')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function validateAppsScriptRedirectUrl(rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (
      parsed.hostname !== 'script.googleusercontent.com' &&
      parsed.hostname !== 'script.google.com'
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function loadSheetSyncSettings(): SheetSyncSettings {
  const envUrl = getEnvAppsScriptUrl();
  try {
    if (fs.existsSync(SHEET_SYNC_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SHEET_SYNC_FILE, 'utf8'));
      const savedUrl =
        typeof parsed?.webhookUrl === 'string'
          ? validateAppsScriptWebhookUrl(parsed.webhookUrl) || ''
          : '';
      const activeUrl = envUrl || savedUrl;
      return {
        enabled: typeof parsed?.enabled === 'boolean' ? parsed.enabled : Boolean(activeUrl),
        webhookUrl: activeUrl,
        spreadsheetName:
          typeof parsed?.spreadsheetName === 'string' ? parsed.spreadsheetName.slice(0, 200) : '',
        sheetName: typeof parsed?.sheetName === 'string' ? parsed.sheetName.slice(0, 120) : '',
        spreadsheetUrl:
          typeof parsed?.spreadsheetUrl === 'string' &&
          parsed.spreadsheetUrl.startsWith('https://docs.google.com/spreadsheets/')
            ? parsed.spreadsheetUrl.slice(0, 500)
            : '',
        lastSyncedAt: typeof parsed?.lastSyncedAt === 'string' ? parsed.lastSyncedAt : null,
        lastError: typeof parsed?.lastError === 'string' ? parsed.lastError : null,
      };
    }
  } catch {
    // ignore invalid file
  }
  return {
    enabled: Boolean(envUrl),
    webhookUrl: envUrl,
    spreadsheetName: '',
    sheetName: '',
    spreadsheetUrl: '',
    lastSyncedAt: null,
    lastError: null,
  };
}

function saveSheetSyncSettings(settings: SheetSyncSettings): void {
  try {
    const tmp = `${SHEET_SYNC_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(tmp, SHEET_SYNC_FILE);
  } catch (err) {
    console.error('Failed to persist sheet-sync-settings.json:', err);
  }
}

let sheetSyncSettings: SheetSyncSettings = loadSheetSyncSettings();
const pendingSheetSyncTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface AppsScriptResponse {
  ok: boolean;
  synced?: number;
  spreadsheetName?: string;
  sheetName?: string;
  spreadsheetUrl?: string;
  totalRows?: number;
  error?: string;
}

async function postToAppsScriptWebhook(
  webhookUrl: string,
  payload: Record<string, unknown>
): Promise<AppsScriptResponse> {
  const safeTarget = validateAppsScriptWebhookUrl(webhookUrl);
  if (!safeTarget) {
    return { ok: false, error: 'Invalid Google Apps Script Web App URL.' };
  }

  let res = await fetch(safeTarget, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  });

  // Safely follow Google Apps Script's standard 302 redirect to script.googleusercontent.com
  let redirectHops = 0;
  while ([301, 302, 303, 307, 308].includes(res.status) && redirectHops < 4) {
    const location = res.headers.get('location') || '';
    const safeRedirect = validateAppsScriptRedirectUrl(location);
    if (!safeRedirect) {
      return { ok: false, error: 'Unexpected redirect from Apps Script endpoint.' };
    }
    res = await fetch(safeRedirect, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    redirectHops += 1;
  }

  const text = await res.text();
  if (!res.ok) {
    return {
      ok: false,
      error: `Apps Script returned HTTP ${res.status}. Ensure "Who has access" is set to "Anyone".`,
    };
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.ok === 'boolean') {
      return parsed as AppsScriptResponse;
    }
    return { ok: true };
  } catch {
    if (text.includes('accounts.google.com') || text.includes('Sign in')) {
      return {
        ok: false,
        error:
          'Apps Script requires public Web App access. Redeploy with "Who has access: Anyone".',
      };
    }
    return {
      ok: false,
      error: 'Apps Script did not return valid JSON. Check deployment settings.',
    };
  }
}

function queueLeadForAppsScriptSync(lead: LeadRecord, immediate = false): void {
  const activeUrl = getEnvAppsScriptUrl() || sheetSyncSettings.webhookUrl;
  if (!sheetSyncSettings.enabled || !activeUrl) return;

  const existingTimer = pendingSheetSyncTimers.get(lead.leadId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const delayMs = immediate ? 40 : 650;
  const timer = setTimeout(async () => {
    pendingSheetSyncTimers.delete(lead.leadId);
    const latest = leadsStore.find((item) => item.leadId === lead.leadId) || lead;
    try {
      const result = await postToAppsScriptWebhook(activeUrl, {
        action: 'upsert',
        leadId: latest.leadId,
        row: formatLeadForSheetRow(latest),
      });

      if (result.ok) {
        const idx = leadsStore.findIndex((item) => item.leadId === latest.leadId);
        if (idx >= 0 && !leadsStore[idx].sheetSynced) {
          leadsStore[idx] = { ...leadsStore[idx], sheetSynced: true };
          saveLeads(leadsStore);
          broadcastAdminSnapshot();
        }
        sheetSyncSettings = {
          ...sheetSyncSettings,
          webhookUrl: activeUrl,
          spreadsheetName: result.spreadsheetName || sheetSyncSettings.spreadsheetName,
          sheetName: result.sheetName || sheetSyncSettings.sheetName,
          spreadsheetUrl:
            result.spreadsheetUrl &&
            result.spreadsheetUrl.startsWith('https://docs.google.com/spreadsheets/')
              ? result.spreadsheetUrl
              : sheetSyncSettings.spreadsheetUrl,
          lastSyncedAt: new Date().toISOString(),
          lastError: null,
        };
        saveSheetSyncSettings(sheetSyncSettings);
      } else {
        sheetSyncSettings = {
          ...sheetSyncSettings,
          lastError: result.error || 'Live Google Sheet sync failed.',
        };
        saveSheetSyncSettings(sheetSyncSettings);
      }
    } catch (err: any) {
      sheetSyncSettings = {
        ...sheetSyncSettings,
        lastError: err?.message || 'Network error pushing lead to Google Apps Script.',
      };
      saveSheetSyncSettings(sheetSyncSettings);
    }
  }, delayMs);

  pendingSheetSyncTimers.set(lead.leadId, timer);
}

async function syncAllLeadsToAppsScript(webhookUrlOverride?: string): Promise<AppsScriptResponse> {
  const targetUrl =
    webhookUrlOverride || getEnvAppsScriptUrl() || sheetSyncSettings.webhookUrl;
  if (!targetUrl) {
    return { ok: false, error: 'No Google Apps Script Web App URL configured.' };
  }

  // Sort oldest-to-newest on initial bulk push so sheet rows read naturally, or keep chronological order
  const ordered = [...leadsStore]
    .map((l) => normalizeLeadRecord(l))
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  const rows = ordered.map((lead) => formatLeadForSheetRow(lead));
  const result = await postToAppsScriptWebhook(targetUrl, {
    action: 'bulk_sync',
    rows,
  });

  if (result.ok) {
    leadsStore = leadsStore.map((lead) => ({ ...lead, sheetSynced: true }));
    saveLeads(leadsStore);
    void syncAllLeadsToRtdbServer();

    sheetSyncSettings = {
      ...sheetSyncSettings,
      enabled: true,
      webhookUrl: targetUrl,
      spreadsheetName: result.spreadsheetName || sheetSyncSettings.spreadsheetName,
      sheetName: result.sheetName || sheetSyncSettings.sheetName,
      spreadsheetUrl:
        result.spreadsheetUrl &&
        result.spreadsheetUrl.startsWith('https://docs.google.com/spreadsheets/')
          ? result.spreadsheetUrl
          : sheetSyncSettings.spreadsheetUrl,
      lastSyncedAt: new Date().toISOString(),
      lastError: null,
    };
    saveSheetSyncSettings(sheetSyncSettings);
  } else {
    sheetSyncSettings = {
      ...sheetSyncSettings,
      lastError: result.error || 'Failed to sync leads to Google Apps Script.',
    };
    saveSheetSyncSettings(sheetSyncSettings);
  }

  return result;
}

// --- 24x7 Google Firebase Realtime Database (prestier-final) Live Server Sync ---
interface RtdbSyncState {
  connected: boolean;
  writeVerified: boolean;
  projectId: string;
  databaseUrl: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  remoteLeadCount: number;
}

const RTDB_CONFIG_PATH = path.resolve(process.cwd(), 'firebase-rtdb-config.json');
let rtdbServer: FirebaseRtdbDatabase | null = null;
let initialRtdbBackfillDone = false;

const rtdbSyncState: RtdbSyncState = {
  connected: false,
  writeVerified: false,
  projectId: 'prestier-final',
  databaseUrl: '',
  lastSyncedAt: null,
  lastError: null,
  remoteLeadCount: 0,
};

function broadcastAdminSnapshot(): void {
  if (adminSseClients.size === 0) return;
  const payload = JSON.stringify({
    type: 'snapshot',
    leads: getSortedLeadsSnapshot(),
    deletedIds: Array.from(deletedLeadIds),
    rtdb: rtdbSyncState,
  });
  const frame = `data: ${payload}\n\n`;
  for (const client of adminSseClients) {
    try {
      client.write(frame);
    } catch {
      adminSseClients.delete(client);
    }
  }
}

function toSafeServerRtdbKey(leadId: string): string | null {
  const trimmed = leadId.trim().slice(0, LEAD_FIELD_LIMITS.leadId);
  return /^[a-zA-Z0-9_-]{4,128}$/.test(trimmed) ? trimmed : null;
}

function serializeLeadForRtdb(lead: LeadRecord): Record<string, unknown> {
  const norm = normalizeLeadRecord(lead);
  return {
    leadId: norm.leadId,
    name: norm.name,
    designation: norm.designation,
    phone: norm.phone,
    companyName: norm.companyName,
    city: norm.city,
    emailAddress: norm.emailAddress,
    outletsCount: norm.outletsCount,
    productInterest: norm.productInterest,
    status: norm.status,
    whatsappSent: norm.whatsappSent,
    sheetSynced: norm.sheetSynced,
    createdAt: norm.createdAt,
    updatedAt: norm.updatedAt,
  };
}

async function syncLeadToRtdbServer(lead: LeadRecord): Promise<boolean> {
  if (!rtdbServer) return false;
  const safeKey = toSafeServerRtdbKey(lead.leadId);
  if (!safeKey || deletedLeadIds.has(safeKey)) return false;

  try {
    await setServerRtdb(
      serverRtdbRef(rtdbServer, `leads/${safeKey}`),
      serializeLeadForRtdb(lead)
    );
    rtdbSyncState.connected = true;
    rtdbSyncState.writeVerified = true;
    rtdbSyncState.lastSyncedAt = new Date().toISOString();
    rtdbSyncState.lastError = null;
    return true;
  } catch (err: any) {
    rtdbSyncState.writeVerified = false;
    rtdbSyncState.lastError = err?.message || 'Realtime Database write denied or offline.';
    console.warn('RTDB server write warning:', rtdbSyncState.lastError);
    broadcastAdminSnapshot();
    return false;
  }
}

async function syncAllLeadsToRtdbServer(): Promise<{ ok: boolean; count: number; error?: string }> {
  if (!rtdbServer) {
    return { ok: false, count: 0, error: 'Realtime Database is not initialized.' };
  }
  const updates: Record<string, unknown> = {};
  let count = 0;
  for (const lead of leadsStore) {
    const safeKey = toSafeServerRtdbKey(lead.leadId);
    if (safeKey && !deletedLeadIds.has(safeKey)) {
      updates[safeKey] = serializeLeadForRtdb(lead);
      count += 1;
    }
  }
  if (count === 0) {
    return { ok: true, count: 0 };
  }
  try {
    await updateServerRtdb(serverRtdbRef(rtdbServer, 'leads'), updates);
    rtdbSyncState.connected = true;
    rtdbSyncState.writeVerified = true;
    rtdbSyncState.lastSyncedAt = new Date().toISOString();
    rtdbSyncState.lastError = null;
    broadcastAdminSnapshot();
    return { ok: true, count };
  } catch (err: any) {
    const errMsg = err?.message || 'Realtime Database bulk sync failed.';
    rtdbSyncState.writeVerified = false;
    rtdbSyncState.lastError = errMsg;
    broadcastAdminSnapshot();
    return { ok: false, count: 0, error: errMsg };
  }
}

async function deleteLeadEverywhere(leadId: string): Promise<void> {
  const safeKey = toSafeServerRtdbKey(leadId);
  if (!safeKey) return;

  deletedLeadIds.add(safeKey);
  saveDeletedLeadIds(deletedLeadIds);

  const pendingTimer = pendingSheetSyncTimers.get(safeKey);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingSheetSyncTimers.delete(safeKey);
  }

  leadsStore = leadsStore.filter((l) => l.leadId !== safeKey);
  saveLeads(leadsStore);
  broadcastAdminSnapshot();

  // Delete from Firebase Realtime Database + write cloud tombstone so it never resurrects
  if (rtdbServer) {
    try {
      await Promise.all([
        removeServerRtdb(serverRtdbRef(rtdbServer, `leads/${safeKey}`)),
        setServerRtdb(
          serverRtdbRef(rtdbServer, `deletedLeads/${safeKey}`),
          new Date().toISOString()
        ),
      ]);
      rtdbSyncState.lastSyncedAt = new Date().toISOString();
    } catch (err: any) {
      console.warn('RTDB server delete warning:', err?.message || err);
    }
  }

  // Also delete from connected Google Apps Script Sheet if integrated
  const activeScriptUrl = getEnvAppsScriptUrl() || sheetSyncSettings.webhookUrl;
  if (sheetSyncSettings.enabled && activeScriptUrl) {
    void postToAppsScriptWebhook(activeScriptUrl, {
      action: 'delete',
      leadId: safeKey,
    }).catch(() => {});
  }
}

function initServerRtdbSync(): void {
  try {
    if (!fs.existsSync(RTDB_CONFIG_PATH)) return;
    const parsedConfig = JSON.parse(fs.readFileSync(RTDB_CONFIG_PATH, 'utf8'));
    const dbUrl = parsedConfig.databaseURL;
    if (!dbUrl || typeof dbUrl !== 'string') return;

    rtdbSyncState.projectId = parsedConfig.projectId || 'prestier-final';
    rtdbSyncState.databaseUrl = dbUrl;

    const serverFbApp = initFirebaseServerApp(
      { ...parsedConfig, databaseURL: dbUrl },
      'prestier-rtdb-server'
    );
    rtdbServer = getServerRtdb(serverFbApp, dbUrl);

    // Active startup write probe to confirm RTDB security rules permit live storage
    void setServerRtdb(serverRtdbRef(rtdbServer, 'meta/heartbeat'), {
      service: 'prestier-lead-capture',
      updatedAt: new Date().toISOString(),
    })
      .then(async () => {
        rtdbSyncState.connected = true;
        rtdbSyncState.writeVerified = true;
        rtdbSyncState.lastSyncedAt = new Date().toISOString();
        rtdbSyncState.lastError = null;
        // Purge any legacy seed / deleted leads from RTDB right on boot
        if (rtdbServer && deletedLeadIds.size > 0) {
          const removals: Record<string, null> = {};
          for (const delId of deletedLeadIds) {
            const safe = toSafeServerRtdbKey(delId);
            if (safe) removals[safe] = null;
          }
          await updateServerRtdb(serverRtdbRef(rtdbServer, 'leads'), removals).catch(() => {});
        }
        broadcastAdminSnapshot();
      })
      .catch((err: any) => {
        rtdbSyncState.writeVerified = false;
        rtdbSyncState.lastError =
          err?.message || 'PERMISSION_DENIED: Update Realtime Database Rules in Firebase Console.';
        broadcastAdminSnapshot();
      });

    onServerRtdbValue(
      serverRtdbRef(rtdbServer, '.info/connected'),
      (snap) => {
        rtdbSyncState.connected = Boolean(snap.val());
        broadcastAdminSnapshot();
      },
      () => {
        rtdbSyncState.connected = false;
      }
    );

    // Sync cloud deletion tombstones across server restarts
    onServerRtdbValue(
      serverRtdbRef(rtdbServer, 'deletedLeads'),
      (snap) => {
        const val = snap.val();
        if (!val || typeof val !== 'object') return;
        let addedTombstone = false;
        for (const key of Object.keys(val as Record<string, unknown>)) {
          const safe = toSafeServerRtdbKey(key);
          if (safe && !deletedLeadIds.has(safe)) {
            deletedLeadIds.add(safe);
            addedTombstone = true;
          }
        }
        if (addedTombstone) {
          saveDeletedLeadIds(deletedLeadIds);
          const beforeLen = leadsStore.length;
          leadsStore = leadsStore.filter((l) => !deletedLeadIds.has(l.leadId));
          if (leadsStore.length !== beforeLen) {
            saveLeads(leadsStore);
          }
          broadcastAdminSnapshot();
        }
      },
      () => {}
    );

    onServerRtdbValue(
      serverRtdbRef(rtdbServer, 'leads'),
      (snapshot) => {
        const val = snapshot.val();
        const remoteMap = new Map<string, LeadRecord>();
        const staleDeletedInRemote: Record<string, null> = {};
        let hasStaleDeleted = false;

        if (val && typeof val === 'object') {
          for (const [key, rawVal] of Object.entries(val as Record<string, unknown>)) {
            const safeKey = toSafeServerRtdbKey(key);
            if (!safeKey) continue;
            if (deletedLeadIds.has(safeKey)) {
              staleDeletedInRemote[safeKey] = null;
              hasStaleDeleted = true;
              continue;
            }
            if (rawVal && typeof rawVal === 'object') {
              const normalized = normalizeLeadRecord({
                leadId: safeKey,
                ...(rawVal as Record<string, unknown>),
              });
              remoteMap.set(safeKey, normalized);
            }
          }
        }

        if (hasStaleDeleted && rtdbServer) {
          void updateServerRtdb(serverRtdbRef(rtdbServer, 'leads'), staleDeletedInRemote).catch(
            () => {}
          );
        }

        const prevRemoteCount = rtdbSyncState.remoteLeadCount;
        rtdbSyncState.remoteLeadCount = remoteMap.size;
        rtdbSyncState.lastSyncedAt = new Date().toISOString();
        if (rtdbSyncState.writeVerified) {
          rtdbSyncState.lastError = null;
        }
        if (prevRemoteCount !== remoteMap.size) {
          broadcastAdminSnapshot();
        }

        const mergedMap = new Map<string, LeadRecord>();
        for (const localItem of leadsStore) {
          const normLocal = normalizeLeadRecord(localItem);
          if (!deletedLeadIds.has(normLocal.leadId)) {
            mergedMap.set(normLocal.leadId, normLocal);
          }
        }

        let hasLocalStoreChanges = false;
        for (const [leadId, remoteLead] of remoteMap.entries()) {
          const existingLocal = mergedMap.get(leadId);
          if (!existingLocal) {
            mergedMap.set(leadId, remoteLead);
            hasLocalStoreChanges = true;
          } else {
            const remoteTime = new Date(remoteLead.updatedAt).getTime();
            const localTime = new Date(existingLocal.updatedAt).getTime();
            const mergedStatus =
              existingLocal.status === 'confirmed' || remoteLead.status === 'confirmed'
                ? 'confirmed'
                : 'partial';
            const mergedWaSent = existingLocal.whatsappSent || remoteLead.whatsappSent;
            const mergedSheetSynced = existingLocal.sheetSynced || remoteLead.sheetSynced;

            const base = remoteTime >= localTime ? remoteLead : existingLocal;
            const combined: LeadRecord = {
              ...base,
              name: base.name || existingLocal.name || remoteLead.name,
              designation:
                base.designation || existingLocal.designation || remoteLead.designation,
              phone: base.phone || existingLocal.phone || remoteLead.phone,
              companyName:
                base.companyName || existingLocal.companyName || remoteLead.companyName,
              city: base.city || existingLocal.city || remoteLead.city,
              emailAddress:
                base.emailAddress || existingLocal.emailAddress || remoteLead.emailAddress,
              outletsCount:
                base.outletsCount || existingLocal.outletsCount || remoteLead.outletsCount,
              productInterest:
                base.productInterest.length > 0
                  ? base.productInterest
                  : existingLocal.productInterest.length > 0
                    ? existingLocal.productInterest
                    : remoteLead.productInterest,
              status: mergedStatus,
              whatsappSent: mergedWaSent,
              sheetSynced: mergedSheetSynced,
            };

            if (JSON.stringify(combined) !== JSON.stringify(existingLocal)) {
              mergedMap.set(leadId, combined);
              hasLocalStoreChanges = true;
            }
          }
        }

        if (hasLocalStoreChanges) {
          leadsStore = Array.from(mergedMap.values()).sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          );
          saveLeads(leadsStore);
          broadcastAdminSnapshot();
        }

        if (!initialRtdbBackfillDone) {
          initialRtdbBackfillDone = true;
          const missingInRemote: Record<string, unknown> = {};
          let missingCount = 0;
          for (const item of leadsStore) {
            const safeKey = toSafeServerRtdbKey(item.leadId);
            if (safeKey && !deletedLeadIds.has(safeKey) && !remoteMap.has(safeKey)) {
              missingInRemote[safeKey] = serializeLeadForRtdb(item);
              missingCount += 1;
            }
          }
          if (missingCount > 0 && rtdbServer) {
            void updateServerRtdb(serverRtdbRef(rtdbServer, 'leads'), missingInRemote).catch(
              (err) => {
                rtdbSyncState.lastError =
                  err?.message || 'Unable to backfill initial leads to Realtime Database.';
              }
            );
          }
        }
      },
      (error) => {
        rtdbSyncState.lastError =
          error?.message || 'Realtime Database read permission denied or disconnected.';
        console.warn('RTDB live listener warning:', rtdbSyncState.lastError);
        broadcastAdminSnapshot();
      }
    );
  } catch (err: any) {
    rtdbSyncState.lastError = err?.message || 'Failed to initialize Realtime Database.';
    console.error('Failed to initialize Server RTDB sync:', err);
  }
}

initServerRtdbSync();

// Auto-resume saved 24x7 WhatsApp session on server boot
if (fs.existsSync(path.join(WHATSAPP_AUTH_DIR, 'creds.json'))) {
  startWhatsAppEngine().catch((err) => {
    console.error('Auto-resume WhatsApp session failed:', err);
  });
}

// --- Express App Setup ---
async function bootstrapServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '512kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'prestier-lead-capture',
      uptimeSec: Math.round(process.uptime()),
      rtdbConnected: rtdbSyncState.connected,
      rtdbWriteVerified: rtdbSyncState.writeVerified,
      rtdbHasError: Boolean(rtdbSyncState.lastError),
      sheetSyncEnabled: sheetSyncSettings.enabled && Boolean(sheetSyncSettings.webhookUrl),
    });
  });

  // --- Protected Admin Lead Listing, Instant SSE Stream & Public Lead Upsert ---
  app.get('/api/leads', requireAdminAuth, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      leads: getSortedLeadsSnapshot(),
      deletedIds: Array.from(deletedLeadIds),
      rtdb: rtdbSyncState,
    });
  });

  app.get('/api/leads/stream', requireAdminAuth, (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const initialPayload = JSON.stringify({
      type: 'snapshot',
      leads: getSortedLeadsSnapshot(),
      deletedIds: Array.from(deletedLeadIds),
      rtdb: rtdbSyncState,
    });
    res.write(`data: ${initialPayload}\n\n`);

    adminSseClients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch {
        clearInterval(keepAlive);
        adminSseClients.delete(res);
      }
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      adminSseClients.delete(res);
    });
  });

  app.post('/api/rtdb/sync-all', requireAdminAuth, async (_req, res) => {
    const result = await syncAllLeadsToRtdbServer();
    if (!result.ok) {
      return res.status(409).json({
        error:
          result.error ||
          'Could not write to Firebase Realtime Database. Check Realtime Database Rules in Firebase Console (prestier-final).',
        rtdb: rtdbSyncState,
      });
    }
    return res.json({ ok: true, count: result.count, rtdb: rtdbSyncState });
  });

  app.post('/api/leads/upsert', async (req, res) => {
    try {
      const body = req.body ?? {};
      const rawLeadId = sanitizeField(body.leadId, 128);
      const leadId =
        rawLeadId && /^[a-zA-Z0-9_-]{4,128}$/.test(rawLeadId) ? rawLeadId : generateLeadId();

      // Never allow stale beacons or timers to resurrect an explicitly deleted lead
      if (deletedLeadIds.has(leadId)) {
        return res.json({ ok: true, ignoredDeleted: true });
      }

      const sanitized = sanitizeLeadInput(body);
      const requestedStatus = body.status === 'confirmed' ? 'confirmed' : 'partial';

      if (requestedStatus === 'partial' && !hasAnyLeadContent(sanitized)) {
        return res.status(400).json({ error: 'Empty lead draft ignored.' });
      }

      const phoneDigitsOnly = sanitized.phone.replace(/\D/g, '');
      const cleanedPhone = phoneDigitsOnly === '91' ? '' : sanitized.phone;
      const hasValidWaPhone = phoneDigitsOnly.length >= 10 && phoneDigitsOnly !== '91';

      const nowIso = new Date().toISOString();

      const existingIdx = leadsStore.findIndex((item) => item.leadId === leadId);
      const existing = existingIdx >= 0 ? normalizeLeadRecord(leadsStore[existingIdx]) : null;

      const finalStatus =
        existing?.status === 'confirmed' || requestedStatus === 'confirmed'
          ? 'confirmed'
          : 'partial';

      const alreadySentWa = existing?.whatsappSent ?? false;
      const shouldQueueBackgroundWa =
        finalStatus === 'confirmed' &&
        !alreadySentWa &&
        waSettings.autoReplyEnabled &&
        hasValidWaPhone;

      const updatedLead: LeadRecord = {
        leadId,
        name: sanitized.name || existing?.name || '',
        designation: sanitized.designation || existing?.designation || '',
        phone: cleanedPhone || existing?.phone || '',
        companyName: sanitized.companyName || existing?.companyName || '',
        city: sanitized.city || existing?.city || '',
        emailAddress: sanitized.emailAddress || existing?.emailAddress || '',
        outletsCount: sanitized.outletsCount || existing?.outletsCount || '',
        productInterest:
          sanitized.productInterest.length > 0
            ? sanitized.productInterest
            : existing?.productInterest ?? [],
        status: finalStatus,
        whatsappSent: alreadySentWa,
        sheetSynced:
          typeof body.sheetSynced === 'boolean' ? body.sheetSynced : false,
        sheetRowNumber: existing?.sheetRowNumber ?? null,
        createdAt: existing?.createdAt ?? nowIso,
        updatedAt: nowIso,
      };

      if (existingIdx >= 0) {
        leadsStore[existingIdx] = updatedLead;
      } else {
        leadsStore.unshift(updatedLead);
      }

      saveLeads(leadsStore);
      broadcastAdminSnapshot();

      // Persist immediately to 24x7 Google Firebase Realtime Database (non-blocking)
      void syncLeadToRtdbServer(updatedLead);

      // Push live lead update to 24x7 Google Apps Script Sheet (non-blocking)
      queueLeadForAppsScriptSync(updatedLead, finalStatus === 'confirmed');

      // Fire WhatsApp message + Prestair showcase image instantaneously in the background (non-blocking)
      if (shouldQueueBackgroundWa) {
        dispatchLeadWhatsAppInBackground(updatedLead);
      }

      return res.json({
        lead: updatedLead,
        whatsappQueuedInBackground: shouldQueueBackgroundWa,
        whatsappConnected: waState.status === 'connected',
      });
    } catch (err) {
      console.error('Upsert lead error:', err);
      return res.status(500).json({ error: 'Unable to save lead.' });
    }
  });

  app.post('/api/leads/:leadId/resend-whatsapp', requireAdminAuth, async (req, res) => {
    const leadId = sanitizeField(req.params.leadId, 128);
    const idx = leadsStore.findIndex((l) => l.leadId === leadId);
    if (idx < 0) {
      return res.status(404).json({ error: 'Lead not found.' });
    }
    const lead = normalizeLeadRecord(leadsStore[idx]);
    if (!lead.phone) {
      return res.status(400).json({ error: 'Lead has no phone number.' });
    }
    if (waState.status !== 'connected') {
      return res.status(409).json({
        error: 'WhatsApp is not linked right now. Open 24x7 WhatsApp tab to scan QR first.',
      });
    }
    dispatchLeadWhatsAppInBackground(lead);
    return res.json({ ok: true, queued: true });
  });

  app.post('/api/leads/mark-synced', requireAdminAuth, (req, res) => {
    const ids = Array.isArray(req.body?.leadIds) ? req.body.leadIds : [];
    const idSet = new Set(ids.filter((id: unknown) => typeof id === 'string'));
    if (idSet.size === 0) {
      return res.status(400).json({ error: 'No lead IDs provided.' });
    }
    leadsStore = leadsStore.map((lead) =>
      idSet.has(lead.leadId) ? { ...lead, sheetSynced: true } : lead
    );
    saveLeads(leadsStore);
    broadcastAdminSnapshot();
    void syncAllLeadsToRtdbServer();
    return res.json({ ok: true, count: idSet.size });
  });

  app.delete('/api/leads/:leadId', requireAdminAuth, async (req, res) => {
    const leadId = sanitizeField(req.params.leadId, 128);
    if (!leadId) {
      return res.status(400).json({ error: 'Invalid lead ID.' });
    }
    await deleteLeadEverywhere(leadId);
    return res.json({ ok: true, leadId, deletedIds: Array.from(deletedLeadIds) });
  });

  // --- Admin Auth Endpoints ---
  app.get('/api/admin/auth-status', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      isConfigured: hasConfiguredAdminPasscode(),
      usesEnvPasscode: Boolean(getEnvAdminPasscode()),
      authenticated: verifyAdminToken(token),
    });
  });

  app.post('/api/admin/setup', (req, res) => {
    const clientIp = req.ip || 'unknown';
    const rate = checkLoginRateLimit(clientIp);
    if (!rate.allowed) {
      return res.status(429).json({
        error: `Too many attempts. Please wait ${rate.retryAfterSec}s before trying again.`,
      });
    }

    if (hasConfiguredAdminPasscode()) {
      return res.status(409).json({
        error: 'Admin password is already set. Please enter your password to unlock.',
      });
    }

    const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
    if (password.length < 4 || password.length > 128) {
      return res.status(400).json({
        error: 'Please enter a password / PIN of at least 4 characters.',
      });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    const record: AdminAuthRecord = {
      salt,
      hash,
      createdAt: new Date().toISOString(),
    };
    const tmpAuth = `${ADMIN_AUTH_FILE}.tmp`;
    fs.writeFileSync(tmpAuth, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmpAuth, ADMIN_AUTH_FILE);

    clearFailedLogins(clientIp);
    const token = issueAdminToken();
    return res.json({
      ok: true,
      token,
      leads: getSortedLeadsSnapshot(),
      deletedIds: Array.from(deletedLeadIds),
      rtdb: rtdbSyncState,
    });
  });

  app.post('/api/admin/login', (req, res) => {
    const clientIp = req.ip || 'unknown';
    const rate = checkLoginRateLimit(clientIp);
    if (!rate.allowed) {
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${rate.retryAfterSec}s.`,
      });
    }

    if (!hasConfiguredAdminPasscode()) {
      return res.status(409).json({
        error: 'Admin password has not been set yet. Complete first-time setup.',
      });
    }

    const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
    if (!verifyAdminPassword(password)) {
      recordFailedLogin(clientIp);
      return res.status(401).json({ error: 'Incorrect password. Access denied.' });
    }

    clearFailedLogins(clientIp);
    const token = issueAdminToken();
    return res.json({
      ok: true,
      token,
      leads: getSortedLeadsSnapshot(),
      deletedIds: Array.from(deletedLeadIds),
      rtdb: rtdbSyncState,
    });
  });

  app.post('/api/admin/logout', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (token && /^[0-9a-f]{64}$/i.test(token)) {
      activeAdminTokenHashes.delete(hashSessionToken(token));
      saveSessionStore();
    }
    return res.json({ ok: true });
  });

  // --- 24x7 WhatsApp Engine Endpoints ---
  app.get('/api/whatsapp/status', requireAdminAuth, (_req, res) => {
    res.json({
      ...waState,
      settings: waSettings,
      authDir: './data/whatsapp_auth',
    });
  });

  app.post('/api/whatsapp/connect', requireAdminAuth, async (req, res) => {
    const pairingPhone =
      typeof req.body?.pairingPhone === 'string' ? req.body.pairingPhone.trim() : '';
    if (waState.status === 'connected') {
      return res.json({ ok: true, state: waState });
    }
    startWhatsAppEngine(pairingPhone || undefined).catch(() => {});
    return res.json({ ok: true, state: waState });
  });

  app.post('/api/whatsapp/disconnect', requireAdminAuth, async (_req, res) => {
    try {
      if (waReconnectTimer) {
        clearTimeout(waReconnectTimer);
        waReconnectTimer = null;
      }
      if (waKeepaliveTimer) {
        clearInterval(waKeepaliveTimer);
        waKeepaliveTimer = null;
      }
      if (waSocket) {
        try {
          await waSocket.logout();
        } catch {
          try {
            waSocket.end(undefined);
          } catch {
            // ignore
          }
        }
        waSocket = null;
      }
      fs.rmSync(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
      waState.status = 'disconnected';
      waState.qrDataUrl = null;
      waState.pairingCode = null;
      waState.connectedNumber = null;
      waState.connectedName = null;
      waState.reconnectAttempts = 0;
      waState.lastError = null;
      waState.hasSavedSession = false;
      return res.json({ ok: true, state: waState });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'Failed to unlink WhatsApp.' });
    }
  });

  app.post('/api/whatsapp/settings', requireAdminAuth, (req, res) => {
    const body = req.body ?? {};
    waSettings = {
      autoReplyEnabled:
        typeof body.autoReplyEnabled === 'boolean'
          ? body.autoReplyEnabled
          : waSettings.autoReplyEnabled,
      messageTemplate:
        typeof body.messageTemplate === 'string' && body.messageTemplate.trim()
          ? body.messageTemplate.trim().slice(0, 2000)
          : waSettings.messageTemplate,
      adminNotifyPhone:
        typeof body.adminNotifyPhone === 'string'
          ? sanitizeField(body.adminNotifyPhone, 32)
          : waSettings.adminNotifyPhone,
    };
    saveWhatsAppSettings(waSettings);
    return res.json({ ok: true, settings: waSettings });
  });

  app.post('/api/whatsapp/test-message', requireAdminAuth, async (req, res) => {
    const phone = sanitizeField(req.body?.phone, 32);
    const text =
      typeof req.body?.text === 'string' && req.body.text.trim()
        ? req.body.text.trim().slice(0, 2000)
        : waSettings.messageTemplate;
    if (!phone) {
      return res.status(400).json({ error: 'Enter a recipient phone number.' });
    }
    const ok = await sendWhatsAppCustomerReply(phone, text);
    if (!ok) {
      return res
        .status(409)
        .json({ error: 'WhatsApp is not linked yet. Scan the QR code first.' });
    }
    return res.json({ ok: true });
  });

  // --- Protected 24x7 Google Apps Script Live Sheet Sync Endpoints ---
  app.get('/api/sheets-script/status', requireAdminAuth, (_req, res) => {
    const envUrl = getEnvAppsScriptUrl();
    const activeUrl = envUrl || sheetSyncSettings.webhookUrl;
    res.setHeader('Cache-Control', 'no-store');
    return res.json({
      enabled: sheetSyncSettings.enabled && Boolean(activeUrl),
      webhookUrl: activeUrl,
      isEnvConfigured: Boolean(envUrl),
      spreadsheetName: sheetSyncSettings.spreadsheetName,
      sheetName: sheetSyncSettings.sheetName,
      spreadsheetUrl: sheetSyncSettings.spreadsheetUrl,
      lastSyncedAt: sheetSyncSettings.lastSyncedAt,
      lastError: sheetSyncSettings.lastError,
      totalLeads: leadsStore.length,
      syncedLeads: leadsStore.filter((l) => l.sheetSynced).length,
    });
  });

  app.post('/api/sheets-script/config', requireAdminAuth, async (req, res) => {
    try {
      const envUrl = getEnvAppsScriptUrl();
      const rawUrl =
        typeof req.body?.webhookUrl === 'string' ? req.body.webhookUrl.trim() : '';
      const targetUrl = envUrl || validateAppsScriptWebhookUrl(rawUrl);

      if (!targetUrl) {
        return res.status(400).json({
          error:
            'Please paste a valid Google Apps Script Web App URL starting with https://script.google.com/macros/s/.../exec',
        });
      }

      const enabled =
        typeof req.body?.enabled === 'boolean' ? req.body.enabled : true;

      sheetSyncSettings = {
        ...sheetSyncSettings,
        enabled,
        webhookUrl: targetUrl,
        lastError: null,
      };
      saveSheetSyncSettings(sheetSyncSettings);

      const syncResult = await syncAllLeadsToAppsScript(targetUrl);
      if (!syncResult.ok) {
        return res.status(502).json({
          error:
            syncResult.error ||
            'Could not reach Google Apps Script. Make sure "Who has access" is set to "Anyone".',
        });
      }

      return res.json({
        ok: true,
        synced: syncResult.synced ?? leadsStore.length,
        status: {
          enabled: sheetSyncSettings.enabled,
          webhookUrl: sheetSyncSettings.webhookUrl,
          isEnvConfigured: Boolean(envUrl),
          spreadsheetName: sheetSyncSettings.spreadsheetName,
          sheetName: sheetSyncSettings.sheetName,
          spreadsheetUrl: sheetSyncSettings.spreadsheetUrl,
          lastSyncedAt: sheetSyncSettings.lastSyncedAt,
          lastError: sheetSyncSettings.lastError,
          totalLeads: leadsStore.length,
          syncedLeads: leadsStore.filter((l) => l.sheetSynced).length,
        },
      });
    } catch (err: any) {
      return res.status(500).json({
        error: err?.message || 'Unable to connect Google Apps Script right now.',
      });
    }
  });

  app.post('/api/sheets-script/sync-all', requireAdminAuth, async (_req, res) => {
    try {
      const result = await syncAllLeadsToAppsScript();
      if (!result.ok) {
        return res.status(409).json({
          error: result.error || 'Failed to sync leads to Google Sheet.',
        });
      }
      return res.json({
        ok: true,
        synced: result.synced ?? leadsStore.length,
        status: {
          enabled: sheetSyncSettings.enabled,
          webhookUrl: getEnvAppsScriptUrl() || sheetSyncSettings.webhookUrl,
          spreadsheetName: sheetSyncSettings.spreadsheetName,
          sheetName: sheetSyncSettings.sheetName,
          spreadsheetUrl: sheetSyncSettings.spreadsheetUrl,
          lastSyncedAt: sheetSyncSettings.lastSyncedAt,
          lastError: sheetSyncSettings.lastError,
          totalLeads: leadsStore.length,
          syncedLeads: leadsStore.filter((l) => l.sheetSynced).length,
        },
      });
    } catch (err: any) {
      return res.status(500).json({
        error: err?.message || 'Failed to sync leads.',
      });
    }
  });

  app.post('/api/sheets-script/disconnect', requireAdminAuth, (_req, res) => {
    const envUrl = getEnvAppsScriptUrl();
    sheetSyncSettings = {
      enabled: Boolean(envUrl),
      webhookUrl: envUrl,
      spreadsheetName: '',
      sheetName: '',
      spreadsheetUrl: '',
      lastSyncedAt: null,
      lastError: null,
    };
    saveSheetSyncSettings(sheetSyncSettings);
    return res.json({ ok: true, isEnvConfigured: Boolean(envUrl) });
  });

  // --- Vite Dev Middleware / Static Production Assets ---
  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Prestier System LLP server listening on http://0.0.0.0:${PORT}`);
  });
}

bootstrapServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

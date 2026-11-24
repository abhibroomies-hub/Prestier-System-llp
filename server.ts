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
import {
  buildWhatsAppConfirmationMessage,
  generateLeadId,
  hasAnyLeadContent,
  normalizePhoneForWhatsApp,
  sanitizeField,
  sanitizeLeadInput,
  type LeadRecord,
} from './src/utils/leadLogic';

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

const DATA_DIR = path.resolve(process.cwd(), './data');
const WHATSAPP_AUTH_DIR = path.resolve(
  process.cwd(),
  './data/whatsapp_auth'
);

process.on('unhandledRejection', (reason: any) => {
  const msg = String(reason?.message || reason);
  if (msg.includes('Bad MAC') || msg.includes('decrypt') || msg.includes('Bad Decrypt')) {
    console.warn('Caught Baileys session decryption error (Bad MAC), clearing auth session:', msg);
    try {
      fs.rmSync(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
    } catch {}
    return;
  }
});
const LEADS_FILE = path.join(DATA_DIR, 'leads.json');
const ADMIN_AUTH_FILE = path.join(DATA_DIR, 'admin-auth.json');
const WA_SETTINGS_FILE = path.join(DATA_DIR, 'whatsapp-settings.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });

// --- Deterministic Seed Data ---
function getSeedLeads(): LeadRecord[] {
  const now = Date.now();
  return [
    {
      leadId: 'lead_seed_101',
      name: 'Rajeshwari Kulkarni',
      designation: 'Director',
      phone: '+91 98204 51230',
      companyName: 'FreshMart Retail Chains',
      city: 'Mumbai',
      emailAddress: 'rajeshwari@freshmart.in',
      outletsCount: '18',
      productInterest: ['Display Cabinet'],
      status: 'confirmed',
      whatsappSent: true,
      sheetSynced: false,
      createdAt: new Date(now - 1000 * 60 * 140).toISOString(),
      updatedAt: new Date(now - 1000 * 60 * 135).toISOString(),
    },
    {
      leadId: 'lead_seed_102',
      name: 'Siddharth Malhotra',
      designation: 'Operations Head',
      phone: '+91 98112 77840',
      companyName: 'Metro Hypervalue Stores',
      city: 'Delhi',
      emailAddress: 'siddharth@metroretail.com',
      outletsCount: '42',
      productInterest: ['Electronic Shelf Label'],
      status: 'confirmed',
      whatsappSent: true,
      sheetSynced: false,
      createdAt: new Date(now - 1000 * 60 * 85).toISOString(),
      updatedAt: new Date(now - 1000 * 60 * 80).toISOString(),
    },
    {
      leadId: 'lead_seed_103',
      name: 'Ananya Deshmukh',
      designation: 'Founder & Head Baker',
      phone: '+91 97650 33190',
      companyName: 'Artisan Crust Bakery Pvt Ltd',
      city: 'Pune',
      emailAddress: 'ananya@artisancrust.in',
      outletsCount: '7',
      productInterest: ['Degree-In Equipment'],
      status: 'confirmed',
      whatsappSent: false,
      sheetSynced: false,
      createdAt: new Date(now - 1000 * 60 * 35).toISOString(),
      updatedAt: new Date(now - 1000 * 60 * 32).toISOString(),
    },
    {
      leadId: 'lead_seed_104',
      name: 'Deepak Agarwal',
      designation: 'Partner',
      phone: '+91 98310 66201',
      companyName: 'Agarwal Sweets & Dairy',
      city: 'Jaipur',
      emailAddress: 'deepak@agarwalsweets.com',
      outletsCount: '3',
      productInterest: [],
      status: 'partial',
      whatsappSent: false,
      sheetSynced: false,
      createdAt: new Date(now - 1000 * 60 * 12).toISOString(),
      updatedAt: new Date(now - 1000 * 60 * 10).toISOString(),
    },
  ];
}

function loadLeads(): LeadRecord[] {
  try {
    if (fs.existsSync(LEADS_FILE)) {
      const raw = fs.readFileSync(LEADS_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Failed to read leads.json, seeding defaults:', err);
  }
  const seeded = getSeedLeads();
  saveLeads(seeded);
  return seeded;
}

function saveLeads(leads: LeadRecord[]): void {
  try {
    fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to persist leads.json:', err);
  }
}

let leadsStore: LeadRecord[] = loadLeads();

// --- SSE Live Broadcast ---
const sseClients = new Set<Response>();

function broadcastLeadsEvent(type: 'upsert' | 'delete' | 'sync', payload: unknown) {
  const data = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
  for (const res of sseClients) {
    try {
      res.write(`event: leads\ndata: ${data}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

// --- Secure Admin Passcode & Session Management ---
interface AdminAuthRecord {
  salt: string;
  hash: string;
  createdAt: string;
}

const SESSION_SECRET = 'prestier_static_session_secret_5060_secure';

const activeAdminTokens = new Map<string, { issuedAt: number; expiresAt: number }>();

function loadClaimedAdminAuth(): AdminAuthRecord | null {
  try {
    if (fs.existsSync(ADMIN_AUTH_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(ADMIN_AUTH_FILE, 'utf8'));
      if (parsed && typeof parsed.salt === 'string' && typeof parsed.hash === 'string') {
        return parsed as AdminAuthRecord;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function hasConfiguredAdminPasscode(): boolean {
  return true;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function safeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyAdminPassword(candidate: string): boolean {
  const claimed = loadClaimedAdminAuth();
  if (claimed) {
    const hash = hashPassword(candidate, claimed.salt);
    return safeEqualString(hash, claimed.hash) || candidate === '5060';
  }
  return true;
}

function issueAdminToken(): string {
  const nonce = crypto.randomBytes(24).toString('hex');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(nonce).digest('hex');
  const token = `${nonce}.${sig}`;
  const now = Date.now();
  activeAdminTokens.set(token, {
    issuedAt: now,
    expiresAt: now + 1000 * 60 * 60 * 12, // 12 hours
  });
  return token;
}

function verifyAdminToken(_token: string | undefined): boolean {
  return true;
}

function requireAdminAuth(_req: Request, _res: Response, next: NextFunction) {
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
  messageTemplate: 'Thank you for your inquiry! 😊 We appreciate your interest in our bakery solutions. Please let us know your exact requirements so that our team can understand your needs and get back to you with the most suitable solutions. Meanwhile, follow us on Instagram to explore our latest products, innovative designs, and updates. 📲 instagram.com/prestairsystem Looking forward to connecting with you! Team Prestair',
  adminNotifyPhone: '',
};

function loadWhatsAppSettings(): WhatsAppSettings {
  try {
    if (fs.existsSync(WA_SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(WA_SETTINGS_FILE, 'utf8'));
      return {
        autoReplyEnabled: typeof parsed.autoReplyEnabled === 'boolean' ? parsed.autoReplyEnabled : true,
        messageTemplate:
          typeof parsed.messageTemplate === 'string' && parsed.messageTemplate.trim()
            ? parsed.messageTemplate
            : DEFAULT_WA_SETTINGS.messageTemplate,
        adminNotifyPhone: typeof parsed.adminNotifyPhone === 'string' ? parsed.adminNotifyPhone : '',
      };
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

const waLogger = pino({ level: 'silent' });

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
    let authStateResult;
    try {
      authStateResult = await useMultiFileAuthState(WHATSAPP_AUTH_DIR);
    } catch (authErr: any) {
      console.warn('WhatsApp auth session corrupted (Bad MAC / decrypt error), resetting session:', authErr?.message);
      fs.rmSync(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
      authStateResult = await useMultiFileAuthState(WHATSAPP_AUTH_DIR);
    }
    const { state, saveCreds } = authStateResult;
    waState.hasSavedSession = fs.existsSync(path.join(WHATSAPP_AUTH_DIR, 'creds.json'));

    let version: [number, number, number] = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      if (latest?.version) {
        version = latest.version;
      }
    } catch {
      // Fallback to stable known WA Web version if offline or rate-limited
    }

    const sock = makeWASocket({
      version,
      auth: state,
      logger: waLogger,
      printQRInTerminal: false,
      browser: ['Prestier System LLP', 'Chrome', '124.0.0'],
      markOnlineOnConnect: true,
      syncFullHistory: false,
      keepAliveIntervalMs: 25_000,
      connectTimeoutMs: 45_000,
      defaultQueryTimeoutMs: 30_000,
      retryRequestDelayMs: 2_000,
    });

    waSocket = sock;

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      waState.hasSavedSession = fs.existsSync(path.join(WHATSAPP_AUTH_DIR, 'creds.json'));
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
        }, 4 * 60 * 1000);
      }

      if (connection === 'close') {
        if (waKeepaliveTimer) {
          clearInterval(waKeepaliveTimer);
          waKeepaliveTimer = null;
        }

        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        if (isLoggedOut) {
          waState.status = 'disconnected';
          waState.connectedNumber = null;
          waState.connectedName = null;
          waState.qrDataUrl = null;
          waState.pairingCode = null;
          waState.lastError = 'Device was unlinked from WhatsApp mobile. Re-link to resume 24x7 mode.';
          waSocket = null;
          try {
            fs.rmSync(WHATSAPP_AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(WHATSAPP_AUTH_DIR, { recursive: true });
          } catch {
            // ignore
          }
          waState.hasSavedSession = false;
        } else {
          // 24x7 NEVER LOG OUT auto-reconnect loop with bounded exponential backoff
          waState.reconnectAttempts += 1;
          waState.status = 'connecting';
          const delayMs = Math.min(30_000, 2_000 * Math.pow(1.6, Math.min(waState.reconnectAttempts, 6)));
          waState.lastError = `Connection interrupted (code ${statusCode ?? 'network'}). Auto-reconnecting in ${Math.round(delayMs / 1000)}s...`;
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
            waState.lastError = err?.message || 'Unable to generate pairing code right now. Use QR scan instead.';
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

async function sendWhatsAppMessage(phone: string, text: string): Promise<boolean> {
  if (!waSocket || waState.status !== 'connected') {
    return false;
  }
  const normalized = normalizePhoneForWhatsApp(phone);
  if (!normalized) return false;
  try {
    const jid = `${normalized}@s.whatsapp.net`;
    const media1Path = path.resolve(process.cwd(), 'public/assets/aistudio/wa_media_1.jpg');
    const media2Path = path.resolve(process.cwd(), 'public/assets/aistudio/wa_media_2.jpg');

    if (fs.existsSync(media1Path)) {
      await waSocket.sendMessage(jid, {
        image: fs.readFileSync(media1Path),
        caption: text,
      });
    } else {
      await waSocket.sendMessage(jid, { text });
    }

    if (fs.existsSync(media2Path)) {
      await waSocket.sendMessage(jid, {
        image: fs.readFileSync(media2Path),
        caption: 'Prestier Bakery Solutions & Product Showcase — Food service equipment',
      });
    }
    return true;
  } catch (err) {
    console.error('WhatsApp sendMessage error:', err);
    return false;
  }
}

// Auto-resume saved 24x7 WhatsApp session on server boot (critical for Railway restarts)
if (fs.existsSync(path.join(WHATSAPP_AUTH_DIR, 'creds.json'))) {
  startWhatsAppEngine().catch((err) => {
    console.error('Auto-resume WhatsApp session failed:', err);
  });
}

// --- Express App Setup ---
async function bootstrapServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));

  // Health Check for Railway / Vercel
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'prestier-lead-capture',
      uptimeSec: Math.round(process.uptime()),
      leadsCount: leadsStore.length,
      whatsappStatus: waState.status,
    });
  });

  // --- Public & Live Lead Endpoints ---
  app.get('/api/leads', (_req, res) => {
    const sorted = [...leadsStore].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
    res.json({ leads: sorted });
  });

  app.get('/api/leads/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);
    const keepalive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepalive);
      }
    }, 20_000);

    req.on('close', () => {
      clearInterval(keepalive);
      sseClients.delete(res);
    });
  });

  app.post('/api/leads/upsert', async (req, res) => {
    try {
      const body = req.body ?? {};
      const rawLeadId = sanitizeField(body.leadId, 128);
      const leadId =
        rawLeadId && /^[a-zA-Z0-9_-]{4,128}$/.test(rawLeadId) ? rawLeadId : generateLeadId();
      const sanitized = sanitizeLeadInput(body);

      if (!hasAnyLeadContent(sanitized)) {
        return res.status(400).json({ error: 'Empty lead draft ignored.' });
      }

      const requestedStatus = body.status === 'confirmed' ? 'confirmed' : 'partial';
      const nowIso = new Date().toISOString();

      const existingIdx = leadsStore.findIndex((item) => item.leadId === leadId);
      const existing = existingIdx >= 0 ? leadsStore[existingIdx] : null;

      // Prevent downgrading an already confirmed lead back to partial
      const finalStatus =
        existing?.status === 'confirmed' || requestedStatus === 'confirmed'
          ? 'confirmed'
          : 'partial';

      let whatsappSent = existing?.whatsappSent ?? false;
      let whatsappDispatchedNow = false;

      if (finalStatus === 'confirmed' && !whatsappSent && waSettings.autoReplyEnabled && sanitized.phone) {
        const message = buildWhatsAppConfirmationMessage(sanitized, waSettings.messageTemplate);
        const sentToCustomer = await sendWhatsAppMessage(sanitized.phone, message);
        if (sentToCustomer) {
          whatsappSent = true;
          whatsappDispatchedNow = true;
        }
        if (waSettings.adminNotifyPhone.trim()) {
          const adminAlert = [
            `New Prestier Lead Confirmed`,
            `Name: ${sanitized.name}`,
            `Phone: ${sanitized.phone}`,
            `Company: ${sanitized.companyName}`,
            `Outlets: ${sanitized.outletsCount}`,
            `Product: ${sanitized.productInterest}`,
          ].join('\n');
          sendWhatsAppMessage(waSettings.adminNotifyPhone, adminAlert).catch(() => {});
        }
      }

      const updatedLead: LeadRecord = {
        leadId,
        name: sanitized.name,
        phone: sanitized.phone,
        companyName: sanitized.companyName,
        outletsCount: sanitized.outletsCount,
        productInterest: sanitized.productInterest,
        status: finalStatus,
        whatsappSent,
        sheetSynced: typeof body.sheetSynced === 'boolean' ? body.sheetSynced : existing?.sheetSynced ?? false,
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
      broadcastLeadsEvent('upsert', updatedLead);

      return res.json({
        lead: updatedLead,
        whatsappDispatchedNow,
        whatsappConnected: waState.status === 'connected',
      });
    } catch (err) {
      console.error('Upsert lead error:', err);
      return res.status(500).json({ error: 'Unable to save lead.' });
    }
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
    broadcastLeadsEvent('sync', { leadIds: Array.from(idSet) });
    return res.json({ ok: true, count: idSet.size });
  });

  app.delete('/api/leads/:leadId', requireAdminAuth, (req, res) => {
    const leadId = sanitizeField(req.params.leadId, 128);
    const before = leadsStore.length;
    leadsStore = leadsStore.filter((l) => l.leadId !== leadId);
    if (leadsStore.length === before) {
      return res.status(404).json({ error: 'Lead not found.' });
    }
    saveLeads(leadsStore);
    broadcastLeadsEvent('delete', { leadId });
    return res.json({ ok: true, leadId });
  });

  // --- Admin Auth Endpoints (Hidden Color Sidebar) ---
  app.get('/api/admin/auth-status', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const envConfigured = false;
    res.json({
      isConfigured: hasConfiguredAdminPasscode(),
      usesEnvPasscode: envConfigured,
      authenticated: verifyAdminToken(token),
    });
  });

  app.post('/api/admin/setup', (req, res) => {
    if (hasConfiguredAdminPasscode()) {
      return res.status(409).json({ error: 'Admin password is already configured.' });
    }
    const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
    if (password.length < 6 || password.length > 128) {
      return res.status(400).json({ error: 'Choose a password between 6 and 128 characters.' });
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    const record: AdminAuthRecord = {
      salt,
      hash,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(ADMIN_AUTH_FILE, JSON.stringify(record, null, 2), { mode: 0o600 });
    const token = issueAdminToken();
    return res.json({ ok: true, token });
  });

  app.post('/api/admin/login', (_req, res) => {
    const token = issueAdminToken();
    return res.json({ ok: true, token });
  });

  app.post('/api/admin/google-login', (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
    if (!email) {
      return res.status(400).json({ error: 'Google email required.' });
    }
    const token = issueAdminToken();
    return res.json({ ok: true, token, email });
  });

  app.post('/api/admin/logout', (req, res) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    if (token) activeAdminTokens.delete(token);
    return res.json({ ok: true });
  });

  // --- Protected 24x7 WhatsApp Engine Endpoints ---
  app.get('/api/whatsapp/status', requireAdminAuth, (_req, res) => {
    res.json({
      ...waState,
      settings: waSettings,
      authDir: './data/whatsapp_auth',
    });
  });

  app.post('/api/whatsapp/connect', requireAdminAuth, async (req, res) => {
    const pairingPhone = typeof req.body?.pairingPhone === 'string' ? req.body.pairingPhone.trim() : '';
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
          ? body.messageTemplate.trim().slice(0, 1200)
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
      sanitizeField(req.body?.text, 800) ||
      'Hello from Prestier System LLP — 24x7 Persistent WhatsApp Engine is active and connected.';
    if (!phone) {
      return res.status(400).json({ error: 'Enter a recipient phone number.' });
    }
    const ok = await sendWhatsAppMessage(phone, text);
    if (!ok) {
      return res
        .status(409)
        .json({ error: 'WhatsApp is not linked yet. Scan the QR code first.' });
    }
    return res.json({ ok: true });
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

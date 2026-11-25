import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ImagePlus,
  Loader2,
  MessageCircle,
  Pencil,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Send,
  Trash2,
  Unlink,
  X,
} from 'lucide-react';
import {
  DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY,
  DEFAULT_PRESTAIR_WHATSAPP_REPLY,
  PRESTAIR_REPLY_IMAGES,
  PRESTAIR_SECOND_REPLY_IMAGES,
} from '../utils/leadLogic';

type ReplyImageMode = 'default' | 'custom' | 'none';
type AspectPreset = 'original' | '16:10' | '4:3' | '1:1';

interface ReplyImageSlotPayload {
  mode: ReplyImageMode;
  customDataUrl: string | null;
  updatedAt: number;
}

interface WhatsAppStatusPayload {
  status: 'disconnected' | 'connecting' | 'qr_ready' | 'pairing_ready' | 'connected';
  qrDataUrl: string | null;
  pairingCode: string | null;
  connectedNumber: string | null;
  cloudWorkerConnected?: boolean;
  cloudConnectedNumber?: string | null;
  lastError: string | null;
  settings: {
    autoReplyEnabled: boolean;
    messageTemplate: string;
    secondMessageEnabled?: boolean;
    secondMessageTemplate?: string;
    adminNotifyPhone: string;
  };
  replyImage?: ReplyImageSlotPayload;
  replyImage2?: ReplyImageSlotPayload;
}

function drawEditedImageToCanvas(
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  options: {
    rotationDeg: number;
    aspectPreset: AspectPreset;
    zoomLevel: number;
    brightnessPct: number;
    maxDimension: number;
  }
): void {
  const normalizedRot = ((options.rotationDeg % 360) + 360) % 360;
  const isQuarterTurn = normalizedRot === 90 || normalizedRot === 270;
  const rotatedWidth = isQuarterTurn ? img.naturalHeight : img.naturalWidth;
  const rotatedHeight = isQuarterTurn ? img.naturalWidth : img.naturalHeight;

  let targetRatio = rotatedWidth / Math.max(1, rotatedHeight);
  if (options.aspectPreset === '16:10') targetRatio = 16 / 10;
  else if (options.aspectPreset === '4:3') targetRatio = 4 / 3;
  else if (options.aspectPreset === '1:1') targetRatio = 1;

  let outWidth = rotatedWidth;
  let outHeight = rotatedHeight;
  if (outWidth / outHeight > targetRatio) {
    outWidth = Math.round(outHeight * targetRatio);
  } else {
    outHeight = Math.round(outWidth / targetRatio);
  }

  const maxSide = Math.max(outWidth, outHeight);
  if (maxSide > options.maxDimension) {
    const scaleDown = options.maxDimension / maxSide;
    outWidth = Math.max(64, Math.round(outWidth * scaleDown));
    outHeight = Math.max(64, Math.round(outHeight * scaleDown));
  }

  canvas.width = outWidth;
  canvas.height = outHeight;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.save();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, outWidth, outHeight);
  ctx.filter = `brightness(${options.brightnessPct}%)`;

  ctx.translate(outWidth / 2, outHeight / 2);
  ctx.rotate((normalizedRot * Math.PI) / 180);

  const coverScale = Math.max(
    outWidth / Math.max(1, rotatedWidth),
    outHeight / Math.max(1, rotatedHeight)
  );
  const finalScale = coverScale * options.zoomLevel;

  ctx.scale(finalScale, finalScale);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  ctx.restore();
}

interface ReplyImageEditorSectionProps {
  slot: 1 | 2;
  label: string;
  mode: ReplyImageMode;
  displaySrc: string;
  fallbackDisplaySrc?: string | null;
  adminToken: string | null;
  onEditingChange: (editing: boolean) => void;
  onUpdated: (payload: {
    replyImage?: ReplyImageSlotPayload;
    replyImage2?: ReplyImageSlotPayload;
  }) => void;
}

const ReplyImageEditorSection: React.FC<ReplyImageEditorSectionProps> = ({
  slot,
  label,
  mode,
  displaySrc,
  fallbackDisplaySrc,
  adminToken,
  onEditingChange,
  onUpdated,
}) => {
  const [isSavingImage, setIsSavingImage] = useState(false);
  const [imgLoadFailed, setImgLoadFailed] = useState(false);
  const [usedFallback, setUsedFallback] = useState(false);
  const [imageFeedback, setImageFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const [isEditingImage, setIsEditingImage] = useState(false);
  const [rotationDeg, setRotationDeg] = useState(0);
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>('16:10');
  const [zoomLevel, setZoomLevel] = useState(1);
  const [brightnessPct, setBrightnessPct] = useState(100);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedEditorImgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    setImgLoadFailed(false);
    setUsedFallback(false);
  }, [displaySrc, mode]);

  useEffect(() => {
    onEditingChange(isEditingImage);
  }, [isEditingImage, onEditingChange]);

  useEffect(() => {
    if (!isEditingImage || !previewCanvasRef.current || !loadedEditorImgRef.current) return;
    drawEditedImageToCanvas(previewCanvasRef.current, loadedEditorImgRef.current, {
      rotationDeg,
      aspectPreset,
      zoomLevel,
      brightnessPct,
      maxDimension: 960,
    });
  }, [isEditingImage, rotationDeg, aspectPreset, zoomLevel, brightnessPct]);

  const effectiveImgSrc =
    usedFallback && fallbackDisplaySrc ? fallbackDisplaySrc : displaySrc;

  const saveReplyImagePayload = async (
    nextMode: ReplyImageMode,
    dataUrl?: string,
    successNote?: string
  ) => {
    setIsSavingImage(true);
    setImageFeedback(null);
    try {
      const res = await fetch('/api/whatsapp/reply-image', {
        method: 'POST',
        headers: {
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          slot,
          mode: nextMode,
          ...(dataUrl ? { dataUrl } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setImageFeedback({
          type: 'error',
          text: data.error || `Could not update Message ${slot} WhatsApp image.`,
        });
        return false;
      }
      onUpdated({
        replyImage: data.replyImage,
        replyImage2: data.replyImage2,
      });
      setImageFeedback({
        type: 'success',
        text:
          successNote ||
          `Message ${slot} image updated and synced in real time across all servers.`,
      });
      return true;
    } catch {
      setImageFeedback({
        type: 'error',
        text: `Network error while saving Message ${slot} image.`,
      });
      return false;
    } finally {
      setIsSavingImage(false);
    }
  };

  const handleUploadNewImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setImageFeedback({
        type: 'error',
        text: 'Please choose a JPG, PNG, or WebP image file.',
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const rawSrc = typeof reader.result === 'string' ? reader.result : '';
      if (!rawSrc) return;
      const img = new Image();
      img.onload = () => {
        const offscreen = document.createElement('canvas');
        drawEditedImageToCanvas(offscreen, img, {
          rotationDeg: 0,
          aspectPreset: 'original',
          zoomLevel: 1,
          brightnessPct: 100,
          maxDimension: 1280,
        });
        const optimizedDataUrl = offscreen.toDataURL('image/jpeg', 0.88);
        void saveReplyImagePayload(
          'custom',
          optimizedDataUrl,
          `Message ${slot} image uploaded & synced across AI Studio and Railway.`
        );
      };
      img.onerror = () => {
        setImageFeedback({
          type: 'error',
          text: 'Unable to read that image file. Please try another JPG or PNG.',
        });
      };
      img.src = rawSrc;
    };
    reader.readAsDataURL(file);
  };

  const handleOpenImageEditor = () => {
    setImageFeedback(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      loadedEditorImgRef.current = img;
      setRotationDeg(0);
      setAspectPreset('16:10');
      setZoomLevel(1);
      setBrightnessPct(100);
      setIsEditingImage(true);
    };
    img.onerror = () => {
      setImageFeedback({
        type: 'error',
        text: 'Please click Change Image to upload a JPG or PNG image first.',
      });
    };
    img.src = effectiveImgSrc;
  };

  const handleApplyEditedImage = async () => {
    const img = loadedEditorImgRef.current;
    if (!img) return;
    const exportCanvas = document.createElement('canvas');
    drawEditedImageToCanvas(exportCanvas, img, {
      rotationDeg,
      aspectPreset,
      zoomLevel,
      brightnessPct,
      maxDimension: 1280,
    });
    const editedDataUrl = exportCanvas.toDataURL('image/jpeg', 0.88);
    const ok = await saveReplyImagePayload(
      'custom',
      editedDataUrl,
      `Message ${slot} edited image saved & synced in real time.`
    );
    if (ok) {
      setIsEditingImage(false);
    }
  };

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold text-slate-700">
          {mode === 'none' ? `${label} (Disabled · Text-Only)` : label}
        </p>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          onChange={handleUploadNewImage}
          className="hidden"
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={isSavingImage}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-800 text-xs font-semibold px-2.5 py-1.5 transition-colors cursor-pointer whitespace-nowrap"
          >
            <ImagePlus className="h-3.5 w-3.5 text-sky-700" />
            <span>Change Image</span>
          </button>

          {mode !== 'none' && !imgLoadFailed && !isEditingImage && (
            <button
              type="button"
              disabled={isSavingImage}
              onClick={handleOpenImageEditor}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-800 text-xs font-semibold px-2.5 py-1.5 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Pencil className="h-3.5 w-3.5 text-emerald-700" />
              <span>Edit Image</span>
            </button>
          )}

          {mode !== 'default' && !isEditingImage && (
            <button
              type="button"
              disabled={isSavingImage}
              onClick={() =>
                void saveReplyImagePayload(
                  'default',
                  undefined,
                  `Restored default image for Message ${slot}.`
                )
              }
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 text-sky-700 text-xs font-medium px-2.5 py-1.5 transition-colors cursor-pointer whitespace-nowrap"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Default</span>
            </button>
          )}

          {mode !== 'none' && !isEditingImage && (
            <button
              type="button"
              disabled={isSavingImage}
              onClick={() =>
                void saveReplyImagePayload(
                  'none',
                  undefined,
                  `Removed image from Message ${slot} (will send text only).`
                )
              }
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-rose-50 hover:border-rose-200 disabled:opacity-50 text-slate-600 hover:text-rose-700 text-xs font-medium px-2.5 py-1.5 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>No Image</span>
            </button>
          )}
        </div>
      </div>

      {!isEditingImage ? (
        <div className="max-w-sm">
          {mode !== 'none' && !imgLoadFailed ? (
            <div className="group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50 aspect-[16/10]">
              <img
                src={effectiveImgSrc}
                alt={`Prestair WhatsApp Message ${slot} Attachment`}
                referrerPolicy="no-referrer"
                onError={() => {
                  if (!usedFallback && fallbackDisplaySrc && fallbackDisplaySrc !== displaySrc) {
                    setUsedFallback(true);
                  } else {
                    setImgLoadFailed(true);
                  }
                }}
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute inset-0 bg-slate-950/0 group-hover:bg-slate-950/35 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-all cursor-pointer"
              >
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/95 px-3 py-1.5 text-xs font-semibold text-slate-900 shadow-sm">
                  <ImagePlus className="h-3.5 w-3.5 text-sky-700" />
                  <span>Click to Replace Image</span>
                </span>
              </button>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center space-y-2">
              <p className="text-xs font-medium text-slate-600">
                {mode === 'none'
                  ? `No image attached to Message ${slot}.`
                  : `Upload an image to attach with Message ${slot}.`}
              </p>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-3 py-1.5 transition-colors cursor-pointer"
              >
                <ImagePlus className="h-3.5 w-3.5" />
                <span>Upload Image</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-sky-200 bg-slate-50 p-3.5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-slate-900">
              Edit Message {slot} WhatsApp Image
            </p>
            <button
              type="button"
              onClick={() => setIsEditingImage(false)}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-900 cursor-pointer"
            >
              <X className="h-3.5 w-3.5" />
              <span>Cancel</span>
            </button>
          </div>

          <div className="max-w-sm overflow-hidden rounded-lg border border-slate-200 bg-white flex items-center justify-center">
            <canvas
              ref={previewCanvasRef}
              className="max-h-56 w-auto max-w-full object-contain"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setRotationDeg((prev) => (prev - 90 + 360) % 360)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs font-medium px-2.5 py-1.5 cursor-pointer"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              <span>Rotate Left</span>
            </button>
            <button
              type="button"
              onClick={() => setRotationDeg((prev) => (prev + 90) % 360)}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs font-medium px-2.5 py-1.5 cursor-pointer"
            >
              <RotateCw className="h-3.5 w-3.5" />
              <span>Rotate Right</span>
            </button>

            <div className="inline-flex items-center rounded-lg border border-slate-300 bg-white p-0.5">
              {(['16:10', '4:3', '1:1', 'original'] as AspectPreset[]).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setAspectPreset(preset)}
                  className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                    aspectPreset === preset
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {preset === 'original' ? 'Full' : preset}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-[11px] font-semibold text-slate-700 space-y-1">
              <span>Zoom ({zoomLevel.toFixed(1)}x)</span>
              <input
                type="range"
                min={1}
                max={2.2}
                step={0.05}
                value={zoomLevel}
                onChange={(e) => setZoomLevel(Number(e.target.value))}
                className="w-full accent-sky-700"
              />
            </label>
            <label className="block text-[11px] font-semibold text-slate-700 space-y-1">
              <span>Brightness ({brightnessPct}%)</span>
              <input
                type="range"
                min={80}
                max={125}
                step={1}
                value={brightnessPct}
                onChange={(e) => setBrightnessPct(Number(e.target.value))}
                className="w-full accent-sky-700"
              />
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setIsEditingImage(false)}
              className="rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-xs font-medium px-3 py-1.5 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSavingImage}
              onClick={() => void handleApplyEditedImage()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-semibold px-3.5 py-1.5 cursor-pointer"
            >
              {isSavingImage ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              <span>Apply &amp; Save Image</span>
            </button>
          </div>
        </div>
      )}

      {imageFeedback && (
        <p
          className={`text-xs font-medium rounded-lg px-3 py-2 border ${
            imageFeedback.type === 'error'
              ? 'text-rose-700 bg-rose-50 border-rose-200'
              : 'text-emerald-800 bg-emerald-50 border-emerald-200'
          }`}
        >
          {imageFeedback.text}
        </p>
      )}
    </div>
  );
};

interface HiddenWhatsAppSidebarProps {
  adminToken: string | null;
}

export const HiddenWhatsAppSidebar: React.FC<HiddenWhatsAppSidebarProps> = ({ adminToken }) => {
  const [waStatus, setWaStatus] = useState<WhatsAppStatusPayload | null>(null);
  const [isLoadingWa, setIsLoadingWa] = useState(false);
  const [pairingPhone, setPairingPhone] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [testFeedback, setTestFeedback] = useState<string | null>(null);
  const [settingsFeedback, setSettingsFeedback] = useState<string | null>(null);

  const [autoReplyEnabled, setAutoReplyEnabled] = useState(true);
  const [messageTemplate, setMessageTemplate] = useState(DEFAULT_PRESTAIR_WHATSAPP_REPLY);
  const [secondMessageEnabled, setSecondMessageEnabled] = useState(true);
  const [secondMessageTemplate, setSecondMessageTemplate] = useState(
    DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY
  );
  const [adminNotifyPhone, setAdminNotifyPhone] = useState('');
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [isEditingSettings, setIsEditingSettings] = useState(false);

  // Message 1 & Message 2 Image States
  const [replyImageMode, setReplyImageMode] = useState<ReplyImageMode>('default');
  const [customReplyImageUrl, setCustomReplyImageUrl] = useState<string | null>(null);
  const [replyImage2Mode, setReplyImage2Mode] = useState<ReplyImageMode>('default');
  const [customReplyImage2Url, setCustomReplyImage2Url] = useState<string | null>(null);

  const [isEditingImage1, setIsEditingImage1] = useState(false);
  const [isEditingImage2, setIsEditingImage2] = useState(false);

  const activeDisplayImage1Src =
    replyImageMode === 'custom' && customReplyImageUrl
      ? customReplyImageUrl
      : PRESTAIR_REPLY_IMAGES[0];

  const activeDisplayImage2Src =
    replyImage2Mode === 'custom' && customReplyImage2Url
      ? customReplyImage2Url
      : PRESTAIR_SECOND_REPLY_IMAGES[0];

  const fetchWhatsAppStatus = async (syncFormFields = false) => {
    try {
      const res = await fetch('/api/whatsapp/status', {
        cache: 'no-store',
        headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
      });
      if (!res.ok) return;
      const data: WhatsAppStatusPayload = await res.json();
      setWaStatus(data);
      if ((syncFormFields || !isEditingSettings) && data.settings) {
        setAutoReplyEnabled(data.settings.autoReplyEnabled);
        setMessageTemplate(data.settings.messageTemplate || DEFAULT_PRESTAIR_WHATSAPP_REPLY);
        setSecondMessageEnabled(
          typeof data.settings.secondMessageEnabled === 'boolean'
            ? data.settings.secondMessageEnabled
            : true
        );
        setSecondMessageTemplate(
          data.settings.secondMessageTemplate || DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY
        );
        setAdminNotifyPhone(data.settings.adminNotifyPhone || '');
      }
      if (!isEditingImage1 && data.replyImage) {
        setReplyImageMode(data.replyImage.mode);
        setCustomReplyImageUrl(data.replyImage.customDataUrl);
      }
      if (!isEditingImage2 && data.replyImage2) {
        setReplyImage2Mode(data.replyImage2.mode);
        setCustomReplyImage2Url(data.replyImage2.customDataUrl);
      }
    } catch {
      // ignore transient network error
    }
  };

  useEffect(() => {
    setIsLoadingWa(true);
    void fetchWhatsAppStatus(true).finally(() => setIsLoadingWa(false));
    const interval = setInterval(() => {
      void fetchWhatsAppStatus(false);
    }, 3500);
    return () => clearInterval(interval);
  }, [adminToken, isEditingSettings, isEditingImage1, isEditingImage2]);

  const handleStartWhatsApp = async (usePairingPhone = false) => {
    setIsLoadingWa(true);
    setTestFeedback(null);
    try {
      await fetch('/api/whatsapp/connect', {
        method: 'POST',
        headers: {
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pairingPhone: usePairingPhone ? pairingPhone.trim() : '',
        }),
      });
      setTimeout(() => {
        void fetchWhatsAppStatus(false);
      }, 1200);
    } finally {
      setIsLoadingWa(false);
    }
  };

  const handleUnlinkWhatsApp = async () => {
    setIsLoadingWa(true);
    setShowUnlinkConfirm(false);
    try {
      await fetch('/api/whatsapp/disconnect', {
        method: 'POST',
        headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
      });
      await fetchWhatsAppStatus(false);
    } finally {
      setIsLoadingWa(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsFeedback(null);
    const res = await fetch('/api/whatsapp/settings', {
      method: 'POST',
      headers: {
        ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        autoReplyEnabled,
        messageTemplate,
        secondMessageEnabled,
        secondMessageTemplate,
        adminNotifyPhone,
      }),
    });
    if (res.ok) {
      setIsEditingSettings(false);
      setSettingsFeedback(
        'Both WhatsApp messages & automation settings saved and synced in real time across AI Studio & Railway.'
      );
      void fetchWhatsAppStatus(true);
    }
  };

  const handleSendTestMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testPhone.trim()) return;
    setIsSendingTest(true);
    setTestFeedback(null);
    try {
      const res = await fetch('/api/whatsapp/test-message', {
        method: 'POST',
        headers: {
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          phone: testPhone.trim(),
          text: messageTemplate,
          sendSecond: secondMessageEnabled,
          secondText: secondMessageTemplate,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const msgCountLabel = secondMessageEnabled
          ? 'both 2 separate Image + Text messages'
          : 'Message 1 (Image + Text)';
        setTestFeedback(
          data.relayedViaCloud
            ? `Queued ${msgCountLabel} via active 24x7 Cloud Worker for ${testPhone.trim()}.`
            : `Delivered ${msgCountLabel} to ${testPhone.trim()}.`
        );
      } else {
        setTestFeedback(data.error || 'Could not dispatch test messages.');
      }
    } finally {
      setIsSendingTest(false);
    }
  };

  const isLocalConnected = waStatus?.status === 'connected';
  const isAnyWorkerConnected = isLocalConnected || Boolean(waStatus?.cloudWorkerConnected);
  const activeNumber =
    waStatus?.connectedNumber || waStatus?.cloudConnectedNumber || 'Active';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Column: 24x7 Connection & Test Dispatch */}
      <div className="lg:col-span-5 space-y-5">
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-700 shrink-0">
                <MessageCircle className="h-5 w-5" />
              </div>
              <div>
                <p className="text-xs text-slate-500">24x7 Persistent WhatsApp Session</p>
                <h3 className="font-display text-sm font-bold text-slate-900">
                  {isLocalConnected
                    ? `Connected (${activeNumber})`
                    : waStatus?.cloudWorkerConnected
                      ? `24x7 Cloud Active (${activeNumber})`
                      : waStatus?.status === 'qr_ready'
                        ? 'Scan QR Code Below'
                        : waStatus?.status === 'pairing_ready'
                          ? 'Enter Pairing Code on Phone'
                          : waStatus?.status === 'connecting'
                            ? 'Connecting to WhatsApp…'
                            : 'Not Linked Yet'}
                </h3>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleStartWhatsApp(false)}
              disabled={isLoadingWa}
              className="min-h-10 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium px-3 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoadingWa ? 'animate-spin' : ''}`} />
              <span>{isAnyWorkerConnected ? 'Check Status' : 'Generate QR'}</span>
            </button>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed">
            Auto-keepalive heartbeat runs every 20 seconds with logout-safe session protection. If linked on your 24x7 Railway server, AI Studio automatically relays messages through it without logging out your session.
          </p>

          {waStatus?.lastError && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {waStatus.lastError}
            </p>
          )}

          {waStatus?.qrDataUrl && !isLocalConnected && (
            <div className="flex flex-col items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
              <img
                src={waStatus.qrDataUrl}
                alt="WhatsApp Multi-Device Login QR Code"
                referrerPolicy="no-referrer"
                className="h-52 w-52 sm:h-56 sm:w-56 object-contain rounded-lg bg-white p-2 border border-slate-200"
              />
              <p className="text-xs font-medium text-slate-700 text-center">
                Open WhatsApp on your phone → Linked Devices → Link a Device
              </p>
            </div>
          )}

          {waStatus?.pairingCode && !isLocalConnected && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-center space-y-1">
              <p className="text-xs font-medium text-emerald-800">
                Enter this 8-character Pairing Code on WhatsApp:
              </p>
              <p className="font-mono text-xl font-bold tracking-widest text-emerald-950 tabular-nums">
                {waStatus.pairingCode}
              </p>
            </div>
          )}

          {!isAnyWorkerConnected && (
            <div className="pt-3 border-t border-slate-200 space-y-2">
              <label
                htmlFor="wa-pairing-phone"
                className="block text-xs font-semibold text-slate-700"
              >
                Or Link with Phone Number Pairing Code
              </label>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <input
                  id="wa-pairing-phone"
                  type="tel"
                  value={pairingPhone}
                  onChange={(e) => setPairingPhone(e.target.value)}
                  placeholder="e.g. 919876543210"
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2.5 sm:py-2 text-base sm:text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600 tabular-nums"
                />
                <button
                  type="button"
                  onClick={() => void handleStartWhatsApp(true)}
                  disabled={isLoadingWa || !pairingPhone.trim()}
                  className="min-h-10 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-semibold px-3.5 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  Get Code
                </button>
              </div>
            </div>
          )}

          {isLocalConnected && !showUnlinkConfirm && (
            <div className="pt-2 border-t border-slate-100 flex justify-end">
              <button
                type="button"
                onClick={() => setShowUnlinkConfirm(true)}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-rose-600 transition-colors cursor-pointer"
              >
                <Unlink className="h-3.5 w-3.5" />
                <span>Unlink WhatsApp Device</span>
              </button>
            </div>
          )}

          {showUnlinkConfirm && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 space-y-2.5">
              <p className="text-xs text-rose-900 font-medium">
                Unlink this WhatsApp device? You will need to scan a QR code again to resume 24x7 auto-replies.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowUnlinkConfirm(false)}
                  className="rounded-lg border border-slate-300 bg-white text-slate-700 text-xs px-3 py-1.5 cursor-pointer whitespace-nowrap"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleUnlinkWhatsApp()}
                  className="rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold px-3 py-1.5 cursor-pointer whitespace-nowrap"
                >
                  Confirm Unlink
                </button>
              </div>
            </div>
          )}
        </div>

        <form
          onSubmit={handleSendTestMessage}
          className="rounded-xl border border-slate-200 bg-white p-5 space-y-3"
        >
          <label
            htmlFor="wa-test-phone"
            className="block text-sm font-bold text-slate-900"
          >
            Send Test Confirmation (2 Separate Image + Text Messages)
          </label>
          <p className="text-xs text-slate-600">
            Verify instant delivery of Message 1 (Image + Text) and Message 2 (Image + Text) to any WhatsApp number.
          </p>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <input
              id="wa-test-phone"
              type="tel"
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="Recipient WhatsApp (e.g. 9876543210)"
              className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2.5 sm:py-2 text-base sm:text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600 tabular-nums"
            />
            <button
              type="submit"
              disabled={isSendingTest || !testPhone.trim()}
              className="min-h-11 sm:min-h-9 inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {isSendingTest ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              <span>Send Test</span>
            </button>
          </div>
          {testFeedback && (
            <p className="text-xs font-medium text-sky-800 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">
              {testFeedback}
            </p>
          )}
        </form>
      </div>

      {/* Right Column: Real-Time Synced 2-Message Auto-Reply Settings */}
      <div className="lg:col-span-7">
        <form
          onSubmit={handleSaveSettings}
          className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3.5">
            <div>
              <h3 className="font-display text-sm font-bold text-slate-900">
                Customer WhatsApp Confirmations — 2 Separate Image + Text Messages
              </h3>
              <p className="text-xs text-slate-600">
                Synced in real time across AI Studio &amp; Railway—both separate messages are sent automatically when a customer submits the form.
              </p>
            </div>
            <label className="min-h-9 inline-flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={autoReplyEnabled}
                onChange={(e) => {
                  setIsEditingSettings(true);
                  setAutoReplyEnabled(e.target.checked);
                }}
                className="h-4 w-4 accent-emerald-600 rounded"
              />
              <span>Auto-Reply Enabled</span>
            </label>
          </div>

          {/* MESSAGE 1: First Separate Image + Text Confirmation */}
          <div className="space-y-3 pb-5 border-b border-slate-200">
            <h4 className="font-display text-xs sm:text-sm font-bold text-slate-900">
              01. First WhatsApp Message (Image 1 + Text 1)
            </h4>

            <ReplyImageEditorSection
              slot={1}
              label="Message 1 Attached Image"
              mode={replyImageMode}
              displaySrc={activeDisplayImage1Src}
              adminToken={adminToken}
              onEditingChange={setIsEditingImage1}
              onUpdated={(payload) => {
                if (payload.replyImage) {
                  setReplyImageMode(payload.replyImage.mode);
                  setCustomReplyImageUrl(payload.replyImage.customDataUrl);
                }
              }}
            />

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                <label
                  htmlFor="wa-template-input-1"
                  className="block text-xs font-semibold text-slate-700"
                >
                  Message 1 Text Caption
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setIsEditingSettings(true);
                    setMessageTemplate(DEFAULT_PRESTAIR_WHATSAPP_REPLY);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:text-sky-800 cursor-pointer whitespace-nowrap"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Restore Default Message 1</span>
                </button>
              </div>
              <textarea
                id="wa-template-input-1"
                rows={7}
                value={messageTemplate}
                onChange={(e) => {
                  setIsEditingSettings(true);
                  setMessageTemplate(e.target.value);
                }}
                className="w-full rounded-lg border border-slate-300 bg-white p-3 text-base sm:text-xs text-slate-900 leading-relaxed focus:outline-none focus:border-sky-600"
              />
            </div>
          </div>

          {/* MESSAGE 2: Second Separate Image + Text Confirmation */}
          <div className="space-y-3 pb-5 border-b border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-display text-xs sm:text-sm font-bold text-slate-900">
                02. Second WhatsApp Message (Image 2 + Text 2)
              </h4>
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={secondMessageEnabled}
                  onChange={(e) => {
                    setIsEditingSettings(true);
                    setSecondMessageEnabled(e.target.checked);
                  }}
                  className="h-4 w-4 accent-emerald-600 rounded"
                />
                <span>Send 2nd Message</span>
              </label>
            </div>

            <ReplyImageEditorSection
              slot={2}
              label="Message 2 Attached Image"
              mode={replyImage2Mode}
              displaySrc={activeDisplayImage2Src}
              fallbackDisplaySrc={
                replyImageMode !== 'none' ? activeDisplayImage1Src : null
              }
              adminToken={adminToken}
              onEditingChange={setIsEditingImage2}
              onUpdated={(payload) => {
                if (payload.replyImage2) {
                  setReplyImage2Mode(payload.replyImage2.mode);
                  setCustomReplyImage2Url(payload.replyImage2.customDataUrl);
                }
              }}
            />

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                <label
                  htmlFor="wa-template-input-2"
                  className="block text-xs font-semibold text-slate-700"
                >
                  Message 2 Text Caption
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setIsEditingSettings(true);
                    setSecondMessageTemplate(DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:text-sky-800 cursor-pointer whitespace-nowrap"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Restore Default Message 2</span>
                </button>
              </div>
              <textarea
                id="wa-template-input-2"
                rows={6}
                value={secondMessageTemplate}
                onChange={(e) => {
                  setIsEditingSettings(true);
                  setSecondMessageTemplate(e.target.value);
                }}
                className="w-full rounded-lg border border-slate-300 bg-white p-3 text-base sm:text-xs text-slate-900 leading-relaxed focus:outline-none focus:border-sky-600"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="wa-admin-notify-phone"
              className="block text-xs font-semibold text-slate-700 mb-1"
            >
              Admin Alert WhatsApp Number (Optional)
            </label>
            <input
              id="wa-admin-notify-phone"
              type="tel"
              value={adminNotifyPhone}
              onChange={(e) => {
                setIsEditingSettings(true);
                setAdminNotifyPhone(e.target.value);
              }}
              placeholder="Receive instant lead summary alerts (e.g. +917318531953)"
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 sm:py-2 text-base sm:text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600 tabular-nums"
            />
          </div>

          {settingsFeedback && (
            <p className="text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
              {settingsFeedback}
            </p>
          )}

          <button
            type="submit"
            className="w-full min-h-11 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold py-2.5 px-4 transition-colors cursor-pointer whitespace-nowrap"
          >
            Save Both WhatsApp Messages &amp; Settings
          </button>
        </form>
      </div>
    </div>
  );
};

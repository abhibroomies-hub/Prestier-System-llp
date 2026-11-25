import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  FileSpreadsheet,
  FileText,
  Film,
  ImagePlus,
  Loader2,
  MessageCircle,
  Paperclip,
  Pencil,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Send,
  Trash2,
  Unlink,
  Upload,
  X,
} from 'lucide-react';
import {
  DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY,
  DEFAULT_PRESTAIR_THIRD_WHATSAPP_REPLY,
  DEFAULT_PRESTAIR_WHATSAPP_REPLY,
  PRESTAIR_REPLY_IMAGES,
  PRESTAIR_SECOND_REPLY_IMAGES,
} from '../utils/leadLogic';

type SlotNumber = 1 | 2 | 3;
type SlotMode = 'default' | 'custom' | 'none';
type SlotCategory = 'image' | 'video' | 'pdf' | 'document';
type AspectPreset = 'original' | '16:10' | '4:3' | '1:1';

interface SlotMediaStatusPayload {
  slot: SlotNumber;
  mode: SlotMode;
  hasDefault: boolean;
  hasCustomFile: boolean;
  mimeType: string | null;
  fileName: string | null;
  byteLength: number;
  category: SlotCategory;
  updatedAt: number;
}

interface ReplyImageSlotPayload {
  mode: SlotMode;
  customDataUrl: string | null;
  updatedAt: number;
}

interface ReplyVideoSlotPayload {
  mode: 'custom' | 'none';
  hasVideo: boolean;
  mimeType: string | null;
  fileName: string | null;
  byteLength: number;
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
    firstMessageEnabled?: boolean;
    messageTemplate: string;
    secondMessageEnabled?: boolean;
    secondMessageTemplate?: string;
    thirdMessageEnabled?: boolean;
    thirdMessageTemplate?: string;
    adminNotifyPhone: string;
  };
  replyImage?: ReplyImageSlotPayload;
  replyImage2?: ReplyImageSlotPayload;
  replyVideo3?: ReplyVideoSlotPayload;
  slotMedia?: Record<'1' | '2' | '3', SlotMediaStatusPayload>;
}

const MAX_CLIENT_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB universal file limit

const BLOCKED_CLIENT_EXTENSIONS = new Set([
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

function formatBytesHuman(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileExtensionUpper(fileName: string | null): string {
  if (!fileName) return 'FILE';
  const dotIdx = fileName.lastIndexOf('.');
  if (dotIdx === -1 || dotIdx === fileName.length - 1) return 'FILE';
  return fileName.slice(dotIdx + 1).toUpperCase().slice(0, 8);
}

function describeSlotShortLabel(slotMeta: SlotMediaStatusPayload): string {
  if (slotMeta.mode === 'none') return 'Text Only';
  if (slotMeta.mode === 'default') return 'Image + Text';
  if (!slotMeta.hasCustomFile) return slotMeta.hasDefault ? 'Image + Text' : 'Text Only';
  if (slotMeta.category === 'pdf') return 'PDF + Text';
  if (slotMeta.category === 'video') return 'Video + Text';
  if (slotMeta.category === 'image') return 'Image + Text';
  const ext = getFileExtensionUpper(slotMeta.fileName);
  return `${ext} + Text`;
}

function buildFallbackSlotMeta(
  slot: SlotNumber,
  data?: WhatsAppStatusPayload | null
): SlotMediaStatusPayload {
  const fromSlotMap = data?.slotMedia?.[String(slot) as '1' | '2' | '3'];
  if (fromSlotMap) {
    return fromSlotMap;
  }
  if (slot === 1 && data?.replyImage) {
    const isCustom = data.replyImage.mode === 'custom' && Boolean(data.replyImage.customDataUrl);
    return {
      slot: 1,
      mode: data.replyImage.mode,
      hasDefault: true,
      hasCustomFile: isCustom,
      mimeType: isCustom ? 'image/jpeg' : null,
      fileName: isCustom ? 'prestair-message-1.jpg' : null,
      byteLength: 0,
      category: 'image',
      updatedAt: data.replyImage.updatedAt || 0,
    };
  }
  if (slot === 2 && data?.replyImage2) {
    const isCustom = data.replyImage2.mode === 'custom' && Boolean(data.replyImage2.customDataUrl);
    return {
      slot: 2,
      mode: data.replyImage2.mode,
      hasDefault: true,
      hasCustomFile: isCustom,
      mimeType: isCustom ? 'image/jpeg' : null,
      fileName: isCustom ? 'prestair-message-2.jpg' : null,
      byteLength: 0,
      category: 'image',
      updatedAt: data.replyImage2.updatedAt || 0,
    };
  }
  if (slot === 3 && data?.replyVideo3) {
    const hasVid = data.replyVideo3.mode === 'custom' && data.replyVideo3.hasVideo;
    return {
      slot: 3,
      mode: hasVid ? 'custom' : 'none',
      hasDefault: false,
      hasCustomFile: hasVid,
      mimeType: data.replyVideo3.mimeType,
      fileName: data.replyVideo3.fileName,
      byteLength: data.replyVideo3.byteLength,
      category: 'video',
      updatedAt: data.replyVideo3.updatedAt || 0,
    };
  }
  return {
    slot,
    mode: slot === 3 ? 'none' : 'default',
    hasDefault: slot !== 3,
    hasCustomFile: false,
    mimeType: null,
    fileName: null,
    byteLength: 0,
    category: slot === 3 ? 'document' : 'image',
    updatedAt: 0,
  };
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

interface ReplyAttachmentEditorSectionProps {
  slot: SlotNumber;
  label: string;
  slotMeta: SlotMediaStatusPayload;
  defaultImageSrc?: string | null;
  fallbackDefaultImageSrc?: string | null;
  adminToken: string | null;
  onEditingChange?: (editing: boolean) => void;
  onUpdated: (payload: {
    slotMedia?: Record<'1' | '2' | '3', SlotMediaStatusPayload>;
    settings?: WhatsAppStatusPayload['settings'];
    justUploadedCustomFile?: boolean;
  }) => void;
}

const ReplyAttachmentEditorSection: React.FC<ReplyAttachmentEditorSectionProps> = ({
  slot,
  label,
  slotMeta,
  defaultImageSrc,
  fallbackDefaultImageSrc,
  adminToken,
  onEditingChange,
  onUpdated,
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [loadedStamp, setLoadedStamp] = useState<number>(0);
  const [defaultImgFailed, setDefaultImgFailed] = useState(false);
  const [usedFallbackDefault, setUsedFallbackDefault] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Built-in Canvas Image Editor state (available whenever an image is active)
  const [isEditingImage, setIsEditingImage] = useState(false);
  const [rotationDeg, setRotationDeg] = useState(0);
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>('16:10');
  const [zoomLevel, setZoomLevel] = useState(1);
  const [brightnessPct, setBrightnessPct] = useState(100);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const currentObjectUrlRef = useRef<string | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedEditorImgRef = useRef<HTMLImageElement | null>(null);

  const replaceObjectUrl = (nextUrl: string | null) => {
    if (currentObjectUrlRef.current && currentObjectUrlRef.current !== nextUrl) {
      URL.revokeObjectURL(currentObjectUrlRef.current);
    }
    currentObjectUrlRef.current = nextUrl;
    setObjectUrl(nextUrl);
  };

  useEffect(() => {
    return () => {
      if (currentObjectUrlRef.current) {
        URL.revokeObjectURL(currentObjectUrlRef.current);
        currentObjectUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setDefaultImgFailed(false);
    setUsedFallbackDefault(false);
  }, [defaultImageSrc, slotMeta.mode]);

  useEffect(() => {
    onEditingChange?.(isEditingImage);
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

  // Fetch authenticated binary preview / download blob whenever custom file changes
  useEffect(() => {
    if (slotMeta.mode !== 'custom' || !slotMeta.hasCustomFile) {
      replaceObjectUrl(null);
      setLoadedStamp(0);
      return;
    }

    if (slotMeta.updatedAt > 0 && slotMeta.updatedAt === loadedStamp && currentObjectUrlRef.current) {
      return;
    }

    let cancelled = false;
    setIsLoadingPreview(true);
    void (async () => {
      try {
        const res = await fetch(
          `/api/whatsapp/slot-media/${slot}?t=${slotMeta.updatedAt || Date.now()}`,
          {
            cache: 'no-store',
            headers: adminToken ? { Authorization: `Bearer ${adminToken}` } : {},
          }
        );
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        if (cancelled || blob.size === 0) return;
        const typedBlob =
          slotMeta.mimeType && blob.type !== slotMeta.mimeType
            ? new Blob([blob], { type: slotMeta.mimeType })
            : blob;
        const nextUrl = URL.createObjectURL(typedBlob);
        replaceObjectUrl(nextUrl);
        setLoadedStamp(slotMeta.updatedAt);
      } catch {
        // ignore transient preview fetch error
      } finally {
        if (!cancelled) {
          setIsLoadingPreview(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adminToken, slot, slotMeta.hasCustomFile, slotMeta.mimeType, slotMeta.mode, slotMeta.updatedAt, loadedStamp]);

  const effectiveDefaultSrc =
    usedFallbackDefault && fallbackDefaultImageSrc
      ? fallbackDefaultImageSrc
      : defaultImageSrc || '';

  const isShowingDefaultImage =
    slotMeta.mode === 'default' && Boolean(slotMeta.hasDefault && effectiveDefaultSrc);
  const isShowingCustomImage =
    slotMeta.mode === 'custom' && slotMeta.hasCustomFile && slotMeta.category === 'image';
  const isShowingCustomVideo =
    slotMeta.mode === 'custom' && slotMeta.hasCustomFile && slotMeta.category === 'video';
  const isShowingCustomDocOrPdf =
    slotMeta.mode === 'custom' &&
    slotMeta.hasCustomFile &&
    (slotMeta.category === 'pdf' || slotMeta.category === 'document');

  const activeImageSrcForEditor = isShowingCustomImage
    ? objectUrl || ''
    : isShowingDefaultImage
      ? effectiveDefaultSrc
      : '';

  const handleUploadAnyFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (file.size === 0) {
      setFeedback({
        type: 'error',
        text: 'Selected file is empty. Please choose a valid file.',
      });
      return;
    }

    if (file.size > MAX_CLIENT_ATTACHMENT_BYTES) {
      setFeedback({
        type: 'error',
        text: `"${file.name}" is ${formatBytesHuman(file.size)}. Please choose a file under 25 MB for WhatsApp delivery.`,
      });
      return;
    }

    const dotIdx = file.name.lastIndexOf('.');
    const extLower = dotIdx >= 0 ? file.name.slice(dotIdx).toLowerCase() : '';
    if (extLower && BLOCKED_CLIENT_EXTENSIONS.has(extLower)) {
      setFeedback({
        type: 'error',
        text: `Executable or script files (${extLower}) are blocked for security. Upload any PDF, Image, Video, Office doc, or ZIP file.`,
      });
      return;
    }

    setIsSaving(true);
    setFeedback(null);
    setIsEditingImage(false);

    try {
      const res = await fetch(`/api/whatsapp/slot-media/${slot}`, {
        method: 'POST',
        headers: {
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          'X-File-Mime': file.type || 'application/octet-stream',
        },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({
          type: 'error',
          text: data.error || `Could not upload file for Message ${slot}.`,
        });
        return;
      }

      const updatedSlotMeta: SlotMediaStatusPayload | undefined =
        data.slotMedia?.[String(slot) as '1' | '2' | '3'];
      const localPreviewUrl = URL.createObjectURL(file);
      replaceObjectUrl(localPreviewUrl);
      if (updatedSlotMeta?.updatedAt) {
        setLoadedStamp(updatedSlotMeta.updatedAt);
      }

      onUpdated({
        slotMedia: data.slotMedia,
        settings: data.settings,
        justUploadedCustomFile: true,
      });

      const typeLabel =
        updatedSlotMeta?.category === 'pdf'
          ? 'PDF'
          : updatedSlotMeta?.category === 'video'
            ? 'Video'
            : updatedSlotMeta?.category === 'image'
              ? 'Image'
              : 'File';

      setFeedback({
        type: 'success',
        text: `${typeLabel} "${file.name}" (${formatBytesHuman(file.size)}) attached to Message ${slot} & synced across AI Studio and Railway.`,
      });
    } catch {
      setFeedback({
        type: 'error',
        text: `Network error while uploading "${file.name}" to Message ${slot}.`,
      });
    } finally {
      setIsSaving(false);
    }
  };

  const saveSlotModeOrCanvasImage = async (
    nextMode: SlotMode,
    dataUrl?: string,
    fileName?: string,
    successNote?: string
  ): Promise<boolean> => {
    setIsSaving(true);
    setFeedback(null);
    try {
      const res = await fetch(`/api/whatsapp/slot-media/${slot}/mode`, {
        method: 'POST',
        headers: {
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mode: nextMode,
          ...(dataUrl ? { dataUrl } : {}),
          ...(fileName ? { fileName } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({
          type: 'error',
          text: data.error || `Could not update Message ${slot} attachment.`,
        });
        return false;
      }

      if (nextMode !== 'custom') {
        replaceObjectUrl(null);
        setLoadedStamp(0);
      }

      onUpdated({
        slotMedia: data.slotMedia,
      });

      setFeedback({
        type: 'success',
        text: successNote || `Message ${slot} attachment updated & synced.`,
      });
      return true;
    } catch {
      setFeedback({
        type: 'error',
        text: `Network error while updating Message ${slot} attachment.`,
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handleOpenImageEditor = () => {
    if (!activeImageSrcForEditor) return;
    setFeedback(null);
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
      setFeedback({
        type: 'error',
        text: 'Unable to open image editor for this file. Please upload a JPG, PNG, or WebP image.',
      });
    };
    img.src = activeImageSrcForEditor;
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
    const ok = await saveSlotModeOrCanvasImage(
      'custom',
      editedDataUrl,
      `prestair-message-${slot}.jpg`,
      `Message ${slot} edited image saved & synced in real time.`
    );
    if (ok) {
      setIsEditingImage(false);
    }
  };

  const safeDownloadFileName =
    slotMeta.fileName ||
    (slotMeta.category === 'pdf'
      ? `prestair-message-${slot}.pdf`
      : slotMeta.category === 'video'
        ? `prestair-message-${slot}.mp4`
        : `prestair-message-${slot}`);

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600 min-w-0">
          <span className="font-semibold text-slate-700">
            {slotMeta.mode === 'none'
              ? `${label} (No File · Text Only)`
              : slotMeta.mode === 'default'
                ? `${label} (Default Image)`
                : label}
          </span>
          {slotMeta.mode === 'custom' && slotMeta.hasCustomFile && slotMeta.fileName && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate max-w-44 font-medium text-slate-800">
                {slotMeta.fileName}
              </span>
              {slotMeta.byteLength > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="tabular-nums">{formatBytesHuman(slotMeta.byteLength)}</span>
                </>
              )}
            </>
          )}
        </div>

        {/* Unrestricted file input so PDF, Image, Video, Word, Excel, ZIP, HEIC, MOV, etc. are ALL selectable */}
        <input
          ref={fileInputRef}
          type="file"
          onChange={(e) => void handleUploadAnyFile(e)}
          className="hidden"
        />

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={isSaving}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-800 text-xs font-semibold px-2.5 py-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-700" />
            ) : (
              <Upload className="h-3.5 w-3.5 text-sky-700" />
            )}
            <span>
              {slotMeta.mode === 'custom' && slotMeta.hasCustomFile
                ? 'Replace File'
                : 'Upload File (PDF / Image / Video)'}
            </span>
          </button>

          {(isShowingDefaultImage || isShowingCustomImage) &&
            Boolean(activeImageSrcForEditor) &&
            !defaultImgFailed &&
            !isEditingImage && (
              <button
                type="button"
                disabled={isSaving}
                onClick={handleOpenImageEditor}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-800 text-xs font-semibold px-2.5 py-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Pencil className="h-3.5 w-3.5 text-emerald-700" />
                <span>Edit Image</span>
              </button>
            )}

          {slotMeta.hasDefault && slotMeta.mode !== 'default' && !isEditingImage && (
            <button
              type="button"
              disabled={isSaving}
              onClick={() =>
                void saveSlotModeOrCanvasImage(
                  'default',
                  undefined,
                  undefined,
                  `Restored default Prestair image for Message ${slot}.`
                )
              }
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 text-sky-700 text-xs font-medium px-2.5 py-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-3 w-3" />
              <span>Default</span>
            </button>
          )}

          {slotMeta.mode !== 'none' && !isEditingImage && (
            <button
              type="button"
              disabled={isSaving}
              onClick={() =>
                void saveSlotModeOrCanvasImage(
                  'none',
                  undefined,
                  undefined,
                  `Removed file from Message ${slot} (will send text caption only).`
                )
              }
              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white hover:bg-rose-50 hover:border-rose-200 disabled:opacity-50 text-slate-600 hover:text-rose-700 text-xs font-medium px-2.5 py-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Trash2 className="h-3.5 w-3.5" />
              <span>No File</span>
            </button>
          )}
        </div>
      </div>

      {!isEditingImage ? (
        <div className="max-w-md">
          {isShowingDefaultImage && !defaultImgFailed ? (
            <div className="group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50 aspect-[16/10] max-w-sm">
              <img
                src={effectiveDefaultSrc}
                alt={`Prestair WhatsApp Message ${slot} Default Image`}
                referrerPolicy="no-referrer"
                onError={() => {
                  if (
                    !usedFallbackDefault &&
                    fallbackDefaultImageSrc &&
                    fallbackDefaultImageSrc !== defaultImageSrc
                  ) {
                    setUsedFallbackDefault(true);
                  } else {
                    setDefaultImgFailed(true);
                  }
                }}
                className="h-full w-full object-cover"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="absolute inset-0 bg-slate-950/0 group-hover:bg-slate-950/40 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
              >
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/95 px-3 py-1.5 text-xs font-semibold text-slate-900 shadow-sm whitespace-nowrap">
                  <Upload className="h-3.5 w-3.5 text-sky-700" />
                  <span>Upload PDF, Image, Video or Any File</span>
                </span>
              </button>
            </div>
          ) : isShowingCustomImage ? (
            <div className="group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50 aspect-[16/10] max-w-sm flex items-center justify-center">
              {objectUrl ? (
                <>
                  <img
                    src={objectUrl}
                    alt={slotMeta.fileName || `Message ${slot} Attached Image`}
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="absolute inset-0 bg-slate-950/0 group-hover:bg-slate-950/40 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
                  >
                    <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/95 px-3 py-1.5 text-xs font-semibold text-slate-900 shadow-sm whitespace-nowrap">
                      <Upload className="h-3.5 w-3.5 text-sky-700" />
                      <span>Replace with Any File (PDF / Image / Video)</span>
                    </span>
                  </button>
                </>
              ) : (
                <div className="flex items-center gap-2 text-xs text-slate-500 px-4">
                  <Loader2
                    className={`h-4 w-4 text-sky-600 shrink-0 ${
                      isLoadingPreview ? 'animate-spin' : ''
                    }`}
                  />
                  <span>Loading synced image preview…</span>
                </div>
              )}
            </div>
          ) : isShowingCustomVideo ? (
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-950 aspect-[16/10] max-w-sm flex items-center justify-center">
              {objectUrl ? (
                <video
                  key={objectUrl}
                  src={objectUrl}
                  controls
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-contain bg-slate-950"
                />
              ) : (
                <div className="flex items-center gap-2 text-xs text-slate-300 px-4 text-center">
                  <Loader2
                    className={`h-4 w-4 text-sky-400 shrink-0 ${
                      isLoadingPreview ? 'animate-spin' : ''
                    }`}
                  />
                  <span>Loading synced video preview…</span>
                </div>
              )}
            </div>
          ) : isShowingCustomDocOrPdf ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 flex items-start justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <div
                  className={`h-10 w-10 rounded-lg border flex items-center justify-center shrink-0 ${
                    slotMeta.category === 'pdf'
                      ? 'bg-rose-50 border-rose-200 text-rose-700'
                      : 'bg-sky-50 border-sky-200 text-sky-700'
                  }`}
                >
                  {slotMeta.category === 'pdf' ? (
                    <FileText className="h-5 w-5" />
                  ) : getFileExtensionUpper(slotMeta.fileName).match(/^(XLS|XLSX|CSV|ODS)$/) ? (
                    <FileSpreadsheet className="h-5 w-5" />
                  ) : (
                    <Paperclip className="h-5 w-5" />
                  )}
                </div>
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs font-bold text-slate-900 truncate">
                    {slotMeta.fileName || `Message-${slot}-Attachment`}
                  </p>
                  <p className="text-xs text-slate-600 tabular-nums">
                    {slotMeta.category === 'pdf'
                      ? 'PDF Catalogue / Document'
                      : `${getFileExtensionUpper(slotMeta.fileName)} File Attachment`}{' '}
                    · {formatBytesHuman(slotMeta.byteLength)}
                  </p>
                  <p className="text-[11px] text-emerald-800">
                    Delivers on WhatsApp with filename + text caption below
                  </p>
                </div>
              </div>

              {objectUrl && (
                <a
                  href={objectUrl}
                  download={safeDownloadFileName}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs font-semibold px-2.5 py-1.5 transition-colors whitespace-nowrap shrink-0"
                >
                  <Download className="h-3.5 w-3.5 text-sky-700" />
                  <span>Check File</span>
                </a>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-center space-y-2 max-w-sm">
              <p className="text-xs font-medium text-slate-600">
                Upload <strong className="font-semibold text-slate-800">PDF, Image, Video, Word/Excel, or any file</strong> (up to 25 MB) for Message {slot}.
              </p>
              <button
                type="button"
                disabled={isSaving}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 transition-colors cursor-pointer whitespace-nowrap"
              >
                {isSaving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                <span>Choose Any File (PDF / Image / Video)</span>
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
              disabled={isSaving}
              onClick={() => void handleApplyEditedImage()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-semibold px-3.5 py-1.5 cursor-pointer"
            >
              {isSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5" />
              )}
              <span>Apply &amp; Save Image</span>
            </button>
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-500">
        Supported formats: PDF, JPG, PNG, WebP, HEIC, MP4, MOV, WebM, Word, Excel, PPT, ZIP &amp; all standard files up to 25 MB.
      </p>

      {feedback && (
        <p
          className={`text-xs font-medium rounded-lg px-3 py-2 border ${
            feedback.type === 'error'
              ? 'text-rose-700 bg-rose-50 border-rose-200'
              : 'text-emerald-800 bg-emerald-50 border-emerald-200'
          }`}
        >
          {feedback.text}
        </p>
      )}
    </div>
  );
};

interface HiddenWhatsAppSidebarProps {
  adminToken: string | null;
  onOpenShowcaseTab?: () => void;
}

export const HiddenWhatsAppSidebar: React.FC<HiddenWhatsAppSidebarProps> = ({
  adminToken,
  onOpenShowcaseTab,
}) => {
  const [waStatus, setWaStatus] = useState<WhatsAppStatusPayload | null>(null);
  const [isLoadingWa, setIsLoadingWa] = useState(false);
  const [pairingPhone, setPairingPhone] = useState('917428545777');
  const [copiedPairingCode, setCopiedPairingCode] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [testFeedback, setTestFeedback] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [settingsFeedback, setSettingsFeedback] = useState<string | null>(null);

  const [autoReplyEnabled, setAutoReplyEnabled] = useState(true);
  const [firstMessageEnabled, setFirstMessageEnabled] = useState(true);
  const [messageTemplate, setMessageTemplate] = useState(DEFAULT_PRESTAIR_WHATSAPP_REPLY);
  const [secondMessageEnabled, setSecondMessageEnabled] = useState(true);
  const [secondMessageTemplate, setSecondMessageTemplate] = useState(
    DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY
  );
  const [thirdMessageEnabled, setThirdMessageEnabled] = useState(true);
  const [thirdMessageTemplate, setThirdMessageTemplate] = useState(
    DEFAULT_PRESTAIR_THIRD_WHATSAPP_REPLY
  );
  const [adminNotifyPhone, setAdminNotifyPhone] = useState('');
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [isEditingSettings, setIsEditingSettings] = useState(false);

  // Unified 3-Slot Attachment State (PDF / Image / Video / Any File across all 3 messages)
  const [slot1Meta, setSlot1Meta] = useState<SlotMediaStatusPayload>(() =>
    buildFallbackSlotMeta(1, null)
  );
  const [slot2Meta, setSlot2Meta] = useState<SlotMediaStatusPayload>(() =>
    buildFallbackSlotMeta(2, null)
  );
  const [slot3Meta, setSlot3Meta] = useState<SlotMediaStatusPayload>(() =>
    buildFallbackSlotMeta(3, null)
  );

  const [isEditingImage1, setIsEditingImage1] = useState(false);
  const [isEditingImage2, setIsEditingImage2] = useState(false);
  const [isEditingImage3, setIsEditingImage3] = useState(false);

  const applySlotMediaMap = (
    map?: Record<'1' | '2' | '3', SlotMediaStatusPayload>,
    fullStatus?: WhatsAppStatusPayload
  ) => {
    if (map) {
      if (!isEditingImage1 && map['1']) setSlot1Meta(map['1']);
      if (!isEditingImage2 && map['2']) setSlot2Meta(map['2']);
      if (!isEditingImage3 && map['3']) setSlot3Meta(map['3']);
      return;
    }
    if (fullStatus) {
      if (!isEditingImage1) setSlot1Meta(buildFallbackSlotMeta(1, fullStatus));
      if (!isEditingImage2) setSlot2Meta(buildFallbackSlotMeta(2, fullStatus));
      if (!isEditingImage3) setSlot3Meta(buildFallbackSlotMeta(3, fullStatus));
    }
  };

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
        setFirstMessageEnabled(
          typeof data.settings.firstMessageEnabled === 'boolean'
            ? data.settings.firstMessageEnabled
            : true
        );
        setMessageTemplate(data.settings.messageTemplate || DEFAULT_PRESTAIR_WHATSAPP_REPLY);
        setSecondMessageEnabled(
          typeof data.settings.secondMessageEnabled === 'boolean'
            ? data.settings.secondMessageEnabled
            : true
        );
        setSecondMessageTemplate(
          data.settings.secondMessageTemplate || DEFAULT_PRESTAIR_SECOND_WHATSAPP_REPLY
        );
        setThirdMessageEnabled(
          typeof data.settings.thirdMessageEnabled === 'boolean'
            ? data.settings.thirdMessageEnabled
            : true
        );
        setThirdMessageTemplate(
          data.settings.thirdMessageTemplate || DEFAULT_PRESTAIR_THIRD_WHATSAPP_REPLY
        );
        setAdminNotifyPhone(data.settings.adminNotifyPhone || '');
      }
      applySlotMediaMap(data.slotMedia, data);
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
  }, [adminToken, isEditingSettings, isEditingImage1, isEditingImage2, isEditingImage3]);

  const handleStartWhatsApp = async (usePairingPhone = false) => {
    setIsLoadingWa(true);
    setTestFeedback(null);
    setCopiedPairingCode(false);
    try {
      const res = await fetch('/api/whatsapp/connect', {
        method: 'POST',
        headers: {
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          pairingPhone: usePairingPhone ? pairingPhone.trim() : '',
        }),
      });
      if (res.ok) {
        const snap = (await res.json().catch(() => null)) as Partial<WhatsAppStatusPayload> | null;
        if (snap && snap.status) {
          setWaStatus((prev) =>
            prev
              ? {
                  ...prev,
                  status: snap.status || prev.status,
                  qrDataUrl: snap.qrDataUrl ?? null,
                  pairingCode: snap.pairingCode ?? null,
                  connectedNumber: snap.connectedNumber ?? prev.connectedNumber,
                  lastError: snap.lastError ?? null,
                }
              : prev
          );
        }
      }
      await fetchWhatsAppStatus(false);
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

  const activeMessageCount =
    (firstMessageEnabled ? 1 : 0) +
    (secondMessageEnabled ? 1 : 0) +
    (thirdMessageEnabled ? 1 : 0);

  const selectedSummaryParts: string[] = [];
  if (firstMessageEnabled) selectedSummaryParts.push(`Msg 1 (${describeSlotShortLabel(slot1Meta)})`);
  if (secondMessageEnabled) selectedSummaryParts.push(`Msg 2 (${describeSlotShortLabel(slot2Meta)})`);
  if (thirdMessageEnabled) selectedSummaryParts.push(`Msg 3 (${describeSlotShortLabel(slot3Meta)})`);

  const isPreset1Active =
    firstMessageEnabled && !secondMessageEnabled && !thirdMessageEnabled;
  const isPreset2Active =
    firstMessageEnabled && secondMessageEnabled && !thirdMessageEnabled;
  const isPreset3Active =
    firstMessageEnabled && secondMessageEnabled && thirdMessageEnabled;

  const applyMessageCountPreset = (count: 1 | 2 | 3) => {
    setIsEditingSettings(true);
    setSettingsFeedback(null);
    if (count === 1) {
      setFirstMessageEnabled(true);
      setSecondMessageEnabled(false);
      setThirdMessageEnabled(false);
    } else if (count === 2) {
      setFirstMessageEnabled(true);
      setSecondMessageEnabled(true);
      setThirdMessageEnabled(false);
    } else {
      setFirstMessageEnabled(true);
      setSecondMessageEnabled(true);
      setThirdMessageEnabled(true);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsFeedback(null);
    if (!firstMessageEnabled && !secondMessageEnabled && !thirdMessageEnabled) {
      setSettingsFeedback(
        'Please select at least 1 message (1 Message, 2 Messages, or All 3 Messages) before saving.'
      );
      return;
    }
    setIsSavingSettings(true);
    try {
      const res = await fetch('/api/whatsapp/settings', {
        method: 'POST',
        headers: {
          ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          autoReplyEnabled,
          firstMessageEnabled,
          messageTemplate,
          secondMessageEnabled,
          secondMessageTemplate,
          thirdMessageEnabled,
          thirdMessageTemplate,
          adminNotifyPhone,
        }),
      });
      if (res.ok) {
        setIsEditingSettings(false);
        setSettingsFeedback(
          `Saved! WhatsApp automation will send ${activeMessageCount} message${
            activeMessageCount === 1 ? '' : 's'
          } (${selectedSummaryParts.join(' · ')}) across AI Studio & Railway.`
        );
        void fetchWhatsAppStatus(true);
      } else {
        const errData = await res.json().catch(() => ({}));
        setSettingsFeedback(errData.error || 'Could not save WhatsApp automation settings.');
      }
    } finally {
      setIsSavingSettings(false);
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
          sendFirst: firstMessageEnabled,
          text: messageTemplate,
          sendSecond: secondMessageEnabled,
          secondText: secondMessageTemplate,
          sendThird: thirdMessageEnabled,
          thirdText: thirdMessageTemplate,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const countLabel = `${activeMessageCount} message${
          activeMessageCount === 1 ? '' : 's'
        } (${selectedSummaryParts.join(' + ')})`;
        setTestFeedback(
          data.relayedViaCloud
            ? `Queued ${countLabel} via active 24x7 Cloud Worker for ${testPhone.trim()}.`
            : `Delivered ${countLabel} to ${testPhone.trim()}.`
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
            Encrypted Cloud Session Backup keeps your WhatsApp linked across every GitHub push, Railway container redeploy, and restart—with single-leader protection so servers never log each other out.
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
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 space-y-2.5">
              <p className="text-xs font-medium text-emerald-900 text-center leading-relaxed">
                Open WhatsApp on your phone → Linked Devices → Link a Device → Link with phone number instead:
              </p>
              <div className="flex items-center justify-center gap-2.5">
                <p className="font-mono text-2xl font-bold tracking-widest text-emerald-950 tabular-nums select-all">
                  {waStatus.pairingCode}
                </p>
                <button
                  type="button"
                  onClick={() => {
                    if (!waStatus.pairingCode) return;
                    void navigator.clipboard
                      ?.writeText(waStatus.pairingCode.replace(/-/g, ''))
                      .then(() => {
                        setCopiedPairingCode(true);
                        setTimeout(() => setCopiedPairingCode(false), 2000);
                      })
                      .catch(() => {});
                  }}
                  className="min-h-9 inline-flex items-center gap-1 rounded-lg border border-emerald-300 bg-white hover:bg-emerald-100 text-emerald-900 text-xs font-medium px-2.5 py-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  {copiedPairingCode ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      <span>Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {!isAnyWorkerConnected && (
            <div className="pt-3 border-t border-slate-200 space-y-2">
              <label
                htmlFor="wa-pairing-phone"
                className="block text-xs font-semibold text-slate-700"
              >
                Link with Phone Number Pairing Code (No QR Scan Required)
              </label>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                <input
                  id="wa-pairing-phone"
                  type="tel"
                  value={pairingPhone}
                  onChange={(e) => setPairingPhone(e.target.value)}
                  placeholder="e.g. 917428545777"
                  className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2.5 sm:py-2 text-base sm:text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-sky-600 tabular-nums"
                />
                <button
                  type="button"
                  onClick={() => void handleStartWhatsApp(true)}
                  disabled={isLoadingWa || !pairingPhone.trim()}
                  className="min-h-10 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-semibold px-3.5 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  {isLoadingWa ? 'Generating…' : 'Get Pairing Code'}
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
            Send Test Confirmation ({activeMessageCount} Selected Message
            {activeMessageCount === 1 ? '' : 's'})
          </label>
          <p className="text-xs text-slate-600">
            {activeMessageCount > 0
              ? `Verify instant delivery of ${selectedSummaryParts.join(' → ')} to any WhatsApp number.`
              : 'Select at least 1 message on the right to send a test confirmation.'}
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
              disabled={isSendingTest || !testPhone.trim() || activeMessageCount === 0}
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

      {/* Right Column: Real-Time Synced 1 / 2 / 3-Message Universal File Auto-Reply Settings */}
      <div className="lg:col-span-7">
        <form
          onSubmit={handleSaveSettings}
          className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5 space-y-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3.5">
            <div>
              <h3 className="font-display text-sm font-bold text-slate-900">
                Customer WhatsApp Automation — PDF, Image, Video &amp; Any File
              </h3>
              <p className="text-xs text-slate-600">
                Attach any file format (PDF, Image, Video, Doc) to Messages 1, 2 &amp; 3 and choose 1, 2, or all 3 messages below.
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

          {/* 1 / 2 / 3 Active Messages Preset Selector + Quick Save */}
          <div className="space-y-2.5 pb-4 border-b border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-bold text-slate-900">
                How Many WhatsApp Messages Should Go to the Customer?
              </p>
              <span className="text-xs text-slate-500 tabular-nums">
                {activeMessageCount > 0
                  ? `${activeMessageCount} of 3 selected`
                  : '0 selected'}
              </span>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <div className="grid grid-cols-3 sm:inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100 border border-slate-200 w-full sm:w-auto">
                <button
                  type="button"
                  onClick={() => applyMessageCountPreset(1)}
                  className={`min-h-9 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    isPreset1Active
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'text-slate-700 hover:text-slate-900'
                  }`}
                >
                  1 Message
                </button>
                <button
                  type="button"
                  onClick={() => applyMessageCountPreset(2)}
                  className={`min-h-9 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    isPreset2Active
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'text-slate-700 hover:text-slate-900'
                  }`}
                >
                  2 Messages
                </button>
                <button
                  type="button"
                  onClick={() => applyMessageCountPreset(3)}
                  className={`min-h-9 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    isPreset3Active
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'text-slate-700 hover:text-slate-900'
                  }`}
                >
                  All 3 Messages
                </button>
              </div>

              <button
                type="submit"
                disabled={isSavingSettings || activeMessageCount === 0}
                className="min-h-9 w-full sm:w-auto inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-semibold px-3.5 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {isSavingSettings ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                <span>Save Selection</span>
              </button>
            </div>

            <p className="text-xs text-slate-600">
              {selectedSummaryParts.length > 0
                ? `Active sequence: ${selectedSummaryParts.join(' · ')}`
                : 'No messages selected—enable 1, 2, or all 3 messages above.'}
            </p>
          </div>

          {/* MESSAGE 1: First Separate File (Image / PDF / Video / Any File) + Text Confirmation */}
          <div className="space-y-3 pb-5 border-b border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-display text-xs sm:text-sm font-bold text-slate-900">
                01. First WhatsApp Message (Image / PDF / Video + Text 1)
              </h4>
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={firstMessageEnabled}
                  onChange={(e) => {
                    setIsEditingSettings(true);
                    setFirstMessageEnabled(e.target.checked);
                  }}
                  className="h-4 w-4 accent-emerald-600 rounded"
                />
                <span>Send 1st Message</span>
              </label>
            </div>

            <ReplyAttachmentEditorSection
              slot={1}
              label="Message 1 Attachment"
              slotMeta={slot1Meta}
              defaultImageSrc={PRESTAIR_REPLY_IMAGES[0]}
              adminToken={adminToken}
              onEditingChange={setIsEditingImage1}
              onUpdated={({ slotMedia, settings, justUploadedCustomFile }) => {
                if (slotMedia) applySlotMediaMap(slotMedia);
                if (justUploadedCustomFile || settings?.firstMessageEnabled) {
                  setFirstMessageEnabled(true);
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
                rows={6}
                value={messageTemplate}
                onChange={(e) => {
                  setIsEditingSettings(true);
                  setMessageTemplate(e.target.value);
                }}
                className="w-full rounded-lg border border-slate-300 bg-white p-3 text-base sm:text-xs text-slate-900 leading-relaxed focus:outline-none focus:border-sky-600"
              />
            </div>
          </div>

          {/* MESSAGE 2: Second Separate File (PDF / Image / Video / Any File) + Text Confirmation */}
          <div className="space-y-3 pb-5 border-b border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-display text-xs sm:text-sm font-bold text-slate-900">
                02. Second WhatsApp Message (PDF / Image / Video + Text 2)
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

            <ReplyAttachmentEditorSection
              slot={2}
              label="Message 2 Attachment"
              slotMeta={slot2Meta}
              defaultImageSrc={PRESTAIR_SECOND_REPLY_IMAGES[0]}
              fallbackDefaultImageSrc={PRESTAIR_REPLY_IMAGES[0]}
              adminToken={adminToken}
              onEditingChange={setIsEditingImage2}
              onUpdated={({ slotMedia, settings, justUploadedCustomFile }) => {
                if (slotMedia) applySlotMediaMap(slotMedia);
                if (justUploadedCustomFile || settings?.secondMessageEnabled) {
                  setSecondMessageEnabled(true);
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
                rows={5}
                value={secondMessageTemplate}
                onChange={(e) => {
                  setIsEditingSettings(true);
                  setSecondMessageTemplate(e.target.value);
                }}
                className="w-full rounded-lg border border-slate-300 bg-white p-3 text-base sm:text-xs text-slate-900 leading-relaxed focus:outline-none focus:border-sky-600"
              />
            </div>
          </div>

          {/* MESSAGE 3: Third Separate File (Video / PDF / Image / Any File) + Text Confirmation */}
          <div className="space-y-3 pb-5 border-b border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-display text-xs sm:text-sm font-bold text-slate-900">
                03. Third WhatsApp Message (Video / PDF / Image + Text 3)
              </h4>
              <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={thirdMessageEnabled}
                  onChange={(e) => {
                    setIsEditingSettings(true);
                    setThirdMessageEnabled(e.target.checked);
                  }}
                  className="h-4 w-4 accent-emerald-600 rounded"
                />
                <span>Send 3rd Message</span>
              </label>
            </div>

            <ReplyAttachmentEditorSection
              slot={3}
              label="Message 3 Attachment"
              slotMeta={slot3Meta}
              adminToken={adminToken}
              onEditingChange={setIsEditingImage3}
              onUpdated={({ slotMedia, settings, justUploadedCustomFile }) => {
                if (slotMedia) applySlotMediaMap(slotMedia);
                if (justUploadedCustomFile || settings?.thirdMessageEnabled) {
                  setThirdMessageEnabled(true);
                }
              }}
            />

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                <label
                  htmlFor="wa-template-input-3"
                  className="block text-xs font-semibold text-slate-700"
                >
                  Message 3 Text Caption
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setIsEditingSettings(true);
                    setThirdMessageTemplate(DEFAULT_PRESTAIR_THIRD_WHATSAPP_REPLY);
                  }}
                  className="inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:text-sky-800 cursor-pointer whitespace-nowrap"
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>Restore Default Message 3</span>
                </button>
              </div>
              <textarea
                id="wa-template-input-3"
                rows={5}
                value={thirdMessageTemplate}
                onChange={(e) => {
                  setIsEditingSettings(true);
                  setThirdMessageTemplate(e.target.value);
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

          {onOpenShowcaseTab && (
            <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-slate-600">
                Want to choose which image appears on the website Thank You Showcase?
              </p>
              <button
                type="button"
                onClick={onOpenShowcaseTab}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-sky-800 text-xs font-semibold px-3 py-1.5 transition-colors cursor-pointer whitespace-nowrap"
              >
                <ImagePlus className="h-3.5 w-3.5" />
                <span>Select Showcase Image →</span>
              </button>
            </div>
          )}

          <button
            type="submit"
            disabled={isSavingSettings || activeMessageCount === 0}
            className="w-full min-h-11 inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-semibold py-2.5 px-4 transition-colors cursor-pointer whitespace-nowrap"
          >
            {isSavingSettings ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            <span>
              Save WhatsApp Automation ({activeMessageCount} Message
              {activeMessageCount === 1 ? '' : 's'} Selected)
            </span>
          </button>
        </form>
      </div>
    </div>
  );
};

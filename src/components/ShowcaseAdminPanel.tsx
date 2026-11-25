import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  EyeOff,
  Image as ImageIcon,
  ImagePlus,
  Loader2,
  Pencil,
  RotateCcw,
  RotateCw,
  X,
} from 'lucide-react';
import { PRESTAIR_REPLY_IMAGES } from '../utils/leadLogic';

export type ShowcaseImageSource = 'wa1' | 'wa2' | 'custom' | 'none';
type AspectPreset = '4:3' | '16:10' | '1:1' | 'original';

export interface ShowcaseStatusPayload {
  source: ShowcaseImageSource;
  activeImageSrc: string | null;
  customDataUrl: string | null;
  wa1DataUrl: string | null;
  wa2DataUrl: string | null;
  updatedAt: number;
}

function drawShowcaseCanvas(
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
  if (options.aspectPreset === '4:3') targetRatio = 4 / 3;
  else if (options.aspectPreset === '16:10') targetRatio = 16 / 10;
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

interface ShowcaseAdminPanelProps {
  adminToken: string | null;
  onShowcaseChanged?: (payload: {
    source: ShowcaseImageSource;
    imageSrc: string | null;
  }) => void;
}

export const ShowcaseAdminPanel: React.FC<ShowcaseAdminPanelProps> = ({
  adminToken,
  onShowcaseChanged,
}) => {
  const [status, setStatus] = useState<ShowcaseStatusPayload | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Built-in Showcase Image Editor
  const [isEditingImage, setIsEditingImage] = useState(false);
  const [rotationDeg, setRotationDeg] = useState(0);
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>('4:3');
  const [zoomLevel, setZoomLevel] = useState(1);
  const [brightnessPct, setBrightnessPct] = useState(100);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedEditorImgRef = useRef<HTMLImageElement | null>(null);

  const fetchShowcaseStatus = useCallback(async () => {
    if (!adminToken) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/showcase/status', {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) return;
      const data: ShowcaseStatusPayload = await res.json();
      setStatus(data);
      setPreviewFailed(false);
    } catch {
      // ignore transient network failure
    } finally {
      setIsLoading(false);
    }
  }, [adminToken]);

  useEffect(() => {
    void fetchShowcaseStatus();
  }, [fetchShowcaseStatus]);

  useEffect(() => {
    if (!isEditingImage || !previewCanvasRef.current || !loadedEditorImgRef.current) return;
    drawShowcaseCanvas(previewCanvasRef.current, loadedEditorImgRef.current, {
      rotationDeg,
      aspectPreset,
      zoomLevel,
      brightnessPct,
      maxDimension: 1080,
    });
  }, [isEditingImage, rotationDeg, aspectPreset, zoomLevel, brightnessPct]);

  const saveShowcaseUpdate = async (
    nextSource: ShowcaseImageSource,
    dataUrl?: string,
    successNote?: string
  ) => {
    if (!adminToken) return false;
    setIsSaving(true);
    setFeedback(null);
    try {
      const res = await fetch('/api/showcase/settings', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          source: nextSource,
          ...(dataUrl ? { dataUrl } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFeedback({
          type: 'error',
          text: data.error || 'Could not update Showcase image.',
        });
        return false;
      }
      const nextPayload: ShowcaseStatusPayload = {
        source: data.source,
        activeImageSrc: data.activeImageSrc,
        customDataUrl: data.customDataUrl,
        wa1DataUrl: data.wa1DataUrl,
        wa2DataUrl: data.wa2DataUrl,
        updatedAt: data.updatedAt,
      };
      setStatus(nextPayload);
      setPreviewFailed(false);
      onShowcaseChanged?.({
        source: nextPayload.source,
        imageSrc: nextPayload.activeImageSrc,
      });
      setFeedback({
        type: 'success',
        text:
          successNote ||
          'Thank You Showcase image updated & synced live across AI Studio and Railway.',
      });
      return true;
    } catch {
      setFeedback({
        type: 'error',
        text: 'Network error while saving Showcase image.',
      });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  const handleSelectSource = (targetSource: ShowcaseImageSource) => {
    if (targetSource === 'custom' && !status?.customDataUrl) {
      fileInputRef.current?.click();
      return;
    }
    const labels: Record<ShowcaseImageSource, string> = {
      wa1: 'Showcase set to WhatsApp Message 1 Image.',
      wa2: 'Showcase set to WhatsApp Message 2 Image.',
      custom: 'Showcase set to your Custom Uploaded Image.',
      none: 'Showcase image hidden (Thank You popup will show text only).',
    };
    void saveShowcaseUpdate(targetSource, undefined, labels[targetSource]);
  };

  const handleUploadCustomFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setFeedback({
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
        drawShowcaseCanvas(offscreen, img, {
          rotationDeg: 0,
          aspectPreset: 'original',
          zoomLevel: 1,
          brightnessPct: 100,
          maxDimension: 1280,
        });
        const optimizedDataUrl = offscreen.toDataURL('image/jpeg', 0.88);
        void saveShowcaseUpdate(
          'custom',
          optimizedDataUrl,
          'Custom Showcase image uploaded & synced live across AI Studio and Railway.'
        );
      };
      img.onerror = () => {
        setFeedback({
          type: 'error',
          text: 'Could not read that image file. Please try another JPG or PNG.',
        });
      };
      img.src = rawSrc;
    };
    reader.readAsDataURL(file);
  };

  const handleOpenEditor = () => {
    const srcToEdit = status?.activeImageSrc;
    if (!srcToEdit) {
      fileInputRef.current?.click();
      return;
    }
    setFeedback(null);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      loadedEditorImgRef.current = img;
      setRotationDeg(0);
      setAspectPreset('4:3');
      setZoomLevel(1);
      setBrightnessPct(100);
      setIsEditingImage(true);
    };
    img.onerror = () => {
      fileInputRef.current?.click();
    };
    img.src = srcToEdit;
  };

  const handleApplyEditedImage = async () => {
    const img = loadedEditorImgRef.current;
    if (!img) return;
    const exportCanvas = document.createElement('canvas');
    drawShowcaseCanvas(exportCanvas, img, {
      rotationDeg,
      aspectPreset,
      zoomLevel,
      brightnessPct,
      maxDimension: 1280,
    });
    const editedDataUrl = exportCanvas.toDataURL('image/jpeg', 0.88);
    const ok = await saveShowcaseUpdate(
      'custom',
      editedDataUrl,
      'Edited Showcase image saved & synced live across AI Studio and Railway.'
    );
    if (ok) {
      setIsEditingImage(false);
    }
  };

  const currentSource = status?.source || 'wa1';
  const currentPreviewSrc = status?.activeImageSrc || PRESTAIR_REPLY_IMAGES[0];

  const sourceOptions: Array<{
    id: ShowcaseImageSource;
    title: string;
    description: string;
    thumbSrc: string | null;
  }> = [
    {
      id: 'custom',
      title: '01. Custom Showcase Image (Upload Any Photo)',
      description: status?.customDataUrl
        ? 'Uses your dedicated custom image uploaded specifically for the Thank You showcase.'
        : 'Click to upload any dedicated showcase photo from your device.',
      thumbSrc: status?.customDataUrl || null,
    },
    {
      id: 'wa1',
      title: '02. Use WhatsApp Message 1 Image',
      description: 'Automatically displays the same image attached to WhatsApp Message 1.',
      thumbSrc: status?.wa1DataUrl || null,
    },
    {
      id: 'wa2',
      title: '03. Use WhatsApp Message 2 Image',
      description: 'Automatically displays the same image attached to WhatsApp Message 2.',
      thumbSrc: status?.wa2DataUrl || null,
    },
    {
      id: 'none',
      title: '04. Hide Showcase Image (Text Only)',
      description: 'Hides the left image frame on the Thank You popup and shows text cleanly.',
      thumbSrc: null,
    },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
      {/* Left Column: Choose Which Image Appears in Showcase */}
      <div className="lg:col-span-6 space-y-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3.5">
            <div>
              <h3 className="font-display text-sm sm:text-base font-bold text-slate-900">
                Choose Thank You Popup Showcase Image
              </h3>
              <p className="text-xs text-slate-600 mt-0.5">
                Select which image customers see on the “Thank you for your inquiry!” screen right after submitting the form.
              </p>
            </div>
            {isLoading && <Loader2 className="h-4 w-4 animate-spin text-sky-700 shrink-0 mt-1" />}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={handleUploadCustomFile}
            className="hidden"
          />

          <div className="space-y-2.5">
            {sourceOptions.map((opt) => {
              const isSelected = currentSource === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={isSaving}
                  onClick={() => handleSelectSource(opt.id)}
                  className={`w-full text-left flex items-center justify-between gap-3.5 rounded-xl border p-3.5 transition-colors cursor-pointer disabled:opacity-60 ${
                    isSelected
                      ? 'border-sky-600 bg-sky-50/70 ring-2 ring-sky-600/15'
                      : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    {opt.thumbSrc ? (
                      <img
                        src={opt.thumbSrc}
                        alt={opt.title}
                        referrerPolicy="no-referrer"
                        className="h-12 w-16 rounded-lg object-cover border border-slate-200 shrink-0 bg-slate-100"
                      />
                    ) : (
                      <div className="h-12 w-16 rounded-lg border border-slate-200 bg-slate-50 flex items-center justify-center text-slate-500 shrink-0">
                        {opt.id === 'none' ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <ImageIcon className="h-4 w-4" />
                        )}
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="font-display text-xs sm:text-sm font-bold text-slate-900 truncate">
                        {opt.title}
                      </p>
                      <p className="text-xs text-slate-600 mt-0.5 line-clamp-2">
                        {opt.description}
                      </p>
                    </div>
                  </div>

                  <span
                    className={`text-xs font-bold shrink-0 whitespace-nowrap ${
                      isSelected ? 'text-sky-800' : 'text-slate-400'
                    }`}
                  >
                    {isSelected ? 'Active' : 'Select'}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="pt-2 border-t border-slate-200 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={isSaving}
              onClick={() => fileInputRef.current?.click()}
              className="min-h-10 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 transition-colors cursor-pointer whitespace-nowrap"
            >
              <ImagePlus className="h-3.5 w-3.5" />
              <span>Upload New Showcase Image</span>
            </button>

            {currentSource !== 'none' && !previewFailed && !isEditingImage && (
              <button
                type="button"
                disabled={isSaving}
                onClick={handleOpenEditor}
                className="min-h-10 inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-800 text-xs font-semibold px-3.5 py-2 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Pencil className="h-3.5 w-3.5 text-emerald-700" />
                <span>Crop / Edit Active Image</span>
              </button>
            )}
          </div>

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
      </div>

      {/* Right Column: Live Customer Thank-You Showcase Preview & Crop/Rotate Studio */}
      <div className="lg:col-span-6">
        <div className="rounded-xl border border-slate-200 bg-white p-5 space-y-4">
          <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-3.5">
            <div>
              <h3 className="font-display text-sm sm:text-base font-bold text-slate-900">
                Live Customer Showcase Preview
              </h3>
              <p className="text-xs text-slate-600 mt-0.5">
                Exact preview of the Showcase box on the customer Thank You screen.
              </p>
            </div>
          </div>

          {!isEditingImage ? (
            currentSource === 'none' ? (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 aspect-[4/3] flex flex-col items-center justify-center p-6 text-center space-y-2">
                <EyeOff className="h-6 w-6 text-slate-400" />
                <p className="text-sm font-semibold text-slate-700">
                  Showcase Image Hidden (Text-Only Mode)
                </p>
                <p className="text-xs text-slate-500 max-w-xs">
                  Customers will see a clean centered Thank You message without an image box.
                </p>
              </div>
            ) : !previewFailed && currentPreviewSrc ? (
              <div className="group relative overflow-hidden rounded-xl border border-slate-200 bg-slate-50 aspect-[4/3]">
                <img
                  src={currentPreviewSrc}
                  alt="Prestair Bakery Solutions Showcase Live Preview"
                  referrerPolicy="no-referrer"
                  onError={() => setPreviewFailed(true)}
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="absolute inset-0 bg-slate-950/0 group-hover:bg-slate-950/35 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
                >
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/95 px-3.5 py-2 text-xs font-semibold text-slate-900 shadow-sm">
                    <ImagePlus className="h-3.5 w-3.5 text-sky-700" />
                    <span>Click to Upload Different Image</span>
                  </span>
                </button>
              </div>
            ) : (
              <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 aspect-[4/3] flex flex-col items-center justify-center p-6 text-center space-y-3">
                <p className="text-xs font-medium text-slate-600">
                  No image uploaded yet. Upload a JPG, PNG, or WebP image for your Showcase.
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold px-4 py-2 transition-colors cursor-pointer"
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                  <span>Upload Showcase Image</span>
                </button>
              </div>
            )
          ) : (
            <div className="rounded-xl border border-sky-200 bg-slate-50 p-4 space-y-3.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-bold text-slate-900">
                  Edit Customer Showcase Image
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

              <div className="overflow-hidden rounded-lg border border-slate-200 bg-white flex items-center justify-center">
                <canvas
                  ref={previewCanvasRef}
                  className="max-h-64 w-auto max-w-full object-contain"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRotationDeg((prev) => (prev - 90 + 360) % 360)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs font-medium px-2.5 py-1.5 cursor-pointer whitespace-nowrap"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  <span>Rotate Left</span>
                </button>
                <button
                  type="button"
                  onClick={() => setRotationDeg((prev) => (prev + 90) % 360)}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-xs font-medium px-2.5 py-1.5 cursor-pointer whitespace-nowrap"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                  <span>Rotate Right</span>
                </button>

                <div className="inline-flex items-center rounded-lg border border-slate-300 bg-white p-0.5">
                  {(['4:3', '16:10', '1:1', 'original'] as AspectPreset[]).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => setAspectPreset(preset)}
                      className={`rounded-md px-2 py-1 text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap ${
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
                  className="rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 text-xs font-medium px-3 py-1.5 cursor-pointer whitespace-nowrap"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isSaving}
                  onClick={() => void handleApplyEditedImage()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white text-xs font-semibold px-3.5 py-1.5 cursor-pointer whitespace-nowrap"
                >
                  {isSaving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  <span>Apply &amp; Save Showcase Image</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

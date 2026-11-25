// Real-time partial and confirmed lead capture form component
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  Briefcase,
  Building2,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Store,
  User as UserIcon,
  X,
} from 'lucide-react';
import {
  DEFAULT_PRESTAIR_WHATSAPP_REPLY,
  PRESTAIR_REPLY_IMAGES,
  PRODUCT_OPTIONS,
  type LeadFormInput,
} from '../utils/leadLogic';

interface LeadCaptureFormProps {
  form: LeadFormInput;
  errors: Partial<Record<keyof LeadFormInput, string>>;
  syncState: 'idle' | 'saving' | 'saved_partial' | 'confirmed';
  lastSavedTime: string | null;
  isSubmitting: boolean;
  submittedLeadId: string | null;
  whatsappSentAuto: boolean;
  whatsappDirectUrl: string | null;
  onFieldChange: <K extends keyof LeadFormInput>(field: K, value: LeadFormInput[K]) => void;
  onSubmit: (e: React.FormEvent) => void;
  onStartNewLead: () => void;
}

const LOGO_SRC = '/src/assets/images/prestier_logo_emblem_1795501498338.jpg';

export const LeadCaptureForm: React.FC<LeadCaptureFormProps> = ({
  form,
  errors,
  syncState,
  lastSavedTime,
  isSubmitting,
  submittedLeadId,
  onFieldChange,
  onSubmit,
  onStartNewLead,
}) => {
  const [logoFailed, setLogoFailed] = React.useState(false);
  const [failedReplyImages, setFailedReplyImages] = React.useState<Record<string, boolean>>({});

  const isThankYouPopupOpen = syncState === 'confirmed' && Boolean(submittedLeadId);

  useEffect(() => {
    if (!isThankYouPopupOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onStartNewLead();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isThankYouPopupOpen, onStartNewLead]);

  const handleProductCheckboxToggle = (val: string) => {
    const current = Array.isArray(form.productInterest) ? [...form.productInterest] : [];
    const idx = current.indexOf(val);
    if (idx >= 0) {
      current.splice(idx, 1);
    } else {
      current.push(val);
    }
    onFieldChange('productInterest', current);
  };

  const getGlassInputClass = (hasError: boolean, extra = '') =>
    `w-full rounded-xl border ${extra} ${
      hasError
        ? 'border-rose-500 bg-white/95 focus:ring-rose-500/25'
        : 'border-slate-200/90 bg-white/85 hover:bg-white/95 focus:bg-white focus:border-sky-600 focus:ring-sky-600/15'
    } pl-10 pr-4 py-3 text-base sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-3 transition-colors backdrop-blur-sm`;

  return (
    <>
      <section
        aria-label="Prestier System LLP Customer Inquiry Form"
        className="w-full rounded-2xl border border-white/75 bg-white/80 p-5 sm:p-8 shadow-2xl shadow-slate-950/25 backdrop-blur-xl"
      >
        {/* Top Company Identity Header */}
        <div className="space-y-3 pb-5 border-b border-slate-200/80">
          <div className="flex items-center gap-3.5">
            {!logoFailed ? (
              <img
                src={LOGO_SRC}
                alt="Prestier System LLP Emblem"
                referrerPolicy="no-referrer"
                onError={() => setLogoFailed(true)}
                className="h-14 w-14 rounded-xl object-cover border border-slate-200 shadow-xs shrink-0"
              />
            ) : (
              <div className="h-14 w-14 rounded-xl bg-slate-900 border border-slate-200 flex items-center justify-center font-display font-bold text-white text-lg shrink-0">
                PS
              </div>
            )}
            <div className="min-w-0 space-y-1">
              <p className="font-display text-sm sm:text-base font-extrabold text-sky-800 tracking-tight underline decoration-amber-500 decoration-2 underline-offset-4">
                Food Service Equipments
              </p>
              <h1 className="font-display text-xl sm:text-2xl font-bold text-slate-900 tracking-tight pt-0.5">
                Prestair System LLP
              </h1>
            </div>
          </div>

          {/* Clean Unboxed Real-Time Sync State */}
          <div className="text-xs text-slate-600 font-medium flex items-center gap-1.5 tabular-nums">
            {syncState === 'saving' && (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-700 shrink-0" />
                <span className="text-sky-800 font-semibold">Saving live inquiry…</span>
              </>
            )}
            {syncState === 'saved_partial' && (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 text-amber-700 shrink-0" />
                <span className="text-slate-700 font-semibold">
                  Draft auto-saved {lastSavedTime ? `· ${lastSavedTime}` : ''}
                </span>
              </>
            )}
            {syncState === 'confirmed' && (
              <>
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-700 shrink-0" />
                <span className="text-emerald-800 font-semibold">
                  Inquiry submitted &amp; WhatsApp reply queued{' '}
                  {lastSavedTime ? `· ${lastSavedTime}` : ''}
                </span>
              </>
            )}
            {syncState === 'idle' && (
              <span>Food service &amp; bakery solutions inquiry</span>
            )}
          </div>
        </div>

        {/* Main Customer Form (Phone Number compulsory) */}
        <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
          {/* 1. Full Name */}
          <div>
            <label
              htmlFor="lead-name"
              className="block text-sm font-semibold text-slate-900 mb-1.5"
            >
              1. Full Name
            </label>
            <div className="relative">
              <UserIcon className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="lead-name"
                name="name"
                type="text"
                autoComplete="name"
                placeholder="Enter your full name (e.g. Rajesh Sharma)"
                value={form.name}
                onChange={(e) => onFieldChange('name', e.target.value)}
                className={getGlassInputClass(Boolean(errors.name))}
              />
            </div>
          </div>

          {/* 2. Designation */}
          <div>
            <label
              htmlFor="lead-designation"
              className="block text-sm font-semibold text-slate-900 mb-1.5"
            >
              2. Designation
            </label>
            <div className="relative">
              <Briefcase className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="lead-designation"
                name="designation"
                type="text"
                autoComplete="organization-title"
                placeholder="Your designation (e.g. Founder, Director, Store Manager)"
                value={form.designation}
                onChange={(e) => onFieldChange('designation', e.target.value)}
                className={getGlassInputClass(Boolean(errors.designation))}
              />
            </div>
          </div>

          {/* 3. Phone / WhatsApp Number (Compulsory) */}
          <div>
            <label
              htmlFor="lead-phone"
              className="block text-sm font-semibold text-slate-900 mb-1.5"
            >
              3. Phone / WhatsApp Number{' '}
              <span className="text-rose-600 font-bold" aria-hidden="true">
                *
              </span>
              <span className="ml-1.5 text-xs font-semibold text-rose-700">(Required)</span>
            </label>
            <div className="relative">
              <Phone className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="lead-phone"
                name="phone"
                type="tel"
                required
                aria-required="true"
                aria-invalid={Boolean(errors.phone)}
                aria-describedby={errors.phone ? 'lead-phone-error' : undefined}
                autoComplete="tel"
                placeholder="Enter 10-digit WhatsApp mobile number (Compulsory)"
                value={form.phone}
                onChange={(e) => onFieldChange('phone', e.target.value)}
                className={getGlassInputClass(Boolean(errors.phone), 'tabular-nums')}
              />
            </div>
            {errors.phone && (
              <p
                id="lead-phone-error"
                role="alert"
                className="mt-1.5 text-xs font-semibold text-rose-700"
              >
                {errors.phone}
              </p>
            )}
          </div>

          {/* 4. Company / Store Name */}
          <div>
            <label
              htmlFor="lead-company"
              className="block text-sm font-semibold text-slate-900 mb-1.5"
            >
              4. Company / Store Name
            </label>
            <div className="relative">
              <Building2 className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="lead-company"
                name="companyName"
                type="text"
                autoComplete="organization"
                placeholder="Your bakery, cafe, supermarket, or company name"
                value={form.companyName}
                onChange={(e) => onFieldChange('companyName', e.target.value)}
                className={getGlassInputClass(Boolean(errors.companyName))}
              />
            </div>
          </div>

          {/* 5. City & 6. Email Address */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="lead-city"
                className="block text-sm font-semibold text-slate-900 mb-1.5"
              >
                5. City
              </label>
              <div className="relative">
                <MapPin className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="lead-city"
                  name="city"
                  type="text"
                  autoComplete="address-level2"
                  placeholder="e.g. Mumbai, Delhi, Pune"
                  value={form.city}
                  onChange={(e) => onFieldChange('city', e.target.value)}
                  className={getGlassInputClass(Boolean(errors.city))}
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="lead-email"
                className="block text-sm font-semibold text-slate-900 mb-1.5"
              >
                6. Email Address
              </label>
              <div className="relative">
                <Mail className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="lead-email"
                  name="emailAddress"
                  type="email"
                  autoComplete="email"
                  placeholder="you@company.com"
                  value={form.emailAddress}
                  onChange={(e) => onFieldChange('emailAddress', e.target.value)}
                  className={getGlassInputClass(Boolean(errors.emailAddress))}
                />
              </div>
            </div>
          </div>

          {/* 7. No. of Outlets */}
          <div>
            <label
              htmlFor="lead-outlets"
              className="block text-sm font-semibold text-slate-900 mb-1.5"
            >
              7. No. of Outlets
            </label>
            <div className="relative">
              <Store className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="lead-outlets"
                name="outletsCount"
                type="number"
                min={0}
                max={100000}
                inputMode="numeric"
                placeholder="e.g. 5"
                value={form.outletsCount}
                onChange={(e) => onFieldChange('outletsCount', e.target.value)}
                className={getGlassInputClass(Boolean(errors.outletsCount), 'tabular-nums')}
              />
            </div>
          </div>

          {/* 8. Multi-Select Equipment Options */}
          <fieldset className="pt-1">
            <legend className="block text-sm font-semibold text-slate-900 mb-2">
              8. Equipment Requirements (Select one or multiple)
            </legend>
            <div className="grid grid-cols-1 gap-2.5">
              {PRODUCT_OPTIONS.map((option, idx) => {
                const isSelected =
                  Array.isArray(form.productInterest) &&
                  form.productInterest.includes(option.value);
                const borderClasses = isSelected
                  ? 'border-sky-600 bg-sky-50/90 ring-2 ring-sky-600/15'
                  : 'border-slate-200/90 bg-white/80 hover:bg-white/95';

                return (
                  <label
                    key={option.value}
                    htmlFor={`product-option-${idx}`}
                    className={`flex items-start gap-3.5 rounded-xl border p-3.5 cursor-pointer transition-colors backdrop-blur-sm ${borderClasses}`}
                  >
                    <input
                      id={`product-option-${idx}`}
                      type="checkbox"
                      value={option.value}
                      checked={isSelected}
                      onChange={() => handleProductCheckboxToggle(option.value)}
                      className="mt-1 h-4 w-4 rounded border-slate-400 accent-sky-700 shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display text-sm font-bold text-slate-900">
                          0{idx + 1}. {option.label}
                        </span>
                        {isSelected && (
                          <span className="text-xs font-bold text-sky-800 shrink-0">
                            Selected
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-600 mt-0.5">{option.description}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {/* Primary Submit Button */}
          <div className="pt-2">
            <button
              type="submit"
              disabled={isSubmitting}
              className="w-full min-h-12 rounded-xl bg-sky-700 hover:bg-sky-600 active:bg-sky-800 disabled:opacity-60 text-white font-display font-bold text-sm sm:text-base px-6 py-3.5 shadow-md shadow-sky-900/10 transition-colors flex items-center justify-center gap-2.5 cursor-pointer whitespace-nowrap"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span>Submitting Inquiry…</span>
                </>
              ) : (
                <span>Submit Inquiry</span>
              )}
            </button>
          </div>
        </form>
      </section>

      {/* Full-Screen Thank You Popup Modal */}
      {isThankYouPopupOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="thank-you-popup-heading"
            className="fixed inset-0 z-[60] min-h-dvh w-screen bg-white text-slate-900 overflow-y-auto flex flex-col"
          >
            <div className="w-full border-b border-slate-200 bg-white px-5 sm:px-10 py-4 shrink-0">
              <div className="max-w-5xl mx-auto flex items-center justify-between gap-6">
                <div className="flex items-center gap-3 min-w-0">
                  {!logoFailed ? (
                    <img
                      src={LOGO_SRC}
                      alt="Prestier System LLP Emblem"
                      referrerPolicy="no-referrer"
                      onError={() => setLogoFailed(true)}
                      className="h-11 w-11 rounded-lg object-cover border border-slate-200 shrink-0"
                    />
                  ) : (
                    <div className="h-11 w-11 rounded-lg bg-slate-900 flex items-center justify-center font-display font-bold text-white text-sm shrink-0">
                      PS
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="font-display text-xs sm:text-sm font-extrabold text-sky-800 underline decoration-amber-500 decoration-2 underline-offset-2 truncate">
                      Food Service Equipments
                    </p>
                    <p className="font-display text-base sm:text-lg font-bold text-slate-900 tracking-tight truncate pt-0.5">
                      Prestair System LLP
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={onStartNewLead}
                  aria-label="Close thank you popup"
                  className="inline-flex items-center gap-1.5 min-h-11 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-900 text-xs font-semibold px-4 py-2 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <X className="h-4 w-4" />
                  <span>Close</span>
                </button>
              </div>
            </div>

            <div className="flex-1 flex items-center justify-center px-5 sm:px-10 py-8 sm:py-12">
              <div className="max-w-5xl w-full mx-auto">
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm font-medium text-emerald-700">
                    <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
                    <span>Inquiry Submitted</span>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span>Instant WhatsApp Reply Sent</span>
                    {form.name.trim() && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="text-slate-600">{form.name.trim()}</span>
                      </>
                    )}
                    {form.companyName.trim() && (
                      <>
                        <span aria-hidden="true" className="text-slate-300">
                          ·
                        </span>
                        <span className="text-slate-600">{form.companyName.trim()}</span>
                      </>
                    )}
                  </div>

                  <h2
                    id="thank-you-popup-heading"
                    className="font-display text-2xl sm:text-4xl font-bold text-slate-900 tracking-tight text-balance"
                  >
                    Thank you for your inquiry! 😊
                  </h2>
                </div>

                <div className="mt-8 pt-8 border-t border-slate-200 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
                  <div className="lg:col-span-6">
                    {PRESTAIR_REPLY_IMAGES.map((src) =>
                      !failedReplyImages[src] ? (
                        <div
                          key={src}
                          className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 aspect-[4/3] max-h-[60vh]"
                        >
                          <img
                            src={src}
                            alt="Prestair Bakery Solutions Showcase"
                            referrerPolicy="no-referrer"
                            onError={() =>
                              setFailedReplyImages((prev) => ({ ...prev, [src]: true }))
                            }
                            className="h-full w-full object-cover"
                          />
                        </div>
                      ) : (
                        <div
                          key={src}
                          className="rounded-xl border border-slate-200 bg-slate-50 aspect-[4/3] flex items-center justify-center p-6 text-center text-xs font-medium text-slate-500"
                        >
                          Prestair Bakery Solutions Showcase
                        </div>
                      )
                    )}
                  </div>

                  <div className="lg:col-span-6 flex flex-col justify-between space-y-6">
                    <div className="text-sm sm:text-base text-slate-800 whitespace-pre-line leading-relaxed">
                      {DEFAULT_PRESTAIR_WHATSAPP_REPLY}
                    </div>

                    <div className="pt-5 border-t border-slate-200 flex flex-wrap items-center gap-3">
                      <button
                        type="button"
                        onClick={onStartNewLead}
                        className="min-h-11 rounded-xl bg-sky-700 hover:bg-sky-600 active:bg-sky-800 text-white font-display font-bold text-sm px-6 py-3 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                      >
                        Submit New Inquiry
                      </button>

                      <a
                        href="https://instagram.com/prestairsystem"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 min-h-11 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 text-sm font-semibold px-4 py-3 transition-colors whitespace-nowrap shrink-0"
                      >
                        <span>instagram.com/prestairsystem</span>
                        <ExternalLink className="h-4 w-4 text-sky-700" />
                      </a>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

import React from 'react';
import {
  Building2,
  CheckCircle2,
  Loader2,
  MessageCircle,
  Phone,
  RotateCcw,
  Store,
  User as UserIcon,
} from 'lucide-react';
import {
  PRODUCT_OPTIONS,
  type LeadFormInput,
  type ProductInterest,
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
  whatsappSentAuto,
  whatsappDirectUrl,
  onFieldChange,
  onSubmit,
  onStartNewLead,
}) => {
  const [logoFailed, setLogoFailed] = React.useState(false);

  return (
    <section
      aria-label="Prestier System LLP Customer Inquiry Form"
      className="w-full rounded-2xl border border-slate-800 bg-slate-900/90 p-5 sm:p-7 shadow-xl backdrop-blur-md"
    >
      {/* Top Company Identity Header: Logo + Prestier System LLP */}
      <div className="space-y-3 pb-4 border-b border-slate-800">
        <div className="flex items-center gap-3.5">
          {!logoFailed ? (
            <img
              src={LOGO_SRC}
              alt="Prestier System LLP Emblem"
              referrerPolicy="no-referrer"
              onError={() => setLogoFailed(true)}
              className="h-13 w-13 rounded-xl object-cover border border-slate-700 shrink-0"
            />
          ) : (
            <div className="h-13 w-13 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center font-display font-bold text-amber-400 text-lg shrink-0">
              PS
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs font-medium text-amber-400/90 tracking-wide">
              Precision Stainless Steel &amp; Retail Systems
            </p>
            <h2 className="font-display text-xl sm:text-2xl font-bold text-white tracking-tight whitespace-nowrap">
              Prestier System LLP
            </h2>
          </div>
        </div>

        {/* Unboxed real-time sync state indicator */}
        <div className="text-xs text-slate-400 flex items-center gap-1.5 tabular-nums">
          {syncState === 'saving' && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400 shrink-0" />
              <span className="text-sky-300 font-medium">Auto-capturing to Live Sheet…</span>
            </>
          )}
          {syncState === 'saved_partial' && (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-amber-400 shrink-0" />
              <span className="text-amber-300 font-medium">
                Live draft synced {lastSavedTime ? `· ${lastSavedTime}` : ''}
              </span>
            </>
          )}
          {syncState === 'confirmed' && (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
              <span className="text-emerald-300 font-medium">
                Confirmed in Live Sheet {lastSavedTime ? `· ${lastSavedTime}` : ''}
              </span>
            </>
          )}
          {syncState === 'idle' && (
            <span>Instant auto-save active · No data lost even before submit</span>
          )}
        </div>
      </div>

      {/* Confirmed Post-Submission Banner */}
      {syncState === 'confirmed' && submittedLeadId ? (
        <div
          role="status"
          className="mt-6 rounded-xl border border-emerald-500/40 bg-emerald-950/40 p-5 space-y-4"
        >
          <div className="flex items-start gap-3">
            <CheckCircle2 className="h-6 w-6 text-emerald-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h3 className="font-display text-lg font-bold text-white">
                Inquiry Confirmed &amp; Logged to Live Sheet
              </h3>
              <p className="text-sm text-slate-300">
                Thank you, <span className="font-semibold text-white">{form.name}</span>. Your
                requirement for{' '}
                <span className="font-semibold text-emerald-300">{form.productInterest}</span> (
                {form.outletsCount} outlets) is confirmed under ID{' '}
                <span className="font-mono text-xs text-slate-300">{submittedLeadId}</span>.
              </p>
              {whatsappSentAuto ? (
                <p className="text-xs text-emerald-300 font-medium pt-1">
                  Automated 24x7 WhatsApp confirmation was dispatched directly to {form.phone}.
                </p>
              ) : (
                <p className="text-xs text-slate-300 pt-1">
                  You can also open your inquiry directly on WhatsApp below for immediate priority
                  assistance.
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {whatsappDirectUrl && (
              <a
                href={whatsappDirectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm px-4 py-2.5 transition-colors whitespace-nowrap shrink-0"
              >
                <MessageCircle className="h-4 w-4" />
                Open Inquiry on WhatsApp
              </a>
            )}
            <button
              type="button"
              onClick={onStartNewLead}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-800/80 hover:bg-slate-800 text-slate-200 font-medium text-sm px-4 py-2.5 transition-colors whitespace-nowrap shrink-0"
            >
              <RotateCcw className="h-4 w-4" />
              Enter Another Inquiry
            </button>
          </div>
        </div>
      ) : null}

      {/* Main Customer Form */}
      <form onSubmit={onSubmit} noValidate className="mt-5 space-y-4">
        {/* 1. Customer Full Name */}
        <div>
          <label
            htmlFor="lead-name"
            className="block text-sm font-medium text-slate-200 mb-1.5"
          >
            1. Full Name <span className="text-amber-400">*</span>
          </label>
          <div className="relative">
            <UserIcon className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="lead-name"
              name="name"
              type="text"
              autoComplete="name"
              required
              placeholder="Enter your full name (e.g. Rajesh Sharma)"
              value={form.name}
              onChange={(e) => onFieldChange('name', e.target.value)}
              className={`w-full rounded-xl border ${
                errors.name
                  ? 'border-rose-500 focus:ring-rose-500/30'
                  : 'border-slate-700/90 focus:border-sky-400 focus:ring-sky-500/25'
              } bg-slate-950/80 pl-10 pr-4 py-3 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-3 transition-all`}
            />
          </div>
          {errors.name && (
            <p role="alert" className="mt-1 text-xs text-rose-400">
              {errors.name}
            </p>
          )}
        </div>

        {/* 2. Phone Number (Strictly right below Name at the top) */}
        <div>
          <label
            htmlFor="lead-phone"
            className="block text-sm font-medium text-slate-200 mb-1.5"
          >
            2. Phone / WhatsApp Number <span className="text-amber-400">*</span>
          </label>
          <div className="relative">
            <Phone className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="lead-phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              required
              placeholder="Enter 10-digit mobile / WhatsApp number (e.g. 9876543210)"
              value={form.phone}
              onChange={(e) => onFieldChange('phone', e.target.value)}
              className={`w-full rounded-xl border tabular-nums ${
                errors.phone
                  ? 'border-rose-500 focus:ring-rose-500/30'
                  : 'border-slate-700/90 focus:border-sky-400 focus:ring-sky-500/25'
              } bg-slate-950/80 pl-10 pr-4 py-3 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-3 transition-all`}
            />
          </div>
          {errors.phone && (
            <p role="alert" className="mt-1 text-xs text-rose-400">
              {errors.phone}
            </p>
          )}
        </div>

        {/* 3. Company Name & 4. Number of Outlets (2-column responsive grid on tablet/desktop) */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-4">
          <div className="sm:col-span-8">
            <label
              htmlFor="lead-company"
              className="block text-sm font-medium text-slate-200 mb-1.5"
            >
              3. Company / Store Name <span className="text-amber-400">*</span>
            </label>
            <div className="relative">
              <Building2 className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="lead-company"
                name="companyName"
                type="text"
                autoComplete="organization"
                required
                placeholder="Your company, supermarket, or bakery name"
                value={form.companyName}
                onChange={(e) => onFieldChange('companyName', e.target.value)}
                className={`w-full rounded-xl border ${
                  errors.companyName
                    ? 'border-rose-500 focus:ring-rose-500/30'
                    : 'border-slate-700/90 focus:border-sky-400 focus:ring-sky-500/25'
                } bg-slate-950/80 pl-10 pr-4 py-3 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-3 transition-all`}
              />
            </div>
            {errors.companyName && (
              <p role="alert" className="mt-1 text-xs text-rose-400">
                {errors.companyName}
              </p>
            )}
          </div>

          <div className="sm:col-span-4">
            <label
              htmlFor="lead-outlets"
              className="block text-sm font-medium text-slate-200 mb-1.5"
            >
              4. No. of Outlets <span className="text-amber-400">*</span>
            </label>
            <div className="relative">
              <Store className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="lead-outlets"
                name="outletsCount"
                type="number"
                min={1}
                max={100000}
                inputMode="numeric"
                required
                placeholder="e.g. 5"
                value={form.outletsCount}
                onChange={(e) => onFieldChange('outletsCount', e.target.value)}
                className={`w-full rounded-xl border tabular-nums ${
                  errors.outletsCount
                    ? 'border-rose-500 focus:ring-rose-500/30'
                    : 'border-slate-700/90 focus:border-sky-400 focus:ring-sky-500/25'
                } bg-slate-950/80 pl-10 pr-3 py-3 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-3 transition-all`}
              />
            </div>
            {errors.outletsCount && (
              <p role="alert" className="mt-1 text-xs text-rose-400">
                {errors.outletsCount}
              </p>
            )}
          </div>
        </div>

        {/* 5. Production / Product Selection (Mandatory 1 of 3 options) */}
        <fieldset className="pt-1">
          <legend className="block text-sm font-medium text-slate-200 mb-2">
            5. Production / Equipment Requirement (Select any 1 option){' '}
            <span className="text-amber-400">*</span>
          </legend>
          <div className="grid grid-cols-1 gap-2.5">
            {PRODUCT_OPTIONS.map((option, idx) => {
              const isSelected = form.productInterest === option.value;
              const borderClasses = isSelected
                ? option.accentKey === 'sky'
                  ? 'border-sky-400 bg-sky-950/55 ring-2 ring-sky-500/25'
                  : option.accentKey === 'emerald'
                    ? 'border-emerald-400 bg-emerald-950/55 ring-2 ring-emerald-500/25'
                    : 'border-amber-400 bg-amber-950/55 ring-2 ring-amber-500/25'
                : 'border-slate-800 bg-slate-950/70 hover:border-slate-700';

              return (
                <label
                  key={option.value}
                  htmlFor={`product-option-${idx}`}
                  className={`flex items-start gap-3.5 rounded-xl border p-3.5 cursor-pointer transition-all ${borderClasses}`}
                >
                  <input
                    id={`product-option-${idx}`}
                    type="radio"
                    name="productInterest"
                    value={option.value}
                    checked={isSelected}
                    onChange={() =>
                      onFieldChange('productInterest', option.value as ProductInterest)
                    }
                    className="mt-1 h-4 w-4 accent-sky-500 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-display text-sm sm:text-base font-semibold text-white">
                        0{idx + 1}. {option.label}
                      </span>
                      {isSelected && (
                        <span className="text-xs font-semibold text-sky-300 shrink-0">
                          Selected
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-400 mt-0.5">{option.description}</p>
                  </div>
                </label>
              );
            })}
          </div>
          {errors.productInterest && (
            <p role="alert" className="mt-1.5 text-xs text-rose-400">
              {errors.productInterest}
            </p>
          )}
        </fieldset>

        {/* Primary Submit Button */}
        <div className="pt-2">
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full min-h-12 rounded-xl bg-sky-600 hover:bg-sky-500 active:bg-sky-700 disabled:opacity-60 text-white font-display font-bold text-sm sm:text-base px-6 py-3.5 shadow-lg shadow-sky-950/50 transition-all flex items-center justify-center gap-2.5 cursor-pointer whitespace-nowrap"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>Submitting</span>
              </>
            ) : (
              <span>Submit</span>
            )}
          </button>
          <p className="mt-2 text-center text-xs text-slate-400">
            Every character you type is automatically backed up to our Live Sheet so you never lose
            progress.
          </p>
        </div>
      </form>
    </section>
  );
};

import React from 'react';
import {
  Building2,
  CheckCircle2,
  Loader2,
  Mail,
  MapPin,
  Phone,
  Store,
  User as UserIcon,
  Briefcase,
} from 'lucide-react';
import {
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
  whatsappSentAuto,
  whatsappDirectUrl,
  onFieldChange,
  onSubmit,
  onStartNewLead,
}) => {
  const [logoFailed, setLogoFailed] = React.useState(false);

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

  return (
    <section
      aria-label="Prestier System LLP Customer Inquiry Form"
      className="w-full rounded-2xl border border-slate-200 bg-white p-6 sm:p-8 shadow-2xl shadow-slate-300/50"
    >
      {/* Top Company Identity Header: Logo + Prestier System LLP */}
      <div className="space-y-3 pb-5 border-b border-slate-200">
        <div className="flex items-center gap-3.5">
          {!logoFailed ? (
            <img
              src={LOGO_SRC}
              alt="Prestier System LLP Emblem"
              referrerPolicy="no-referrer"
              onError={() => setLogoFailed(true)}
              className="h-14 w-14 rounded-xl object-cover border border-slate-200 shadow-sm shrink-0"
            />
          ) : (
            <div className="h-14 w-14 rounded-xl bg-slate-900 border border-slate-200 flex items-center justify-center font-display font-bold text-amber-400 text-lg shadow-sm shrink-0">
              PS
            </div>
          )}
          <div className="min-w-0">
            <p className="text-xs font-semibold text-sky-700 tracking-wide uppercase">
              Food service equipment
            </p>
            <h2 className="font-display text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
              Prestier System LLP
            </h2>
          </div>
        </div>

        {/* Real-time sync indicator */}
        <div className="text-xs text-slate-500 flex items-center gap-1.5 tabular-nums">
          {syncState === 'saving' && (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-600 shrink-0" />
              <span className="text-sky-700 font-medium">Auto-capturing to Live Sheet…</span>
            </>
          )}
          {syncState === 'saved_partial' && (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-amber-600 shrink-0" />
              <span className="text-amber-800 font-medium">
                Live draft synced {lastSavedTime ? `· ${lastSavedTime}` : ''}
              </span>
            </>
          )}
          {syncState === 'confirmed' && (
            <>
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0" />
              <span className="text-emerald-800 font-medium">
                Confirmed in Live Sheet {lastSavedTime ? `· ${lastSavedTime}` : ''}
              </span>
            </>
          )}
          {syncState === 'idle' && (
            <span>Instant auto-save active · Secure inquiry capture</span>
          )}
        </div>
      </div>

      {syncState === 'confirmed' && submittedLeadId ? (
        <div
          role="status"
          className="mt-6 rounded-xl border border-emerald-300 bg-emerald-50 p-6 text-center space-y-3"
        >
          <CheckCircle2 className="h-9 w-9 text-emerald-600 mx-auto" />
          <h3 className="font-display text-xl font-bold text-emerald-950">
            Thank you for your inquiry!
          </h3>
          <p className="text-xs text-emerald-900 leading-relaxed max-w-md mx-auto">
            We appreciate your interest in our bakery solutions. Please let us know your exact requirements so that our team can understand your needs and get back to you with the most suitable solutions. Meanwhile, follow us on Instagram to explore our latest products, innovative designs, and updates. 📲 instagram.com/prestairsystem
          </p>
          <div className="pt-2 flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={onStartNewLead}
              className="rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white font-medium text-xs px-4 py-2.5 transition-colors cursor-pointer shadow-sm"
            >
              Submit Another Inquiry
            </button>
          </div>
        </div>
      ) : null}

      {/* Main Customer Form */}
      <form onSubmit={onSubmit} noValidate className="mt-6 space-y-4">
        {/* 1. Full Name */}
        <div>
          <label
            htmlFor="lead-name"
            className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
          >
            1. Full Name <span className="text-rose-600">*</span>
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
                  : 'border-slate-300 focus:border-sky-600 focus:ring-sky-500/20'
              } bg-slate-50/50 pl-10 pr-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-3 transition-all`}
            />
          </div>
          {errors.name && (
            <p role="alert" className="mt-1 text-xs text-rose-600">
              {errors.name}
            </p>
          )}
        </div>

        {/* 2. Designation (New Field after Name) */}
        <div>
          <label
            htmlFor="lead-designation"
            className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
          >
            2. Designation <span className="text-rose-600">*</span>
          </label>
          <div className="relative">
            <Briefcase className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              id="lead-designation"
              name="designation"
              type="text"
              required
              placeholder="Your designation (e.g. Director, Store Manager, Owner)"
              value={form.designation}
              onChange={(e) => onFieldChange('designation', e.target.value)}
              className={`w-full rounded-xl border ${
                errors.designation
                  ? 'border-rose-500 focus:ring-rose-500/30'
                  : 'border-slate-300 focus:border-sky-600 focus:ring-sky-500/20'
              } bg-slate-50/50 pl-10 pr-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-3 transition-all`}
            />
          </div>
          {errors.designation && (
            <p role="alert" className="mt-1 text-xs text-rose-600">
              {errors.designation}
            </p>
          )}
        </div>

        {/* 3. Phone / WhatsApp Number */}
        <div>
          <label
            htmlFor="lead-phone"
            className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
          >
            3. Phone / WhatsApp Number <span className="text-rose-600">*</span>
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
                  : 'border-slate-300 focus:border-sky-600 focus:ring-sky-500/20'
              } bg-slate-50/50 pl-10 pr-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-3 transition-all`}
            />
          </div>
          {errors.phone && (
            <p role="alert" className="mt-1 text-xs text-rose-600">
              {errors.phone}
            </p>
          )}
        </div>

        {/* 4. Company Name */}
        <div>
          <label
            htmlFor="lead-company"
            className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
          >
            4. Company / Store Name <span className="text-rose-600">*</span>
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
                  : 'border-slate-300 focus:border-sky-600 focus:ring-sky-500/20'
              } bg-slate-50/50 pl-10 pr-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-3 transition-all`}
            />
          </div>
          {errors.companyName && (
            <p role="alert" className="mt-1 text-xs text-rose-600">
              {errors.companyName}
            </p>
          )}
        </div>

        {/* 5. City and 6. Email Address (After Company Name) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label
              htmlFor="lead-city"
              className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
            >
              5. City <span className="text-rose-600">*</span>
            </label>
            <div className="relative">
              <MapPin className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="lead-city"
                name="city"
                type="text"
                required
                placeholder="City (e.g. Mumbai)"
                value={form.city}
                onChange={(e) => onFieldChange('city', e.target.value)}
                className={`w-full rounded-xl border ${
                  errors.city
                    ? 'border-rose-500 focus:ring-rose-500/30'
                    : 'border-slate-300 focus:border-sky-600 focus:ring-sky-500/20'
                } bg-slate-50/50 pl-10 pr-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-3 transition-all`}
              />
            </div>
            {errors.city && (
              <p role="alert" className="mt-1 text-xs text-rose-600">
                {errors.city}
              </p>
            )}
          </div>

          <div>
            <label
              htmlFor="lead-email"
              className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
            >
              6. Email Address <span className="text-rose-600">*</span>
            </label>
            <div className="relative">
              <Mail className="h-4 w-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="lead-email"
                name="emailAddress"
                type="email"
                autoComplete="email"
                required
                placeholder="name@company.com"
                value={form.emailAddress}
                onChange={(e) => onFieldChange('emailAddress', e.target.value)}
                className={`w-full rounded-xl border ${
                  errors.emailAddress
                    ? 'border-rose-500 focus:ring-rose-500/30'
                    : 'border-slate-300 focus:border-sky-600 focus:ring-sky-500/20'
                } bg-slate-50/50 pl-10 pr-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-3 transition-all`}
              />
            </div>
            {errors.emailAddress && (
              <p role="alert" className="mt-1 text-xs text-rose-600">
                {errors.emailAddress}
              </p>
            )}
          </div>
        </div>

        {/* 7. No. of Outlets */}
        <div>
          <label
            htmlFor="lead-outlets"
            className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5"
          >
            7. No. of Outlets <span className="text-rose-600">*</span>
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
                  : 'border-slate-300 focus:border-sky-600 focus:ring-sky-500/20'
              } bg-slate-50/50 pl-10 pr-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-3 transition-all`}
            />
          </div>
          {errors.outletsCount && (
            <p role="alert" className="mt-1 text-xs text-rose-600">
              {errors.outletsCount}
            </p>
          )}
        </div>

        {/* 8. Production / Product Selection (Multiple options can be selected using checkboxes) */}
        <fieldset className="pt-2">
          <legend className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-2">
            8. Equipment / Product Requirements (Select multiple options if applicable){' '}
            <span className="text-rose-600">*</span>
          </legend>
          <div className="grid grid-cols-1 gap-2.5">
            {PRODUCT_OPTIONS.map((option, idx) => {
              const isSelected = Array.isArray(form.productInterest) && form.productInterest.includes(option.value);
              const borderClasses = isSelected
                ? 'border-sky-600 bg-sky-50/80 ring-2 ring-sky-500/20'
                : 'border-slate-200 bg-slate-50/50 hover:border-slate-300';

              return (
                <label
                  key={option.value}
                  htmlFor={`product-option-${idx}`}
                  className={`flex items-start gap-3.5 rounded-xl border p-3.5 cursor-pointer transition-all ${borderClasses}`}
                >
                  <input
                    id={`product-option-${idx}`}
                    type="checkbox"
                    value={option.value}
                    checked={isSelected}
                    onChange={() => handleProductCheckboxToggle(option.value)}
                    className="mt-1 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-500 shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-display text-sm font-bold text-slate-900">
                        0{idx + 1}. {option.label}
                      </span>
                      {isSelected && (
                        <span className="text-xs font-semibold text-sky-700 shrink-0">
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
          {errors.productInterest && (
            <p role="alert" className="mt-1.5 text-xs text-rose-600">
              {errors.productInterest}
            </p>
          )}
        </fieldset>

        {/* Primary Submit Button */}
        <div className="pt-3">
          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full min-h-12 rounded-xl bg-sky-600 hover:bg-sky-500 active:bg-sky-700 disabled:opacity-60 text-white font-display font-bold text-sm sm:text-base px-6 py-3.5 shadow-lg shadow-sky-600/30 transition-all flex items-center justify-center gap-2.5 cursor-pointer whitespace-nowrap"
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
          <p className="mt-2.5 text-center text-xs text-slate-500">
            Every character you type is automatically backed up to our Live Sheet so you never lose progress.
          </p>
        </div>
      </form>
    </section>
  );
};

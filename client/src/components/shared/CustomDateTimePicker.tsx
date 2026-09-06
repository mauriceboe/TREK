import { Calendar, ChevronLeft, ChevronRight, Keyboard } from 'lucide-react';
import { localIsoDate } from '../../utils/localDate';
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../../i18n';
import { useRemeasureSignal } from '../../hooks/useAnchoredPosition';

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}
function getWeekday(year: number, month: number, day: number): number {
  return new Date(year, month, day).getDay();
}
const YEAR_PAGE_SIZE = 12;
type CalendarView = 'days' | 'months' | 'years';

interface CustomDatePickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
  compact?: boolean;
  borderless?: boolean;
  // Optional inclusive ISO (YYYY-MM-DD) bounds. Dates outside the range are
  // disabled in the calendar and rejected on manual entry.
  min?: string;
  max?: string;
}

export function CustomDatePicker({
  value,
  onChange,
  placeholder,
  style = {},
  compact = false,
  borderless = false,
  min,
  max,
}: CustomDatePickerProps) {
  const { locale, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<CalendarView>('days');
  const [yearPageStart, setYearPageStart] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  // Re-renders the open calendar whenever its anchor may have moved (#1999).
  const reanchor = useRemeasureSignal(open);

  const parsed = value ? new Date(value + 'T00:00:00Z') : null;
  const [viewYear, setViewYear] = useState(parsed?.getUTCFullYear() || new Date().getFullYear());
  const [viewMonth, setViewMonth] = useState(parsed?.getUTCMonth() ?? new Date().getMonth());

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      if (dropRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    if (open) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) {
      if (parsed) {
        setViewYear(parsed.getUTCFullYear());
        setViewMonth(parsed.getUTCMonth());
      } else if (min || max) {
        // No value yet: open on the first in-range month so the user isn't
        // greeted by an all-disabled calendar.
        const anchor = new Date((min || max) + 'T00:00:00Z');
        setViewYear(anchor.getUTCFullYear());
        setViewMonth(anchor.getUTCMonth());
      }
      setView('days');
    }
  }, [open]);

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear((y) => y - 1);
    } else setViewMonth((m) => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear((y) => y + 1);
    } else setViewMonth((m) => m + 1);
  };

  const handlePrev = () => {
    if (view === 'days') prevMonth();
    else if (view === 'months') setViewYear((y) => y - 1);
    else setYearPageStart((s) => s - YEAR_PAGE_SIZE);
  };
  const handleNext = () => {
    if (view === 'days') nextMonth();
    else if (view === 'months') setViewYear((y) => y + 1);
    else setYearPageStart((s) => s + YEAR_PAGE_SIZE);
  };

  // prevAriaLabel / nextAriaLabel:
  const prevAriaLabel =
    view === 'days'
      ? t('common.datepicker.prevMonth')
      : view === 'months'
        ? t('common.datepicker.prevYear')
        : t('common.datepicker.prevYears');

  const nextAriaLabel =
    view === 'days'
      ? t('common.datepicker.nextMonth')
      : view === 'months'
        ? t('common.datepicker.nextYear')
        : t('common.datepicker.nextYears');

  // headerAriaLabel:
  const headerAriaLabel =
    view === 'days'
      ? t('common.datepicker.selectMonth')
      : view === 'months'
        ? t('common.datepicker.selectYear')
        : undefined;

  const monthLabel = new Date(viewYear, viewMonth).toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  const yearRangeLabel = `${yearPageStart} – ${yearPageStart + YEAR_PAGE_SIZE - 1}`;
  const headerLabel = view === 'days' ? monthLabel : view === 'months' ? String(viewYear) : yearRangeLabel;

  const handleHeaderClick = () => {
    if (view === 'days') {
      setView('months');
    } else if (view === 'months') {
      setYearPageStart(Math.floor(viewYear / YEAR_PAGE_SIZE) * YEAR_PAGE_SIZE);
      setView('years');
    }
  };

  const days = daysInMonth(viewYear, viewMonth);
  const startDay = (getWeekday(viewYear, viewMonth, 1) + 6) % 7;
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, i + 1).toLocaleDateString(locale, { weekday: 'narrow' })
  );

  const monthNames = Array.from({ length: 12 }, (_, i) =>
    new Date(viewYear, i).toLocaleDateString(locale, { month: 'short' })
  );
  const years = Array.from({ length: YEAR_PAGE_SIZE }, (_, i) => yearPageStart + i);

  const displayValue = parsed
    ? parsed.toLocaleDateString(
        locale,
        compact
          ? { day: '2-digit', month: '2-digit', year: '2-digit', timeZone: 'UTC' }
          : { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }
      )
    : null;

  const inputValue = parsed
    ? parsed.toLocaleDateString(locale, {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '';

  // Inclusive range check on ISO (YYYY-MM-DD) strings — lexicographic order
  // matches chronological order for this format.
  const isOutOfRange = (iso: string) => (!!min && iso < min) || (!!max && iso > max);

  const selectDay = (day: number) => {
    const y = String(viewYear);
    const m = String(viewMonth + 1).padStart(2, '0');
    const d = String(day).padStart(2, '0');
    const iso = `${y}-${m}-${d}`;
    if (isOutOfRange(iso)) return;
    onChange(iso);
    setOpen(false);
  };

  const selectMonth = (month: number) => {
    setViewMonth(month);
    setView('days');
  };

  const selectYear = (year: number) => {
    setViewYear(year);
    setView('months');
  };

  const selectedDay =
    parsed && parsed.getUTCFullYear() === viewYear && parsed.getUTCMonth() === viewMonth ? parsed.getUTCDate() : null;
  const today = new Date();
  const isToday = (d: number) =>
    today.getFullYear() === viewYear && today.getMonth() === viewMonth && today.getDate() === d;

  const [textInput, setTextInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);

  const handleTextSubmit = () => {
    setIsTyping(false);
    if (!textInput.trim()) return;
    const input = textInput.trim();

    // Try ISO first — always works
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
      if (isOutOfRange(input)) return;
      onChange(input);
      return;
    }

    // Determine field order for active locale via Intl
    const parts = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'numeric', year: 'numeric' }).formatToParts(
      new Date(2001, 5, 15)
    ); // known date: June 15, 2001
    const order = parts
      .filter((p) => ['day', 'month', 'year'].includes(p.type))
      .map((p) => p.type as 'day' | 'month' | 'year');

    // Strip non-numeric chars (handles RTL marks, dots, slashes, spaces)
    const nums = input
      .replace(/[^\d]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (nums.length !== 3) return;

    // nachher:
    const get = (field: 'day' | 'month' | 'year') => Number.parseInt(nums[order.indexOf(field)]);
    let d = get('day'),
      m = get('month');
    const y = get('year');
    if (Number.isNaN(d) || Number.isNaN(m) || Number.isNaN(y)) return;

    // If locale order gives impossible month but valid swap, correct it
    if (m > 12 && d <= 12) {
      const tmp = m;
      m = d;
      d = tmp;
    }
    const year = y < 100 ? 2000 + y : y;
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    // 31.02. parses fine as numbers but is no day at all; without the round-trip it would
    // travel on as '2026-02-31' and come back out of new Date() as 3 March.
    const probe = new Date(Date.UTC(year, m - 1, d));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return;
    const iso = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (isOutOfRange(iso)) return;
    onChange(iso);
  };

  const gridCellStyle = (selected: boolean, current: boolean): React.CSSProperties => ({
    borderRadius: 8,
    border: 'none',
    background: selected ? 'var(--accent)' : 'transparent',
    color: selected ? 'var(--accent-text)' : 'var(--text-primary)',
    fontWeight: selected ? 700 : current ? 600 : 400,
    cursor: 'pointer',
    outline: current && !selected ? '2px solid var(--border-primary)' : 'none',
    outlineOffset: -2,
    transition: 'background 0.1s',
  });

  return (
    <div ref={ref} style={{ position: 'relative', ...style }}>
      {isTyping ? (
        <input
          autoFocus
          type="text"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleTextSubmit();
            if (e.key === 'Escape') setIsTyping(false);
          }}
          onBlur={handleTextSubmit}
          placeholder="DD.MM.YYYY"
          aria-label="Enter date manually"
          style={{
            width: '100%',
            padding: '8px 14px',
            borderRadius: 10,
            border: '1px solid var(--text-faint)',
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
            fontSize: 'calc(13px * var(--fs-scale-body, 1))',
            fontFamily: 'inherit',
            outline: 'none',
          }}
        />
      ) : (
        // `stretch`, not `center`: the keyboard button's own padding made it a
        // few pixels shorter than the date trigger beside it, and the two sat in
        // a row with mismatched heights. Stretching means it tracks the trigger
        // whatever the type scale does to that one.
        <div style={{ display: 'flex', gap: 4, alignItems: 'stretch' }}>
          {/* Calendar trigger */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-label={displayValue || placeholder || t('common.date')}
            aria-expanded={open}
            aria-haspopup="dialog"
            style={{
              flex: 1,
              // Without this the trigger never goes below its text width, so the
              // ellipsis on the label below is unreachable and the button
              // overflows its column instead. A long locale date ("12. Sept.
              // 2026") in a two-column grid is exactly that case (#2267).
              minWidth: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: compact ? 4 : 8,
              padding: compact ? '4px 6px' : '8px 14px',
              borderRadius: compact ? 4 : 10,
              border: borderless ? 'none' : '1px solid var(--border-primary)',
              background: borderless ? 'transparent' : 'var(--bg-input)',
              color: displayValue ? 'var(--text-primary)' : 'var(--text-faint)',
              fontSize: 'calc(13px * var(--fs-scale-body, 1))',
              fontFamily: 'inherit',
              cursor: 'pointer',
              outline: 'none',
              transition: 'border-color 0.15s',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.borderColor = 'var(--text-faint)')}
            onMouseLeave={(e) => {
              if (!open) e.currentTarget.style.borderColor = 'var(--border-primary)';
            }}
          >
            {!compact && <Calendar size={14} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />}
            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {displayValue || placeholder || t('common.date')}
            </span>
          </button>

          {/* Keyboard / text-input trigger (non-compact only; compact gets it in the popup footer) */}
          {!compact && !borderless && (
            <button
              type="button"
              onClick={() => {
                setTextInput(inputValue || '');
                setIsTyping(true);
              }}
              aria-label={t('common.datepicker.enterManually')}
              title={t('common.datepicker.typeDate')}
              style={{
                background: 'none',
                border: '1px solid var(--border-primary)',
                // Same corner as the trigger it stands next to.
                borderRadius: 10,
                cursor: 'pointer',
                padding: '0 9px',
                display: 'flex',
                alignItems: 'center',
                color: 'var(--text-faint)',
                flexShrink: 0,
                transition: 'color 0.15s, border-color 0.15s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = 'var(--text-primary)';
                e.currentTarget.style.borderColor = 'var(--text-faint)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = 'var(--text-faint)';
                e.currentTarget.style.borderColor = 'var(--border-primary)';
              }}
            >
              <Keyboard size={13} />
            </button>
          )}
        </div>
      )}

      {open &&
        createPortal(
          <div
            ref={dropRef}
            role="dialog"
            aria-label={t('common.datepicker.dialog')}
            style={{
              position: 'fixed',
              // reanchor ticks on scroll / resize / keyboard so this recomputes
              // against a fresh rect instead of the one measured on open (#1999).
              ...((): { top: number; left: number } => {
                void reanchor;
                const r = ref.current?.getBoundingClientRect();
                if (!r) return { top: 0, left: 0 };
                const w = 268,
                  pad = 8,
                  h = 360;
                const vw = window.innerWidth;
                const vh = window.visualViewport?.height ?? window.innerHeight;
                let left = r.left;
                let top = r.bottom + 4;
                if (left + w > vw - pad) left = Math.max(pad, vw - w - pad);
                if (top + h > vh - pad) top = r.top - h - 4;
                top = Math.max(pad, Math.min(top, vh - h - pad));
                if (vw < 360) left = Math.max(pad, (vw - w) / 2);
                return { top, left };
              })(),
              zIndex: 99999,
              background: 'var(--bg-card)',
              border: '1px solid var(--border-primary)',
              borderRadius: 14,
              boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
              padding: 12,
              width: 268,
              maxWidth: 'calc(100vw - 16px)',
              animation: 'selectIn 0.15s ease-out',
              backdropFilter: 'blur(24px)',
              WebkitBackdropFilter: 'blur(24px)',
            }}
          >
            {/* ── Header ── */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <button
                type="button"
                onClick={handlePrev}
                aria-label={prevAriaLabel}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  borderRadius: 6,
                  display: 'flex',
                  color: 'var(--text-faint)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
              >
                <ChevronLeft size={16} />
              </button>

              {/* Clickable label — drills down (days → months → years) */}
              {view !== 'years' ? (
                <button
                  type="button"
                  onClick={handleHeaderClick}
                  aria-label={headerAriaLabel}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '2px 8px',
                    borderRadius: 6,
                    fontSize: 'calc(13px * var(--fs-scale-body, 1))',
                    fontWeight: 600,
                    color: 'var(--text-primary)',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-hover)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                >
                  {headerLabel}
                </button>
              ) : (
                <span style={{ fontSize: 'calc(13px * var(--fs-scale-body, 1))', fontWeight: 600, color: 'var(--text-primary)' }}>{headerLabel}</span>
              )}

              <button
                type="button"
                onClick={handleNext}
                aria-label={nextAriaLabel}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 4,
                  borderRadius: 6,
                  display: 'flex',
                  color: 'var(--text-faint)',
                }}
                onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
                onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
              >
                <ChevronRight size={16} />
              </button>
            </div>

            {/* ── Days view ── */}
            {view === 'days' && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
                  {weekdays.map((d, i) => (
                    <div
                      key={i}
                      style={{
                        textAlign: 'center',
                        fontSize: 'calc(10px * var(--fs-scale-caption, 1))',
                        fontWeight: 600,
                        color: 'var(--text-faint)',
                        padding: '2px 0',
                      }}
                    >
                      {d}
                    </div>
                  ))}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
                  {Array.from({ length: startDay }, (_, i) => (
                    <div key={`e-${i}`} />
                  ))}
                  {Array.from({ length: days }, (_, i) => {
                    const d = i + 1;
                    const sel = d === selectedDay;
                    const td = isToday(d);
                    const isoDate = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
                    const disabled = isOutOfRange(isoDate);
                    const ariaLabel = new Date(isoDate + 'T00:00:00Z').toLocaleDateString(locale, {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                      timeZone: 'UTC',
                    });
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => selectDay(d)}
                        disabled={disabled}
                        aria-label={ariaLabel}
                        aria-pressed={sel}
                        style={{
                          width: 32,
                          height: 32,
                          fontSize: 'calc(12px * var(--fs-scale-body, 1))',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          ...gridCellStyle(sel, td),
                          ...(disabled ? { opacity: 0.3, cursor: 'not-allowed' } : {}),
                        }}
                        onMouseEnter={(e) => {
                          if (!sel && !disabled) e.currentTarget.style.background = 'var(--bg-hover)';
                        }}
                        onMouseLeave={(e) => {
                          if (!sel) e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              </>
            )}

            {/* ── Months view ── */}
            {view === 'months' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
                {monthNames.map((name, i) => {
                  const sel = !!(parsed && parsed.getUTCFullYear() === viewYear && parsed.getUTCMonth() === i);
                  const cur = today.getFullYear() === viewYear && today.getMonth() === i;
                  const ariaLabel = new Date(viewYear, i).toLocaleDateString(locale, {
                    month: 'long',
                    year: 'numeric',
                  });
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => selectMonth(i)}
                      aria-label={ariaLabel}
                      aria-pressed={sel}
                      style={{
                        padding: '10px 4px',
                        fontSize: 'calc(12px * var(--fs-scale-body, 1))',
                        ...gridCellStyle(sel, cur),
                      }}
                      onMouseEnter={(e) => {
                        if (!sel) e.currentTarget.style.background = 'var(--bg-hover)';
                      }}
                      onMouseLeave={(e) => {
                        if (!sel) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                      }}
                    >
                      {name}
                    </button>
                  );
                })}
              </div>
            )}

            {/* ── Years view ── */}
            {view === 'years' && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4 }}>
                {years.map((year) => {
                  const sel = !!(parsed && parsed.getUTCFullYear() === year);
                  const cur = today.getFullYear() === year;
                  return (
                    <button
                      key={year}
                      type="button"
                      onClick={() => selectYear(year)}
                      aria-label={String(year)}
                      aria-pressed={sel}
                      style={{
                        padding: '10px 4px',
                        fontSize: 'calc(12px * var(--fs-scale-body, 1))',
                        ...gridCellStyle(sel, cur),
                      }}
                      onMouseEnter={(e) => {
                        if (!sel) e.currentTarget.style.background = 'var(--bg-hover)';
                      }}
                      onMouseLeave={(e) => {
                        if (!sel) (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                      }}
                    >
                      {year}
                    </button>
                  );
                })}
              </div>
            )}

            {/* ── Footer: keyboard trigger (compact) + clear ── */}
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              {/* In compact/borderless mode, the keyboard icon lives here instead of next to the trigger */}
              {compact || borderless ? (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    setTextInput(inputValue || '');
                    setIsTyping(true);
                  }}
                  aria-label={t('common.datepicker.enterManually')}
                  title={t('common.datepicker.typeDate')}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '3px 6px',
                    borderRadius: 6,
                    display: 'flex',
                    color: 'var(--text-faint)',
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--text-primary)')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
                >
                  <Keyboard size={13} />
                </button>
              ) : (
                <div />
              )}

              {value && (
                <button
                  type="button"
                  onClick={() => {
                    onChange('');
                    setOpen(false);
                  }}
                  aria-label={t('common.datepicker.clearDate')}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 'calc(11px * var(--fs-scale-caption, 1))',
                    color: 'var(--text-faint)',
                    padding: '3px 8px',
                    borderRadius: 6,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
                  onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-faint)')}
                >
                  ✕
                </button>
              )}
            </div>
          </div>,
          document.body
        )}

      <style>{`@keyframes selectIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}

interface CustomDateTimePickerProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  style?: React.CSSProperties;
}

export function CustomDateTimePicker({ value, onChange, placeholder, style = {} }: CustomDateTimePickerProps) {
  const { locale } = useTranslation();
  const [datePart, timePart] = (value || '').split('T');

  const handleDateChange = (d: string) => {
    onChange(d ? `${d}T${timePart || '12:00'}` : '');
  };
  const handleTimeChange = (t: string) => {
    const d = datePart || localIsoDate();
    onChange(t ? `${d}T${t}` : d);
  };

  return (
    <div style={{ display: 'flex', gap: 8, ...style }}>
      <CustomDatePicker value={datePart || ''} onChange={handleDateChange} style={{ flex: 1, minWidth: 0 }} />
      <div style={{ width: 110, flexShrink: 0 }}>
        <CustomTimePicker value={timePart || ''} onChange={handleTimeChange} />
      </div>
    </div>
  );
}

import CustomTimePicker from './CustomTimePicker';

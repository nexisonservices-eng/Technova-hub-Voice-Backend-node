const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const IST_TIMEZONES = new Set(['Asia/Kolkata', 'Asia/Calcutta']);
const EXPLICIT_TIMEZONE_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const IST_OFFSET_MINUTES = 330;

export const parseScheduledDateInTimezone = (value, timezone = DEFAULT_TIMEZONE) => {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const text = String(value || '').trim();
  if (!text) return null;

  if (EXPLICIT_TIMEZONE_PATTERN.test(text)) {
    const explicitDate = new Date(text);
    return Number.isNaN(explicitDate.getTime()) ? null : explicitDate;
  }

  const localMatch = text.match(LOCAL_DATETIME_PATTERN);
  if (localMatch) {
    const [, year, month, day, hour, minute, second = '0'] = localMatch;
    const utcMillis = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );

    if (IST_TIMEZONES.has(String(timezone || DEFAULT_TIMEZONE))) {
      return new Date(utcMillis - (IST_OFFSET_MINUTES * 60 * 1000));
    }
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export default parseScheduledDateInTimezone;

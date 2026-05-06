const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const IST_TIMEZONES = new Set(['Asia/Kolkata', 'Asia/Calcutta']);
const EXPLICIT_TIMEZONE_PATTERN = /(Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_DATETIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const IST_OFFSET_MINUTES = 330;
const DAY_MS = 24 * 60 * 60 * 1000;

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

export const parseDateOnlyInTimezone = (value, timezone = DEFAULT_TIMEZONE, endOfDay = false) => {
  if (!value) return null;
  const text = String(value || '').trim();
  const match = text.match(LOCAL_DATE_PATTERN);
  if (!match) return parseScheduledDateInTimezone(value, timezone);

  const [, year, month, day] = match;
  const utcMillis = Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0);
  const offsetMillis = IST_TIMEZONES.has(String(timezone || DEFAULT_TIMEZONE))
    ? IST_OFFSET_MINUTES * 60 * 1000
    : 0;
  const start = new Date(utcMillis - offsetMillis);
  return endOfDay ? new Date(start.getTime() + DAY_MS - 1) : start;
};

export const getDateRangeInTimezone = (period = 'today', timezone = DEFAULT_TIMEZONE) => {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || DEFAULT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const todayStart = parseDateOnlyInTimezone(`${parts.year}-${parts.month}-${parts.day}`, timezone);
  const start = new Date(todayStart);
  const end = new Date(todayStart.getTime() + DAY_MS - 1);

  switch (period) {
    case 'today':
      break;
    case 'yesterday':
      start.setTime(todayStart.getTime() - DAY_MS);
      end.setTime(todayStart.getTime() - 1);
      break;
    case 'week':
      start.setTime(todayStart.getTime() - (7 * DAY_MS));
      break;
    case 'last_week':
      start.setTime(todayStart.getTime() - (14 * DAY_MS));
      end.setTime(todayStart.getTime() - (7 * DAY_MS) - 1);
      break;
    case 'month':
      start.setUTCMonth(start.getUTCMonth() - 1);
      break;
    case 'last_month':
      start.setUTCMonth(start.getUTCMonth() - 2);
      end.setUTCMonth(end.getUTCMonth() - 1);
      break;
    case 'year':
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      break;
    default:
      break;
  }

  return { start, end };
};

export default parseScheduledDateInTimezone;

import { formatDuration, formatMoney } from '@lounge/core';
import { useMemo } from 'react';
import { intlLocale, usePrefs } from '../i18n';
import { useBranch } from './queries';

const FALLBACK = { currency: 'JOD', currencyDecimals: 3, timezone: 'Asia/Amman' };

/** All number/date formatting goes through here: branch currency + time zone, user language, Latin digits. */
export function useFmt() {
  const lang = usePrefs((s) => s.lang);
  const branch = useBranch();
  const currency = branch?.currency ?? FALLBACK.currency;
  const decimals = branch?.currencyDecimals ?? FALLBACK.currencyDecimals;
  const tz = branch?.timezone ?? FALLBACK.timezone;

  return useMemo(() => {
    const locale = intlLocale(lang);
    const cf = { currency, decimals, locale };
    const timeF = new Intl.DateTimeFormat(locale, { timeZone: tz, hour: 'numeric', minute: '2-digit' });
    const dateF = new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' });
    const dateTimeF = new Intl.DateTimeFormat(locale, { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const currencyLabel =
      new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? currency;

    return {
      tz,
      decimals,
      currency,
      currencyLabel,
      /** "3.500" */
      money: (minor: number) => formatMoney(minor, cf, { symbol: false }),
      /** "3.500 د.أ" */
      moneyC: (minor: number) => `${formatMoney(minor, cf, { symbol: false })} ${currencyLabel}`,
      rate: (perHour: number) => formatMoney(Math.round(perHour), cf, { symbol: false }),
      // Wrapped in first-strong isolates so "4:30 م" keeps its own reading order wherever it lands
      // (inside a number, a sentence or a "from – to" range) and never swaps with its neighbours.
      time: (ms: number) => isolate(timeF.format(ms)),
      date: (ms: number) => isolate(dateF.format(ms)),
      dateTime: (ms: number) => isolate(dateTimeF.format(ms)),
      /** Timers: always hours:minutes:seconds ("0:01:05"), so a minute is never read as an hour. */
      duration: (ms: number) => {
        const s = formatDuration(ms);
        return s.split(':').length === 2 ? `0:${s}` : s;
      },
      /** Played time in words for lists and totals: "1 س 25 د" / "1h 25m" (never an ambiguous "01:05"). */
      span: (ms: number) => minutesText(Math.round(Math.max(0, ms) / 60_000), lang),
      /** "1h 30m" style for planned durations */
      minutes: (m: number) => minutesText(m, lang),
      /** Major units → minor (for inputs). */
      toMinor: (major: number) => Math.round(major * 10 ** decimals),
      toMajor: (minor: number) => minor / 10 ** decimals,
    };
  }, [lang, currency, decimals, tz]);
}

export type Fmt = ReturnType<typeof useFmt>;

const isolate = (s: string) => `⁨${s}⁩`;

function minutesText(m: number, lang: string) {
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (lang === 'ar') return h && r ? `${h} س ${r} د` : h ? `${h} س` : `${r} د`;
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`;
}

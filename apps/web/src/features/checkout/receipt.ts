import { translate, type Lang } from '../../i18n';
import type { Fmt } from '../../lib/format';
import type { Bill, Station } from '../../lib/types';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * 80mm thermal-printer friendly receipt, printed from its own window so the app layout never
 * interferes. (Direct ESC/POS printing through the local server is planned for the hardware phase.)
 */
export function printReceipt(bill: Bill, opts: { branchName: string; lang: Lang; f: Fmt; stations: Station[] }) {
  const { f, lang } = opts;
  const t = (k: string, v?: Record<string, string | number>) => translate(lang, k, v);
  const b = bill.breakdown;
  const rows: string[] = [];
  const line = (label: string, value: string, cls = '') => rows.push(`<tr class="${cls}"><td>${esc(label)}</td><td class="v">${esc(value)}</td></tr>`);

  for (const l of b.time?.lines ?? []) {
    const st = opts.stations.find((s) => s.id === l.stationId)?.name ?? '';
    line(`${st} · ${t(`modes.${l.mode}`)} · ${f.duration(l.ms)}`, f.money(l.amount));
  }
  if (b.time?.adjustment.reason && b.time.adjustment.amount) line(t(`session.adjustment.${b.time.adjustment.reason}`), f.money(b.time.adjustment.amount));
  if (b.time && b.time.savings > 0) line(b.time.package ? b.time.package.name : t('session.cap'), `-${f.money(b.time.savings)}`);
  for (const i of b.items.filter((x) => !x.voided)) line(`${i.qty}× ${i.name}`, f.money(i.qty * i.unitPrice));
  rows.push('<tr><td colspan="2"><hr/></td></tr>');
  line(t('checkout.subtotal'), f.money(b.totals.subtotal));
  if (b.totals.discountAmount) line(t('checkout.discount'), `-${f.money(b.totals.discountAmount)}`);
  if (b.totals.rounding) line(t('checkout.rounding'), f.money(b.totals.rounding));
  line(t('common.total'), f.moneyC(b.totals.total), 'total');
  if (b.totals.paid) line(t('checkout.prepaid'), `-${f.money(b.totals.paid)}`);
  for (const p of b.payments) line(t(`checkout.${p.method}`), f.money(p.amount));

  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  // The shop's name on top; the branch under it only when it says something else.
  const brand = t('app.name');
  const sameName = opts.branchName.trim().toLowerCase() === brand.toLowerCase();
  const html = `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${esc(t('checkout.receipt'))} #${bill.number}</title>
<style>
  @page { size: 80mm auto; margin: 4mm; }
  body { font-family: 'IBM Plex Sans Arabic', system-ui, sans-serif; font-size: 12px; color: #000; margin: 0; width: 72mm; }
  h1 { font-size: 18px; text-align: center; margin: 0 0 2px; letter-spacing: 0.12em; text-transform: uppercase; }
  .muted { text-align: center; color: #333; margin: 0 0 8px; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 2px 0; vertical-align: top; }
  td.v { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; direction: ltr; unicode-bidi: isolate; }
  tr.total td { font-size: 15px; font-weight: 700; padding-top: 6px; }
  hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
  .thanks { text-align: center; margin-top: 10px; }
</style></head><body>
<h1>${esc(brand)}</h1>
${sameName ? '' : `<p class="muted">${esc(opts.branchName)}</p>`}
<p class="muted">${esc(t('checkout.receipt'))} #${bill.number} · ${esc(f.dateTime(new Date(bill.createdAt).getTime()))}${b.label ? ` · ${esc(b.label)}` : ''}</p>
<table>${rows.join('')}</table>
<p class="thanks">${esc(t('checkout.thanks'))}</p>
</body></html>`;

  const w = window.open('', '_blank', 'width=420,height=640');
  if (!w) return false;
  w.document.open();
  w.document.write(html);
  w.document.close();
  // Printed from here, not by a script inside the receipt: the security policy forbids inline scripts.
  w.focus();
  setTimeout(() => {
    w.print();
    w.close();
  }, 250);
  return true;
}

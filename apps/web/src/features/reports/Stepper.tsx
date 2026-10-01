import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '../../components/ui/button';

/** ‹ label › — steps through business days or months. Arrows follow the reading direction. */
export function Stepper({
  label,
  prevLabel,
  nextLabel,
  onPrev,
  onNext,
}: {
  label: React.ReactNode;
  prevLabel: string;
  nextLabel: string;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-card border border-line bg-surface-1 p-1 shadow-[var(--shadow-card)]">
      <Button variant="ghost" size="icon" disabled={!onPrev} onClick={onPrev} aria-label={prevLabel} title={prevLabel}>
        <ChevronRight className="size-5 ltr:rotate-180" />
      </Button>
      <span className="min-w-44 px-2 text-center text-sm font-semibold">{label}</span>
      <Button variant="ghost" size="icon" disabled={!onNext} onClick={onNext} aria-label={nextLabel} title={nextLabel}>
        <ChevronLeft className="size-5 ltr:rotate-180" />
      </Button>
    </div>
  );
}

// The streak. Deliberately not a score: filled stars only ever go up, there is
// no empty-star shame state beyond "not yet", and it disappears at zero.

import { useI18n } from "../i18n";

export function StreakStars({ count, total }: { count: number; total: number }) {
  const { lang, tIn } = useI18n();
  if (total <= 0) return null;
  const slots = Array.from({ length: total }, (_, i) => i < count);
  return (
    <p className="streak" aria-label={`${tIn(lang, "streak.label")}: ${count}`} data-streak={count}>
      {slots.map((filled, i) => (
        <svg key={i} className={`star${filled ? " is-filled" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2.6l2.9 6 6.6.9-4.8 4.6 1.2 6.5-5.9-3.1-5.9 3.1 1.2-6.5L2.5 9.5l6.6-.9z" />
        </svg>
      ))}
    </p>
  );
}

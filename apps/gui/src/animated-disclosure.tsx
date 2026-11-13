import { type ReactNode, useEffect, useState } from 'react';

/** Keep closing content mounted until the height transition finishes. */
export function AnimatedDisclosure({ open, children }: { open: boolean; children: ReactNode }) {
  const [retained, setRetained] = useState(open);
  if (open && !retained) setRetained(true);

  useEffect(() => {
    if (open || !retained) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setRetained(false);
      return;
    }
    // Also release content if a hidden ancestor prevents transitionend from firing.
    const timer = window.setTimeout(() => setRetained(false), 300);
    return () => window.clearTimeout(timer);
  }, [open, retained]);

  return (
    <div
      className="motion-disclosure"
      data-open={open}
      aria-hidden={!open}
      inert={!open}
      onTransitionEnd={(event) => {
        if (
          !open &&
          event.target === event.currentTarget &&
          event.propertyName === 'grid-template-rows'
        )
          setRetained(false);
      }}
    >
      <div className="motion-disclosure-clip">{(open || retained) && children}</div>
    </div>
  );
}

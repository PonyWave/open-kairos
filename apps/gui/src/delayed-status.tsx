import { type ReactNode, useEffect, useState } from 'react';

export function DelayedStatus({ delay = 200, children }: { delay?: number; children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);
  return visible ? children : null;
}

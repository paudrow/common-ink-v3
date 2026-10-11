import { useEffect, useState } from "react";

/** The time now, read again a few times a second while `running`, for a clock that is shown counting. */
export function useTick(running: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [running]);
  return running ? now : Date.now();
}

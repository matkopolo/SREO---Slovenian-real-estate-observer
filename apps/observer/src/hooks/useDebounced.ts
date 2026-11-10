import { useEffect, useState } from "react";

/** The value once it has stopped changing for `delay` ms (map moves: one request per pause, not per frame). */
export function useDebounced<T>(value: T, delay: number) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [delay, value]);
  return settled;
}

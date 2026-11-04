import { untrack } from "svelte";

/**
 * Animate a number toward its target (18% of the gap per frame) and return it
 * rounded, so the scan counters tick up instead of snapping. Takes a GETTER so the
 * effect re-arms on every live value; the current value is read untracked, because
 * writing the animated frame inside the effect that reads it would re-trigger the
 * effect and loop forever.
 */
export function useCountUp(getTarget: () => number): { readonly value: number } {
  let val = $state(getTarget());

  $effect(() => {
    const target = getTarget();
    let current = untrack(() => val);
    let raf = 0;
    const tick = () => {
      const diff = target - current;
      if (Math.abs(diff) < 0.5) {
        val = target;
        return;
      }
      current += diff * 0.18;
      val = current;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  return {
    get value() {
      return Math.round(val);
    },
  };
}

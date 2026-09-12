import { useEffect, useRef, useState } from "react";
import "./Truncate.scss";

// One line of text that ends in an ellipsis when it doesn't fit, with the full string in a tooltip
// for as long as it's cut short.
//
// A component rather than a class to reuse, because the truncation has two parts that have to
// travel together: text-overflow applies to the inline content of a block, so text that lives
// directly in a flex or grid box (a row label beside its icon, say) clips without ever showing the
// dots — it needs its own box, which is this one. And the tooltip has to be conditional, or every
// short label that needs no explaining gets one anyway.
export function Truncate({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);

  // Whether the text fits is a measurement, and it changes without the text changing — dragging the
  // window narrower is the usual way — so the box watches its own size rather than checking once.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setClipped(el.scrollWidth > el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span
      ref={ref}
      className={className ? `truncate ${className}` : "truncate"}
      title={clipped ? text : undefined}
    >
      {text}
    </span>
  );
}

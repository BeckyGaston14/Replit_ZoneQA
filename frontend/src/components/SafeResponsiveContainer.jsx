import { useLayoutEffect, useRef, useState } from "react";
import { ResponsiveContainer } from "recharts";

function pixelHeight(height) {
  return typeof height === "number" ? `${Math.max(1, height)}px` : height;
}

export function SafeResponsiveContainer({ height, children, className = "", testId }) {
  const hostRef = useRef(null);
  const [size, setSize] = useState(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = host.getBoundingClientRect();
        const width = Math.floor(rect.width);
        const measuredHeight = Math.floor(rect.height);
        setSize(width > 0 && measuredHeight > 0 ? { width, height: measuredHeight } : null);
      });
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(host);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  return <div ref={hostRef} data-testid={testId} data-chart-ready={size ? "true" : "false"} className={`min-w-0 w-full overflow-hidden ${className}`} style={{ height: pixelHeight(height) }}>
    {size && <ResponsiveContainer width={size.width} height={size.height} minWidth={1} minHeight={1}>{children}</ResponsiveContainer>}
  </div>;
}
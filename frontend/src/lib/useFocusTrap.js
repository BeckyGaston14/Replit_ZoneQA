import { useCallback, useEffect, useRef, useState } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useFocusTrap(open, onClose) {
  const containerRef = useRef(null);
  const [container, setContainer] = useState(null);
  const closeRef = useRef(onClose);
  const restoreRef = useRef(null);
  const setContainerRef = useCallback((node) => {
    containerRef.current = node;
    setContainer(node);
  }, []);

  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;

    restoreRef.current = document.activeElement;
    const onKeyDown = (event) => {
      const currentContainer = containerRef.current;
      if (!currentContainer) return;
      const focusables = [...currentContainer.querySelectorAll(FOCUSABLE)];
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;

      if (!focusables.length) {
        event.preventDefault();
        currentContainer.focus();
        return;
      }
      const firstElement = focusables[0];
      const lastElement = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
      restoreRef.current = null;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !container) return;
    const first = container.querySelector(FOCUSABLE);
    if (first) first.focus();
    else container.focus();
  }, [open, container]);

  return setContainerRef;
}
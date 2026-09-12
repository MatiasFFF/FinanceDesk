import { useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react";

export function AiDialog({ title, onClose, children, wide = false }) {
  const panelRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    function onKeyDown(event) {
      if (Array.from(document.querySelectorAll(".ai-dialog")).at(-1) !== panelRef.current) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const elements = Array.from(panelRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') || []).filter((element) => element.getClientRects().length);
      if (!elements.length) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === elements[0] || document.activeElement === panelRef.current)) { event.preventDefault(); elements.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === elements.at(-1)) { event.preventDefault(); elements[0].focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); document.body.style.overflow = previousOverflow; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  return <div className="ai-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panelRef} tabIndex={-1} className={`ai-dialog${wide ? " ai-dialog-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="ai-dialog-heading"><h2>{title}</h2><button className="ai-icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={22} /></button></header>
      {children}
    </section>
  </div>;
}

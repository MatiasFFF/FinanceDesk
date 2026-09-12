import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";

const dialogs = [];
let bodyOverflow = "";

function syncDialogLayers() {
  dialogs.forEach((dialog, index) => {
    const active = index === dialogs.length - 1;
    dialog.backdrop.style.zIndex = String(50 + index * 2);
    dialog.backdrop.inert = !active;
    dialog.panel.setAttribute("aria-modal", String(active));
    if (active) dialog.panel.removeAttribute("aria-hidden");
    else dialog.panel.setAttribute("aria-hidden", "true");
  });
}

export function AiDialog({ title, onClose, children, wide = false, className = "", closeDisabled = false }) {
  const panelRef = useRef(null);
  const backdropRef = useRef(null);
  const closeRef = useRef(onClose);
  const disabledRef = useRef(closeDisabled);
  const titleId = useId();
  closeRef.current = onClose;
  disabledRef.current = closeDisabled;
  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = { panel: panelRef.current, backdrop: backdropRef.current };
    if (!dialogs.length) { bodyOverflow = document.body.style.overflow; document.body.style.overflow = "hidden"; }
    dialogs.push(dialog);
    syncDialogLayers();
    const autofocus = dialog.panel.querySelector('input:not(:disabled):not([type="hidden"]), textarea:not(:disabled)');
    (autofocus || dialog.panel).focus({ preventScroll: true });
    function focusable() {
      return Array.from(dialog.panel.querySelectorAll('button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')).filter((element) => element.getClientRects().length && !element.closest("[inert]"));
    }
    function onKeyDown(event) {
      if (dialogs.at(-1) !== dialog) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!disabledRef.current) closeRef.current(); return; }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === elements[0] || document.activeElement === dialog.panel)) { event.preventDefault(); elements.at(-1).focus({ preventScroll: true }); }
      else if (!event.shiftKey && (document.activeElement === elements.at(-1) || document.activeElement === dialog.panel)) { event.preventDefault(); elements[0].focus({ preventScroll: true }); }
    }
    function onFocus(event) {
      if (dialogs.at(-1) === dialog && !dialog.panel.contains(event.target)) dialog.panel.focus({ preventScroll: true });
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocus);
      const index = dialogs.indexOf(dialog);
      if (index !== -1) dialogs.splice(index, 1);
      syncDialogLayers();
      if (!dialogs.length) document.body.style.overflow = bodyOverflow;
      const top = dialogs.at(-1)?.panel;
      if (previousFocus?.isConnected && !previousFocus.closest("[inert]") && (!top || top.contains(previousFocus))) previousFocus.focus({ preventScroll: true });
      else top?.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(<div ref={backdropRef} className="ai-dialog-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !closeDisabled) onClose(); }}>
    <section ref={panelRef} tabIndex={-1} className={`ai-dialog${wide ? " ai-dialog-wide" : ""}${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="ai-dialog-heading"><h2 id={titleId}>{title}</h2><button className="ai-icon-button" type="button" aria-label="关闭" disabled={closeDisabled} onClick={onClose}><X size={22} /></button></header>
      <div className="ai-dialog-content">{children}</div>
    </section>
  </div>, document.querySelector(".ai-simple-app") || document.body);
}

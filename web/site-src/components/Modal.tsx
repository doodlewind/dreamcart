/**
 * Modal / Drawer — headless overlay dialog. `variant="modal"` (centered) or
 * "drawer" (slide-over from the right). Closes on overlay click + Escape.
 * Style via [data-part="overlay"|"modal"|"modal-*"] in base.ts.
 */
import { useEffect, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  variant?: "modal" | "drawer";
  children: ReactNode;
  /** Extra controls placed in the header (before the close button). */
  headerExtra?: ReactNode;
}

export function Modal({
  open,
  onClose,
  title,
  variant = "modal",
  children,
  headerExtra,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      data-part="overlay"
      data-variant={variant}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        data-part="modal"
        data-variant={variant}
        role="dialog"
        aria-modal="true"
      >
        <div data-part="modal-header">
          {title != null && <h2 data-part="modal-title">{title}</h2>}
          {headerExtra}
          <button
            type="button"
            data-part="modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            ✕
          </button>
        </div>
        <div data-part="modal-body">{children}</div>
      </div>
    </div>
  );
}

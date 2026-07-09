// Small reusable DOM modal (issue #189). Native alert()/confirm() are
// avoided deliberately: in Electron they block the event loop the automation
// layer relies on, so hand-off / resume and other in-flight work would stall
// behind them.

import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  dismissible?: boolean;
}

export function Modal({ title, onClose, children, dismissible = true }: ModalProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Read through a ref so the mount effect below never needs `onClose` in its
  // dependency array: depending on it directly would re-run the effect (and
  // re-capture / restore focus) on every parent re-render while the modal is
  // open, losing the original pre-open focus target.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (dismissible) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [dismissible]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={dismissible ? onClose : undefined}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-full w-full max-w-md flex-col gap-3 overflow-y-auto rounded bg-white p-3 shadow-lg sm:p-4 md:max-w-lg"
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-medium">{title}</h3>
          {dismissible && (
            <button
              type="button"
              onClick={onClose}
              aria-label="閉じる"
              className="shrink-0 text-neutral-400 hover:text-neutral-700"
            >
              ×
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

import { useEffect, useRef, type ReactNode } from "react";
export function ConfirmationDialog({
  title,
  onClose,
  children,
  closeLabel = "Cancel",
  className = "",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closeLabel?: string;
  className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`confirmation ${className}`}
      aria-label={title}
      onCancel={onClose}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          type="button"
          className="dialog-icon-close"
          aria-label={
            closeLabel === "Close wallet" ? "Close wallet" : "Close dialog"
          }
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
      {closeLabel !== "Close wallet" && (
        <button
          type="button"
          className="secondary dialog-close"
          onClick={onClose}
        >
          {closeLabel}
        </button>
      )}
    </dialog>
  );
}

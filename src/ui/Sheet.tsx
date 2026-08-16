import { useEffect, useRef, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Button, IconButton } from './primitives';
import './ui.css';

function useDismissOnEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
}

/** Focus the first focusable node so keyboard and screen readers land inside. */
function useAutoFocus(open: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const node = ref.current;
    if (!node) return;
    const focusable = node.querySelector<HTMLElement>(
      'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
    );
    (focusable ?? node).focus({ preventScroll: true });
  }, [open]);
  return ref;
}

export function Sheet({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useDismissOnEscape(open, onClose);
  const ref = useAutoFocus(open);
  if (!open) return null;
  return (
    <div className="overlay" onPointerDown={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="sheet__grip" aria-hidden="true" />
        {title && (
          <div className="sheet__head">
            <h2>{title}</h2>
            <IconButton icon="close" label="Close" onClick={onClose} />
          </div>
        )}
        <div className="sheet__body">{children}</div>
        {footer && <div className="sheet__footer">{footer}</div>}
      </div>
    </div>
  );
}

export interface MenuItem {
  icon: IconName;
  label: string;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  hint?: string;
}

export function MenuSheet({
  open,
  title,
  items,
  onClose,
}: {
  open: boolean;
  title?: string;
  items: MenuItem[];
  onClose: () => void;
}) {
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      <ul className="menu">
        {items.map((item) => (
          <li key={item.label}>
            <button
              type="button"
              className={`menu__item ${item.tone === 'danger' ? 'is-danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              <Icon name={item.icon} size={20} />
              <span className="menu__label">
                {item.label}
                {item.hint && <span className="menu__hint">{item.hint}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

export function Dialog({
  open,
  title,
  body,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm?: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  useDismissOnEscape(open, onClose);
  const ref = useAutoFocus(open);
  if (!open) return null;
  return (
    <div className="overlay overlay--center" onPointerDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <h2>{title}</h2>
        {body && <div className="dialog__body">{body}</div>}
        {children}
        <div className="dialog__actions">
          <Button variant="ghost" onClick={onClose}>
            {cancelLabel}
          </Button>
          {onConfirm && (
            <Button variant={destructive ? 'danger' : 'primary'} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

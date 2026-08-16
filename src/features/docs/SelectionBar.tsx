import { Icon, type IconName } from '@/ui/Icon';
import './DocCard.css';

export interface SelectionAction {
  icon: IconName;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}

export interface SelectionBarProps {
  count: number;
  /** How many items could be selected, for the "select all" affordance. */
  total: number;
  /** Singular noun for the live announcement: "document", "page". */
  noun: string;
  actions: SelectionAction[];
  onSelectAll: () => void;
  onDone: () => void;
}

/**
 * The bar that replaces the bottom chrome while a multi-selection is active.
 * It owns the count, "select all" and "done"; the caller supplies whatever
 * actions make sense for what is selected.
 */
export function SelectionBar({ count, total, noun, actions, onSelectAll, onDone }: SelectionBarProps) {
  const label = `${count} ${count === 1 ? noun : `${noun}s`} selected`;
  return (
    <div className="selbar" role="region" aria-label="Selection">
      <div className="selbar__head">
        <span className="selbar__count" aria-live="polite">
          {label}
        </span>
        <button type="button" className="selbar__link" onClick={onSelectAll} disabled={count >= total}>
          Select all
        </button>
        <button type="button" className="selbar__link selbar__link--strong" onClick={onDone}>
          Done
        </button>
      </div>
      <div className="selbar__actions">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className={`tool-btn selbar__action ${action.tone === 'danger' ? 'is-danger' : ''}`}
            onClick={action.onSelect}
            disabled={action.disabled || count === 0}
          >
            <Icon name={action.icon} size={22} />
            <span>{action.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

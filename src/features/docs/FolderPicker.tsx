import { useEffect, useMemo, useRef, useState } from 'react';
import type { Folder, ID } from '@/types';
import { useStore } from '@/state/store';
import { Icon } from '@/ui/Icon';
import { Button } from '@/ui/primitives';
import { Dialog, Sheet } from '@/ui/Sheet';
import './DocCard.css';

/** A folder plus how deep it sits, so the list can show the hierarchy. */
interface FolderRow {
  folder: Folder;
  depth: number;
}

/** Depth-first, alphabetical within each level. */
function flattenFolders(folders: Folder[]): FolderRow[] {
  const byParent = new Map<ID | null, Folder[]>();
  for (const folder of folders) {
    const siblings = byParent.get(folder.parentId) ?? [];
    siblings.push(folder);
    byParent.set(folder.parentId, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort((a, b) => a.name.localeCompare(b.name));

  const rows: FolderRow[] = [];
  const seen = new Set<ID>();
  const walk = (parentId: ID | null, depth: number) => {
    for (const folder of byParent.get(parentId) ?? []) {
      // A corrupt parent chain must not hang the picker.
      if (seen.has(folder.id)) continue;
      seen.add(folder.id);
      rows.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  // Anything whose parent has gone missing still deserves to be reachable.
  for (const folder of folders) {
    if (!seen.has(folder.id)) rows.push({ folder, depth: 0 });
  }
  return rows;
}

export interface FolderPickerProps {
  open: boolean;
  title?: string;
  /** Marked as the current choice and never offered as a destination. */
  currentFolderId?: ID | null;
  /** Folder ids that cannot be chosen. */
  disabledIds?: ID[];
  /** Label for the "no folder" row. */
  rootLabel?: string;
  onPick: (folderId: ID | null) => void;
  onClose: () => void;
}

/**
 * Sheet for choosing a destination folder, with an inline way to create one so
 * filing a document never needs a trip back to the library.
 */
export function FolderPicker({
  open,
  title = 'Move to folder',
  currentFolderId,
  disabledIds,
  rootLabel = 'All documents',
  onPick,
  onClose,
}: FolderPickerProps) {
  const folders = useStore((s) => s.folders);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => flattenFolders(Object.values(folders)), [folders]);
  const blocked = new Set(disabledIds ?? []);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const id = await useStore.getState().newFolder(trimmed);
      setName('');
      setCreating(false);
      onPick(id);
    } catch (error) {
      useStore
        .getState()
        .notify(error instanceof Error ? error.message : 'That folder could not be created', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      title={title}
      onClose={() => {
        setCreating(false);
        onClose();
      }}
    >
      <ul className="menu fpicker">
        <li>
          <button
            type="button"
            className="menu__item"
            disabled={currentFolderId === null}
            onClick={() => onPick(null)}
          >
            <Icon name="home" size={20} />
            <span className="menu__label">{rootLabel}</span>
            {currentFolderId === null && <Icon name="check" size={18} />}
          </button>
        </li>
        {rows.map(({ folder, depth }) => (
          <li key={folder.id}>
            <button
              type="button"
              className="menu__item"
              style={{ paddingLeft: `${depth * 18 + 6}px` }}
              disabled={folder.id === currentFolderId || blocked.has(folder.id)}
              onClick={() => onPick(folder.id)}
            >
              <Icon name="folder" size={20} />
              <span className="menu__label truncate">{folder.name}</span>
              {folder.id === currentFolderId && <Icon name="check" size={18} />}
            </button>
          </li>
        ))}
      </ul>

      {creating ? (
        <form
          className="fpicker__new"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <input
            autoFocus
            value={name}
            maxLength={60}
            placeholder="Folder name"
            aria-label="New folder name"
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={busy || name.trim() === ''}>
            Create
          </Button>
        </form>
      ) : (
        <button type="button" className="menu__item fpicker__add" onClick={() => setCreating(true)}>
          <Icon name="folderPlus" size={20} />
          <span className="menu__label">New folder…</span>
        </button>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

export interface PromptDialogProps {
  open: boolean;
  title: string;
  /** Accessible name for the field, shown above it. */
  label: string;
  hint?: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  maxLength?: number;
  onConfirm: (value: string) => void;
  onClose: () => void;
}

/**
 * A dialog asking for one line of text — naming a folder, retitling a document,
 * adding tags. Empty input is rejected rather than silently discarded, and the
 * field is re-seeded every time the dialog opens.
 */
export function PromptDialog({ open, ...rest }: PromptDialogProps) {
  // Mounting only while open is what re-seeds the field: the state below starts
  // from `initial` every time, with no prop-to-state syncing.
  return open ? <PromptBody {...rest} /> : null;
}

function PromptBody({
  title,
  label,
  hint,
  initial = '',
  placeholder,
  confirmLabel = 'Save',
  maxLength = 120,
  onConfirm,
  onClose,
}: Omit<PromptDialogProps, 'open'>) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // The dialog focuses its first control, but the caret belongs at the end of
    // the existing text, not in front of it.
    const frame = requestAnimationFrame(() => {
      const node = inputRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(node.value.length, node.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  const submit = () => {
    const trimmed = value.trim();
    if (trimmed === '') return;
    onConfirm(trimmed);
  };

  return (
    <Dialog open title={title} confirmLabel={confirmLabel} onConfirm={submit} onClose={onClose}>
      <label className="field">
        <span className="field__label">{label}</span>
        <input
          ref={inputRef}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            submit();
          }}
        />
        {hint && <span className="field__hint">{hint}</span>}
      </label>
    </Dialog>
  );
}

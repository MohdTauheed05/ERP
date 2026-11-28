Attempting to perform the InitializeDefaultDrives operation on the 'FileSystem' provider failed.
import React, { useMemo, useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, X } from 'lucide-react';

export interface SelectOption {
  value: number | string;
  label: string;
  sublabel?: string;
}

interface SearchableSelectProps {
  options: SelectOption[];
  value: number | string | '';
  onChange: (value: number | string) => void;
  placeholder?: string;
  disabled?: boolean;
  createOptionLabel?: string;
  onCreateOption?: (query: string) => void;
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Select...',
  disabled = false,
  createOptionLabel,
  onCreateOption,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const updateDropdownPosition = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const gap = 4;
    const maxHeight = 280;
    const below = window.innerHeight - rect.bottom - gap;
    const above = rect.top - gap;
    const placeAbove = below < 180 && above > below;
    const availableHeight = Math.max(120, Math.min(maxHeight, placeAbove ? above : below));
    setDropdownStyle({
      position: 'fixed',
      left: Math.max(8, rect.left),
      width: Math.min(rect.width, window.innerWidth - Math.max(8, rect.left) - 8),
      ...(placeAbove
        ? { bottom: window.innerHeight - rect.top + gap }
        : { top: rect.bottom + gap }),
      maxHeight: availableHeight,
    });
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node) &&
        !dropdownRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    updateDropdownPosition();
    const reposition = () => updateDropdownPosition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) => o.label.toLowerCase().includes(q) || (o.sublabel && o.sublabel.toLowerCase().includes(q))
    );
  }, [options, query]);

  const selected = options.find((o) => String(o.value) === String(value));

  return (
    <div ref={containerRef} className="relative">
      <div className="w-full flex items-center bg-white border border-slate-300 rounded-md hover:border-slate-400 focus-within:ring-2 focus-within:ring-slate-900">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setOpen((o) => !o);
            setHighlight(0);
          }}
          className="flex-1 min-w-0 flex items-center justify-between gap-2 px-3 py-1.5 text-sm disabled:bg-slate-100 text-left focus:outline-none"
        >
          <span className={`truncate ${selected ? 'text-slate-900' : 'text-slate-400'}`}>
            {selected ? selected.label : placeholder}
          </span>
          <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
        </button>
        {selected && !disabled && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
              setQuery('');
            }}
            className="pr-2 text-slate-400 hover:text-slate-700"
            title="Clear selection"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && typeof document !== 'undefined' && createPortal(
        <div ref={dropdownRef} style={dropdownStyle} className="z-[100] flex flex-col overflow-hidden bg-white border border-slate-200 rounded-md shadow-lg">
          <div className="p-2 border-b border-slate-100 flex items-center gap-2">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              autoFocus
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHighlight((h) => Math.min(filtered.length - 1, h + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHighlight((h) => Math.max(0, h - 1));
                } else if (e.key === 'Enter' && filtered[highlight]) {
                  e.preventDefault();
                  onChange(filtered[highlight].value);
                  setOpen(false);
                  setQuery('');
                } else if (e.key === 'Enter' && query.trim() && onCreateOption) {
                  e.preventDefault();
                  onCreateOption(query.trim());
                  setOpen(false);
                  setQuery('');
                } else if (e.key === 'Escape') {
                  setOpen(false);
                }
              }}
              placeholder="Type to filter..."
              className="w-full text-xs focus:outline-none"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain divide-y divide-slate-50">
            {filtered.length === 0 ? (
              <div className="p-2">
                <div className="px-1 py-1 text-xs text-slate-500">No matches found</div>
                {query.trim() && onCreateOption && (
                  <button
                    type="button"
                    onClick={() => {
                      onCreateOption(query.trim());
                      setOpen(false);
                      setQuery('');
                    }}
                    className="w-full px-2.5 py-2 text-left text-xs font-medium text-blue-700 hover:bg-blue-50 rounded"
                  >
                    + Create {createOptionLabel || 'new record'} “{query.trim()}”
                  </button>
                )}
              </div>
            ) : (
              filtered.map((opt, idx) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                    setQuery('');
                  }}
                  className={`w-full px-3 py-2 text-left text-xs flex flex-col ${
                    idx === highlight ? 'bg-slate-100 text-slate-900' : 'hover:bg-slate-50 text-slate-700'
                  }`}
                >
                  <span className="font-medium truncate">{opt.label}</span>
                  {opt.sublabel && <span className="text-[11px] text-slate-500 truncate">{opt.sublabel}</span>}
                </button>
              ))
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}


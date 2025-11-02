import * as React from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

function SearchableSelect({
  value,
  onValueChange,
  options = [],
  placeholder = 'Select option...',
  searchPlaceholder = 'Search...',
  emptyText = 'No results found.',
  className,
  disabled = false,
  renderOption,
  renderValue,
}) {
  const [open, setOpen] = React.useState(false);
  const [searchTerm, setSearchTerm] = React.useState('');
  const containerRef = React.useRef(null);
  const listId = React.useId();

  const selectedOption = React.useMemo(
    () => options.find((option) => option.value === value) || null,
    [options, value]
  );

  const displayValue = React.useMemo(() => {
    if (!selectedOption) {
      return '';
    }
    if (typeof renderValue === 'function') {
      const rendered = renderValue(selectedOption);
      return typeof rendered === 'string' ? rendered : selectedOption.label || '';
    }
    return selectedOption.label || '';
  }, [renderValue, selectedOption]);

  React.useEffect(() => {
    if (!open) {
      setSearchTerm('');
    }
  }, [open]);

  React.useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handleClickAway = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickAway);
    document.addEventListener('touchstart', handleClickAway);

    return () => {
      document.removeEventListener('mousedown', handleClickAway);
      document.removeEventListener('touchstart', handleClickAway);
    };
  }, [open]);

  React.useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  const filteredOptions = React.useMemo(() => {
    if (!searchTerm) {
      return options;
    }
    const normalizedSearch = searchTerm.trim().toLowerCase();
    return options.filter((option) => {
      const label = option.label?.toLowerCase() || '';
      const searchText = option.searchText?.toLowerCase() || '';
      return label.includes(normalizedSearch) || searchText.includes(normalizedSearch);
    });
  }, [options, searchTerm]);

  const handleSelect = React.useCallback(
    (optionValue) => {
      const nextValue = optionValue === value ? '' : optionValue;
      onValueChange(nextValue);
      setOpen(false);
      setSearchTerm('');
    },
    [onValueChange, value]
  );

  const handleFocus = React.useCallback(() => {
    if (!disabled) {
      setOpen(true);
    }
  }, [disabled]);

  const handleInputChange = React.useCallback(
    (event) => {
      if (disabled) {
        return;
      }
      if (!open) {
        setOpen(true);
      }
      setSearchTerm(event.target.value);
    },
    [disabled, open]
  );

  const handleKeyDown = React.useCallback(
    (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        event.currentTarget.blur();
      } else if (event.key === 'ArrowDown' && !open) {
        event.preventDefault();
        setOpen(true);
      } else if (event.key === 'Enter' && open) {
        event.preventDefault();
        if (filteredOptions.length > 0) {
          handleSelect(filteredOptions[0].value);
        }
      }
    },
    [filteredOptions, handleSelect, open]
  );

  const inputValue = open ? searchTerm : displayValue;
  const inputPlaceholder = open ? searchPlaceholder : placeholder;

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
        <Input
          value={inputValue}
          placeholder={inputPlaceholder}
          onFocus={handleFocus}
          onClick={handleFocus}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          readOnly={disabled}
          disabled={disabled}
          aria-expanded={open}
          aria-controls={listId}
          role="combobox"
          className={cn(
            'w-full cursor-text pl-9 pr-9',
            !displayValue && !open && 'placeholder:text-muted-foreground'
          )}
        />
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
      </div>

      {open ? (
        <div
          id={listId}
          role="listbox"
          className="absolute z-50 mt-2 max-h-60 w-full overflow-auto rounded-lg border border-border bg-popover shadow-xl"
        >
          {filteredOptions.length === 0 ? (
            <div className="px-3 py-4 text-sm text-muted-foreground/70">{emptyText}</div>
          ) : (
            filteredOptions.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleSelect(option.value)}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus:outline-none',
                    isSelected ? 'bg-accent/40 text-foreground' : 'text-foreground/90'
                  )}
                >
                  <span className="flex-1 truncate">
                    {renderOption ? renderOption(option) : option.label}
                  </span>
                  {isSelected ? <Check className="h-4 w-4 shrink-0" /> : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

export { SearchableSelect };

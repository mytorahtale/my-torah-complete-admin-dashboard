import * as React from 'react';
import { cn } from '@/lib/utils';

const Textarea = React.forwardRef(({ className, minRows = 3, ...props }, ref) => {
  // Calculate min-height based on minRows
  const minHeight = minRows ? `${minRows * 1.5}rem` : '120px';

  return (
    <textarea
      className={cn(
        'flex w-full rounded-lg border border-border/70 bg-input/70 px-3 py-2 text-sm text-foreground/90 ring-offset-background placeholder:text-foreground/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
      style={{ minHeight }}
      rows={minRows}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };

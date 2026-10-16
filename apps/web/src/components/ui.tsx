import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** A dashboard panel: rounded box with an upper-case header row. */
export function Panel({
  title,
  aside,
  className = '',
  children,
}: {
  title: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={`flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-line bg-panel ${className}`}
    >
      <PanelHeader aside={aside}>{title}</PanelHeader>
      {children}
    </section>
  );
}

export function PanelHeader({
  aside,
  className = '',
  children,
}: {
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <header
      className={`flex items-center gap-2.5 border-b border-line px-3 py-[9px] text-[11px] font-semibold tracking-[1px] text-dim uppercase ${className}`}
    >
      <h2>{children}</h2>
      <div className="flex-1" />
      {aside}
    </header>
  );
}

export function Button({
  primary = false,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  const tone = primary
    ? 'border-[#0369a1] bg-accent-deep text-[#e0f2fe] enabled:hover:bg-[#075985]'
    : 'border-line bg-panel-2 text-ink enabled:hover:border-[#334155] enabled:hover:bg-[#1c2230]';
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-[7px] text-xs font-semibold whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 ${tone} ${className}`}
      {...props}
    />
  );
}

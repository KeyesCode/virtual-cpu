/** Header and body cell classes shared by the bottom-row tables. */
export const TH =
  'sticky top-0 bg-panel px-3 py-[7px] text-left font-sans text-[10.5px] font-semibold tracking-[0.8px] text-dim uppercase shadow-[inset_0_-1px_0_var(--color-line)]';
export const TD = 'border-b border-line-soft px-3 py-[5px] whitespace-nowrap';

export function Empty({ children = 'No instructions executed yet' }: { children?: string }) {
  return <p className="p-3 text-xs text-faint">{children}</p>;
}

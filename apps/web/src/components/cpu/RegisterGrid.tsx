import { REGISTER_NAMES } from '@vcpu/shared';
import { binaryNibbles, hex, signed } from '../../lib/format';

/** One general-purpose register: hex, unsigned and signed readings, and its bits. */
export function RegisterCard({
  name,
  value,
  changed,
}: {
  name: string;
  value: number;
  changed: boolean;
}) {
  return (
    <div
      data-testid={`register-${name}`}
      data-changed={changed ? 'true' : 'false'}
      className={`rounded-lg border px-2 py-2 @wide:px-2.5 ${changed ? 'border-[#a16207] bg-[#1f1a0e]' : 'border-line bg-panel-2'}`}
    >
      <div className="flex flex-wrap justify-between gap-x-2 font-mono text-[11px] font-semibold whitespace-nowrap text-dim">
        {name}
        <span>
          {value} · {signed(value)}
        </span>
      </div>
      <div
        className={`my-0.5 font-mono text-xl font-semibold ${value === 0 ? 'text-faint' : 'text-white'}`}
      >
        {hex(value)}
      </div>
      <div
        className={`font-mono text-[11px] whitespace-nowrap @wide:tracking-[1px] ${value === 0 ? 'text-faint' : 'text-muted'}`}
      >
        {binaryNibbles(value)}
      </div>
    </div>
  );
}

/** R0–R7; registers the last instruction wrote are outlined amber. */
export function RegisterGrid({
  registers,
  changed,
}: {
  registers: readonly number[];
  changed: ReadonlySet<string>;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 p-3 @min-[640px]:grid-cols-4">
      {REGISTER_NAMES.map((name, index) => (
        <RegisterCard
          key={name}
          name={name}
          value={registers[index] ?? 0}
          changed={changed.has(name)}
        />
      ))}
    </div>
  );
}

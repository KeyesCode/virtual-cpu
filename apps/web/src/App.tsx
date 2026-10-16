import { CPU_NAME } from '@vcpu/shared';

export function App() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 bg-zinc-950 font-mono text-zinc-100">
      <h1 className="text-4xl font-semibold tracking-tight">{CPU_NAME}</h1>
      <p className="text-sm text-zinc-400">Educational 8-bit virtual CPU. Dashboard coming soon.</p>
    </main>
  );
}

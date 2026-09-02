export interface Clock {
  now(): Date;
  nowIso(): string;
}

export interface RandomSource {
  bytes(length: number): Uint8Array;
  identifier(prefix?: string): string;
}

export interface AdapterSet {
  filesystem: import('./filesystem').FileSystemAdapter;
  locks: import('./locks').LockAdapter;
  processes: import('./process').ChildProcessAdapter;
  registry: import('./source').RegistryTransport;
  sources: import('./source').SourceTransport;
  clock: Clock;
  random: RandomSource;
}

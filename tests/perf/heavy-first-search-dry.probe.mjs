// One run per mode of heavy-first-search.probe.mjs (to check the probe before the 8-run job).
process.argv[2] = '1';
process.argv[3] = 'open,perf';
await import('./heavy-first-search.probe.mjs');

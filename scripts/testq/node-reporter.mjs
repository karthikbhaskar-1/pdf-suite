// Test queue reporter for `node --test`: writes one JSON line per finished test to the destination file
// (--test-reporter-destination), so the runner can count passes and failures without parsing human text.
// Line shape: { name, nesting, type: 'test'|'suite', ok, ms, error } where `error` is the first lines of the failure.
export default async function* testqReporter(source) {
  for await (const event of source) {
    if (event.type !== 'test:pass' && event.type !== 'test:fail') continue;
    const d = event.data;
    const err = event.type === 'test:fail' ? d.details?.error : null;
    const cause = err?.cause ?? err;
    const text = String(cause?.message ?? err?.message ?? err ?? '');
    yield `${JSON.stringify({
      name: d.name,
      nesting: d.nesting,
      type: d.details?.type ?? 'test',
      ok: event.type === 'test:pass',
      skip: Boolean(d.skip),
      todo: Boolean(d.todo),
      ms: Math.round(d.details?.duration_ms ?? 0),
      error: text ? text.split(/\r?\n/).slice(0, 6).join('\n') : undefined,
      file: d.file,
    })}\n`;
  }
}

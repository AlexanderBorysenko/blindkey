// Dependency-free health probe for HEALTHCHECK: the runtime image has no curl.
const port = process.env.BLINDKEY_PORT ?? '8080';
try {
  const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) process.exit(1);
  const body = await res.json();
  process.exit(body && body.ok === true ? 0 : 1);
} catch {
  process.exit(1);
}

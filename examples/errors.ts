/**
 * Errors: one error type, keyed on `code` (the API's stable error codes plus a few of the SDK's own).
 *
 *     PDIGGER_FACTORY_URL=http://factory-orin.local:8120 node examples/errors.ts
 */
import { FactoryClient, isFactoryError } from "pdigger-factory-sdk";

const factory = new FactoryClient(process.env.PDIGGER_FACTORY_URL ?? "http://factory-orin.local:8120", {
  timeoutMs: 10_000, // per request (the default)
  retries: 3, // GET retries on connection errors, 429, 502, 503 and 504 (the default)
});

// #region errors
try {
  await factory.api.getFrame(0); // the unit keeps only its newest frames
} catch (err) {
  if (!isFactoryError(err, "not_retained")) throw err;
  console.log(`frame 0 is gone: the unit keeps frames ${err.retained?.g0} to ${err.retained?.g1}`);
}

try {
  const live = await factory.live();
  console.log(`live camera: ${live.title}`);
} catch (err) {
  if (!isFactoryError(err, "live_unavailable")) throw err;
  console.log("this unit lists no camera: the shared session plays recordings");
}

try {
  await factory.api.getVideo("no-such-video");
} catch (err) {
  if (!isFactoryError(err)) throw err;
  console.log(`${err.status} ${err.code} (field ${err.field}): ${err.message}; retryable: ${err.isRetryable()}`);
}
// #endregion errors

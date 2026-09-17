# express-completions

A streaming completion endpoint protected by `@mohadjillani/idempotency-kit`. `POST /v1/completions` streams server-sent events from a stand-in model provider; the middleware is what makes a retry replay that stream instead of paying for a second one.

```sh
npm run demo:completions                     # from the repository root
npm start -w examples/express-completions    # serves on :3000 with the memory store
```

The demo prints a running token count, which is the whole argument:

```
scenario                      status  replayed  billed  answer
first call                    200     -         13      time it every a the different the answer
retry, same key (replay)      200     yes       13      time it every a the different the answer
same prompt, new key          200     -         26      time different you every answer twice different model
```

## Why a completion is a sharper case than a charge

A charge retried twice is at least the same charge. The provider here _samples_, so an unprotected retry is billed again **and** returns a different answer — the caller pays a second time to have their result changed underneath them.

Magic prompts exercise the error rules: `__overloaded__` returns 503, which is not stored, so the retry reaches the provider; `__refused__` returns 400, which is stored, because a content refusal is a property of the prompt and asking again only pays for the same refusal.

## What the replay is, exactly

The binding captures the response through `write`/`end`, so every byte of the stream is stored and returned verbatim — including the trailing `usage` event, which is why the recorded cost of a replay matches the original rather than being recomputed.

It is replayed as **one write, not as a stream**. The bytes are identical and any SSE parser will read them, but a client that renders tokens as they arrive will see the replay appear at once. That is the honest shape of a replay: it is a recording, not a second generation.

Two consequences worth knowing before copying this:

- **The whole completion is buffered in memory** before it is stored. Fine for completions of this size, wrong for very long generations — that would want a streaming store, which the kit does not have.
- **The lock has to outlive the generation.** `lockTtlMs` is 60s here; if it expired mid-stream a retry would start a second generation, which is the thing this exists to prevent.

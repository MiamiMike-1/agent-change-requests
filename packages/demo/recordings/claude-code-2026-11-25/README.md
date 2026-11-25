# Recorded run: Claude Code against the invoices demo

Recorded 2026-11-25 with Claude Code 2.1.332 in headless mode (`claude -p`), against the demo server over stdio. Each session was a new process with no memory of the others, and could use only the invoices server's tools. Nothing in the prompts mentions change requests. Claude Code does not advertise the extension, so it used the tool fallback (`change_requests_*`) that Backward Compatibility describes.

- [`transcript.md`](transcript.md): the run, readable. Long tool results are cut.
- `session-1.jsonl`, `session-2.jsonl`, `session-3.jsonl`: every call, every result exactly as the model saw it, any `_meta` it did not see, and every reply. Session ids, usage, and model identifiers are removed.
- [`../../scripts/record-claude.sh`](../../scripts/record-claude.sh) records a new run, and [`render-recording.mjs`](../../scripts/render-recording.mjs) turns the raw output into these files.

## What happened

**Session 1, server 1.0.0.** Asked what `cus_007` owes, Claude paged through all 230 invoices (5 calls) and answered $2,008, which is correct. Without being asked, it then filed `crq_f962aeaec7554f2d` with `change_requests_submit`. The request has a `tool` target, `failureMode: interface_cost`, an impact block, its workaround, and one acceptance test. It used a placeholder customer id (`cus_example`) instead of `cus_007`, and told the user the request "includes no customer data".

**The vendor ships 1.1.0.** `ship.js` moved the request to `shipped` with `workaroundObsolete: true`.

**Session 2, server 1.1.0.** Asked what `cus_012` owes, Claude used the new `customer_id` and `status` arguments it found in the tool's schema and answered $921 in one call. It never learned that its request had shipped, and did not confirm. The server did add the update notice. The result carried `_meta: {"com.rocketproforma/change-requests": {"updates": 1}}` and the text line "Note from Invoices: 1 of your change requests has an update…". But `list_invoices` returns `structuredContent`, and Claude Code gives the model the structured content in place of the text content, so the line never reached it. Claude Code does not show `_meta` to the model either.

**Session 3, server 1.1.0, with a memory note.** The same question, with one line added to the system prompt naming the request filed in session 1, standing in for the memory a client keeps between sessions. Claude called `list_invoices` with the filters and `change_requests_get` on its request, saw `shipped` with `workaroundObsolete: true`, and confirmed with `outcome: pass` and `adopted: true`. It told the user the change was live and that it had dropped the workaround.

## Findings for the SEP

1. **An agent files a usable request unprompted.** A plain task was enough for the model to notice the cost of the workaround, file, fill in the structured fields, and keep customer data out of the request.
2. **The text notice does not reach clients that show `structuredContent`.** Section 7 and the Rationale assume that one line of text on every tool result reaches any client. For a tool with an `outputSchema`, Claude Code shows the model only the structured content, and the server cannot put the notice there without breaking the tool's own schema (`additionalProperties: false`). Session 2 shows the result: the fix was adopted, but by accident, and the request was never confirmed. The SEP now makes this a client duty (Section 7): a client that shows the model structured content in place of text should keep the notice line, or add one from the `_meta` count.
3. **The model-written acceptance test could not be run as written.** It calls `list_invoices` with `customer_id: "cus_example"` and expects the text to contain `cus_example` and `unpaid`. The redaction that kept the real customer out also made the test refer to a customer that does not exist, and the demo's text content ("3 invoices.") would not contain those strings for any customer. In session 3 Claude judged the fix by its real call instead of re-running the test. The demo's ship script also reports every test as `pass` without running it.
4. **Confirmation works once the agent knows to look.** With the request id in memory, the model read the status, confirmed, and reported adoption in two calls.

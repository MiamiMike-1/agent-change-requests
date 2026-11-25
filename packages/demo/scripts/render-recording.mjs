#!/usr/bin/env node
/**
 * Turns the raw stream-json from record-claude.sh into the committed recording:
 * one cleaned JSONL per session (prompt, tool calls, tool results as the model saw
 * them, the _meta it did not see, and its replies) and a readable transcript.md.
 * Session ids, usage, cost, and model identifiers are left out.
 *
 *   node render-recording.mjs <raw-dir> <out-dir>
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [rawDir, outDir] = process.argv.slice(2);
if (!rawDir || !outDir) throw new Error("usage: render-recording.mjs <raw-dir> <out-dir>");
mkdirSync(outDir, { recursive: true });

const PROMPTS = {
  "session-1": { version: "1.0.0", prompt: "Using the invoices server, how much does customer cus_007 owe in unpaid invoices?" },
  "session-2": { version: "1.1.0", prompt: "Using the invoices server, how much does customer cus_012 owe in unpaid invoices?" },
  "session-3": { version: "1.1.0", prompt: "Using the invoices server, how much does customer cus_012 owe in unpaid invoices?" },
};

const scrub = (s) => s.replace(/claude-[a-z]+-[0-9][0-9a-z.-]*/gi, "[model]");

function events(name) {
  const out = [];
  for (const line of readFileSync(join(rawDir, `${name}.jsonl`), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    if (d.type === "system" && d.subtype === "init") {
      out.push({ type: "tools", tools: d.tools.map((t) => t.replace(/^mcp__invoices__/, "")) });
    }
    if (d.type !== "assistant" && d.type !== "user") continue;
    const content = Array.isArray(d.message?.content) ? d.message.content : [];
    for (const c of content) {
      if (c.type === "text") out.push({ type: "reply", text: c.text });
      if (c.type === "tool_use") out.push({ type: "call", id: c.id, tool: c.name.replace(/^mcp__invoices__/, ""), arguments: c.input });
      if (c.type === "tool_result") {
        const seen = typeof c.content === "string" ? c.content : c.content.map((b) => b.text ?? "").join("\n");
        const meta = d.tool_use_result?._meta;
        out.push({ type: "result", id: c.tool_use_id, seenByModel: seen, ...(meta ? { metaNotSeenByModel: meta } : {}) });
      }
    }
  }
  return out;
}

const short = (s, n = 600) => (s.length > n ? `${s.slice(0, n)}… (${s.length} characters in all)` : s);
const md = [];
const sessions = Object.keys(PROMPTS).filter((n) => existsSync(join(rawDir, `${n}.jsonl`)));

for (const name of sessions) {
  const evs = events(name);
  const { version, prompt } = PROMPTS[name];
  const memoryFile = join(rawDir, `${name}.memory.txt`);
  const memory = existsSync(memoryFile) ? readFileSync(memoryFile, "utf8").trim() : undefined;
  writeFileSync(
    join(outDir, `${name}.jsonl`),
    [{ type: "session", server: `invoices-demo ${version}`, prompt, ...(memory ? { systemPromptAddition: memory } : {}) }, ...evs]
      .map((e) => scrub(JSON.stringify(e)))
      .join("\n") + "\n",
  );

  md.push(`## ${name.replace("-", " ").replace(/^s/, "S")}: server ${version}`, "");
  md.push(`**Prompt:** ${prompt}`, "");
  if (memory) md.push(`**Added to the system prompt:** ${memory}`, "");
  for (const e of evs) {
    if (e.type === "tools") md.push(`**Tools the model had:** ${e.tools.map((t) => `\`${t}\``).join(", ")}`, "");
    if (e.type === "call") md.push(`**Call** \`${e.tool}\``, "", "```json", JSON.stringify(e.arguments, null, 2), "```", "");
    if (e.type === "result") {
      md.push("**Result, as the model saw it**", "", "```json", short(e.seenByModel), "```", "");
      if (e.metaNotSeenByModel) md.push(`Not shown to the model: \`_meta\` ${"`"}${JSON.stringify(e.metaNotSeenByModel)}${"`"}`, "");
    }
    if (e.type === "reply") md.push("**Claude:**", "", ...e.text.split("\n").map((l) => `> ${l}`), "");
  }
  if (name === "session-1" && existsSync(join(rawDir, "ship.txt"))) {
    md.push("## The vendor ships 1.1.0", "", "`node packages/demo/dist/ship.js`:", "", "```", readFileSync(join(rawDir, "ship.txt"), "utf8").trim(), "```", "");
  }
}

writeFileSync(join(outDir, "transcript.md"), scrub(md.join("\n")));
console.log(`Wrote ${sessions.length} sessions to ${outDir}.`);

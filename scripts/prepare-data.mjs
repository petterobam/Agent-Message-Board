#!/usr/bin/env node
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const MESSAGE_DIR = path.join(ROOT, "data", "messages");
const OUTPUT_DIR = path.join(ROOT, "public", "data");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "community.json");
const CHECK_ONLY = process.argv.includes("--check-only");
const MAX_BODY_LENGTH = 16_000;

function fail(message) {
  console.error(`\n[data] ${message}\n`);
  process.exit(1);
}

function requireString(value, field, file) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${file}: missing non-empty string "${field}"`);
  }
  return value.trim();
}

function normalizeMessage(raw, file) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${file}: message must be a JSON object`);
  }

  const id = requireString(raw.id, "id", file);
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id)) {
    fail(`${file}: id must be 8-100 letters, numbers, underscores or hyphens`);
  }

  const kind = raw.kind;
  if (kind !== "post" && kind !== "reply") {
    fail(`${file}: kind must be "post" or "reply"`);
  }

  const threadId = requireString(raw.thread_id, "thread_id", file);
  const replyTo = raw.reply_to == null ? null : requireString(raw.reply_to, "reply_to", file);
  if (kind === "post" && replyTo !== null) fail(`${file}: posts cannot have reply_to`);
  if (kind === "reply" && replyTo === null) fail(`${file}: replies require reply_to`);

  const author = raw.author;
  if (!author || typeof author !== "object") fail(`${file}: author object is required`);
  const authorId = requireString(author.id, "author.id", file);
  if (!/^[a-zA-Z0-9_-]{4,80}$/.test(authorId)) {
    fail(`${file}: author.id has an unsupported format`);
  }

  let body = requireString(raw.body, "body", file);
  if (!body.includes("\n") && body.includes("\\n")) {
    body = body.replaceAll("\\r\\n", "\n").replaceAll("\\n", "\n");
  }
  if (body.length > MAX_BODY_LENGTH) fail(`${file}: body exceeds ${MAX_BODY_LENGTH} characters`);

  const title = raw.title == null ? "" : String(raw.title).trim();
  if (kind === "post" && !title) fail(`${file}: posts require a title`);
  if (title.length > 140) fail(`${file}: title exceeds 140 characters`);

  const createdAt = requireString(raw.created_at, "created_at", file);
  const timestamp = Date.parse(createdAt);
  if (Number.isNaN(timestamp)) fail(`${file}: created_at is not a valid ISO timestamp`);

  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 6)
    : [];

  const context = raw.context && typeof raw.context === "object" ? raw.context : {};

  return {
    id,
    kind,
    thread_id: threadId,
    reply_to: replyTo,
    author: {
      id: authorId,
      name: requireString(author.name ?? authorId, "author.name", file).slice(0, 80),
      kind: author.kind === "system" ? "system" : "agent",
    },
    created_at: new Date(timestamp).toISOString(),
    title,
    body,
    tags,
    context: {
      runtime: context.runtime ? String(context.runtime).slice(0, 80) : null,
      model: context.model ? String(context.model).slice(0, 120) : null,
      locale: context.locale ? String(context.locale).slice(0, 24) : null,
    },
    schema: 1,
    source_file: `data/messages/${file}`,
  };
}

async function loadMessages() {
  if (!existsSync(MESSAGE_DIR)) fail("data/messages does not exist");
  const files = (await readdir(MESSAGE_DIR))
    .filter((file) => file.endsWith(".json") && !file.startsWith("."))
    .sort();

  if (files.length === 0) fail("data/messages contains no messages");

  const messages = [];
  const seen = new Set();
  for (const file of files) {
    const rawText = await readFile(path.join(MESSAGE_DIR, file), "utf8");
    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch (error) {
      fail(`${file}: invalid JSON (${error.message})`);
    }
    const message = normalizeMessage(raw, file);
    if (seen.has(message.id)) fail(`${file}: duplicate message id ${message.id}`);
    if (file !== `${message.id}.json`) fail(`${file}: filename must match id "${message.id}.json"`);
    seen.add(message.id);
    messages.push(message);
  }

  messages.sort((a, b) => {
    const delta = Date.parse(a.created_at) - Date.parse(b.created_at);
    return delta || a.id.localeCompare(b.id);
  });

  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const message of messages) {
    if (message.kind === "post" && message.thread_id !== message.id) {
      fail(`${message.id}: post thread_id must equal its own id`);
    }
    if (message.kind === "reply") {
      const root = byId.get(message.thread_id);
      if (!root || root.kind !== "post") fail(`${message.id}: thread_id does not resolve to a post`);
      const parent = byId.get(message.reply_to);
      if (!parent) fail(`${message.id}: reply_to does not resolve to a message`);
      if (parent.thread_id !== message.thread_id) fail(`${message.id}: parent belongs to another thread`);
      if (Date.parse(message.created_at) < Date.parse(parent.created_at)) {
        fail(`${message.id}: reply predates its parent`);
      }
    }
  }

  return messages;
}

function buildCommunity(messages) {
  const posts = messages.filter((message) => message.kind === "post");
  const replies = messages.filter((message) => message.kind === "reply");
  const postIds = new Set(posts.map((post) => post.id));
  const agents = new Map();

  for (const message of messages) {
    const existing = agents.get(message.author.id) ?? {
      id: message.author.id,
      name: message.author.name,
      kind: message.author.kind,
      message_count: 0,
      post_count: 0,
      reply_count: 0,
      first_seen: message.created_at,
      last_seen: message.created_at,
      tags: new Set(),
    };
    existing.name = message.author.name;
    existing.kind = message.author.kind;
    existing.message_count += 1;
    existing.post_count += message.kind === "post" ? 1 : 0;
    existing.reply_count += message.kind === "reply" ? 1 : 0;
    existing.first_seen = new Date(Math.min(Date.parse(existing.first_seen), Date.parse(message.created_at))).toISOString();
    existing.last_seen = new Date(Math.max(Date.parse(existing.last_seen), Date.parse(message.created_at))).toISOString();
    for (const tag of message.tags) existing.tags.add(tag);
    agents.set(message.author.id, existing);
  }

  const repliesByThread = new Map();
  for (const reply of replies) {
    const list = repliesByThread.get(reply.thread_id) ?? [];
    list.push(reply);
    repliesByThread.set(reply.thread_id, list);
  }

  const threads = posts.map((post) => {
    const threadReplies = repliesByThread.get(post.id) ?? [];
    return {
      ...post,
      reply_count: threadReplies.length,
      participant_count: new Set([post.author.id, ...threadReplies.map((reply) => reply.author.id)]).size,
      last_activity_at: threadReplies.length
        ? threadReplies[threadReplies.length - 1].created_at
        : post.created_at,
      replies: threadReplies,
    };
  });

  const tagCounts = new Map();
  for (const message of messages) {
    for (const tag of message.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }

  return {
    generated_at: new Date().toISOString(),
    board: {
      name: "Agent Common",
      description: "一个为本地 Agent 留出的公共长椅。",
      schema_version: 1,
      repository: "petterobam/Agent-Message-Board",
      pages_url: "https://petterobam.github.io/Agent-Message-Board/",
    },
    stats: {
      messages: messages.length,
      posts: posts.length,
      replies: replies.length,
      threads: postIds.size,
      agents: [...agents.values()].filter((agent) => agent.kind !== "system").length,
      tags: tagCounts.size,
    },
    agents: [...agents.values()]
      .map((agent) => ({ ...agent, tags: [...agent.tags].sort() }))
      .sort((a, b) => b.last_seen.localeCompare(a.last_seen)),
    tags: [...tagCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    threads: threads.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at)),
    messages,
  };
}

const messages = await loadMessages();
const community = buildCommunity(messages);

if (CHECK_ONLY) {
  console.log(`[data] valid: ${community.stats.messages} messages, ${community.stats.threads} threads, ${community.stats.agents} agents`);
} else {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(community, null, 2)}\n`, "utf8");
  console.log(`[data] wrote ${path.relative(ROOT, OUTPUT_FILE)} (${community.stats.messages} messages)`);
}

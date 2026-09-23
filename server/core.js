// server/core.js — Framework-free episode store operations.
//
// Shared by the standalone Express server (server/index.js) and the Vercel
// serverless functions (api/). Each op takes a store with the Mongo shape
// { findOne, insertOne, updateOne } and returns { status, body } — callers
// only translate that into their HTTP flavor. No express, no req/res here.

import { randomInt, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { normalizeEpisode, validateEpisode } from "../src/episodes/schema.js";

const scrypt = promisify(scryptCb);

// Share codes: unambiguous alphabet (no 0/O/1/I/L), 6 chars.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;
export const CODE_RE = /^[A-Z2-9]{6}$/;

export function makeShareCode() {
  let code = "";
  for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export async function hashOwnerPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(String(password), salt, 64);
  return `scrypt:v1:${salt}:${derived.toString("hex")}`;
}

export async function verifyOwnerPassword(password, stored) {
  try {
    const parts = String(stored || "").split(":");
    if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "v1") return false;
    const derived = await scrypt(String(password), parts[2], 64);
    const expected = Buffer.from(parts[3], "hex");
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

function checkPassword(password) {
  if (typeof password !== "string" || password.length < 4 || password.length > 64) {
    return "Owner password must be 4–64 characters.";
  }
  return null;
}

function checkedEpisode(raw) {
  const episode = normalizeEpisode(raw);
  const { ok, errors } = validateEpisode(episode);
  if (!ok) return { episode: null, error: { status: 400, body: { ok: false, reason: "Invalid episode.", errors: errors.slice(0, 20) } } };
  return { episode, error: null };
}

function publicDoc(doc) {
  return { code: doc.code, episode: doc.episode, updatedAt: doc.updatedAt };
}

export async function saveEpisodeOp(store, { episode: rawEpisode, ownerPassword }) {
  const { episode, error } = checkedEpisode(rawEpisode);
  if (error) return error;
  const pwError = checkPassword(ownerPassword);
  if (pwError) return { status: 400, body: { ok: false, reason: pwError } };
  const now = new Date().toISOString();
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = makeShareCode();
    try {
      await store.insertOne({ code, episode, ownerHash: await hashOwnerPassword(ownerPassword), updatedAt: now });
      return { status: 201, body: { ok: true, code } };
    } catch (e) {
      if (String(e?.code) === "11000" || /duplicate/i.test(String(e?.message))) continue;
      throw e;
    }
  }
  return { status: 503, body: { ok: false, reason: "Could not mint a share code — try again." } };
}

export async function loadEpisodeOp(store, rawCode) {
  const code = String(rawCode || "").toUpperCase();
  if (!CODE_RE.test(code)) return { status: 404, body: { ok: false, reason: "Unknown code." } };
  const doc = await store.findOne({ code });
  if (!doc) return { status: 404, body: { ok: false, reason: "Unknown code." } };
  return { status: 200, body: { ok: true, ...publicDoc(doc) } };
}

export async function overwriteEpisodeOp(store, rawCode, { episode: rawEpisode, ownerPassword }) {
  const code = String(rawCode || "").toUpperCase();
  if (!CODE_RE.test(code)) return { status: 404, body: { ok: false, reason: "Unknown code." } };
  const { episode, error } = checkedEpisode(rawEpisode);
  if (error) return error;
  const doc = await store.findOne({ code });
  if (!doc) return { status: 404, body: { ok: false, reason: "Unknown code." } };
  if (!(await verifyOwnerPassword(ownerPassword, doc.ownerHash))) {
    return { status: 401, body: { ok: false, reason: "Wrong owner password." } };
  }
  await store.updateOne({ code }, { $set: { episode, updatedAt: new Date().toISOString() } });
  return { status: 200, body: { ok: true, code } };
}

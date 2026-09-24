// server/db.js — MongoDB adapter for episode storage.
//
// Reads MONGO_URL (+ optional MONGO_DB, default "buzzers") from the
// environment. Exposes a minimal store interface { findOne, insertOne,
// updateOne } shaped like a Mongo collection so tests can inject an
// in-memory fake without touching this file.
//
// Serverless note: the connect promise is cached on globalThis so warm
// invocations reuse one connection instead of reconnecting per request.
// Set __EPISODE_TEST_STORE__ (tests only) to bypass Mongo entirely.

import { MongoClient } from "mongodb";

function getTestStore() {
  try {
    return globalThis.__EPISODE_TEST_STORE__ || null;
  } catch {
    return null;
  }
}

function getCached() {
  try {
    return globalThis.__EPISODE_MONGO__ || null;
  } catch {
    return null;
  }
}

function setCached(promise) {
  try {
    globalThis.__EPISODE_MONGO__ = promise;
  } catch {}
}

function clearCached() {
  try {
    globalThis.__EPISODE_MONGO__ = null;
  } catch {}
}

export async function getEpisodesCollection() {
  const testStore = getTestStore();
  if (testStore) return testStore;
  const cached = getCached();
  if (cached) return cached;
  const url = process.env.MONGO_URL;
  if (!url) throw new Error("MONGO_URL is not set — episode cloud storage is disabled.");
  const pending = (async () => {
    const client = new MongoClient(url);
    await client.connect();
    const db = client.db(process.env.MONGO_DB || "buzzers");
    const collection = db.collection("episodes");
    await collection.createIndex({ code: 1 }, { unique: true });
    return {
      __client: client,
      findOne: (filter) => collection.findOne(filter),
      insertOne: (doc) => collection.insertOne(doc),
      updateOne: (filter, update) => collection.updateOne(filter, update),
    };
  })();
  setCached(pending);
  try {
    return await pending;
  } catch (e) {
    if (getCached() === pending) clearCached();
    throw e;
  }
}

export async function closeDb() {
  const cached = getCached();
  clearCached();
  if (cached) {
    try {
      const resolved = await Promise.resolve(cached).catch(() => null);
      await resolved?.__client?.close?.();
    } catch {}
  }
}

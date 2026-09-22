// server/db.js — MongoDB adapter for episode storage.
//
// Reads MONGO_URL (+ optional MONGO_DB, default "buzzers") from the
// environment. Exposes a minimal store interface { findOne, insertOne,
// updateOne } shaped like a Mongo collection so tests can inject an
// in-memory fake without touching this file.

import { MongoClient } from "mongodb";

let client = null;
let collection = null;

export async function getEpisodesCollection() {
  if (collection) return collection;
  const url = process.env.MONGO_URL;
  if (!url) throw new Error("MONGO_URL is not set — episode cloud storage is disabled.");
  client = new MongoClient(url);
  await client.connect();
  const db = client.db(process.env.MONGO_DB || "buzzers");
  collection = db.collection("episodes");
  await collection.createIndex({ code: 1 }, { unique: true });
  return collection;
}

export async function closeDb() {
  collection = null;
  if (client) {
    try { await client.close(); } catch {}
    client = null;
  }
}

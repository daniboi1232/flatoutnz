/* =====================================================================
   Enumerating records in Netlify Blobs
   =====================================================================
   Reading a key you just wrote gives you back what you wrote. LISTING
   is a different promise: store.list() is only eventually consistent,
   and a brand-new key can take the better part of a minute to appear
   under it. Measured on the live site, a record was still invisible to
   list 21 seconds after its write had returned ok.

   Anything that finds records by listing them therefore cannot see
   what just happened, which produced two bugs that looked unrelated:
   a job saved and then reloaded came back missing, and a six-digit
   code issued a moment earlier was refused at sign-in because the
   user record it belonged to was not in the list yet.

   The fix is to stop depending on list alone. Each kind keeps an index
   of its ids at index/<kind>, written with the record, and every read
   takes the UNION of that index and list(). The index makes a new
   record visible immediately; list still heals the index if a write of
   it is ever lost. Neither source is trusted on its own, which is the
   point — the union is never worse than what list alone would give.
   ===================================================================== */

const key = kind => 'index/' + kind;

export async function readIndex(store, kind) {
  const v = await store.get(key(kind), { type: 'json' }).catch(() => null);
  return Array.isArray(v) ? v : [];
}

/* Add ids to a kind's index. Writes only when something is actually
   new, so a save that changes an existing record costs one read rather
   than a read and a write. */
export async function addToIndex(store, kind, ids) {
  const have = await readIndex(store, kind);
  const merged = [...new Set(have.concat(ids))];
  if (merged.length === have.length) return merged;
  await store.setJSON(key(kind), merged);
  return merged;
}

export async function removeFromIndex(store, kind, id) {
  const have = await readIndex(store, kind);
  if (!have.includes(id)) return have;
  const left = have.filter(x => x !== id);
  await store.setJSON(key(kind), left);
  return left;
}

/* Every blob key for a kind, from both sources. Callers get keys
   rather than ids because that is what they pass to store.get. */
export async function allKeys(store, kind) {
  const [listed, indexed] = await Promise.all([
    store.list({ prefix: kind + '/' }).catch(() => ({ blobs: [] })),
    readIndex(store, kind)
  ]);
  return [...new Set(
    (listed.blobs || []).map(b => b.key).concat(indexed.map(id => `${kind}/${id}`))
  )];
}

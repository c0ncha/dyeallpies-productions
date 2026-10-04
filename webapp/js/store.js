// Sets and their replays, kept in this browser (IndexedDB). Nothing leaves the device.
const open = () => new Promise((res, rej) => {
  const r = indexedDB.open("replog", 1);
  r.onupgradeneeded = () => { r.result.createObjectStore("sets", { keyPath: "id" }); r.result.createObjectStore("videos"); };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const run = async (stores, mode, fn) => {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction(stores, mode); let out;
    tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    out = fn(tx);
  });
};
const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export const saveSet = (set, blob) => run(["sets", "videos"], "readwrite", (tx) => {
  tx.objectStore("sets").put(set);
  if (blob) tx.objectStore("videos").put(blob, set.id);
});
export const allSets = async () => { const db = await open(); return (await req(db.transaction("sets").objectStore("sets").getAll())).sort((a, b) => a.id.localeCompare(b.id)); };
export const getVideo = async (id) => { const db = await open(); return req(db.transaction("videos").objectStore("videos").get(id)); };
export const deleteSet = (id) => run(["sets", "videos"], "readwrite", (tx) => { tx.objectStore("sets").delete(id); tx.objectStore("videos").delete(id); });

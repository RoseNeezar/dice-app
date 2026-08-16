/**
 * A minimal promise wrapper over IndexedDB.
 *
 * Deliberately dependency free: the schema is small, and owning the upgrade
 * path makes future migrations explicit rather than magic.
 */

export const DB_NAME = 'openscan';
export const DB_VERSION = 1;

export const STORE = {
  docs: 'docs',
  pages: 'pages',
  folders: 'folders',
  blobs: 'blobs',
  kv: 'kv',
} as const;

export type StoreName = (typeof STORE)[keyof typeof STORE];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB is not available in this browser'));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE.docs)) {
        const docs = db.createObjectStore(STORE.docs, { keyPath: 'id' });
        docs.createIndex('folderId', 'folderId');
        docs.createIndex('updatedAt', 'updatedAt');
        docs.createIndex('deletedAt', 'deletedAt');
      }
      if (!db.objectStoreNames.contains(STORE.pages)) {
        const pages = db.createObjectStore(STORE.pages, { keyPath: 'id' });
        pages.createIndex('docId', 'docId');
      }
      if (!db.objectStoreNames.contains(STORE.folders)) {
        const folders = db.createObjectStore(STORE.folders, { keyPath: 'id' });
        folders.createIndex('parentId', 'parentId');
      }
      if (!db.objectStoreNames.contains(STORE.blobs)) {
        db.createObjectStore(STORE.blobs, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE.kv)) {
        db.createObjectStore(STORE.kv);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open the database'));
    request.onblocked = () => reject(new Error('The database is blocked by another tab'));
  });
  return dbPromise;
}

/** Test seam: drop the cached connection. */
export function resetDbConnection(): void {
  dbPromise = null;
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

async function withStore<T>(
  names: StoreName | StoreName[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(names, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('Transaction aborted'));
  });
  const result = await fn(tx);
  await done;
  return result;
}

export async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  return withStore(store, 'readonly', (tx) => promisify<T | undefined>(tx.objectStore(store).get(key)));
}

export async function getAll<T>(store: StoreName): Promise<T[]> {
  return withStore(store, 'readonly', (tx) => promisify<T[]>(tx.objectStore(store).getAll()));
}

export async function getAllByIndex<T>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
  return withStore(store, 'readonly', (tx) =>
    promisify<T[]>(tx.objectStore(store).index(index).getAll(value)),
  );
}

export async function put<T>(store: StoreName, value: T, key?: IDBValidKey): Promise<void> {
  await withStore(store, 'readwrite', (tx) => promisify(tx.objectStore(store).put(value, key)));
}

export async function putMany<T>(store: StoreName, values: T[]): Promise<void> {
  if (values.length === 0) return;
  await withStore(store, 'readwrite', (tx) => {
    const os = tx.objectStore(store);
    for (const value of values) os.put(value);
    return Promise.resolve();
  });
}

export async function del(store: StoreName, key: IDBValidKey): Promise<void> {
  await withStore(store, 'readwrite', (tx) => promisify(tx.objectStore(store).delete(key)));
}

export async function delMany(store: StoreName, keys: IDBValidKey[]): Promise<void> {
  if (keys.length === 0) return;
  await withStore(store, 'readwrite', (tx) => {
    const os = tx.objectStore(store);
    for (const key of keys) os.delete(key);
    return Promise.resolve();
  });
}

export async function clearStore(store: StoreName): Promise<void> {
  await withStore(store, 'readwrite', (tx) => promisify(tx.objectStore(store).clear()));
}

export async function count(store: StoreName): Promise<number> {
  return withStore(store, 'readonly', (tx) => promisify<number>(tx.objectStore(store).count()));
}

/** Write several stores in one atomic transaction. */
export async function transact<T>(
  names: StoreName[],
  fn: (stores: Record<string, IDBObjectStore>) => Promise<T> | T,
): Promise<T> {
  return withStore(names, 'readwrite', (tx) => {
    const stores: Record<string, IDBObjectStore> = {};
    for (const name of names) stores[name] = tx.objectStore(name);
    return fn(stores);
  });
}

export function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return promisify(request);
}

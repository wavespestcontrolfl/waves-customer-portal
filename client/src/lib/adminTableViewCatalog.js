import {
  ADMIN_TABLE_VIEW_STORAGE_ERROR,
  ADMIN_TABLE_VIEW_VERSION,
  normalizeAdminTableViewCatalog,
  readAdminTableViewCatalog,
} from "./adminTableViewStorage";

const DB_NAME = "waves-admin-table-views";
const DB_VERSION = 1;
const STORE_NAME = "catalogs";

function indexedDbFactory() {
  try {
    return typeof indexedDB === "undefined" ? null : indexedDB;
  } catch {
    return null;
  }
}

function openCatalogDatabase() {
  return new Promise((resolve) => {
    const factory = indexedDbFactory();
    if (!factory) {
      resolve(null);
      return;
    }

    let request;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (database) => {
      if (settled) {
        try { database?.close(); } catch { /* ignore */ }
        return;
      }
      settled = true;
      resolve(database);
    };

    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      if (settled) {
        try { request.result.close(); } catch { /* ignore */ }
        return;
      }
      request.result.onversionchange = () => request.result.close();
      finish(request.result);
    };
    request.onerror = () => finish(null);
    request.onblocked = () => finish(null);
  });
}

function failure(views = []) {
  return { views, error: ADMIN_TABLE_VIEW_STORAGE_ERROR };
}

function legacyCatalog(options) {
  if (options.storage === null) return null;
  if (options.storage === undefined) {
    return normalizeAdminTableViewCatalog(null, options.defaults, options.normalize);
  }
  const legacy = readAdminTableViewCatalog(
    options.storage,
    options.storageKey,
    options.defaults,
    options.normalize,
  );
  return legacy.error ? null : {
    version: ADMIN_TABLE_VIEW_VERSION,
    views: legacy.views,
  };
}

function runCatalogTransaction(options = {}, mutation) {
  if (!options || typeof options !== "object") return Promise.resolve(failure());
  const { storageKey, defaults, normalize } = options;
  if (typeof storageKey !== "string" || !storageKey || typeof normalize !== "function") {
    return Promise.resolve(failure());
  }

  return openCatalogDatabase().then((database) => {
    if (!database) return failure();

    return new Promise((resolve) => {
      let settled = false;
      let currentViews = [];
      let outcome = failure();
      const finish = (result) => {
        if (settled) return;
        settled = true;
        try { database.close(); } catch { /* ignore */ }
        resolve(result);
      };

      try {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.oncomplete = () => finish(outcome);
        transaction.onerror = () => finish(failure(currentViews));
        transaction.onabort = () => finish(failure(currentViews));

        const read = transaction.objectStore(STORE_NAME).get(storageKey);
        read.onerror = () => { outcome = failure(currentViews); };
        read.onsuccess = () => {
          try {
            const catalog = read.result === undefined
              ? legacyCatalog(options)
              : normalizeAdminTableViewCatalog(read.result, defaults, normalize);
            if (!catalog) {
              outcome = failure();
              transaction.abort();
              return;
            }

            currentViews = catalog.views;
            const result = mutation ? mutation(currentViews) : { views: currentViews };
            if (!result || typeof result !== "object" || typeof result.then === "function") {
              outcome = failure(currentViews);
              transaction.abort();
              return;
            }
            if (result.cancelled === true) {
              outcome = { views: currentViews, error: null, cancelled: true };
              return;
            }
            if (Object.prototype.hasOwnProperty.call(result, "error")) {
              outcome = { views: currentViews, error: result.error || ADMIN_TABLE_VIEW_STORAGE_ERROR };
              return;
            }
            if (!Array.isArray(result.views)) {
              outcome = failure(currentViews);
              transaction.abort();
              return;
            }

            const next = normalizeAdminTableViewCatalog(
              { version: ADMIN_TABLE_VIEW_VERSION, views: result.views },
              defaults,
              normalize,
            );
            outcome = { views: next.views, error: null };
            const write = transaction.objectStore(STORE_NAME).put(next, storageKey);
            write.onerror = () => { outcome = failure(currentViews); };
          } catch {
            outcome = failure(currentViews);
            try { transaction.abort(); } catch { /* transaction already settled */ }
          }
        };
      } catch {
        finish(failure(currentViews));
      }
    });
  }, () => failure());
}

export function readSavedViewCatalog(options) {
  return runCatalogTransaction(options, null);
}

export function mutateSavedViewCatalog(options, mutation) {
  if (typeof mutation !== "function") return Promise.resolve(failure());
  return runCatalogTransaction(options, mutation);
}

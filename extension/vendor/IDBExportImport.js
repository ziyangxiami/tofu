'use strict';

/**
 * Export all data from an IndexedDB database
 * @param {IDBDatabase} idbDatabase - to export from
 * @param {function(Object?, string?)} cb - callback with signature (error, jsonString)
 */
export function exportToJsonString(idbDatabase, cb) {
  const exportObject = {};
  const objectStoreNamesSet = new Set(idbDatabase.objectStoreNames);
  const size = objectStoreNamesSet.size;
  if (size === 0) {
    cb(null, JSON.stringify(exportObject));
  } else {
    const objectStoreNames = Array.from(objectStoreNamesSet);
    const transaction = idbDatabase.transaction(
        objectStoreNames,
        'readonly'
    );
    transaction.onerror = (event) => cb(event, null);

    objectStoreNames.forEach((storeName) => {
      const allObjects = [];
      transaction.objectStore(storeName).openCursor().onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          allObjects.push(cursor.value);
          cursor.continue();
        } else {
          exportObject[storeName] = allObjects;
          if (
            objectStoreNames.length ===
            Object.keys(exportObject).length
          ) {
            cb(null, JSON.stringify(exportObject));
          }
        }
      };
    });
  }
}

/**
 * Import data from JSON into an IndexedDB database. This does not delete any existing data
 *  from the database, so keys could clash.
 *
 * Only object stores that already exist will be imported.
 *
 * @param {IDBDatabase} idbDatabase - to import into
 * @param {string} jsonString - data to import, one key per object store
 * @param {function(Object)} cb - callback with signature (error), where error is null on success
 * @return {void}
 */
export function importFromJsonString(idbDatabase, jsonString, cb) {
  let transaction;
  let finished = false;
  const finish = (error) => {
    if (finished) return;
    finished = true;
    cb(error);
  };
  try {
    const importObject = JSON.parse(jsonString);
    if (!importObject || typeof importObject !== 'object' || Array.isArray(importObject)) {
      throw new TypeError('Invalid database backup');
    }
    // Older backups may omit stores introduced by later schema versions.
    const objectStoreNames = Array.from(idbDatabase.objectStoreNames)
        .filter(storeName => Object.prototype.hasOwnProperty.call(importObject, storeName));
    for (const storeName of objectStoreNames) {
      if (!Array.isArray(importObject[storeName])) {
        throw new TypeError('Invalid backup table: ' + storeName);
      }
    }
    if (!objectStoreNames.length) {
      finish(null);
      return;
    }
    transaction = idbDatabase.transaction(objectStoreNames, 'readwrite');
    // Request success only means the write was queued; the transaction can
    // still abort (including after its final request has succeeded).
    transaction.oncomplete = () => finish(null);
    transaction.onerror = event => finish(transaction.error || event.target.error || event);
    transaction.onabort = event => finish(transaction.error || event.target.error || new Error('Database import aborted'));
    for (const storeName of objectStoreNames) {
      for (const row of importObject[storeName]) {
        transaction.objectStore(storeName).add(row);
      }
    }
  } catch (error) {
    if (transaction) {
      try { transaction.abort(); } catch (_) {}
    }
    finish(error);
  }
}

/**
 * Clears a database of all data.
 *
 * The object stores will still exist but will be empty.
 *
 * @param {IDBDatabase} idbDatabase - to delete all data from
 * @param {function(Object)} cb - callback with signature (error), where error is null on success
 * @return {void}
 */
export function clearDatabase(idbDatabase, cb) {
  const objectStoreNamesSet = new Set(idbDatabase.objectStoreNames);
  const size = objectStoreNamesSet.size;
  if (size === 0) {
    cb(null);
  } else {
    const objectStoreNames = Array.from(objectStoreNamesSet);
    const transaction = idbDatabase.transaction(
        objectStoreNames,
        'readwrite'
    );
    transaction.onerror = (event) => cb(event);

    let count = 0;
    objectStoreNames.forEach(function(storeName) {
      transaction.objectStore(storeName).clear().onsuccess = () => {
        count++;
        if (count === size) {
          // cleared all object stores
          cb(null);
        }
      };
    });
  }
}

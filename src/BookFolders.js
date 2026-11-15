/**
 * Top-level lorebook folders.
 *
 * Stored on the extension settings object (`extension_settings.lorebookManager.bookFolders`),
 * never inside a lorebook file. Books are keyed by lorebook name so a rename or delete
 * done outside the extension simply stops matching: the old key is dropped and the new
 * book shows up unfiled.
 *
 * {
 *   version: 1,
 *   folders: [{ id: string, name: string, order: number, collapsed: boolean }],
 *   books: { [lorebookName]: { folderId: string|null, order: number } }
 * }
 *
 * `folderId: null` and a missing book key both mean the lorebook is unfiled.
 */

const RESERVED_FOLDER_NAMES = new Set(['unfiled']);

const emptyBooks = ()=>Object.create(null);

export function createBookFolderId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `book-folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const uniqueNames = (worldNames)=>{
    const seen = new Set();
    const names = [];
    for (const name of worldNames ?? []) {
        if (typeof name != 'string' || name.length == 0 || seen.has(name)) continue;
        seen.add(name);
        names.push(name);
    }
    return names;
};

const normalizeFolder = (folder, index)=>{
    if (!folder || typeof folder != 'object' || Array.isArray(folder)) return null;
    const id = typeof folder.id == 'string' ? folder.id.trim() : '';
    const name = typeof folder.name == 'string' ? folder.name.trim() : '';
    if (!id || !name) return null;
    if (RESERVED_FOLDER_NAMES.has(name.toLocaleLowerCase())) return null;
    return {
        id,
        name,
        order: Number.isFinite(folder.order) ? folder.order : index,
        collapsed: folder.collapsed === true,
    };
};

/**
 * @param {any} raw
 * @returns {{version:number, folders:{id:string, name:string, order:number, collapsed:boolean}[], books:Record<string, {folderId:string|null, order:number}>}}
 */
export function normalizeBookFolderState(raw) {
    const source = raw && typeof raw == 'object' ? raw : {};
    const folders = [];
    const seenIds = new Set();
    const seenNames = new Set();
    const rawFolders = Array.isArray(source.folders) ? source.folders : [];
    rawFolders
        .map((folder, index)=>normalizeFolder(folder, index))
        .filter(Boolean)
        .sort((a, b)=>a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .forEach(folder=>{
            const nameKey = folder.name.toLocaleLowerCase();
            if (seenIds.has(folder.id) || seenNames.has(nameKey)) return;
            seenIds.add(folder.id);
            seenNames.add(nameKey);
            folders.push(folder);
        })
    ;
    folders.forEach((folder, order)=>{
        folder.order = order;
    });
    const folderIds = new Set(folders.map(folder=>folder.id));
    const books = emptyBooks();
    const rawBooks = source.books && typeof source.books == 'object' && !Array.isArray(source.books) ? source.books : {};
    for (const name of Object.keys(rawBooks)) {
        if (typeof name != 'string' || name.length == 0) continue;
        const placement = rawBooks[name];
        if (!placement || typeof placement != 'object' || Array.isArray(placement)) continue;
        const folderId = typeof placement.folderId == 'string' && folderIds.has(placement.folderId) ? placement.folderId : null;
        const order = Number.isFinite(placement.order) ? placement.order : Number.MAX_SAFE_INTEGER;
        books[name] = { folderId, order };
    }
    return {
        version: 1,
        folders,
        books,
    };
}

/**
 * Plain JSON-ready copy. Book keys are sorted so the saved object stays stable.
 * @param {ReturnType<typeof normalizeBookFolderState>} state
 */
export function serializeBookFolderState(state) {
    const normalized = normalizeBookFolderState(state);
    const books = {};
    for (const name of Object.keys(normalized.books).sort((a, b)=>a.localeCompare(b))) {
        Object.defineProperty(books, name, {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {
                folderId: normalized.books[name].folderId,
                order: normalized.books[name].order,
            },
        });
    }
    return {
        version: 1,
        folders: normalized.folders.map(folder=>({
            id: folder.id,
            name: folder.name,
            order: folder.order,
            collapsed: folder.collapsed === true,
        })),
        books,
    };
}

export function getSortedBookFolders(state) {
    return state.folders
        .slice()
        .sort((a, b)=>a.order - b.order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    ;
}

/**
 * @param {ReturnType<typeof normalizeBookFolderState>} state
 * @param {string} bookName
 * @returns {string|null}
 */
export function getBookFolderId(state, bookName) {
    const placement = state?.books?.[bookName];
    if (!placement || typeof placement.folderId != 'string' || !placement.folderId) return null;
    if (!state.folders.some(folder=>folder.id == placement.folderId)) return null;
    return placement.folderId;
}

const bookOrder = (state, name)=>{
    const placement = state.books[name];
    if (!placement || !Number.isFinite(placement.order)) return Number.MAX_SAFE_INTEGER;
    return placement.order;
};

const compareBookNames = (state, a, b)=>{
    const order = bookOrder(state, a) - bookOrder(state, b);
    if (order) return order;
    return a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase());
};

export function getFolderBooks(state, worldNames, folderId) {
    return uniqueNames(worldNames)
        .filter(name=>getBookFolderId(state, name) == folderId)
        .sort((a, b)=>compareBookNames(state, a, b))
    ;
}

export function getUnfiledBooks(state, worldNames) {
    return getFolderBooks(state, worldNames, null);
}

/**
 * Drop lorebooks that no longer exist. A book whose folder was removed becomes unfiled.
 * Books that are not in the map stay unfiled, which is how newly created lorebooks appear.
 * @returns {boolean} whether the stored map changed
 */
export function reconcileBookFolders(state, worldNames) {
    const names = new Set(uniqueNames(worldNames));
    let changed = false;
    for (const name of Object.keys(state.books)) {
        if (names.has(name)) continue;
        delete state.books[name];
        changed = true;
    }
    const folderIds = new Set(state.folders.map(folder=>folder.id));
    for (const name of Object.keys(state.books)) {
        const placement = state.books[name];
        if (placement.folderId && !folderIds.has(placement.folderId)) {
            placement.folderId = null;
            changed = true;
        }
    }
    return changed;
}

/**
 * @returns {{ok:true, name:string}|{ok:false, reason:'empty'|'reserved'|'duplicate'}}
 */
export function validateBookFolderName(state, name, ignoreId = null) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return { ok:false, reason:'empty' };
    if (RESERVED_FOLDER_NAMES.has(trimmed.toLocaleLowerCase())) return { ok:false, reason:'reserved' };
    const duplicate = state.folders.some(folder=>folder.id != ignoreId && folder.name.toLocaleLowerCase() == trimmed.toLocaleLowerCase());
    if (duplicate) return { ok:false, reason:'duplicate' };
    return { ok:true, name:trimmed };
}

export function createBookFolder(state, name, id = createBookFolderId()) {
    const valid = validateBookFolderName(state, name);
    if (!valid.ok) return valid;
    if (state.folders.some(folder=>folder.id == id)) return { ok:false, reason:'duplicate' };
    const folder = {
        id,
        name: valid.name,
        order: state.folders.length,
        collapsed: false,
    };
    state.folders.push(folder);
    return { ok:true, folder };
}

export function renameBookFolder(state, folderId, name) {
    const folder = state.folders.find(item=>item.id == folderId);
    if (!folder) return { ok:false, reason:'missing' };
    const valid = validateBookFolderName(state, name, folderId);
    if (!valid.ok) return valid;
    folder.name = valid.name;
    return { ok:true, folder };
}

export function setBookFolderCollapsed(state, folderId, collapsed) {
    const folder = state.folders.find(item=>item.id == folderId);
    if (!folder) return false;
    folder.collapsed = collapsed === true;
    return true;
}

export function moveBookFolder(state, folderId, direction) {
    const folders = getSortedBookFolders(state);
    const index = folders.findIndex(folder=>folder.id == folderId);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= folders.length) return false;
    const [folder] = folders.splice(index, 1);
    folders.splice(targetIndex, 0, folder);
    folders.forEach((item, order)=>{
        item.order = order;
    });
    state.folders = folders;
    return true;
}

const reindexBooks = (state, names, folderId)=>{
    names.forEach((name, order)=>{
        state.books[name] = { folderId, order };
    });
};

/**
 * Delete a folder without deleting its lorebooks. They are appended to the unfiled list.
 * @returns {boolean}
 */
export function deleteBookFolder(state, worldNames, folderId) {
    const names = uniqueNames(worldNames);
    reconcileBookFolders(state, names);
    const folder = state.folders.find(item=>item.id == folderId);
    if (!folder) return false;
    const released = getFolderBooks(state, names, folderId);
    const unfiled = getUnfiledBooks(state, names);
    state.folders = state.folders.filter(item=>item.id != folderId);
    getSortedBookFolders(state).forEach((item, order)=>{
        item.order = order;
    });
    for (const name of Object.keys(state.books)) {
        if (state.books[name].folderId == folderId) state.books[name].folderId = null;
    }
    reindexBooks(state, [...unfiled, ...released], null);
    return true;
}

/**
 * Move a lorebook into a folder (or unfiled when folderId is null).
 * `beforeBookName` inserts before that book in the destination; null appends.
 * @returns {boolean}
 */
export function moveBook(state, worldNames, bookName, targetFolderId, beforeBookName = null) {
    return moveBooks(state, worldNames, [bookName], targetFolderId, beforeBookName);
}

/**
 * Move lorebooks together, keeping `bookNames` order. `beforeBookName` inserts
 * the group before that book in the destination; null appends. A before-book
 * that is part of the group is ignored so the drop stays on a stationary book.
 * @returns {boolean}
 */
export function moveBooks(state, worldNames, bookNames, targetFolderId, beforeBookName = null) {
    const names = uniqueNames(worldNames);
    const moving = [];
    const movingSet = new Set();
    for (const bookName of bookNames ?? []) {
        if (!names.includes(bookName) || movingSet.has(bookName)) continue;
        moving.push(bookName);
        movingSet.add(bookName);
    }
    if (!moving.length) return false;
    if (targetFolderId !== null && !state.folders.some(folder=>folder.id == targetFolderId)) return false;
    reconcileBookFolders(state, names);
    const sourceFolders = new Set(moving.map(bookName=>getBookFolderId(state, bookName)));
    let anchor = beforeBookName;
    if (typeof anchor == 'string' && movingSet.has(anchor)) anchor = null;
    const destinationNames = getFolderBooks(state, names, targetFolderId).filter(bookName=>!movingSet.has(bookName));
    let index = destinationNames.length;
    if (typeof anchor == 'string') {
        const beforeIndex = destinationNames.indexOf(anchor);
        if (beforeIndex >= 0) index = beforeIndex;
    }
    destinationNames.splice(index, 0, ...moving);
    reindexBooks(state, destinationNames, targetFolderId);
    for (const sourceFolderId of sourceFolders) {
        if (sourceFolderId === targetFolderId) continue;
        reindexBooks(state, getFolderBooks(state, names, sourceFolderId), sourceFolderId);
    }
    return true;
}

/**
 * Resolve a drag gesture to a move. Dropping a lorebook on itself is ignored.
 * `targetFolderId` null is the unfiled list. `targetBookName` null appends to the folder.
 * @returns {{bookName:string, folderId:string|null, beforeBookName:string|null}|null}
 */
export function resolveBookDrop(state, worldNames, bookName, targetFolderId, targetBookName = null, placeBefore = true) {
    const names = uniqueNames(worldNames);
    if (!names.includes(bookName)) return null;
    if (targetFolderId !== null && !state.folders.some(folder=>folder.id == targetFolderId)) return null;
    if (targetBookName == bookName) return null;
    let beforeBookName = null;
    if (typeof targetBookName == 'string' && names.includes(targetBookName)) {
        const group = getFolderBooks(state, names, targetFolderId).filter(name=>name != bookName);
        if (placeBefore) {
            beforeBookName = group.includes(targetBookName) ? targetBookName : null;
        } else {
            const index = group.indexOf(targetBookName);
            beforeBookName = index >= 0 ? (group[index + 1] ?? null) : null;
        }
    }
    return { bookName, folderId:targetFolderId, beforeBookName };
}

import { event_types, eventSource, getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { AutoComplete } from '../../../autocomplete/AutoComplete.js';
import { extensionNames, extension_settings } from '../../../extensions.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { renderTemplateAsync } from '../../../templates.js';
import { debounce, debounceAsync, delay, download, getSortableDelay, isTrueBoolean, uuidv4 } from '../../../utils.js';
import { createNewWorldInfo, createWorldInfoEntry, deleteWIOriginalDataValue, deleteWorldInfoEntry, getFreeWorldName, getWorldEntry, loadWorldInfo, onWorldInfoChange, saveWorldInfo, selected_world_info, setWIOriginalDataValue, world_info, world_names } from '../../../world-info.js';
import * as worldInfoModule from '../../../world-info.js';
import { Settings, SORT, SORT_DIRECTION } from './src/Settings.js';
import { createBookFolder, deleteBookFolder, getBookFolderId, getFolderBooks, getSortedBookFolders, getUnfiledBooks, moveBook, moveBookFolder, moveBooks, reconcileBookFolders, renameBookFolder, setBookFolderCollapsed } from './src/BookFolders.js';

const NAME = new URL(import.meta.url).pathname.split('/').at(-2);
const DISPLAY_NAME = 'Lorebook Manager';
const FOLDER_MODULE_NAME = 'lorebookFolders';
const FOLDER_EXTENSION_KEY = 'lorebook_folder';
const UNCATEGORIZED_KEY = '__uncategorized__';
const watchCss = async()=>{
    if (new URL(import.meta.url).pathname.split('/').includes('reload')) return;
    try {
        const FilesPluginApi = (await import('../SillyTavern-FilesPluginApi/api.js')).FilesPluginApi;
        // watch CSS for changes
        const style = document.createElement('style');
        document.body.append(style);
        const path = [
            '~',
            'extensions',
            NAME,
            'style.css',
        ].join('/');
        const ev = await FilesPluginApi.watch(path);
        ev.addEventListener('message', async(/**@type {boolean}*/exists)=>{
            if (!exists) return;
            style.innerHTML = await (await FilesPluginApi.get(path)).text();
            document.querySelector(`#third-party_${NAME}-css`)?.remove();
        });
    } catch { /* empty */ }
};
watchCss();


const dom = {
    drawer: {
        /**@type {HTMLElement} */
        body: undefined,
    },
    /**@type {HTMLElement} */
    books: undefined,
    /**@type {HTMLElement} */
    editor: undefined,
    /**@type {HTMLElement} */
    activationToggle: undefined,
    order: {
        /**@type {HTMLElement} */
        toggle: undefined,
        /**@type {HTMLInputElement} */
        start: undefined,
        /**@type {HTMLInputElement} */
        step: undefined,
        direction: {
            /**@type {HTMLInputElement} */
            up: undefined,
            /**@type {HTMLInputElement} */
            down: undefined,
        },
        filter: {
            /**@type {HTMLElement} */
            root: undefined,
            /**@type {HTMLElement} */
            preview: undefined,
        },
        /**@type {{[book:string]:{[uid:string]:HTMLElement}}} */
        entries: {},
        /**@type {HTMLElement} */
        tbody: undefined,
    },
};
/**@type {{name:string, uid:string}} */
let currentEditor;
let editorRenderToken = null;
let worldInfoPresetPlaceholder;
const localBookRevisions = Object.create(null);
const localSaveRevision = Symbol('stwid.localSaveRevision');

const activationBlock = document.querySelector('#wiActivationSettings');
const activationBlockParent = activationBlock.parentElement;

const entryState = function(entry) {
    if (entry.constant === true) {
        return 'constant';
    } else if (entry.vectorized === true) {
        return 'vectorized';
    } else {
        return 'normal';
    }
};
const markLocalBookRevision = (name)=>{
    if (!name) return 0;
    localBookRevisions[name] = (localBookRevisions[name] ?? 0) + 1;
    return localBookRevisions[name];
};
const getLocalBookRevision = (name)=>localBookRevisions[name] ?? 0;
/**
 * The one book object the manager edits for a loaded book. SillyTavern's entry editor,
 * the sidebar toggles and the Order Helper all write into this same object, so a save
 * from any of them carries the others' changes.
 * @param {string} name
 */
const getLiveBook = (name)=>cache[name]?.loaded ? cache[name].data : null;
const isLiveBook = (name, data)=>{
    const live = getLiveBook(name);
    return !!(live && data && (data === live || data.entries === live.entries));
};
/** Book whose entry editor typed changes that SillyTavern has not written yet (its save waits ~1s). */
let pendingEditorSave = null;
/**
 * SillyTavern keeps a single debounced save timer for every book, and any immediate save
 * cancels it. Write the editor's book now, before something else can drop its pending save.
 * @param {string|null} exceptName Skip the flush when the pending save is for this book.
 */
const flushEditorSave = async(exceptName = null)=>{
    const name = pendingEditorSave;
    if (!name || name === exceptName) return;
    pendingEditorSave = null;
    const live = getLiveBook(name);
    if (!live || !world_names.includes(name)) return;
    await saveWorldInfo(name, live, true);
};
const saveManagedWorldInfo = async(name, data, immediately = true)=>{
    await flushEditorSave(name);
    const revision = markLocalBookRevision(name);
    if (isLiveBook(name, data)) {
        // Saving the live object also covers any pending editor save for this book.
        if (pendingEditorSave === name) pendingEditorSave = null;
    } else if (data && typeof data == 'object') {
        Object.defineProperty(data, localSaveRevision, {
            value: revision,
            configurable: true,
        });
    }
    await saveWorldInfo(name, data, immediately);
};
const normalizeFolderName = (name)=>String(name ?? '').trim();
const getFolderSettings = ()=>{
    if (!extension_settings[FOLDER_MODULE_NAME] || typeof extension_settings[FOLDER_MODULE_NAME] != 'object') {
        extension_settings[FOLDER_MODULE_NAME] = {};
    }
    const settings = extension_settings[FOLDER_MODULE_NAME];
    if (typeof settings.enabled != 'boolean') settings.enabled = true;
    if (!settings.worlds || typeof settings.worlds != 'object') settings.worlds = {};
    return settings;
};
const dedupeFolders = (state)=>{
    const seen = new Set();
    state.folders = state.folders
        .sort((a,b)=>a.order - b.order || a.name.localeCompare(b.name))
        .filter(folder=>{
            const key = folder.name.toLocaleLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .map((folder, index)=>({ ...folder, order:index }))
    ;
};
const getWorldFolderState = (worldName)=>{
    const settings = getFolderSettings();
    if (!worldName) return { folders:[], collapsed:{}, entries:{} };
    if (!settings.worlds[worldName] || typeof settings.worlds[worldName] != 'object') {
        settings.worlds[worldName] = { version:1, folders:[], collapsed:{}, entries:{} };
    }
    const state = settings.worlds[worldName];
    state.version = 1;
    state.folders = Array.isArray(state.folders)
        ? state.folders
            .filter(folder=>folder && typeof folder.name == 'string')
            .map((folder, index)=>({
                name: normalizeFolderName(folder.name),
                order: Number.isFinite(folder.order) ? folder.order : index,
            }))
            .filter(folder=>folder.name)
        : []
    ;
    state.collapsed = state.collapsed && typeof state.collapsed == 'object' ? state.collapsed : {};
    state.entries = state.entries && typeof state.entries == 'object' && !Array.isArray(state.entries)
        ? Object.fromEntries(Object.entries(state.entries).map(([uid, folderName])=>[uid, normalizeFolderName(folderName)]))
        : {}
    ;
    dedupeFolders(state);
    return state;
};
const getStoredEntryFolder = (worldName, uid)=>{
    if (!worldName || uid === undefined || uid === null) return null;
    const state = getWorldFolderState(worldName);
    const key = String(uid);
    if (!Object.hasOwn(state.entries, key)) return null;
    return normalizeFolderName(state.entries[key]);
};
const setStoredEntryFolder = (worldName, uid, folderName)=>{
    if (!worldName || uid === undefined || uid === null) return;
    const state = getWorldFolderState(worldName);
    state.entries[String(uid)] = normalizeFolderName(folderName);
    saveSettingsDebounced();
};
const getEntryFolder = (entry, worldName = null)=>{
    const storedFolder = getStoredEntryFolder(worldName, entry?.uid);
    if (storedFolder !== null) return storedFolder;
    return normalizeFolderName(entry?.extensions?.[FOLDER_EXTENSION_KEY]);
};
const deleteWIOriginalDataPath = (data, uid, key)=>{
    const originalEntry = data?.originalData?.entries?.find(x=>x.uid === uid);
    if (!originalEntry) return;
    const parts = key.split('.');
    let current = originalEntry;
    for (let i = 0; i < parts.length - 1; i++) {
        current = current?.[parts[i]];
        if (!current || typeof current != 'object') return;
    }
    delete current[parts.at(-1)];
};
const migrateEntryFolders = (worldName, data)=>{
    if (!worldName || !data?.entries) return;
    const state = getWorldFolderState(worldName);
    let changed = false;
    for (const entry of Object.values(data.entries)) {
        if (entry?.uid === undefined || entry?.uid === null) continue;
        const key = String(entry.uid);
        if (Object.hasOwn(state.entries, key)) continue;
        const folderName = normalizeFolderName(entry?.extensions?.[FOLDER_EXTENSION_KEY]);
        if (!folderName) continue;
        state.entries[key] = folderName;
        changed = true;
    }
    if (changed) saveSettingsDebounced();
};
const ensureKnownFolder = (worldName, folderName)=>{
    folderName = normalizeFolderName(folderName);
    if (!worldName || !folderName) return false;
    const state = getWorldFolderState(worldName);
    const exists = state.folders.some(folder=>folder.name.toLocaleLowerCase() == folderName.toLocaleLowerCase());
    if (exists) return false;
    state.folders.push({ name:folderName, order:state.folders.length });
    saveSettingsDebounced();
    return true;
};
const getFolderNames = (worldName, data)=>{
    const state = getWorldFolderState(worldName);
    const names = new Map();
    for (const folder of state.folders) {
        names.set(folder.name.toLocaleLowerCase(), folder.name);
    }
    for (const entry of Object.values(data?.entries ?? {})) {
        const folderName = getEntryFolder(entry, worldName);
        if (folderName) names.set(folderName.toLocaleLowerCase(), folderName);
    }
    return [...names.values()].sort((a,b)=>{
        const aState = state.folders.find(folder=>folder.name.toLocaleLowerCase() == a.toLocaleLowerCase());
        const bState = state.folders.find(folder=>folder.name.toLocaleLowerCase() == b.toLocaleLowerCase());
        const aOrder = aState ? aState.order : Number.MAX_SAFE_INTEGER;
        const bOrder = bState ? bState.order : Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder || a.localeCompare(b);
    });
};
const setEntryFolder = (worldName, data, entry, folderName)=>{
    folderName = normalizeFolderName(folderName);
    setStoredEntryFolder(worldName, entry.uid, folderName);
    entry.extensions = entry.extensions && typeof entry.extensions == 'object' ? entry.extensions : {};
    if (folderName) {
        entry.extensions[FOLDER_EXTENSION_KEY] = folderName;
        setWIOriginalDataValue(data, entry.uid, `extensions.${FOLDER_EXTENSION_KEY}`, folderName);
    } else {
        delete entry.extensions[FOLDER_EXTENSION_KEY];
        deleteWIOriginalDataPath(data, entry.uid, `extensions.${FOLDER_EXTENSION_KEY}`);
    }
    if (Object.keys(entry.extensions).length == 0) {
        delete entry.extensions;
    }
};
const applyStoredFolderData = (worldName, data)=>{
    if (!worldName || !data?.entries) return false;
    let changed = false;
    for (const entry of Object.values(data.entries)) {
        if (entry?.uid === undefined || entry?.uid === null) continue;
        const storedFolder = getStoredEntryFolder(worldName, entry.uid);
        if (storedFolder === null) continue;
        const embeddedFolder = normalizeFolderName(entry?.extensions?.[FOLDER_EXTENSION_KEY]);
        if (storedFolder) {
            if (embeddedFolder == storedFolder) continue;
            entry.extensions = entry.extensions && typeof entry.extensions == 'object' ? entry.extensions : {};
            entry.extensions[FOLDER_EXTENSION_KEY] = storedFolder;
            setWIOriginalDataValue(data, entry.uid, `extensions.${FOLDER_EXTENSION_KEY}`, storedFolder);
            changed = true;
            continue;
        }
        if (!embeddedFolder) continue;
        delete entry.extensions[FOLDER_EXTENSION_KEY];
        if (Object.keys(entry.extensions).length == 0) delete entry.extensions;
        deleteWIOriginalDataPath(data, entry.uid, `extensions.${FOLDER_EXTENSION_KEY}`);
        changed = true;
    }
    return changed;
};
const getEmbeddedFolderStats = (data)=>{
    const folders = new Set();
    let assignmentCount = 0;
    for (const entry of Object.values(data?.entries ?? {})) {
        const folderName = normalizeFolderName(entry?.extensions?.[FOLDER_EXTENSION_KEY]);
        if (!folderName) continue;
        folders.add(folderName);
        assignmentCount++;
    }
    return { folderCount:folders.size, assignmentCount };
};
const removeEmbeddedFolderData = (data)=>{
    for (const entry of Object.values(data?.entries ?? {})) {
        if (!entry?.extensions || typeof entry.extensions != 'object') continue;
        delete entry.extensions[FOLDER_EXTENSION_KEY];
        if (Object.keys(entry.extensions).length == 0) delete entry.extensions;
    }
    if (Array.isArray(data?.originalData?.entries)) {
        for (const entry of data.originalData.entries) {
            if (!entry?.extensions || typeof entry.extensions != 'object') continue;
            delete entry.extensions[FOLDER_EXTENSION_KEY];
            if (Object.keys(entry.extensions).length == 0) delete entry.extensions;
        }
    }
};
const askFolderExportChoice = async(stats)=>{
    const result = await Popup.show.confirm(
        'Export Lorebook Folder data?',
        `
            <div>This lorebook has ${stats.folderCount} folder${stats.folderCount == 1 ? '' : 's'} and ${stats.assignmentCount} categorized entr${stats.assignmentCount == 1 ? 'y' : 'ies'}.</div>
            <br>
            <div>Keeping it lets other Lorebook Manager/Lorebook Folders users restore folders. Exporting without it keeps the normal SillyTavern lorebook entries, but removes the folder metadata for people who do not use these extensions.</div>
        `,
        {
            okButton:'Export without folders',
            cancelButton:'Keep folder data',
        },
    );
    if (result === POPUP_RESULT.CANCELLED) return null;
    return result === POPUP_RESULT.AFFIRMATIVE ? 'strip' : 'keep';
};
const exportBookWithFolderChoice = async(worldName)=>{
    await ensureBookLoaded(worldName);
    const exportData = structuredClone({ entries:cache[worldName].entries });
    applyStoredFolderData(worldName, exportData);
    const stats = getEmbeddedFolderStats(exportData);
    if (stats.assignmentCount > 0) {
        const choice = await askFolderExportChoice(stats);
        if (choice === null) return;
        if (choice == 'strip') {
            removeEmbeddedFolderData(exportData);
        }
    }
    download(JSON.stringify(exportData), `${worldName}.json`, 'application/json');
};
const closeStwidBlockers = ()=>{
    document.querySelectorAll('.stwid--blocker').forEach(blocker=>blocker.remove());
    document.querySelectorAll('.stwid--menuTrigger, .stwid--folderAssign').forEach(anchor=>anchor.style.anchorName = '');
};
const promptForFolderName = async(title, defaultValue = '')=>{
    const value = await Popup.show.input(title, 'Folder name:', defaultValue, {
        okButton: 'Save',
        cancelButton: 'Cancel',
        placeholder: 'Folder name',
    });
    const folderName = normalizeFolderName(value);
    if (!folderName) return null;
    if (folderName == UNCATEGORIZED_KEY || folderName.toLocaleLowerCase() == 'uncategorized') {
        toastr.warning('That folder name is reserved.', DISPLAY_NAME);
        return null;
    }
    return folderName;
};
const createFolder = async(worldName)=>{
    const folderName = await promptForFolderName('New Lorebook Folder');
    if (!folderName) return;
    ensureKnownFolder(worldName, folderName);
    regroupBookEntries(worldName);
};
const renameFolder = async(worldName, oldName)=>{
    const newName = await promptForFolderName('Rename Lorebook Folder', oldName);
    if (!newName || newName == oldName) return;
    const state = getWorldFolderState(worldName);
    if (state.folders.some(folder=>folder.name.toLocaleLowerCase() == newName.toLocaleLowerCase())) {
        toastr.warning('A folder with that name already exists.', DISPLAY_NAME);
        return;
    }
    const data = await loadWorldInfo(worldName);
    if (!data?.entries) return;
    for (const entry of Object.values(data.entries)) {
        if (getEntryFolder(entry, worldName) != oldName) continue;
        setStoredEntryFolder(worldName, entry.uid, newName);
        entry.extensions = entry.extensions && typeof entry.extensions == 'object' ? entry.extensions : {};
        entry.extensions[FOLDER_EXTENSION_KEY] = newName;
        setWIOriginalDataValue(data, entry.uid, `extensions.${FOLDER_EXTENSION_KEY}`, newName);
    }
    const folder = state.folders.find(folder=>folder.name == oldName);
    if (folder) folder.name = newName;
    state.collapsed[newName] = state.collapsed[oldName];
    delete state.collapsed[oldName];
    dedupeFolders(state);
    saveSettingsDebounced();
    await saveManagedWorldInfo(worldName, data, true);
    await updateWIChange(worldName, data);
    regroupBookEntries(worldName);
};
const deleteFolder = async(worldName, folderName)=>{
    const result = await Popup.show.confirm(
        'Delete Lorebook Folder',
        `Remove folder "${folderName}" and move its entries to Uncategorized?`,
        { okButton:'Delete', cancelButton:'Cancel' },
    );
    if (result != POPUP_RESULT.AFFIRMATIVE) return;
    const data = await loadWorldInfo(worldName);
    if (!data?.entries) return;
    for (const entry of Object.values(data.entries)) {
        if (getEntryFolder(entry, worldName) != folderName) continue;
        setEntryFolder(worldName, data, entry, '');
    }
    const state = getWorldFolderState(worldName);
    state.folders = state.folders.filter(folder=>folder.name != folderName);
    delete state.collapsed[folderName];
    dedupeFolders(state);
    saveSettingsDebounced();
    await saveManagedWorldInfo(worldName, data, true);
    await updateWIChange(worldName, data);
    regroupBookEntries(worldName);
};
const moveFolder = (worldName, folderName, direction)=>{
    const state = getWorldFolderState(worldName);
    const index = state.folders.findIndex(folder=>folder.name == folderName);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= state.folders.length) return;
    const [folder] = state.folders.splice(index, 1);
    state.folders.splice(targetIndex, 0, folder);
    dedupeFolders(state);
    saveSettingsDebounced();
    regroupBookEntries(worldName);
};
const collapseBookFolders = (worldName, collapsed)=>{
    const state = getWorldFolderState(worldName);
    const folders = new Set([
        ...state.folders.map(folder=>folder.name),
        ...Object.values(cache[worldName]?.entries ?? {}).map(entry=>getEntryFolder(entry, worldName)).filter(Boolean),
        UNCATEGORIZED_KEY,
    ]);
    for (const folderName of folders) {
        state.collapsed[folderName] = collapsed;
    }
    saveSettingsDebounced();
    regroupBookEntries(worldName);
};
const sortEntries = (entries, sortLogic = null, sortDirection = null)=>{
    sortLogic ??= Settings.instance.sortLogic;
    sortDirection ??= Settings.instance.sortDirection;
    const x = (y)=>y.data ?? y;
    let result;
    switch (sortLogic) {
        case SORT.ALPHABETICAL: {
            result = entries.toSorted((a,b)=>(x(a).comment || x(a).key.join(', ')).toLowerCase().localeCompare((x(b).comment || x(b).key.join(', ')).toLowerCase()));
            break;
        }
        case SORT.PROMPT: {
            result = entries.toSorted((a,b)=>{
                if (x(a).position > x(b).position) return 1;
                if (x(a).position < x(b).position) return -1;
                if ((x(a).depth ?? Number.MAX_SAFE_INTEGER) < (x(b).depth ?? Number.MAX_SAFE_INTEGER)) return 1;
                if ((x(a).depth ?? Number.MAX_SAFE_INTEGER) > (x(b).depth ?? Number.MAX_SAFE_INTEGER)) return -1;
                if ((x(a).order ?? Number.MAX_SAFE_INTEGER) > (x(b).order ?? Number.MAX_SAFE_INTEGER)) return 1;
                if ((x(a).order ?? Number.MAX_SAFE_INTEGER) < (x(b).order ?? Number.MAX_SAFE_INTEGER)) return -1;
                return (x(a).comment ?? x(a).key.join(', ')).toLowerCase().localeCompare((x(b).comment ?? x(b).key.join(', ')).toLowerCase());
            });
            break;
        }
        default: {
            result = [...entries];
            break;
        }
    }
    if (sortDirection == SORT_DIRECTION.DESCENDING) result.reverse();
    return result;
};

const sortEntriesIfNeeded = (name)=>{
    if (!cache[name]?.loaded) return;
    regroupBookEntries(name);
};

const cache = {};
const setListLoading = (isLoading)=>{
    dom.drawer.body?.classList.toggle('stwid--isLoading', isLoading);
};
const withListLoading = async(promise)=>{
    setListLoading(true);
    try {
        return await promise;
    } finally {
        setListLoading(false);
    }
};
const getFolderDisplayName = (folderName)=>folderName == UNCATEGORIZED_KEY ? 'Uncategorized' : folderName;
const loadBookEntries = async(name, bookData = null)=>{
    const world = cache[name];
    if (!world) return null;
    if (world.loaded) return world;
    if (world.loading) return world.loading;

    world.loading = (async()=>{
        // loadWorldInfo already hands back a private copy; event data belongs to its sender.
        const data = bookData ? structuredClone(bookData) : await loadWorldInfo(name);
        if (!data?.entries) {
            world.loading = null;
            return world;
        }

        migrateEntryFolders(name, data);
        // Keep the whole book (originalData and any other top-level fields), not just entries,
        // so saves do not strip them from the file.
        world.data = data;
        world.entries = data.entries;
        world.shown = {};
        world.dom.entryList.innerHTML = '';
        world.dom.entry = {};
        let renderCounter = 0;
        for (const e of sortEntries(Object.values(world.entries))) {
            await renderEntry(e, name);
            renderCounter++;
            if (renderCounter % 50 == 0) {
                await delay(0);
            }
        }
        world.loaded = true;
        regroupBookEntries(name);
        world.loading = null;
        return world;
    })().catch(error=>{
        world.loading = null;
        throw error;
    });

    return world.loading;
};
const ensureBookLoaded = async(name)=>cache[name]?.loaded ? cache[name] : await withListLoading(loadBookEntries(name));
const ensureAllBooksLoaded = async()=>withListLoading((async()=>{
    for (const name of Object.keys(cache)) {
        await loadBookEntries(name);
    }
})());
const createStwidMenuItem = (iconClass, label, className = '')=>{
    const item = document.createElement('div');
    item.classList.add('stwid--item');
    if (className) item.classList.add(className);
    const i = document.createElement('i'); {
        i.classList.add('stwid--icon');
        i.classList.add('fa-solid', 'fa-fw', iconClass);
        item.append(i);
    }
    const txt = document.createElement('span'); {
        txt.classList.add('stwid--label');
        txt.textContent = label;
        item.append(txt);
    }
    return item;
};
const bindFolderDropTarget = (target, worldName, folderName)=>{
const setDropTarget = (isTarget)=>{
    if (target.classList.contains('stwid--folderDropTarget') == isTarget) return;
    target.classList.toggle('stwid--folderDropTarget', isTarget);
    const folderHeader = target.classList.contains('stwid--folderHeader') ? target : target.previousElementSibling;
    folderHeader?.classList.toggle('stwid--folderDropTarget', isTarget);
};
    target.addEventListener('dragover', (evt)=>{
        if (selectFrom === null || !selectList?.length) return;
        evt.preventDefault();
        evt.stopPropagation();
        setDropTarget(true);
    });
    target.addEventListener('dragleave', (evt)=>{
        if (selectFrom === null) return;
        if (target.contains(/**@type {Node}*/(evt.relatedTarget))) return;
        evt.stopPropagation();
        setDropTarget(false);
    });
    target.addEventListener('drop', async(evt)=>{
        if (selectFrom === null || !selectList?.length) return;
        evt.preventDefault();
        evt.stopPropagation();
        setDropTarget(false);
        await assignSelectedEntriesToFolder(worldName, folderName, evt.ctrlKey);
        selectEnd();
    });
};
const createFolderDropZone = (worldName, folderName)=>{
    const zone = document.createElement('div');
    zone.classList.add('stwid--folderDropZone');
    zone.dataset.folder = folderName;
    bindFolderDropTarget(zone, worldName, folderName);
    return zone;
};
const assignSelectedEntriesToFolder = async(worldName, folderName, isCopy = false)=>{
    if (selectFrom === null || !selectList?.length) return;
    const targetFolder = folderName == UNCATEGORIZED_KEY ? '' : folderName;
    if (selectFrom != worldName || isCopy) {
        const srcBook = await loadWorldInfo(selectFrom);
        const dstBook = await loadWorldInfo(worldName);
        for (const srcEntry of selectList) {
            const uid = srcEntry.uid;
            const oData = Object.assign({}, srcEntry);
            delete oData.uid;
            const dstEntry = createWorldInfoEntry(null, dstBook);
            Object.assign(dstEntry, oData);
            setEntryFolder(worldName, dstBook, dstEntry, targetFolder);
            if (!isCopy) {
                const deleted = await deleteWorldInfoEntry(srcBook, uid, { silent:true });
                if (deleted) {
                    deleteWIOriginalDataValue(srcBook, uid);
                    delete getWorldFolderState(selectFrom).entries[String(uid)];
                }
            }
        }
        await saveManagedWorldInfo(worldName, dstBook, true);
        if (selectFrom != worldName) {
            await saveManagedWorldInfo(selectFrom, srcBook, true);
            updateWIChange(selectFrom, srcBook);
        }
        updateWIChange(worldName, dstBook);
    } else {
        const data = await loadWorldInfo(worldName);
        for (const srcEntry of selectList) {
            const entry = data.entries?.[srcEntry.uid];
            if (!entry) continue;
            setEntryFolder(worldName, data, entry, targetFolder);
        }
        await saveManagedWorldInfo(worldName, data, true);
        await updateWIChange(worldName, data);
    }
};
const transferEntryToBook = async(srcName, uid, dstName, isCopy = false)=>{
    if (!srcName || !dstName) return false;
    if (srcName == dstName) {
        toastr.warning(`Entry is already in book "${dstName}"`, DISPLAY_NAME);
        return false;
    }

    const [srcBook, dstBook] = await Promise.all([
        loadWorldInfo(srcName),
        loadWorldInfo(dstName),
    ]);
    if (!srcBook?.entries || !dstBook?.entries) {
        toastr.error('Something went wrong', DISPLAY_NAME);
        return false;
    }

    const srcEntry = srcBook.entries[uid];
    if (!srcEntry) {
        toastr.error('Could not find the selected entry.', DISPLAY_NAME);
        return false;
    }

    const oData = Object.assign({}, srcEntry);
    delete oData.uid;
    const dstEntry = createWorldInfoEntry(null, dstBook);
    Object.assign(dstEntry, oData);
    await saveManagedWorldInfo(dstName, dstBook, true);

    if (!isCopy) {
        const deleted = await deleteWorldInfoEntry(srcBook, uid, { silent:true });
        if (deleted) {
            deleteWIOriginalDataValue(srcBook, uid);
            delete getWorldFolderState(srcName).entries[String(uid)];
            await saveManagedWorldInfo(srcName, srcBook, true);
            updateWIChange(srcName, srcBook);
        }
    }
    updateWIChange(dstName, dstBook);
    toastr.success(`${isCopy ? 'Copied' : 'Transferred'} WI Entry`, DISPLAY_NAME);
    return true;
};
const showWorldInfoPresetTransferPopup = async(srcName, uid, transferBtn)=>{
    let sel;
    let isCopy = false;
    const srcEntry = cache[srcName]?.entries?.[uid];
    const dom = document.createElement('div'); {
        dom.classList.add('stwip--transferModal');
        const title = document.createElement('h3'); {
            title.textContent = 'Transfer World Info Entry';
            dom.append(title);
        }
        const subTitle = document.createElement('h4'); {
            const editorEntry = transferBtn.closest('.world_entry');
            const entryName = editorEntry?.querySelector('[name="comment"]')?.value
                || editorEntry?.querySelector('[name="key"]')?.value
                || srcEntry?.comment
                || srcEntry?.key?.join(', ')
                || uid
            ;
            subTitle.textContent = `${srcName}: ${entryName}`;
            dom.append(subTitle);
        }
        sel = /**@type {HTMLSelectElement}*/(document.querySelector('#world_editor_select').cloneNode(true)); {
            sel.classList.add('stwip--worldSelect');
            const currentOption = [...sel.children].find(it=>it.textContent == srcName);
            sel.value = currentOption?.value ?? sel.value;
            sel.addEventListener('keyup', (evt)=>{
                if (evt.key == 'Shift') {
                    (dlg.dom ?? dlg.dlg).classList.remove('stwip--isCopy');
                }
            });
            sel.addEventListener('keydown', (evt)=>{
                if (evt.key == 'Shift') {
                    (dlg.dom ?? dlg.dlg).classList.add('stwip--isCopy');
                    return;
                }
                if (!evt.ctrlKey && !evt.altKey && evt.key == 'Enter') {
                    evt.preventDefault();
                    if (evt.shiftKey) isCopy = true;
                    dlg.completeAffirmative();
                }
            });
            dom.append(sel);
        }
        const hintP = document.createElement('p'); {
            const hint = document.createElement('small'); {
                hint.textContent = 'Type to select book. Enter to transfer. Shift+Enter to copy.';
                hintP.append(hint);
            }
            dom.append(hintP);
        }
    }
    const dlg = new Popup(dom, POPUP_TYPE.CONFIRM, null, { okButton:'Transfer', cancelButton:'Cancel' });
    const copyBtn = document.createElement('div'); {
        copyBtn.classList.add('stwip--copy');
        copyBtn.classList.add('menu_button');
        copyBtn.textContent = 'Copy';
        copyBtn.addEventListener('click', ()=>{
            isCopy = true;
            dlg.completeAffirmative();
        });
        (dlg.ok ?? dlg.okButton).insertAdjacentElement('afterend', copyBtn);
    }
    const prom = dlg.show();
    sel.focus();
    await prom;
    if (dlg.result != POPUP_RESULT.AFFIRMATIVE) return;

    const dstName = sel.selectedOptions[0].textContent;
    await transferEntryToBook(srcName, uid, dstName, isCopy);
};
const createFolderHeader = (worldName, folderName, count)=>{
    const state = getWorldFolderState(worldName);
    const isUncategorized = folderName == UNCATEGORIZED_KEY;
    const collapsed = Boolean(state.collapsed[folderName]);
    const header = document.createElement('div');
    header.classList.add('stwid--folderHeader');
    header.classList.toggle('stwid--folderCollapsed', collapsed);
    header.dataset.folder = folderName;
    header.title = collapsed ? 'Expand folder' : 'Collapse folder';
    bindFolderDropTarget(header, worldName, folderName);
    const chevron = document.createElement('button'); {
        chevron.type = 'button';
        chevron.classList.add('stwid--folderChevron');
        chevron.classList.add('fa-solid', 'fa-fw', 'fa-circle-chevron-down');
        chevron.tabIndex = -1;
        header.append(chevron);
    }
    const label = document.createElement('span'); {
        label.classList.add('stwid--folderName');
        label.textContent = getFolderDisplayName(folderName);
        header.append(label);
    }
    const badge = document.createElement('span'); {
        badge.classList.add('stwid--folderCount');
        badge.textContent = String(count);
        header.append(badge);
    }
    if (!isUncategorized) {
        const rename = document.createElement('button'); {
            rename.type = 'button';
            rename.classList.add('stwid--folderAction');
            rename.classList.add('fa-solid', 'fa-fw', 'fa-pencil');
            rename.title = 'Rename folder';
            rename.addEventListener('click', (evt)=>{
                evt.stopPropagation();
                renameFolder(worldName, folderName);
            });
            header.append(rename);
        }
        const remove = document.createElement('button'); {
            remove.type = 'button';
            remove.classList.add('stwid--folderAction');
            remove.classList.add('stwid--folderDelete');
            remove.classList.add('fa-solid', 'fa-fw', 'fa-trash-can');
            remove.title = 'Delete folder';
            remove.addEventListener('click', (evt)=>{
                evt.stopPropagation();
                deleteFolder(worldName, folderName);
            });
            header.append(remove);
        }
    }
    header.addEventListener('click', ()=>toggleFolder(worldName, folderName));
    cache[worldName].dom.folder[folderName] = { root:header, count:badge };
    return header;
};
const toggleFolder = (worldName, folderName, collapsed = null)=>{
    const state = getWorldFolderState(worldName);
    const nextCollapsed = collapsed ?? !state.collapsed[folderName];
    state.collapsed[folderName] = nextCollapsed;
    saveSettingsDebounced();
    const world = cache[worldName];
    const header = world?.dom.folder?.[folderName]?.root;
    header?.classList.toggle('stwid--folderCollapsed', nextCollapsed);
    header?.setAttribute('title', nextCollapsed ? 'Expand folder' : 'Collapse folder');
    world?.dom.entryList?.querySelectorAll(`.stwid--entry[data-folder="${CSS.escape(folderName)}"]`).forEach(entry=>{
        entry.classList.toggle('stwid--folderHidden', nextCollapsed);
    });
};
/**
 * Move a single entry row when it is the only thing whose place changed (a renamed title).
 * @returns {boolean} false when the change is bigger and the list needs a full regroup
 */
const moveOneEntryRow = (world, before, after, uid)=>{
    const without = (layout)=>JSON.stringify(layout.map(([folderName, collapsed, uids])=>[folderName, collapsed, uids.filter(it=>it !== uid)]));
    if (without(before) !== without(after)) return false;
    const groupIndex = after.findIndex(([, , uids])=>uids.includes(uid));
    if (groupIndex < 0 || !before[groupIndex]?.[2].includes(uid)) return false;
    const row = world.dom.entry[uid]?.root;
    if (!row?.isConnected) return false;
    const uids = after[groupIndex][2];
    const nextUid = uids[uids.indexOf(uid) + 1];
    let ref = null;
    if (nextUid !== undefined) ref = world.dom.entry[nextUid]?.root;
    else if (after[groupIndex + 1]) ref = world.dom.folder[after[groupIndex + 1][0]]?.root;
    if (ref === undefined || (ref && ref.parentElement != world.dom.entryList)) return false;
    world.dom.entryList.insertBefore(row, ref);
    return true;
};
/**
 * @param {string} name
 * @param {{ skipIfUnchanged?:boolean, changedUids?:string[] }} [options] skipIfUnchanged: leave the
 *   DOM alone when the folders, their collapsed state and the entry order come out the same as last
 *   time, and only move the row when a single changed entry just changed place.
 */
const regroupBookEntries = (name, { skipIfUnchanged = false, changedUids = [] } = {})=>{
    const world = cache[name];
    if (!world?.dom?.entryList || !world.loaded) return;
    const state = getWorldFolderState(name);
    const entries = sortEntries(Object.values(world.entries));
    const folders = getFolderNames(name, { entries:world.entries });
    const groups = new Map(folders.map(folderName=>[folderName, []]));
    const uncategorized = [];
    for (const entry of entries) {
        const folderName = getEntryFolder(entry, name);
        if (folderName) {
            if (!groups.has(folderName)) groups.set(folderName, []);
            groups.get(folderName).push(entry);
        } else {
            uncategorized.push(entry);
        }
    }
    if (uncategorized.length || groups.size == 0) {
        groups.set(UNCATEGORIZED_KEY, uncategorized);
    }
    // Re-appending every row of a 1,500-entry book costs most of a second, so a save that
    // does not move anything (most title edits) should not pay for it.
    const layout = [...groups].map(([folderName, groupEntries])=>[
        folderName,
        Boolean(state.collapsed[folderName]),
        groupEntries.map(entry=>String(entry.uid)),
    ]);
    const layoutKey = JSON.stringify(layout);
    if (skipIfUnchanged && layoutKey === world.layoutKey) return;
    if (skipIfUnchanged && changedUids.length == 1 && world.layout && moveOneEntryRow(world, world.layout, layout, String(changedUids[0]))) {
        world.layout = layout;
        world.layoutKey = layoutKey;
        return;
    }
    world.layout = layout;
    world.layoutKey = layoutKey;
    world.dom.folder = Object.create(null);
    world.dom.entryList.querySelectorAll('.stwid--folderHeader, .stwid--folderDropZone').forEach(header=>header.remove());
    Object.values(world.dom.entry).forEach(entry=>{
        entry.root.classList.remove('stwid--folderEntry', 'stwid--folderHidden');
        entry.root.removeAttribute('data-folder');
    });
    const fragment = document.createDocumentFragment();
    for (const [folderName, groupEntries] of groups) {
        fragment.append(createFolderHeader(name, folderName, groupEntries.length));
        fragment.append(createFolderDropZone(name, folderName));
        const collapsed = Boolean(state.collapsed[folderName]);
        for (const entry of groupEntries) {
            const entryRoot = world.dom.entry[entry.uid]?.root;
            if (!entryRoot) continue;
            entryRoot.classList.add('stwid--folderEntry');
            entryRoot.classList.toggle('stwid--folderHidden', collapsed);
            entryRoot.dataset.folder = folderName;
            updateEntryFolderButton(name, entry.uid);
            fragment.append(entryRoot);
        }
    }
    world.dom.entryList.append(fragment);
};
const updateEntryFolderButton = (worldName, uid)=>{
    const button = cache[worldName]?.dom.entry?.[uid]?.folder;
    const entry = cache[worldName]?.entries?.[uid];
    if (!button || !entry) return;
    const folderName = getEntryFolder(entry, worldName);
    button.dataset.folder = folderName;
    button.classList.toggle('stwid--folderAssigned', Boolean(folderName));
    button.title = folderName ? `Folder: ${folderName}` : 'Assign lorebook folder';
};
const showEntryFolderMenu = (anchor, worldName, uid)=>{
    const entry = cache[worldName]?.entries?.[uid];
    if (!entry) return;
    anchor.style.anchorName = '--stwid--ctxAnchor';
    const currentFolder = getEntryFolder(entry, worldName);
    const blocker = document.createElement('div'); {
        blocker.classList.add('stwid--blocker');
        blocker.addEventListener('mousedown', (evt)=>evt.stopPropagation());
        blocker.addEventListener('pointerdown', (evt)=>evt.stopPropagation());
        blocker.addEventListener('touchstart', (evt)=>evt.stopPropagation());
        blocker.addEventListener('click', (evt)=>{
            evt.stopPropagation();
            blocker.remove();
            anchor.style.anchorName = '';
        });
        const menu = document.createElement('div'); {
            menu.classList.add('stwid--menu');
            menu.classList.add('stwid--folderMenu');
            const title = document.createElement('div'); {
                title.classList.add('stwid--folderMenuTitle');
                title.textContent = currentFolder ? `Current: ${currentFolder}` : 'Assign Folder';
                menu.append(title);
            }
            for (const folderName of getFolderNames(worldName, { entries:cache[worldName].entries })) {
                const item = createStwidMenuItem(currentFolder == folderName ? 'fa-check' : 'fa-folder', folderName, 'stwid--assignFolder');
                item.addEventListener('click', async()=>assignEntryFolder(worldName, uid, folderName));
                menu.append(item);
            }
            const newFolder = createStwidMenuItem('fa-plus', 'New Folder...', 'stwid--newFolder'); {
                newFolder.addEventListener('click', async()=>{
                    const folderName = await promptForFolderName('New Lorebook Folder');
                    if (!folderName) return;
                    ensureKnownFolder(worldName, folderName);
                    await assignEntryFolder(worldName, uid, folderName);
                });
                menu.append(newFolder);
            }
            if (currentFolder) {
                const clear = createStwidMenuItem('fa-xmark', 'Move to Uncategorized', 'stwid--clearFolder'); {
                    clear.addEventListener('click', async()=>assignEntryFolder(worldName, uid, ''));
                    menu.append(clear);
                }
            }
            blocker.append(menu);
        }
        document.body.append(blocker);
    }
};
const assignEntryFolder = async(worldName, uid, folderName)=>{
    document.querySelector('.stwid--blocker')?.remove();
    folderName = normalizeFolderName(folderName);
    const data = await loadWorldInfo(worldName);
    const entry = data?.entries?.[uid];
    if (!entry) return;
    setEntryFolder(worldName, data, entry, folderName);
    if (folderName) ensureKnownFolder(worldName, folderName);
    await saveManagedWorldInfo(worldName, data, true);
    await updateWIChange(worldName, data);
};
const manageFolders = async(worldName)=>{
    closeStwidBlockers();
    const data = await loadWorldInfo(worldName);
    if (!data?.entries) return;
    const folders = getFolderNames(worldName, data);
    const counts = new Map(folders.map(folder=>[folder, 0]));
    let uncategorizedCount = 0;
    for (const entry of Object.values(data.entries)) {
        const folderName = getEntryFolder(entry, worldName);
        if (folderName) counts.set(folderName, (counts.get(folderName) ?? 0) + 1);
        else uncategorizedCount++;
    }
    const wrapper = document.createElement('div');
    wrapper.classList.add('stwid--folderManage');
    if (!folders.length) {
        const empty = document.createElement('div');
        empty.classList.add('stwid--folderManageEmpty');
        empty.textContent = 'No folders yet.';
        wrapper.append(empty);
    }
    let popup = null;
    folders.forEach((folderName, index)=>{
        const row = document.createElement('div');
        row.classList.add('stwid--folderManageRow');
        const label = document.createElement('div'); {
            label.classList.add('stwid--folderManageName');
            label.textContent = folderName;
            row.append(label);
        }
        const count = document.createElement('span'); {
            count.classList.add('stwid--folderManageCount');
            count.textContent = String(counts.get(folderName) ?? 0);
            row.append(count);
        }
        const up = createManageFolderButton('fa-arrow-up', 'Move up'); {
            up.disabled = index == 0;
            up.addEventListener('click', async(evt)=>{
                evt.preventDefault();
                evt.stopPropagation();
                await popup?.completeCancelled();
                moveFolder(worldName, folderName, -1);
                await manageFolders(worldName);
            });
            row.append(up);
        }
        const down = createManageFolderButton('fa-arrow-down', 'Move down'); {
            down.disabled = index == folders.length - 1;
            down.addEventListener('click', async(evt)=>{
                evt.preventDefault();
                evt.stopPropagation();
                await popup?.completeCancelled();
                moveFolder(worldName, folderName, 1);
                await manageFolders(worldName);
            });
            row.append(down);
        }
        const rename = createManageFolderButton('fa-pencil', 'Rename'); {
            rename.addEventListener('click', async(evt)=>{
                evt.preventDefault();
                evt.stopPropagation();
                await popup?.completeCancelled();
                await renameFolder(worldName, folderName);
                await manageFolders(worldName);
            });
            row.append(rename);
        }
        const remove = createManageFolderButton('fa-trash-can', 'Delete'); {
            remove.classList.add('stwid--folderManageDelete');
            remove.addEventListener('click', async(evt)=>{
                evt.preventDefault();
                evt.stopPropagation();
                await popup?.completeCancelled();
                await deleteFolder(worldName, folderName);
                await manageFolders(worldName);
            });
            row.append(remove);
        }
        wrapper.append(row);
    });
    if (uncategorizedCount) {
        const row = document.createElement('div');
        row.classList.add('stwid--folderManageRow');
        row.classList.add('stwid--folderManageMuted');
        const label = document.createElement('div');
        label.classList.add('stwid--folderManageName');
        label.textContent = 'Uncategorized';
        const count = document.createElement('span');
        count.classList.add('stwid--folderManageCount');
        count.textContent = String(uncategorizedCount);
        row.append(label, count);
        wrapper.append(row);
    }
    popup = new Popup(wrapper, POPUP_TYPE.TEXT, null, {
        okButton:'Close',
        cancelButton:false,
        wider:true,
        allowVerticalScrolling:true,
    });
    await popup.show();
};
const createManageFolderButton = (iconClass, title)=>{
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('menu_button');
    button.classList.add('stwid--folderManageButton');
    button.classList.add('fa-solid', 'fa-fw', iconClass);
    button.title = title;
    return button;
};
/** @type {string|null} Lorebook currently being dragged between top-level folders */
let draggingBookName = null;
/** @type {string[]|null} Lorebooks moved by the current drag, in list order */
let draggingBookNames = null;
/** @type {Set<string>} */
const bookSelection = new Set();
/** @type {string|null} */
let bookSelectAnchor = null;
/** @type {Map<string, {root:HTMLElement, header:HTMLElement, body:HTMLElement, label:HTMLElement, count:HTMLElement, up?:HTMLButtonElement, down?:HTMLButtonElement}>} */
const bookFolderShells = new Map();
const UNFILED_BOOK_FOLDER_KEY = '';
const bookFolderWarning = (reason)=>{
    if (reason == 'reserved') toastr.warning('That folder name is reserved.', DISPLAY_NAME);
    else if (reason == 'duplicate') toastr.warning('A folder with that name already exists.', DISPLAY_NAME);
};
const promptForBookFolderName = async(title, defaultValue = '')=>{
    const value = await Popup.show.input(title, 'Folder name:', defaultValue, {
        okButton: 'Save',
        cancelButton: 'Cancel',
        placeholder: 'Folder name',
    });
    if (typeof value != 'string') return null;
    const name = value.trim();
    return name || null;
};
const currentBookNames = ()=>Array.isArray(world_names) ? [...world_names] : [];
/** Last drop hint. Cleared by touching only those nodes, never by scanning the book list. */
let bookDragHint = null;
/** Book geometry for the insertion side. Measured when the hovered book or scroll position changes, not on every dragover. */
let bookDragMetrics = null;
const clearBookDragHints = ()=>{
    if (!bookDragHint) return;
    bookDragHint.book?.classList.remove('stwid--dropBefore', 'stwid--dropAfter');
    bookDragHint.folder?.classList.remove('stwid--bookFolderDropTarget');
    bookDragHint.header?.classList.remove('stwid--bookFolderDropTarget');
    bookDragHint = null;
};
const showBookDragHint = (hint)=>{
    if (bookDragHint
        && bookDragHint.key === hint.key
        && bookDragHint.book === hint.book
        && bookDragHint.folder === hint.folder
        && bookDragHint.header === hint.header
    ) return;
    clearBookDragHints();
    if (hint.book) hint.book.classList.add(hint.side == 'before' ? 'stwid--dropBefore' : 'stwid--dropAfter');
    hint.folder?.classList.add('stwid--bookFolderDropTarget');
    hint.header?.classList.add('stwid--bookFolderDropTarget');
    bookDragHint = hint;
};
const setBookFolderCount = (folderId)=>{
    const shell = bookFolderShells.get(folderId || UNFILED_BOOK_FOLDER_KEY);
    if (!shell) return;
    const state = Settings.instance.bookFolders;
    const names = currentBookNames();
    const count = folderId ? getFolderBooks(state, names, folderId).length : getUnfiledBooks(state, names).length;
    const text = String(count);
    if (shell.count.textContent !== text) shell.count.textContent = text;
};
/**
 * Put one folder's book nodes in stored order. Nodes that are already in place
 * stay put, so an open lorebook is not reparented unless it actually moved.
 */
const syncFolderBookNodes = (folderId)=>{
    const shell = bookFolderShells.get(folderId || UNFILED_BOOK_FOLDER_KEY);
    if (!shell) return false;
    const state = Settings.instance.bookFolders;
    const names = currentBookNames();
    const group = folderId ? getFolderBooks(state, names, folderId) : getUnfiledBooks(state, names);
    let cursor = shell.body.firstChild;
    for (const bookName of group) {
        const root = cache[bookName]?.dom?.root;
        if (!root) continue;
        if (cursor === root) {
            cursor = root.nextSibling;
            continue;
        }
        shell.body.insertBefore(root, cursor);
    }
    setBookFolderCount(folderId);
    return true;
};
const bookListOrder = ()=>{
    const state = Settings.instance.bookFolders;
    const names = currentBookNames();
    const ordered = [];
    for (const folder of getSortedBookFolders(state)) ordered.push(...getFolderBooks(state, names, folder.id));
    ordered.push(...getUnfiledBooks(state, names));
    return ordered;
};
const paintBookSelection = (bookName)=>{
    const root = cache[bookName]?.dom?.root;
    if (!root) return;
    const selected = bookSelection.has(bookName);
    root.classList.toggle('stwid--isBookSelected', selected);
    const icon = root.querySelector(':scope > .stwid--head .stwid--bookSelect .stwid--icon');
    if (!icon) return;
    icon.classList.toggle('fa-square-check', selected);
    icon.classList.toggle('fa-square', !selected);
};
const toggleBookSelection = (bookName, shift)=>{
    if (shift && bookSelectAnchor && bookSelectAnchor != bookName) {
        const order = bookListOrder();
        const start = order.indexOf(bookSelectAnchor);
        const end = order.indexOf(bookName);
        if (start >= 0 && end >= 0) {
            const [from, to] = start < end ? [start, end] : [end, start];
            for (let i = from; i <= to; i++) {
                bookSelection.add(order[i]);
                paintBookSelection(order[i]);
            }
            return;
        }
    }
    if (bookSelection.has(bookName)) bookSelection.delete(bookName);
    else bookSelection.add(bookName);
    bookSelectAnchor = bookName;
    paintBookSelection(bookName);
};
const booksForDrag = (bookName)=>{
    if (!bookSelection.has(bookName)) return [bookName];
    const picked = bookListOrder().filter(name=>bookSelection.has(name));
    return picked.length ? picked : [bookName];
};
const updateBookFolderAssignButton = (name)=>{
    const button = cache[name]?.dom?.folderAssign;
    if (!button) return;
    const state = Settings.instance.bookFolders;
    const folderId = getBookFolderId(state, name);
    const folder = state.folders.find(item=>item.id == folderId);
    button.classList.toggle('stwid--bookFolderAssigned', Boolean(folder));
    button.title = folder ? `Folder: ${folder.name}` : 'Move lorebook to folder';
};
const createBookFolderAction = (iconClass, title)=>{
    const button = document.createElement('button');
    button.type = 'button';
    button.classList.add('stwid--bookFolderAction');
    button.classList.add('fa-solid', 'fa-fw', iconClass);
    button.title = title;
    return button;
};
const layoutBookFolders = ()=>{
    if (!dom.books) return;
    const state = Settings.instance.bookFolders;
    // world_names is undefined until SillyTavern finishes settings init. Reconciling
    // against that would treat every lorebook as deleted and wipe the folder map.
    const namesKnown = Array.isArray(world_names);
    const names = namesKnown ? [...world_names] : [];
    if (namesKnown && reconcileBookFolders(state, names)) Settings.instance.save();
    const folders = getSortedBookFolders(state);
    dom.books.classList.toggle('stwid--hasBookFolders', folders.length > 0);
    const seen = new Set();
    const fragment = document.createDocumentFragment();
    for (const folder of folders) {
        seen.add(folder.id);
        const shell = ensureBookFolderShell(folder.id);
        shell.label.textContent = folder.name;
        shell.root.classList.toggle('stwid--bookFolderCollapsed', folder.collapsed === true);
        shell.header.title = folder.collapsed ? 'Expand folder' : 'Collapse folder';
        const books = getFolderBooks(state, names, folder.id).map(name=>cache[name]?.dom?.root).filter(Boolean);
        shell.count.textContent = String(books.length);
        shell.body.replaceChildren(...books);
        if (shell.up) shell.up.disabled = folders[0]?.id == folder.id;
        if (shell.down) shell.down.disabled = folders.at(-1)?.id == folder.id;
        fragment.append(shell.root);
    }
    for (const [id, shell] of bookFolderShells) {
        if (id == UNFILED_BOOK_FOLDER_KEY || seen.has(id)) continue;
        shell.root.remove();
        bookFolderShells.delete(id);
    }
    const unfiled = ensureBookFolderShell(UNFILED_BOOK_FOLDER_KEY);
    const unfiledBooks = getUnfiledBooks(state, names).map(name=>cache[name]?.dom?.root).filter(Boolean);
    unfiled.count.textContent = String(unfiledBooks.length);
    unfiled.body.replaceChildren(...unfiledBooks);
    fragment.append(unfiled.root);
    dom.books.append(fragment);
    for (const name of names) updateBookFolderAssignButton(name);
};
const ensureBookFolderShell = (folderId)=>{
    const existing = bookFolderShells.get(folderId);
    if (existing) return existing;
    const isUnfiled = folderId == UNFILED_BOOK_FOLDER_KEY;
    const root = document.createElement('div');
    root.classList.add('stwid--bookFolder');
    if (isUnfiled) root.classList.add('stwid--bookFolderUnfiled');
    root.dataset.folderId = folderId;
    const header = document.createElement('div');
    header.classList.add('stwid--bookFolderHeader');
    if (!isUnfiled) {
        const chevron = document.createElement('button');
        chevron.type = 'button';
        chevron.classList.add('stwid--bookFolderChevron');
        chevron.classList.add('fa-solid', 'fa-fw', 'fa-circle-chevron-down');
        chevron.tabIndex = -1;
        header.append(chevron);
    } else {
        const icon = document.createElement('i');
        icon.classList.add('stwid--bookFolderChevron');
        icon.classList.add('fa-solid', 'fa-fw', 'fa-folder-open');
        header.append(icon);
    }
    const label = document.createElement('span');
    label.classList.add('stwid--bookFolderName');
    label.textContent = isUnfiled ? 'Unfiled' : '';
    header.append(label);
    const count = document.createElement('span');
    count.classList.add('stwid--bookFolderCount');
    count.textContent = '0';
    header.append(count);
    /**@type {HTMLButtonElement|undefined} */
    let up;
    /**@type {HTMLButtonElement|undefined} */
    let down;
    if (!isUnfiled) {
        up = createBookFolderAction('fa-arrow-up', 'Move folder up');
        down = createBookFolderAction('fa-arrow-down', 'Move folder down');
        const rename = createBookFolderAction('fa-pencil', 'Rename folder');
        const remove = createBookFolderAction('fa-trash-can', 'Delete folder');
        remove.classList.add('stwid--bookFolderDelete');
        up.addEventListener('click', (evt)=>{
            evt.preventDefault();
            evt.stopPropagation();
            if (moveBookFolder(Settings.instance.bookFolders, folderId, -1)) {
                Settings.instance.save();
                layoutBookFolders();
            }
        });
        down.addEventListener('click', (evt)=>{
            evt.preventDefault();
            evt.stopPropagation();
            if (moveBookFolder(Settings.instance.bookFolders, folderId, 1)) {
                Settings.instance.save();
                layoutBookFolders();
            }
        });
        rename.addEventListener('click', (evt)=>{
            evt.preventDefault();
            evt.stopPropagation();
            renameTopLevelBookFolder(folderId);
        });
        remove.addEventListener('click', (evt)=>{
            evt.preventDefault();
            evt.stopPropagation();
            deleteTopLevelBookFolder(folderId);
        });
        header.append(up, down, rename, remove);
        header.addEventListener('click', ()=>toggleTopLevelBookFolder(folderId));
    } else {
        header.title = 'Drag a lorebook here to take it out of a folder';
    }
    const body = document.createElement('div');
    body.classList.add('stwid--bookFolderBody');
    root.append(header, body);
    const shell = { root, header, body, label, count, up, down };
    bookFolderShells.set(folderId, shell);
    return shell;
};
const toggleTopLevelBookFolder = (folderId)=>{
    const folder = Settings.instance.bookFolders.folders.find(item=>item.id == folderId);
    if (!folder) return;
    setBookFolderCollapsed(Settings.instance.bookFolders, folderId, !folder.collapsed);
    Settings.instance.save();
    layoutBookFolders();
};
const renameTopLevelBookFolder = async(folderId)=>{
    const folder = Settings.instance.bookFolders.folders.find(item=>item.id == folderId);
    if (!folder) return;
    const name = await promptForBookFolderName('Rename Lorebook Folder', folder.name);
    if (!name || name == folder.name) return;
    const result = renameBookFolder(Settings.instance.bookFolders, folderId, name);
    if (!result.ok) {
        bookFolderWarning(result.reason);
        return;
    }
    Settings.instance.save();
    layoutBookFolders();
};
const deleteTopLevelBookFolder = async(folderId)=>{
    const folder = Settings.instance.bookFolders.folders.find(item=>item.id == folderId);
    if (!folder) return;
    const result = await Popup.show.confirm(
        'Delete Lorebook Folder',
        `Remove folder "${folder.name}"? Its lorebooks return to the unfiled list and are not deleted.`,
        { okButton:'Delete', cancelButton:'Cancel' },
    );
    if (result != POPUP_RESULT.AFFIRMATIVE) return;
    deleteBookFolder(Settings.instance.bookFolders, currentBookNames(), folderId);
    Settings.instance.save();
    layoutBookFolders();
};
const createTopLevelBookFolder = async()=>{
    const name = await promptForBookFolderName('New Lorebook Folder');
    if (!name) return;
    const result = createBookFolder(Settings.instance.bookFolders, name);
    if (!result.ok) {
        bookFolderWarning(result.reason);
        return;
    }
    Settings.instance.save();
    layoutBookFolders();
    bookFolderShells.get(result.folder.id)?.root.scrollIntoView({ block:'nearest' });
};
const assignBookToFolder = (bookName, folderId)=>{
    if (getBookFolderId(Settings.instance.bookFolders, bookName) === folderId) return;
    if (!moveBook(Settings.instance.bookFolders, currentBookNames(), bookName, folderId, null)) return;
    Settings.instance.save();
    layoutBookFolders();
};
const showBookFolderMenu = (anchor, bookName)=>{
    anchor.style.anchorName = '--stwid--ctxAnchor';
    const state = Settings.instance.bookFolders;
    const currentId = getBookFolderId(state, bookName);
    const current = state.folders.find(folder=>folder.id == currentId);
    const blocker = document.createElement('div'); {
        blocker.classList.add('stwid--blocker');
        blocker.addEventListener('mousedown', (evt)=>evt.stopPropagation());
        blocker.addEventListener('pointerdown', (evt)=>evt.stopPropagation());
        blocker.addEventListener('touchstart', (evt)=>evt.stopPropagation());
        blocker.addEventListener('click', (evt)=>{
            evt.stopPropagation();
            blocker.remove();
            anchor.style.anchorName = '';
        });
        const menu = document.createElement('div'); {
            menu.classList.add('stwid--menu');
            menu.classList.add('stwid--folderMenu');
            const title = document.createElement('div'); {
                title.classList.add('stwid--folderMenuTitle');
                title.textContent = current ? `Current: ${current.name}` : 'Move Lorebook';
                menu.append(title);
            }
            for (const folder of getSortedBookFolders(state)) {
                const item = createStwidMenuItem(currentId == folder.id ? 'fa-check' : 'fa-folder', folder.name, 'stwid--assignBookFolder');
                item.addEventListener('click', ()=>{
                    blocker.remove();
                    anchor.style.anchorName = '';
                    assignBookToFolder(bookName, folder.id);
                });
                menu.append(item);
            }
            const created = createStwidMenuItem('fa-plus', 'New Folder...', 'stwid--newBookFolder'); {
                created.addEventListener('click', async()=>{
                    blocker.remove();
                    anchor.style.anchorName = '';
                    const name = await promptForBookFolderName('New Lorebook Folder');
                    if (!name) return;
                    const result = createBookFolder(Settings.instance.bookFolders, name);
                    if (!result.ok) {
                        bookFolderWarning(result.reason);
                        return;
                    }
                    moveBook(Settings.instance.bookFolders, currentBookNames(), bookName, result.folder.id, null);
                    Settings.instance.save();
                    layoutBookFolders();
                });
                menu.append(created);
            }
            if (current) {
                const clear = createStwidMenuItem('fa-xmark', 'Move to Unfiled', 'stwid--clearBookFolder'); {
                    clear.addEventListener('click', ()=>{
                        blocker.remove();
                        anchor.style.anchorName = '';
                        assignBookToFolder(bookName, null);
                    });
                    menu.append(clear);
                }
            }
            blocker.append(menu);
        }
        document.body.append(blocker);
    }
};
const bindBookDragHandle = (head, book, name)=>{
    head.draggable = true;
    head.addEventListener('dragstart', (evt)=>{
        const target = evt.target instanceof Element ? evt.target : evt.target?.parentElement;
        if (target?.closest('input, button, .stwid--action, .stwid--actions')) {
            evt.preventDefault();
            return;
        }
        if (target?.closest('.stwid--bookSelect')) {
            evt.preventDefault();
            return;
        }
        const moving = booksForDrag(name);
        draggingBookName = name;
        draggingBookNames = moving;
        bookDragMetrics = null;
        dom.books?.classList.add('stwid--isBookDrag');
        for (const bookName of moving) cache[bookName]?.dom?.root?.classList.add('stwid--isBookDragging');
        evt.dataTransfer.effectAllowed = 'move';
        evt.dataTransfer.setData('text/plain', moving.length > 1 ? `${moving.length} lorebooks` : name);
        evt.stopPropagation();
        const preview = document.createElement('div');
        preview.classList.add('stwid--dragPreview');
        preview.textContent = moving.length > 1 ? `${moving.length} lorebooks` : name;
        document.body.append(preview);
        try {
            evt.dataTransfer.setDragImage(preview, 12, 12);
        } catch { /* empty */ }
        requestAnimationFrame(()=>preview.remove());
    });
    head.addEventListener('dragend', ()=>{
        for (const bookName of draggingBookNames ?? []) cache[bookName]?.dom?.root?.classList.remove('stwid--isBookDragging');
        draggingBookName = null;
        draggingBookNames = null;
        bookDragMetrics = null;
        dom.books?.classList.remove('stwid--isBookDrag');
        clearBookDragHints();
    });
};
const bookDragTarget = (evt)=>{
    const target = evt.target instanceof Element ? evt.target : null;
    if (!target || !dom.books?.contains(target)) return null;
    const bookEl = target.closest('.stwid--book');
    if (bookEl) {
        const scrollTop = dom.books.scrollTop;
        if (!bookDragMetrics || bookDragMetrics.book !== bookEl) {
            const rect = bookEl.getBoundingClientRect();
            bookDragMetrics = {
                book: bookEl,
                scrollTop,
                mid: rect.top + (rect.height / 2),
            };
        } else if (bookDragMetrics.scrollTop !== scrollTop) {
            bookDragMetrics.mid += bookDragMetrics.scrollTop - scrollTop;
            bookDragMetrics.scrollTop = scrollTop;
        }
        const before = evt.clientY < bookDragMetrics.mid;
        return {
            key: `book:${bookEl.dataset.bookName}:${before ? 'before' : 'after'}`,
            book: bookEl,
            side: before ? 'before' : 'after',
            bookName: bookEl.dataset.bookName ?? null,
            placeBefore: before,
            folderEl: bookEl.closest('.stwid--bookFolder'),
        };
    }
    const folderEl = target.closest('.stwid--bookFolder');
    if (!folderEl) return null;
    const shell = bookFolderShells.get(folderEl.dataset.folderId || UNFILED_BOOK_FOLDER_KEY);
    return {
        key: `folder:${folderEl.dataset.folderId || ''}`,
        book: null,
        side: null,
        bookName: null,
        placeBefore: true,
        folderEl,
        header: shell?.header ?? null,
    };
};
const bindBookFolderDrag = ()=>{
    if (!dom.books || dom.books.dataset.bookFolderDrag == '1') return;
    dom.books.dataset.bookFolderDrag = '1';
    // Same shape as the entry drag: one class on the current target and no list scan.
    // Book geometry is read when the hovered book or the scroll position changes.
    dom.books.addEventListener('dragover', (evt)=>{
        if (!draggingBookName) return;
        const hit = bookDragTarget(evt);
        if (!hit?.folderEl) return;
        evt.preventDefault();
        evt.stopPropagation();
        if (evt.dataTransfer) evt.dataTransfer.dropEffect = 'move';
        showBookDragHint({
            key: hit.key,
            book: hit.book,
            side: hit.side,
            folder: hit.book ? null : hit.folderEl,
            header: hit.header ?? null,
        });
    }, true);
    dom.books.addEventListener('drop', (evt)=>{
        if (!draggingBookName) return;
        const hit = bookDragTarget(evt);
        if (!hit?.folderEl) return;
        evt.preventDefault();
        evt.stopPropagation();
        const moving = draggingBookNames?.length ? [...draggingBookNames] : [draggingBookName];
        const movingSet = new Set(moving);
        const folderId = hit.folderEl.dataset.folderId || null;
        clearBookDragHints();
        draggingBookName = null;
        draggingBookNames = null;
        bookDragMetrics = null;
        dom.books.classList.remove('stwid--isBookDrag');
        for (const bookName of moving) cache[bookName]?.dom?.root?.classList.remove('stwid--isBookDragging');
        if (hit.bookName && movingSet.has(hit.bookName)) return;
        const names = currentBookNames();
        const state = Settings.instance.bookFolders;
        let beforeBookName = null;
        if (hit.bookName && names.includes(hit.bookName)) {
            const stationary = (folderId ? getFolderBooks(state, names, folderId) : getUnfiledBooks(state, names)).filter(bookName=>!movingSet.has(bookName));
            if (hit.placeBefore) beforeBookName = hit.bookName;
            else {
                const index = stationary.indexOf(hit.bookName);
                beforeBookName = index >= 0 ? (stationary[index + 1] ?? null) : null;
            }
        }
        const sourceFolders = new Set(moving.map(bookName=>getBookFolderId(state, bookName)));
        if (!moveBooks(state, names, moving, folderId, beforeBookName)) return;
        sourceFolders.add(folderId);
        for (const sourceFolderId of sourceFolders) syncFolderBookNodes(sourceFolderId);
        for (const bookName of moving) updateBookFolderAssignButton(bookName);
        Settings.instance.save();
    }, true);
    dom.books.addEventListener('dragleave', (evt)=>{
        if (!draggingBookName) return;
        const next = /**@type {Node|null}*/(evt.relatedTarget);
        if (next && dom.books.contains(next)) return;
        clearBookDragHints();
    });
};
const updateSettingsChange = ()=>{
    console.log('[STWID]', '[UPDATE-SETTINGS]');
    for (const [name, world] of Object.entries(cache)) {
        const active = selected_world_info.includes(name);
        if (world.dom.active.checked != active) {
            world.dom.active.checked = active;
        }
    }
};
/** Books added to or removed from SillyTavern (create, duplicate, rename, delete, import). */
const reconcileBookList = async()=>{
    // removed books
    for (const [n, w] of Object.entries(cache)) {
        if (world_names.includes(n)) continue;
        w.dom.root.remove();
        bookSelection.delete(n);
        delete cache[n];
        if (pendingEditorSave === n) pendingEditorSave = null;
        if (currentEditor?.name == n) {
            currentEditor = null;
            dom.editor.innerHTML = '';
        }
    }
    // added books
    for (const name of world_names) {
        if (cache[name]) continue;
        const before = Object.keys(cache).find(it=>it.toLowerCase().localeCompare(name.toLowerCase()) == 1);
        await renderBook(name, before ? cache[before].dom.root : null);
    }
    layoutBookFolders();
};
/**
 * Copy a book saved from some other object (a loadWorldInfo copy, SillyTavern's own
 * editor, another extension) into the live book in place, so the entry editor keeps
 * pointing at the object that holds the current data.
 */
const mergeIntoLiveBook = (name, data)=>{
    const live = getLiveBook(name);
    if (!live || !data?.entries) return;
    for (const k of Object.keys(live)) {
        if (k != 'entries' && !Object.hasOwn(data, k)) delete live[k];
    }
    for (const [k, v] of Object.entries(data)) {
        if (k != 'entries') live[k] = structuredClone(v);
    }
    const focusedUid = currentEditor?.name == name && dom.editor.contains(document.activeElement) ? String(currentEditor.uid) : null;
    for (const uid of Object.keys(live.entries)) {
        if (!Object.hasOwn(data.entries, uid)) delete live.entries[uid];
    }
    for (const [uid, src] of Object.entries(data.entries)) {
        const dst = live.entries[uid];
        if (!dst) {
            live.entries[uid] = structuredClone(src);
            continue;
        }
        // keep what is being typed in the open editor
        if (uid === focusedUid || dst === src) continue;
        for (const k of Object.keys(dst)) {
            if (!Object.hasOwn(src, k)) delete dst[k];
        }
        Object.assign(dst, structuredClone(src));
    }
};
/** Entry fields that sortEntries and the entry-folder grouping read. */
const SORT_FIELDS = new Set(['comment', 'key', 'position', 'depth', 'order', 'extensions']);
const applyWIChange = async(name = null, data = null, eventRevision = null)=>{
    console.log('[STWID]', '[UPDATE-WI]', name, data);
    const isLive = isLiveBook(name, data);
    eventRevision ??= data?.[localSaveRevision] ?? null;
    if (!isLive && name && eventRevision !== null && cache[name]?.loaded && getLocalBookRevision(name) > eventRevision) {
        console.debug('[STWID]', '[UPDATE-WI]', 'Skipping stale update for', name);
        return;
    }
    await reconcileBookList();
    if (!name || !cache[name]) return;
    const world = cache[name];
    if (!world.loaded) {
        if (data) await loadBookEntries(name, data);
        return;
    }
    if (!isLive) {
        if (!data) data = await loadWorldInfo(name);
        mergeIntoLiveBook(name, data);
    }
    migrateEntryFolders(name, world.data);
    // Compare what the sidebar shows against the live book. The live book is the object
    // SillyTavern's editor writes into, so the sidebar's own snapshot is the only fair baseline.
    const live = world.entries;
    const shown = world.shown;
    const isOpenInEditor = (uid)=>currentEditor?.name == name && String(currentEditor?.uid) == uid;
    // Redraw the open editor at most once, and only when it shows something stale.
    let reopenUid = null;
    const reopenEditor = (uid)=>{ reopenUid = uid; };
    let hasStructureChange = false;
    // removed entries
    for (const e of Object.keys(shown)) {
        if (Object.hasOwn(live, e)) continue;
        world.dom.entry[e]?.root.remove();
        delete world.dom.entry[e];
        delete shown[e];
        delete getWorldFolderState(name).entries[String(e)];
        hasStructureChange = true;
        if (isOpenInEditor(e)) {
            currentEditor = null;
            dom.editor.innerHTML = '';
        }
    }
    // added entries
    for (const e of Object.keys(live)) {
        if (Object.hasOwn(shown, e) && world.dom.entry[e]) continue;
        world.dom.entry[e]?.root.remove();
        await renderEntry(live[e], name);
        hasStructureChange = true;
    }
    // updated entries
    let hasUpdate = false;
    /** @type {string[]} */
    const sortChangedUids = [];
    for (const [e,o] of Object.entries(shown)) {
        const n = live[e];
        const entryDom = world.dom.entry[e];
        let hasChange = false;
        for (const k of new Set([...Object.keys(o), ...Object.keys(n)])) {
            if (o[k] == n[k]) continue;
            if (typeof o[k] == 'object' && JSON.stringify(o[k]) == JSON.stringify(n[k])) continue;
            hasChange = true;
            // only fields that sorting or folder grouping read need a regroup; a text edit does not
            if (SORT_FIELDS.has(k)) {
                hasUpdate = true;
                if (sortChangedUids.at(-1) !== e) sortChangedUids.push(e);
            }
            switch (k) {
                case 'content': {
                    if (isOpenInEditor(e) && dom.editor.querySelector('[name="content"]')?.value != n.content) {
                        reopenEditor(e);
                    }
                    break;
                }
                case 'comment': {
                    if (isOpenInEditor(e) && dom.editor.querySelector('[name="comment"]')?.value != n.comment) {
                        reopenEditor(e);
                    }
                    entryDom.comment.textContent = n.comment;
                    break;
                }
                case 'key': {
                    if (isOpenInEditor(e)) {
                        const inp = /**@type {HTMLTextAreaElement}*/(dom.editor.querySelector(`textarea[name="${k}"]`));
                        if (!inp || inp.value != n[k].join(', ')) {
                            reopenEditor(e);
                        }
                    }
                    entryDom.key.textContent = n.key.join(', ');
                    break;
                }
                case 'disable': {
                    if (isOpenInEditor(e)) {
                        const killSwitch = dom.editor.querySelector('[name="entryKillSwitch"]');
                        if (!killSwitch || killSwitch.classList.contains('fa-toggle-off') != !!n[k]) {
                            reopenEditor(e);
                        }
                    }
                    entryDom.isEnabled.classList[n[k] ? 'remove' : 'add']('fa-toggle-on');
                    entryDom.isEnabled.classList[n[k] ? 'add' : 'remove']('fa-toggle-off');
                    break;
                }
                case 'constant':
                case 'vectorized': {
                    if (isOpenInEditor(e)) {
                        const stateSelect = /**@type {HTMLSelectElement}*/(dom.editor.querySelector('select[name="entryStateSelector"]'));
                        if (!stateSelect || stateSelect.value != entryState(n)) {
                            reopenEditor(e);
                        }
                    }
                    entryDom.strategy.value = entryState(n);
                    break;
                }
                default: {
                    if (isOpenInEditor(e)) {
                        const inp = /**@type {HTMLInputElement}*/(dom.editor.querySelector(`[name="${k}"]`));
                        // A save from somewhere else changed this entry: redraw. The editor's own
                        // saves also fill in fields it has no input for; those need no redraw.
                        const shownValue = inp?.type == 'checkbox' ? inp.checked : inp?.value;
                        if (!isLive || (inp && shownValue != n[k])) {
                            reopenEditor(e);
                        }
                    }
                    break;
                }
            }
        }
        if (hasChange) shown[e] = structuredClone(n);
    }
    if (reopenUid !== null && isOpenInEditor(reopenUid)) world.dom.entry[reopenUid]?.root.click();
    if (hasUpdate || hasStructureChange) {
        regroupBookEntries(name, { skipIfUnchanged:!hasStructureChange, changedUids:sortChangedUids });
    }
    if (hasStructureChange) saveSettingsDebounced();
};
/** Runs list updates one at a time, so two saves cannot interleave their DOM work. */
let wiChangeChain = Promise.resolve();
const updateWIChange = (name = null, data = null, eventRevision = null)=>{
    wiChangeChain = wiChangeChain
        .then(()=>applyWIChange(name, data, eventRevision))
        .catch(error=>console.error('[STWID]', '[UPDATE-WI]', 'List update failed', error))
    ;
    return wiChangeChain;
};
/**
 * Coalesce bursts of saves per book. A single shared debounce would keep only the last
 * call, dropping another book's update (a move saves two books) or the book-list refresh.
 * @type {Map<string|null, any>}
 */
const pendingWIChanges = new Map();
const flushWIChanges = debounce(()=>{
    const changes = [...pendingWIChanges];
    pendingWIChanges.clear();
    for (const [name, data] of changes) updateWIChange(name, data);
});
const queueWIChange = (name = null, data = null)=>{
    pendingWIChanges.set(name, data);
    flushWIChanges();
};

eventSource.on(event_types.WORLDINFO_UPDATED, (name, data)=>{
    if (pendingEditorSave === name && isLiveBook(name, data)) pendingEditorSave = null;
    queueWIChange(name, data);
});
eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, ()=>updateSettingsChange());


export const jumpToEntry = async(name, uid)=>{
    await ensureBookLoaded(name);
    if (dom.activationToggle.classList.contains('stwid--active')) {
        dom.activationToggle.click();
    }
    if (dom.order.toggle.classList.contains('stwid--active')) {
        dom.order.toggle.click();
    }
    cache[name].dom.entryList.classList.remove('stwid--isCollapsed');
    cache[name].dom.collapseToggle.classList.add('fa-chevron-up');
    cache[name].dom.collapseToggle.classList.remove('fa-chevron-down');
    toggleFolder(name, getEntryFolder(cache[name].entries[uid], name) || UNCATEGORIZED_KEY, false);
    cache[name].dom.entry[uid].root.scrollIntoView({ block:'center', inline:'center' });
    if (currentEditor?.name != name || currentEditor?.uid != uid) {
        cache[name].dom.entry[uid].root.click();
    }
};


/** Last clickd/selected DOM (WI entry) @type {HTMLElement} */
let selectLast = null;
/** Name of the book to select WI entries from @type {string} */
let selectFrom = null;
/**@type {'ctrl'|'shift'} */
let selectMode = null;
/** List of selected entries (WI data) @type {{}[]} */
let selectList = null;
/** toastr reference showing selection help @type {JQuery<HTMLElement>} */
let selectToast = null;
const selectEnd = ()=>{
    selectFrom = null;
    selectMode = null;
    selectList = null;
    selectLast = null;
    if (selectToast) {
        toastr.clear(selectToast);
    }
    dom.books.classList.remove('stwid--isDragging');
    [...dom.books.querySelectorAll('.stwid--entry.stwid--isSelected')]
        .forEach(it=>{
            it.classList.remove('stwid--isSelected');
            it.removeAttribute('draggable');
            const icon = it.querySelector('.stwid--selector > .stwid--icon');
            icon.classList.add('fa-square');
            icon.classList.remove('fa-square-check');
        })
    ;
    [...dom.books.querySelectorAll('.stwid--book.stwid--isTarget')]
        .forEach(it=>{
            it.classList.remove('stwid--isTarget');
        })
    ;
};
/**
 *
 * @param {HTMLElement} entry
 */
const selectAdd = (entry)=>{
    entry.classList.add('stwid--isSelected');
    entry.setAttribute('draggable', 'true');
    const icon = entry.querySelector('.stwid--selector > .stwid--icon');
    icon.classList.remove('fa-square');
    icon.classList.add('fa-square-check');
};
const selectRemove = (entry)=>{
    entry.classList.remove('stwid--isSelected');
    entry.setAttribute('draggable', 'false');
    const icon = entry.querySelector('.stwid--selector > .stwid--icon');
    icon.classList.add('fa-square');
    icon.classList.remove('fa-square-check');
};
const setSelectionDragImage = (evt)=>{
    const count = selectList?.length ?? 1;
    const preview = document.createElement('div');
    preview.classList.add('stwid--dragPreview');
    preview.textContent = `${count} ${count == 1 ? 'entry' : 'entries'}`;
    document.body.append(preview);
    evt.dataTransfer.setDragImage(preview, 12, 12);
    requestAnimationFrame(()=>preview.remove());
};
const showBookInNativeEditor = async(name)=>{
    // Write pending editor changes first: a copy should include them, and a save that lands
    // after a delete or rename would put the old book file back.
    await flushEditorSave();
    const sel = /**@type {HTMLSelectElement}*/(document.querySelector('#world_editor_select'));
    const option = /**@type {HTMLOptionElement[]}*/([...sel.children]).find(it=>it.textContent == name);
    if (!option) return false;
    sel.value = option.value;
    if (typeof worldInfoModule.showWorldEditor == 'function') {
        // Wait until SillyTavern has bound its buttons to this book; a fixed delay could
        // still act on the previously shown book when that one is large.
        await worldInfoModule.showWorldEditor(name);
    } else {
        sel.dispatchEvent(new Event('change', { bubbles:true }));
        await delay(500);
    }
    return true;
};
const renderBook = async(name, before = null, bookData = null)=>{
    const world = { entries:{} };
    /** Live book object (set once the entries load); see getLiveBook. */
    world.data = null;
    /** Snapshot of each entry as the sidebar last drew it, used to spot changes. */
    world.shown = {};
    world.dom = {
        /**@type {HTMLElement} */
        root: undefined,
        /**@type {HTMLElement} */
        name: undefined,
        /**@type {HTMLElement} */
        active: undefined,
        /**@type {HTMLElement} */
        entryList: undefined,
        /**@type {{ [folderName:string]:{root:HTMLElement, count:HTMLElement}}} */
        folder: Object.create(null),
        /**@type {{ [uid:string]:{root:HTMLElement, comment:HTMLElement, key:HTMLElement}}} */
        entry: {},
    };
    world.loaded = false;
    world.loading = null;
    cache[name] = world;
    const book = document.createElement('div'); {
        world.dom.root = book;
        book.classList.add('stwid--book');
        book.dataset.bookName = name;
        book.addEventListener('dragover', (evt)=>{
            if (selectFrom === null) return;
            evt.preventDefault();
            if (!book.classList.contains('stwid--isTarget')) book.classList.add('stwid--isTarget');
        });
        book.addEventListener('dragleave', (evt)=>{
            if (selectFrom === null) return;
            const next = evt.relatedTarget;
            if (next instanceof Node && book.contains(next)) return;
            book.classList.remove('stwid--isTarget');
        });
        book.addEventListener('drop', async(evt)=>{
            if (selectFrom === null) return;
            evt.preventDefault();
            const isCopy = evt.ctrlKey;
            if (selectFrom != name || isCopy) {
                const srcBook = await loadWorldInfo(selectFrom);
                const dstBook = await loadWorldInfo(name);
                for (const srcEntry of selectList) {
                    const uid = srcEntry.uid;
                    const oData = Object.assign({}, srcEntry);
                    delete oData.uid;
                    const dstEntry = createWorldInfoEntry(null, dstBook);
                    Object.assign(dstEntry, oData);
                    await saveManagedWorldInfo(name, dstBook, true);
                    if (!isCopy) {
                        const deleted = await deleteWorldInfoEntry(srcBook, uid, { silent:true });
                        if (deleted) {
                            deleteWIOriginalDataValue(srcBook, uid);
                        }
                    }
                }
                if (selectFrom != name) {
                    await saveManagedWorldInfo(selectFrom, srcBook, true);
                    updateWIChange(selectFrom, srcBook);
                }
                updateWIChange(name, dstBook);
            }
            selectEnd();
        });
        const head = document.createElement('div'); {
            head.classList.add('stwid--head');
            bindBookDragHandle(head, book, name);
            const bookSelect = document.createElement('div'); {
                bookSelect.classList.add('stwid--bookSelect');
                bookSelect.title = 'Select lorebook\n---\nShift-click to select a range.\nDrag a selected lorebook to move the whole selection.';
                bookSelect.addEventListener('click', (evt)=>{
                    evt.preventDefault();
                    evt.stopPropagation();
                    toggleBookSelection(name, evt.shiftKey);
                });
                const icon = document.createElement('div'); {
                    icon.classList.add('stwid--icon');
                    icon.classList.add('fa-solid', 'fa-square');
                    bookSelect.append(icon);
                }
                head.append(bookSelect);
            }
            let collapseToggle;
            const title = document.createElement('div'); {
                world.dom.name = title;
                title.classList.add('stwid--title');
                title.textContent = name;
                title.title = name;
                title.addEventListener('click', async()=>{
                    const isOpening = entryList.classList.contains('stwid--isCollapsed');
                    if (isOpening) {
                        await ensureBookLoaded(name);
                    }
                    const is = entryList.classList.toggle('stwid--isCollapsed');
                    if (is) {
                        collapseToggle.classList.remove('fa-chevron-up');
                        collapseToggle.classList.add('fa-chevron-down');
                    } else {
                        collapseToggle.classList.add('fa-chevron-up');
                        collapseToggle.classList.remove('fa-chevron-down');
                    }
                });
                head.append(title);
            }
            const actions = document.createElement('div'); {
                actions.classList.add('stwid--actions');
                const active = document.createElement('input'); {
                    world.dom.active = active;
                    active.title = 'Globally active';
                    active.type = 'checkbox';
                    active.checked = selected_world_info.includes(name);
                    active.addEventListener('click', async()=>{
                        active.disabled = true;
                        onWorldInfoChange({ silent:'true', state:(active.checked ? 'on' : 'off') }, name);
                        active.disabled = false;
                    });
                    actions.append(active);
                }
                const add = document.createElement('div'); {
                    add.classList.add('stwid--action');
                    add.classList.add('stwid--add');
                    add.classList.add('fa-solid', 'fa-fw', 'fa-plus');
                    add.title = 'New Entry';
                    add.addEventListener('click', async()=>{
                        await ensureBookLoaded(name);
                        const data = getLiveBook(name);
                        const newEntry = createWorldInfoEntry(name, data);
                        if (!newEntry) return;
                        await renderEntry(newEntry, name);
                        regroupBookEntries(name);
                        cache[name].dom.entry[newEntry.uid].root.click();
                        await saveManagedWorldInfo(name, data, true);
                    });
                    actions.append(add);
                }
                const folderAssign = document.createElement('div'); {
                    world.dom.folderAssign = folderAssign;
                    folderAssign.classList.add('stwid--action');
                    folderAssign.classList.add('stwid--bookFolderAssign');
                    folderAssign.classList.add('fa-solid', 'fa-fw', 'fa-folder');
                    folderAssign.title = 'Move lorebook to folder';
                    folderAssign.addEventListener('click', (evt)=>{
                        evt.preventDefault();
                        evt.stopPropagation();
                        showBookFolderMenu(folderAssign, name);
                    });
                    actions.append(folderAssign);
                }
                const menuTrigger = document.createElement('div'); {
                    menuTrigger.classList.add('stwid--action');
                    menuTrigger.classList.add('stwid--menuTrigger');
                    menuTrigger.classList.add('fa-solid', 'fa-fw', 'fa-ellipsis-vertical');
                    menuTrigger.addEventListener('click', ()=>{
                        menuTrigger.style.anchorName = '--stwid--ctxAnchor';
                        const blocker = document.createElement('div'); {
                            blocker.classList.add('stwid--blocker');
                            blocker.addEventListener('mousedown', (evt)=>{
                                evt.stopPropagation();
                            });
                            blocker.addEventListener('pointerdown', (evt)=>{
                                evt.stopPropagation();
                            });
                            blocker.addEventListener('touchstart', (evt)=>{
                                evt.stopPropagation();
                            });
                            blocker.addEventListener('click', (evt)=>{
                                evt.stopPropagation();
                                blocker.remove();
                                menuTrigger.style.anchorName = '';
                            });
                            const menu = document.createElement('div'); {
                                menu.classList.add('stwid--menu');
                                const newFolder = createStwidMenuItem('fa-folder-plus', 'New Folder', 'stwid--newFolder'); {
                                    newFolder.addEventListener('click', async()=>{
                                        await createFolder(name);
                                    });
                                    menu.append(newFolder);
                                }
                                const manage = createStwidMenuItem('fa-list-check', 'Manage Folders', 'stwid--manageFolders'); {
                                    manage.addEventListener('click', async()=>{
                                        await manageFolders(name);
                                    });
                                    menu.append(manage);
                                }
                                const expandFolders = createStwidMenuItem('fa-up-right-and-down-left-from-center', 'Expand Folders', 'stwid--expandFolders'); {
                                    expandFolders.addEventListener('click', ()=>collapseBookFolders(name, false));
                                    menu.append(expandFolders);
                                }
                                const collapseFolders = createStwidMenuItem('fa-down-left-and-up-right-to-center', 'Collapse Folders', 'stwid--collapseFolders'); {
                                    collapseFolders.addEventListener('click', ()=>collapseBookFolders(name, true));
                                    menu.append(collapseFolders);
                                }
                                const rename = document.createElement('div'); {
                                    rename.classList.add('stwid--item');
                                    rename.classList.add('stwid--rename');
                                    rename.addEventListener('click', async(evt)=>{
                                        //TODO cheeky monkey: drive SillyTavern's own book buttons
                                        if (!await showBookInNativeEditor(name)) return;
                                        document.querySelector('#world_popup_name_button').click();
                                    });
                                    const i = document.createElement('i'); {
                                        i.classList.add('stwid--icon');
                                        i.classList.add('fa-solid', 'fa-fw', 'fa-pencil');
                                        rename.append(i);
                                    }
                                    const txt = document.createElement('span'); {
                                        txt.classList.add('stwid--label');
                                        txt.textContent = 'Rename Book';
                                        rename.append(txt);
                                    }
                                    menu.append(rename);
                                }
                                if (extensionNames.includes('third-party/SillyTavern-WorldInfoBulkEdit')) {
                                    const bulk = document.createElement('div'); {
                                        bulk.classList.add('stwid--item');
                                        bulk.classList.add('stwid--bulkEdit');
                                        bulk.addEventListener('click', async(evt)=>{
                                            //TODO cheeky monkey
                                            const sel = /**@type {HTMLSelectElement}*/(document.querySelector('#world_editor_select'));
                                            sel.value = /**@type {HTMLOptionElement[]}*/([...sel.children]).find(it=>it.textContent == name).value;
                                            sel.dispatchEvent(new Event('change', { bubbles:true }));
                                            await delay(500);
                                            document.querySelector('.stwibe--trigger').click();
                                        });
                                        const i = document.createElement('i'); {
                                            i.classList.add('stwid--icon');
                                            i.classList.add('fa-solid', 'fa-fw', 'fa-list-check');
                                            bulk.append(i);
                                        }
                                        const txt = document.createElement('span'); {
                                            txt.classList.add('stwid--label');
                                            txt.textContent = 'Bulk Edit';
                                            bulk.append(txt);
                                        }
                                        menu.append(bulk);
                                    }
                                }
                                if (extensionNames.includes('third-party/SillyTavern-WorldInfoExternalEditor')) {
                                    const editor = document.createElement('div'); {
                                        editor.classList.add('stwid--item');
                                        editor.classList.add('stwid--externalEditor');
                                        editor.addEventListener('click', async(evt)=>{
                                            fetch('/api/plugins/wiee/editor', {
                                                method: 'POST',
                                                headers: getRequestHeaders(),
                                                body: JSON.stringify({
                                                    book: name,
                                                    command: 'code',
                                                    commandArguments: ['.'],
                                                }),
                                            });
                                        });
                                        const i = document.createElement('i'); {
                                            i.classList.add('stwid--icon');
                                            i.classList.add('fa-solid', 'fa-fw', 'fa-laptop-code');
                                            editor.append(i);
                                        }
                                        const txt = document.createElement('span'); {
                                            txt.classList.add('stwid--label');
                                            txt.textContent = 'External Editor';
                                            editor.append(txt);
                                        }
                                        menu.append(editor);
                                    }
                                }
                                const exp = document.createElement('div'); {
                                    exp.classList.add('stwid--item');
                                    exp.classList.add('stwid--export');
                                    exp.addEventListener('click', async(evt)=>{
                                        evt.preventDefault();
                                        evt.stopPropagation();
                                        closeStwidBlockers();
                                        await exportBookWithFolderChoice(name);
                                    });
                                    const i = document.createElement('i'); {
                                        i.classList.add('stwid--icon');
                                        i.classList.add('fa-solid', 'fa-fw', 'fa-file-export');
                                        exp.append(i);
                                    }
                                    const txt = document.createElement('span'); {
                                        txt.classList.add('stwid--label');
                                        txt.textContent = 'Export Book';
                                        exp.append(txt);
                                    }
                                    menu.append(exp);
                                }
                                const dup = document.createElement('div'); {
                                    dup.classList.add('stwid--item');
                                    dup.classList.add('stwid--duplicate');
                                    dup.addEventListener('click', async(evt)=>{
                                        //TODO cheeky monkey: drive SillyTavern's own book buttons
                                        if (!await showBookInNativeEditor(name)) return;
                                        document.querySelector('#world_duplicate').click();
                                    });
                                    const i = document.createElement('i'); {
                                        i.classList.add('stwid--icon');
                                        i.classList.add('fa-solid', 'fa-fw', 'fa-paste');
                                        dup.append(i);
                                    }
                                    const txt = document.createElement('span'); {
                                        txt.classList.add('stwid--label');
                                        txt.textContent = 'Duplicate Book';
                                        dup.append(txt);
                                    }
                                    menu.append(dup);
                                }
                                const del = document.createElement('div'); {
                                    del.classList.add('stwid--item');
                                    del.classList.add('stwid--delete');
                                    del.addEventListener('click', async(evt)=>{
                                        //TODO cheeky monkey: drive SillyTavern's own book buttons
                                        if (!await showBookInNativeEditor(name)) return;
                                        document.querySelector('#world_popup_delete').click();
                                    });
                                    const i = document.createElement('i'); {
                                        i.classList.add('stwid--icon');
                                        i.classList.add('fa-solid', 'fa-fw', 'fa-trash-can');
                                        del.append(i);
                                    }
                                    const txt = document.createElement('span'); {
                                        txt.classList.add('stwid--label');
                                        txt.textContent = 'Delete Book';
                                        del.append(txt);
                                    }
                                    menu.append(del);
                                }
                                blocker.append(menu);
                            }
                            document.body.append(blocker);
                        }
                    });
                    actions.append(menuTrigger);
                }
                collapseToggle = document.createElement('div'); {
                    cache[name].dom.collapseToggle = collapseToggle;
                    collapseToggle.classList.add('stwid--action');
                    collapseToggle.classList.add('stwid--collapseToggle');
                    collapseToggle.classList.add('fa-solid', 'fa-fw', 'fa-chevron-down');
                    collapseToggle.addEventListener('click', async()=>{
                        const isOpening = entryList.classList.contains('stwid--isCollapsed');
                        if (isOpening) {
                            await ensureBookLoaded(name);
                        }
                        const is = entryList.classList.toggle('stwid--isCollapsed');
                        if (is) {
                            collapseToggle.classList.remove('fa-chevron-up');
                            collapseToggle.classList.add('fa-chevron-down');
                        } else {
                            collapseToggle.classList.add('fa-chevron-up');
                            collapseToggle.classList.remove('fa-chevron-down');
                        }
                    });
                    actions.append(collapseToggle);
                }
                head.append(actions);
            }
            book.append(head);
        }
        const entryList = document.createElement('div'); {
            world.dom.entryList = entryList;
            entryList.classList.add('stwid--entryList');
            entryList.classList.add('stwid--isCollapsed');
            book.append(entryList);
        }
        if (bookData) {
            await loadBookEntries(name, bookData);
        }
        if (before) before.insertAdjacentElement('beforebegin', book);
        else dom.books.append(book);
    }
    return book;
};
const renderEntry = async(e, name, before = null)=>{
    const world = cache[name];
    world.shown[e.uid] = structuredClone(e);
    world.dom.entry[e.uid] = {};
    const entry = document.createElement('div'); {
        world.dom.entry[e.uid].root = entry;
        entry.classList.add('stwid--entry');
        entry.dataset.uid = e.uid;
        entry.addEventListener('selectstart', (evt)=>evt.preventDefault());
        entry.addEventListener('dragstart', (evt)=>{
            if (selectFrom === null || !selectList.includes(e)) {
                evt.preventDefault();
                return;
            }
            dom.books.classList.add('stwid--isDragging');
            evt.dataTransfer.effectAllowed = 'copyMove';
            evt.dataTransfer.setData('text/plain', `${selectList.length} World Info ${selectList.length == 1 ? 'entry' : 'entries'}`);
            setSelectionDragImage(evt);
        });
        const sel = document.createElement('div'); {
            sel.classList.add('stwid--selector');
            sel.title = 'Click to select entry';
            sel.addEventListener('click', (evt)=>{
                evt.preventDefault();
                // can only select from one book at a time
                if (selectFrom !== null && selectFrom != name) return;
                evt.stopPropagation();
                if (selectLast && evt.shiftKey) {
                    // range-select from last clicked entry
                    const entries = [...world.dom.entryList.querySelectorAll('.stwid--entry')];
                    const start = entries.indexOf(selectLast);
                    const end = entries.indexOf(entry);
                    for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
                        const el = entries[i];
                        const data = world.entries[el.dataset.uid];
                        if (!selectList.includes(data)) {
                            selectAdd(el);
                            selectList.push(data);
                        }
                    }
                    selectLast = entry;
                } else {
                    if (selectFrom === null) {
                        selectFrom = name;
                        selectList = [];
                        const help = document.createElement('ul'); {
                            help.classList.add('stwid--helpToast');
                            const lines = [
                                'Hold [SHIFT] while clicking to select a range of entries',
                                'Drag the selected entries onto another book to move them to that book',
                                'Hold [CTRL] while dragging entries to copy them to the targeted book',
                                'Hold [CTRL] while dragging entries onto the same book to duplicate them',
                                'Press [DEL] to delete the selected entries',
                            ];
                            for (const line of lines) {
                                const  li = document.createElement('li'); {
                                    li.textContent = line;
                                    help.append(li);
                                }
                            }
                        }
                        selectToast = toastr.info($(help), DISPLAY_NAME, {
                            timeOut: 0,
                            extendedTimeOut: 0,
                            escapeHtml: false,
                        });
                    }
                    // regular single select
                    if (selectList.includes(e)) {
                        selectRemove(entry);
                        selectList.splice(selectList.indexOf(e), 1);
                        if (selectLast == entry) selectLast = null;
                        if (selectList.length == 0) {
                            selectEnd();
                        }
                    } else {
                        selectAdd(entry);
                        selectList.push(e);
                        selectLast = entry;
                    }
                }
            });
            const i = document.createElement('div'); {
                i.classList.add('stwid--icon');
                i.classList.add('fa-solid', 'fa-square');
                sel.append(i);
            }
            entry.append(sel);
        }
        const body = document.createElement('div'); {
            body.classList.add('stwid--body');
            const comment = document.createElement('div'); {
                world.dom.entry[e.uid].comment = comment;
                comment.classList.add('stwid--comment');
                comment.textContent = e.comment;
                body.append(comment);
            }
            const key = document.createElement('div'); {
                world.dom.entry[e.uid].key = key;
                key.classList.add('stwid--key');
                key.textContent = e.key.join(', ');
                body.append(key);
            }
            entry.append(body);
        }
        const status = document.createElement('div'); {
            status.classList.add('stwid--status');
            status.addEventListener('click', (evt)=>{
                if (currentEditor?.name != name || currentEditor?.uid != e.uid) evt.stopPropagation();
            });
            const isEnabled = /**@type {HTMLSelectElement}*/(document.querySelector('#entry_edit_template [name="entryKillSwitch"]').cloneNode(true)); {
                world.dom.entry[e.uid].isEnabled = isEnabled;
                isEnabled.classList.add('stwid--enabled');
                if (e.disable) {
                    isEnabled.classList.toggle('fa-toggle-off');
                    isEnabled.classList.toggle('fa-toggle-on');
                }
                isEnabled.addEventListener('click', async()=>{
                    const dis = isEnabled.classList.toggle('fa-toggle-off');
                    isEnabled.classList.toggle('fa-toggle-on');
                    cache[name].entries[e.uid].disable = dis;
                    await saveManagedWorldInfo(name, getLiveBook(name), true);
                });
                status.append(isEnabled);
            }
            const strat = /**@type {HTMLSelectElement}*/(document.querySelector('#entry_edit_template [name="entryStateSelector"]').cloneNode(true)); {
                world.dom.entry[e.uid].strategy = strat;
                strat.classList.add('stwid--strategy');
                strat.value = entryState(e);
                strat.addEventListener('change', async()=>{
                    const value = strat.value;
                    switch (value) {
                        case 'constant': {
                            cache[name].entries[e.uid].constant = true;
                            cache[name].entries[e.uid].vectorized = false;
                            break;
                        }
                        case 'normal': {
                            cache[name].entries[e.uid].constant = false;
                            cache[name].entries[e.uid].vectorized = false;
                            break;
                        }
                        case 'vectorized': {
                            cache[name].entries[e.uid].constant = false;
                            cache[name].entries[e.uid].vectorized = true;
                            break;
                        }
                    }
                    await saveManagedWorldInfo(name, getLiveBook(name), true);
                });
                status.append(strat);
            }
            entry.append(status);
        }
        const actions = document.createElement('div'); {
            actions.classList.add('stwid--actions');
            const folder = document.createElement('div'); {
                world.dom.entry[e.uid].folder = folder;
                folder.classList.add('stwid--folderAssign');
                folder.classList.add('fa-solid', 'fa-fw', 'fa-folder');
                folder.title = 'Assign lorebook folder';
                folder.addEventListener('click', (evt)=>{
                    evt.preventDefault();
                    evt.stopPropagation();
                    showEntryFolderMenu(folder, name, e.uid);
                });
                actions.append(folder);
            }
            entry.append(actions);
        }
        /**@type {string} */
        let clickToken;
        entry.addEventListener('click', async(evt)=>{
            const token = uuidv4();
            clickToken = token;
            editorRenderToken = token;
            if (selectFrom) selectEnd();
            for (const cb of Object.values(cache)) {
                for (const ce of Object.values(cb.dom.entry)) {
                    ce.root.classList.remove('stwid--active');
                }
            }
            if (dom.activationToggle.classList.contains('stwid--active')) {
                dom.activationToggle.click();
            }
            if (dom.order.toggle.classList.contains('stwid--active')) {
                dom.order.toggle.click();
            }
            entry.classList.add('stwid--active');
            // Switching to another book: write the previous book's pending edits first, or
            // the next debounced save (for this book) would replace them in SillyTavern's queue.
            await flushEditorSave(name);
            if (editorRenderToken != token || clickToken != token) return;
            dom.editor.innerHTML = '';
            const unfocus = document.createElement('div'); {
                unfocus.classList.add('stwid--unfocusToggle');
                unfocus.classList.add('menu_button');
                unfocus.classList.add('fa-solid', 'fa-fw', 'fa-compress');
                unfocus.title = 'Unfocus';
                unfocus.addEventListener('click', ()=>{
                    dom.editor.classList.toggle('stwid--focus');
                });
                dom.editor.append(unfocus);
            }
            const keywordHeaders = document.createRange().createContextualFragment(await renderTemplateAsync('worldInfoKeywordHeaders')).querySelector('#WIEntryHeaderTitlesPC');
            if (editorRenderToken != token || clickToken != token) return;
            dom.editor.querySelectorAll('#WIEntryHeaderTitlesPC').forEach(it=>it.remove());
            dom.editor.append(keywordHeaders);
            // The editor writes straight into the live book, so the sidebar, the toggles and
            // later saves all see its changes.
            const liveBook = getLiveBook(name);
            if (!liveBook?.entries?.[e.uid]) return;
            const editDom = (await getWorldEntry(name, liveBook, liveBook.entries[e.uid]))[0];
            if (editorRenderToken != token || clickToken != token) return;
            $(editDom.querySelector('.inline-drawer')).trigger('inline-drawer-toggle');
            const focusContainer = editDom.querySelector('label[for="content "] > small > span > span'); {
                const btn = document.createElement('div'); {
                    btn.classList.add('stwid--focusToggle');
                    btn.classList.add('menu_button');
                    btn.classList.add('fa-solid', 'fa-fw', 'fa-expand');
                    btn.title = 'Focus';
                    btn.addEventListener('click', ()=>{
                        dom.editor.classList.toggle('stwid--focus');
                    });
                    focusContainer.append(btn);
                }
            }
            dom.editor.append(editDom);
            currentEditor = { name, uid:e.uid };
        });
        if (before) before.insertAdjacentElement('beforebegin', entry);
        else world.dom.entryList.append(entry);
        return entry;
    }
};
const loadList = async()=>{
    bookFolderShells.clear();
    dom.books.innerHTML = '';
    for (const name of world_names.toSorted((a,b)=>a.toLowerCase().localeCompare(b.toLowerCase()))) {
        await renderBook(name);
    }
    layoutBookFolders();
};
const loadListDebounced = debounceAsync(()=>loadList());


const placeWorldInfoPresetControls = ()=>{
    const presetControls = document.querySelector('#WorldInfo .stwip--container');
    if (!presetControls) return;

    if (!worldInfoPresetPlaceholder && !presetControls.closest('.stwid--list')) {
        worldInfoPresetPlaceholder = document.createComment('Lorebook Manager WorldInfoPresets placeholder');
        presetControls.parentNode?.insertBefore(worldInfoPresetPlaceholder, presetControls);
    }

    const managerControls = document.querySelector('#WorldInfo .stwid--list .stwid--controls');
    if (document.body.classList.contains('stwid--') && managerControls) {
        presetControls.classList.add('stwip--inManager');
        presetControls.classList.add('stwid--presetCompat');
        if (managerControls.nextElementSibling != presetControls) {
            managerControls.insertAdjacentElement('afterend', presetControls);
        }
        return;
    }

    if (worldInfoPresetPlaceholder?.parentNode) {
        presetControls.classList.remove('stwip--inManager');
        presetControls.classList.remove('stwid--presetCompat');
        if (worldInfoPresetPlaceholder.nextSibling != presetControls) {
            worldInfoPresetPlaceholder.after(presetControls);
        }
    }
};
const watchWorldInfoPresetControls = ()=>{
    const worldInfo = document.querySelector('#WorldInfo');
    if (!worldInfo) return;
    const mo = new MutationObserver(()=>placeWorldInfoPresetControls());
    mo.observe(worldInfo, { childList:true, subtree:true });
    const bodyMo = new MutationObserver(()=>placeWorldInfoPresetControls());
    bodyMo.observe(document.body, { attributes:true, attributeFilter:['class'] });
    placeWorldInfoPresetControls();
};


const addDrawer = ()=>{
    document.addEventListener('keydown', async(evt)=>{
        // only run when drawer is open
        if (document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2).closest('.stwid--body')) {
            // abort if no active selection
            if (selectFrom === null || !selectList?.length) return;
            console.log('[STWID]', evt.key);
            switch (evt.key) {
                case 'Delete': {
                    evt.preventDefault();
                    evt.stopPropagation();
                    const srcBook = await loadWorldInfo(selectFrom);
                    for (const srcEntry of selectList) {
                        const uid = srcEntry.uid;
                        const deleted = await deleteWorldInfoEntry(srcBook, uid, { silent:true });
                        if (deleted) {
                            deleteWIOriginalDataValue(srcBook, uid);
                        }
                    }
                    await saveManagedWorldInfo(selectFrom, srcBook, true);
                    updateWIChange(selectFrom, srcBook);
                    selectEnd();
                    break;
                }
            }
        }
    });
    document.body.classList.add('stwid--');
    const holder = document.querySelector('#wi-holder');
    const drawerContent = document.querySelector('#WorldInfo'); {
        let searchEntriesInput;
        const body = document.createElement('div'); {
            dom.drawer.body = body;
            body.classList.add('stwid--body');
            body.classList.add('stwid--isLoading');
            const list = document.createElement('div'); {
                list.classList.add('stwid--list');
                const controls = document.createElement('div'); {
                    controls.classList.add('stwid--controls');
                    const add = /**@type {HTMLElement}*/(document.querySelector('#world_create_button').cloneNode(true)); {
                        add.removeAttribute('id');
                        add.classList.add('stwid--addBook');
                        add.addEventListener('click', async()=>{
                            const tempName = getFreeWorldName();
                            const finalName = await Popup.show.input('Create a new World Info', 'Enter a name for the new file:', tempName);
                            if (finalName) {
                                const created = await createNewWorldInfo(finalName, { interactive: true });
                                if (created) {
                                    await updateWIChange();
                                    if (!cache[finalName]) return;
                                    cache[finalName].dom.entryList.classList.remove('stwid--isCollapsed');
                                    cache[finalName].dom.collapseToggle.classList.add('fa-chevron-up');
                                    cache[finalName].dom.collapseToggle.classList.remove('fa-chevron-down');
                                    cache[finalName].dom.root.scrollIntoView({ block:'center', inline:'center' });
                                }
                            }
                        });
                        controls.append(add);
                    }
                    const addFolder = document.createElement('div'); {
                        addFolder.classList.add('menu_button');
                        addFolder.classList.add('stwid--addBookFolder');
                        addFolder.classList.add('fa-solid', 'fa-fw', 'fa-folder-plus');
                        addFolder.title = 'New Lorebook Folder\n---\nGroup whole lorebooks. Deleting a folder puts its lorebooks back in the unfiled list.';
                        addFolder.addEventListener('click', ()=>createTopLevelBookFolder());
                        controls.append(addFolder);
                    }
                    const imp = document.createElement('div'); {
                        imp.classList.add('menu_button');
                        imp.classList.add('fa-solid', 'fa-fw', 'fa-file-import');
                        imp.title = 'Import Book';
                        imp.addEventListener('click', ()=>{
                            /**@type {HTMLInputElement}*/(document.querySelector('#world_import_file')).click();
                        });
                        controls.append(imp);
                    }
                    const settings = document.createElement('div'); {
                        dom.activationToggle = settings;
                        settings.classList.add('stwid--activation');
                        settings.classList.add('menu_button');
                        settings.classList.add('fa-solid', 'fa-fw', 'fa-cog');
                        settings.title = 'Global Activation Settings';
                        settings.addEventListener('click', ()=>{
                            const is = settings.classList.toggle('stwid--active');
                            currentEditor = null;
                            if (is) {
                                dom.editor.innerHTML = '';
                                if (dom.order.toggle.classList.contains('stwid--active')) {
                                    dom.order.toggle.click();
                                }
                                for (const cb of Object.values(cache)) {
                                    for (const ce of Object.values(cb.dom.entry)) {
                                        ce.root.classList.remove('stwid--active');
                                    }
                                }
                                const h4 = document.createElement('h4'); {
                                    h4.textContent = 'Global World Info/Lorebook activation settings';
                                    dom.editor.append(h4);
                                }
                                dom.editor.append(activationBlock);
                            } else {
                                activationBlockParent.append(activationBlock);
                                dom.editor.innerHTML = '';
                            }
                        });
                        controls.append(settings);
                    }
                    const order = document.createElement('div'); {
                        dom.order.toggle = order;
                        order.classList.add('menu_button');
                        order.classList.add('fa-solid', 'fa-fw', 'fa-arrow-down-wide-short');
                        order.title = 'Order Helper\n---\nUse drag and drop to help assign an "Order" value to entries of all active books.';
                        order.addEventListener('click', ()=>{
                            dom.editor.innerHTML = '';
                            const is = order.classList.toggle('stwid--active');
                            currentEditor = null;
                            if (dom.activationToggle.classList.contains('stwid--active')) {
                                dom.activationToggle.click();
                            }
                            for (const cb of Object.values(cache)) {
                                for (const ce of Object.values(cb.dom.entry)) {
                                    ce.root.classList.remove('stwid--active');
                                }
                            }
                            if (is) {
                                const entries = sortEntries(
                                    Object.entries(cache)
                                        .filter(([name,data])=>selected_world_info.includes(name))
                                        .map(([name,data])=>Object.values(data.entries).map(it=>({ book:name,data:it })))
                                        .flat(),
                                    SORT.PROMPT,
                                    SORT_DIRECTION.ASCENDING,
                                );
                                const body = document.createElement('div'); {
                                    body.classList.add('stwid--orderHelper');
                                    const actions = document.createElement('div'); {
                                        actions.classList.add('stwid--actions');
                                        const filterToggle = document.createElement('div'); {
                                            filterToggle.classList.add('menu_button');
                                            filterToggle.classList.add('fa-solid', 'fa-fw', 'fa-filter');
                                            filterToggle.title = 'Filter entries\n---\nOrder will only be applied to unfiltered entries';
                                            filterToggle.addEventListener('click', ()=>{
                                                const is = dom.order.filter.root.classList.toggle('stwid--active');
                                                if (is) {
                                                    if (entries.length) {
                                                        dom.order.filter.preview.textContent = JSON.stringify(Object.assign({ book:entries[0].book }, entries[0].data), null, 2);
                                                    }
                                                }
                                            });
                                            actions.append(filterToggle);
                                        }
                                        const startLbl = document.createElement('label'); {
                                            startLbl.classList.add('stwid--inputWrap');
                                            startLbl.title = 'Starting Order (topmost entry in list)';
                                            startLbl.append('Start: ');
                                            const start = document.createElement('input'); {
                                                dom.order.start = start;
                                                start.classList.add('stwid--input');
                                                start.classList.add('text_pole');
                                                start.type = 'number';
                                                start.min = '1';
                                                start.max = '10000';
                                                start.value = localStorage.getItem('stwid--order-start') ?? '100';
                                                start.addEventListener('change', ()=>{
                                                    localStorage.setItem('stwid--order-start', start.value);
                                                });
                                                startLbl.append(start);
                                            }
                                            actions.append(startLbl);
                                        }
                                        const stepLbl = document.createElement('label'); {
                                            stepLbl.classList.add('stwid--inputWrap');
                                            stepLbl.append('Spacing: ');
                                            const step = document.createElement('input'); {
                                                dom.order.step = step;
                                                step.classList.add('stwid--input');
                                                step.classList.add('text_pole');
                                                step.type = 'number';
                                                step.min = '1';
                                                step.max = '10000';
                                                step.value = localStorage.getItem('stwid--order-step') ?? '10';
                                                step.addEventListener('change', ()=>{
                                                    localStorage.setItem('stwid--order-step', step.value);
                                                });
                                                stepLbl.append(step);
                                            }
                                            actions.append(stepLbl);
                                        }
                                        const dir = document.createElement('div'); {
                                            dir.classList.add('stwid--inputWrap');
                                            dir.append('Direction: ');
                                            const wrap = document.createElement('div'); {
                                                wrap.classList.add('stwid--toggleWrap');
                                                const up = document.createElement('label'); {
                                                    up.classList.add('stwid--inputWrap');
                                                    up.title = 'Start at the bottom of the list';
                                                    const inp = document.createElement('input'); {
                                                        dom.order.direction.up = inp;
                                                        inp.type = 'radio';
                                                        inp.checked = (localStorage.getItem('stwid--order-direction') ?? 'down') == 'up';
                                                        inp.addEventListener('click', ()=>{
                                                            inp.checked = true;
                                                            dom.order.direction.down.checked = false;
                                                            apply.classList.remove('fa-arrow-down-1-9');
                                                            apply.classList.add('fa-arrow-up-9-1');
                                                            localStorage.setItem('stwid--order-direction', 'up');
                                                        });
                                                        up.append(inp);
                                                    }
                                                    up.append('up');
                                                    wrap.append(up);
                                                }
                                                const down = document.createElement('label'); {
                                                    down.classList.add('stwid--inputWrap');
                                                    down.title = 'Start at the top of the list';
                                                    const inp = document.createElement('input'); {
                                                        dom.order.direction.down = inp;
                                                        inp.type = 'radio';
                                                        inp.checked = (localStorage.getItem('stwid--order-direction') ?? 'down') == 'down';
                                                        inp.addEventListener('click', ()=>{
                                                            inp.checked = true;
                                                            dom.order.direction.up.checked = false;
                                                            apply.classList.add('fa-arrow-down-1-9');
                                                            apply.classList.remove('fa-arrow-up-9-1');
                                                            localStorage.setItem('stwid--order-direction', 'down');
                                                        });
                                                        down.append(inp);
                                                    }
                                                    down.append('down');
                                                    wrap.append(down);
                                                }
                                                dir.append(wrap);
                                            }
                                            actions.append(dir);
                                        }
                                        const apply = document.createElement('div'); {
                                            apply.classList.add('menu_button');
                                            apply.classList.add('fa-solid', 'fa-fw');
                                            if ((localStorage.getItem('stwid--order-direction') ?? 'down') == 'up') {
                                                apply.classList.add('fa-arrow-up-9-1');
                                            } else {
                                                apply.classList.add('fa-arrow-down-1-9');
                                            }
                                            apply.title = 'Apply current sorting as Order';
                                            apply.addEventListener('click', async()=>{
                                                const start = parseInt(dom.order.start.value);
                                                const step = parseInt(dom.order.step.value);
                                                const up = dom.order.direction.up.checked;
                                                let order = start;
                                                let rows = [...dom.order.tbody.children];
                                                const books = [];
                                                if (up) rows.reverse();
                                                for (const tr of rows) {
                                                    if (tr.classList.contains('stwid--isFiltered')) continue;
                                                    const book = tr.getAttribute('data-book');
                                                    const uid = tr.getAttribute('data-uid');
                                                    if (!books.includes(book)) books.push(book);
                                                    cache[book].entries[uid].order = order;
                                                    /**@type {HTMLInputElement}*/(tr.querySelector('[name="order"]')).value = order.toString();
                                                    order += step;
                                                }
                                                for (const book of books) {
                                                    await saveManagedWorldInfo(book, getLiveBook(book), true);
                                                }
                                            });
                                            actions.append(apply);
                                        }
                                        body.append(actions);
                                    }
                                    const filter = document.createElement('div'); {
                                        dom.order.filter.root = filter;
                                        filter.classList.add('stwid--filter');
                                        const main = document.createElement('div'); {
                                            main.classList.add('stwid--main');
                                            const hint = document.createElement('div'); {
                                                hint.classList.add('stwid--hint');
                                                hint.innerHTML = `
                                                    Script will be called for each entry in all active books.
                                                    Every entry for which the script returns <code>true</code> will be kept.
                                                    Other entries will be filtered out.
                                                    <br>
                                                    Use <code>{{var::entry}}</code> to access the entry and its properties (look
                                                    right for available fields).
                                                    <br>
                                                    Example:
                                                    <br>
                                                    <code>/= entry.book == 'My Book' and !entry.disable and entry.depth > 4</code>
                                                `;
                                                main.append(hint);
                                            }
                                            const script = document.createElement('div'); {
                                                script.classList.add('stwid--script');
                                                const syntax = document.createElement('div'); {
                                                    syntax.classList.add('stwid--syntax');
                                                    syntax.classList.add('hljs');
                                                    syntax.classList.add('language-stscript');
                                                    script.append(syntax);
                                                }
                                                const inp = document.createElement('textarea'); {
                                                    inp.classList.add('stwid--input');
                                                    inp.value = localStorage.getItem('stwid--filter') ?? '/= true';
                                                    const parser = new SlashCommandParser();
                                                    new AutoComplete(
                                                        inp,
                                                        ()=>true,
                                                        async(text, index)=>parser.getNameAt(text, index),
                                                        true,
                                                    );
                                                    const updateScroll = () => {
                                                        syntax.scrollTop = inp.scrollTop;
                                                        syntax.scrollLeft = inp.scrollLeft;
                                                    };
                                                    const updateScrollDebounced = debounce(()=>updateScroll(), 0);
                                                    const filterStack = [];
                                                    const updateList = async()=>{
                                                        try {
                                                            const closure = parser.parse(inp.value);
                                                            filterStack.push(closure);
                                                            closure.scope.letVariable('entry');
                                                            for (const e of entries) {
                                                                if (filterStack.at(-1) != closure) {
                                                                    filterStack.splice(filterStack.indexOf(closure), 1);
                                                                    return;
                                                                }
                                                                closure.scope.setVariable('entry', JSON.stringify(Object.assign({ book:e.book }, e.data)));
                                                                const result = (await closure.execute()).pipe;
                                                                if (filterStack.at(-1) != closure) {
                                                                    filterStack.splice(filterStack.indexOf(closure), 1);
                                                                    return;
                                                                }
                                                                if (isTrueBoolean(result)) {
                                                                    dom.order.entries[e.book][e.data.uid].classList.remove('stwid--isFiltered');
                                                                } else {
                                                                    dom.order.entries[e.book][e.data.uid].classList.add('stwid--isFiltered');
                                                                }
                                                            }
                                                            filterStack.splice(filterStack.indexOf(closure), 1);
                                                        } catch { /* empty */ }
                                                    };
                                                    const updateListDebounced = debounce(()=>updateList(), 1000);
                                                    inp.addEventListener('input', () => {
                                                        syntax.innerHTML = hljs.highlight(`${inp.value}${inp.value.slice(-1) == '\n' ? ' ' : ''}`, { language:'stscript', ignoreIllegals:true })?.value;
                                                        updateScrollDebounced();
                                                        updateListDebounced();
                                                    });
                                                    inp.addEventListener('scroll', ()=>{
                                                        updateScrollDebounced();
                                                    });
                                                    inp.style.color = 'transparent';
                                                    inp.style.background = 'transparent';
                                                    inp.style.setProperty('text-shadow', 'none', 'important');
                                                    syntax.innerHTML = hljs.highlight(`${inp.value}${inp.value.slice(-1) == '\n' ? ' ' : ''}`, { language:'stscript', ignoreIllegals:true })?.value;
                                                    script.append(inp);
                                                }
                                                main.append(script);
                                            }
                                            filter.append(main);
                                        }
                                        const preview = document.createElement('div'); {
                                            dom.order.filter.preview = preview;
                                            preview.classList.add('stwid--preview');
                                            filter.append(preview);
                                        }
                                        body.append(filter);
                                    }
                                    const wrap = document.createElement('div'); {
                                        wrap.classList.add('stwid--orderTableWrap');
                                        const tbl = document.createElement('table'); {
                                            tbl.classList.add('stwid--orderTable');
                                            const thead = document.createElement('thead'); {
                                                const tr = document.createElement('tr'); {
                                                    for (const col of ['', '', 'Entry', 'Strat', 'Position', 'Depth', 'Order', 'Trigg %']) {
                                                        const th = document.createElement('th'); {
                                                            th.textContent = col;
                                                            tr.append(th);
                                                        }
                                                    }
                                                    thead.append(tr);
                                                }
                                                tbl.append(thead);
                                            }
                                            const tbody = document.createElement('tbody'); {
                                                dom.order.tbody = tbody;
                                                $(tbody).sortable({
                                                    // handle: 'stwid--sortableHandle',
                                                    delay: getSortableDelay(),
                                                });
                                                for (const e of entries) {
                                                    const tr = document.createElement('tr'); {
                                                        tr.setAttribute('data-book', e.book);
                                                        tr.setAttribute('data-uid', e.data.uid);
                                                        if (!dom.order.entries[e.book]) {
                                                            dom.order.entries[e.book] = {};
                                                        }
                                                        dom.order.entries[e.book][e.data.uid] = tr;
                                                        const handle = document.createElement('td'); {
                                                            const i = document.createElement('div'); {
                                                                i.classList.add('stwid--sortableHandle');
                                                                i.textContent = '☰';
                                                                handle.append(i);
                                                            }
                                                            tr.append(handle);
                                                        }
                                                        const active = document.createElement('td'); {
                                                            const isEnabled = /**@type {HTMLSelectElement}*/(document.querySelector('#entry_edit_template [name="entryKillSwitch"]').cloneNode(true)); {
                                                                isEnabled.classList.add('stwid--enabled');
                                                                if (e.data.disable) {
                                                                    isEnabled.classList.toggle('fa-toggle-off');
                                                                    isEnabled.classList.toggle('fa-toggle-on');
                                                                }
                                                                isEnabled.addEventListener('click', async()=>{
                                                                    const dis = isEnabled.classList.toggle('fa-toggle-off');
                                                                    isEnabled.classList.toggle('fa-toggle-on');
                                                                    cache[e.book].dom.entry[e.data.uid].isEnabled.classList.toggle('fa-toggle-off');
                                                                    cache[e.book].dom.entry[e.data.uid].isEnabled.classList.toggle('fa-toggle-on');
                                                                    cache[e.book].entries[e.data.uid].disable = dis;
                                                                    await saveManagedWorldInfo(e.book, getLiveBook(e.book), true);
                                                                });
                                                                active.append(isEnabled);
                                                            }
                                                            tr.append(active);
                                                        }
                                                        const entry = document.createElement('td'); {
                                                            const wrap = document.createElement('div'); {
                                                                wrap.classList.add('stwid--colwrap');
                                                                wrap.classList.add('stwid--entry');
                                                                const book = document.createElement('div'); {
                                                                    book.classList.add('stwid--book');
                                                                    const i = document.createElement('i'); {
                                                                        i.classList.add('fa-solid', 'fa-fw', 'fa-book-atlas');
                                                                        book.append(i);
                                                                    }
                                                                    const txt = document.createElement('span'); {
                                                                        txt.textContent = e.book;
                                                                        book.append(txt);
                                                                    }
                                                                    wrap.append(book);
                                                                }
                                                                const comment = document.createElement('div'); {
                                                                    comment.classList.add('stwid--comment');
                                                                    comment.textContent = e.data.comment;
                                                                    wrap.append(comment);
                                                                }
                                                                const key = document.createElement('div'); {
                                                                    key.classList.add('stwid--key');
                                                                    key.textContent = e.data.key.join(', ');
                                                                    wrap.append(key);
                                                                }
                                                                entry.append(wrap);
                                                            }
                                                            tr.append(entry);
                                                        }
                                                        const strategy = document.createElement('td'); {
                                                            const strat = /**@type {HTMLSelectElement}*/(document.querySelector('#entry_edit_template [name="entryStateSelector"]').cloneNode(true)); {
                                                                strat.classList.add('stwid--strategy');
                                                                strat.value = entryState(e.data);
                                                                strat.addEventListener('change', async()=>{
                                                                    const value = strat.value;
                                                                    cache[e.book].dom.entry[e.data.uid].strategy.value = value;
                                                                    switch (value) {
                                                                        case 'constant': {
                                                                            cache[e.book].entries[e.data.uid].constant = true;
                                                                            cache[e.book].entries[e.data.uid].vectorized = false;
                                                                            break;
                                                                        }
                                                                        case 'normal': {
                                                                            cache[e.book].entries[e.data.uid].constant = false;
                                                                            cache[e.book].entries[e.data.uid].vectorized = false;
                                                                            break;
                                                                        }
                                                                        case 'vectorized': {
                                                                            cache[e.book].entries[e.data.uid].constant = false;
                                                                            cache[e.book].entries[e.data.uid].vectorized = true;
                                                                            break;
                                                                        }
                                                                    }
                                                                    await saveManagedWorldInfo(e.book, getLiveBook(e.book), true);
                                                                });
                                                                strategy.append(strat);
                                                            }
                                                            tr.append(strategy);
                                                        }
                                                        const position = document.createElement('td'); {
                                                            const pos = /**@type {HTMLSelectElement}*/(document.querySelector('#entry_edit_template [name="position"]').cloneNode(true)); {
                                                                pos.classList.add('stwid--position');
                                                                pos.value = e.data.position;
                                                                pos.addEventListener('change', async()=>{
                                                                    const value = pos.value;
                                                                    cache[e.book].dom.entry[e.data.uid].position.value = value;
                                                                    cache[e.book].entries[e.data.uid].position = value;
                                                                    await saveManagedWorldInfo(e.book, getLiveBook(e.book), true);
                                                                });
                                                                position.append(pos);
                                                            }
                                                            tr.append(position);
                                                        }
                                                        const depth = document.createElement('td'); {
                                                            const inp = document.createElement('input'); {
                                                                inp.classList.add('stwid--input');
                                                                inp.classList.add('text_pole');
                                                                inp.name = 'depth';
                                                                inp.min = '0';
                                                                inp.max = '99999';
                                                                inp.type = 'number';
                                                                inp.value = e.data.depth ?? '';
                                                                depth.append(inp);
                                                            }
                                                            tr.append(depth);
                                                        }
                                                        const order = document.createElement('td'); {
                                                            const inp = document.createElement('input'); {
                                                                inp.classList.add('stwid--input');
                                                                inp.classList.add('text_pole');
                                                                inp.name = 'order';
                                                                inp.min = '0';
                                                                inp.max = '99999';
                                                                inp.type = 'number';
                                                                inp.value = e.data.order ?? '';
                                                                order.append(inp);
                                                            }
                                                            tr.append(order);
                                                        }
                                                        const probability = document.createElement('td'); {
                                                            const inp = document.createElement('input'); {
                                                                inp.classList.add('stwid--input');
                                                                inp.classList.add('text_pole');
                                                                inp.min = '0';
                                                                inp.max = '100';
                                                                inp.type = 'number';
                                                                inp.value = e.data.probability ?? '';
                                                                probability.append(inp);
                                                            }
                                                            tr.append(probability);
                                                        }
                                                        tbody.append(tr);
                                                    }
                                                }
                                                tbl.append(tbody);
                                            }
                                            wrap.append(tbl);
                                        }
                                        body.append(wrap);
                                    }
                                    dom.editor.append(body);
                                }
                            }
                        });
                        controls.append(order);
                    }
                    const sortSel = document.createElement('select'); {
                        sortSel.classList.add('text_pole');
                        sortSel.addEventListener('change', ()=>{
                            const value = JSON.parse(sortSel.value);
                            Settings.instance.sortLogic = value.sort;
                            Settings.instance.sortDirection = value.direction;
                            for (const name of Object.keys(cache)) {
                                sortEntriesIfNeeded(name);
                            }
                            Settings.instance.save();
                        });
                        const opts = [
                            ['Title ↗', SORT.ALPHABETICAL, SORT_DIRECTION.ASCENDING],
                            ['Title ↘', SORT.ALPHABETICAL, SORT_DIRECTION.DESCENDING],
                            ['Prompt ↗', SORT.PROMPT, SORT_DIRECTION.ASCENDING],
                            ['Prompt ↘', SORT.PROMPT, SORT_DIRECTION.DESCENDING],
                        ];
                        for (const [label, sort, direction] of opts) {
                            const opt = document.createElement('option'); {
                                opt.value = JSON.stringify({ sort, direction });
                                opt.textContent = label;
                                opt.selected = sort == Settings.instance.sortLogic && direction == Settings.instance.sortDirection;
                                sortSel.append(opt);
                            }
                        }
                        controls.append(sortSel);
                    }
                    list.append(controls);
                }
                const filter = document.createElement('div'); {
                    filter.classList.add('stwid--filter');
                    let searchToken = 0;
                    const search = document.createElement('input'); {
                        search.classList.add('stwid--search');
                        search.classList.add('text_pole');
                        search.type = 'search';
                        search.placeholder = 'Search books';
                        search.addEventListener('input', async()=>{
                            const token = ++searchToken;
                            const query = search.value.toLowerCase();
                            if (query.length && searchEntriesInput.checked) {
                                await ensureAllBooksLoaded();
                                if (token != searchToken) return;
                            }
                            for (const b of Object.keys(cache)) {
                                if (query.length) {
                                    const bookMatch = b.toLowerCase().includes(query);
                                    const entryMatch = searchEntriesInput.checked && Object.values(cache[b].entries).find(e=>String(e.comment ?? '').toLowerCase().includes(query));
                                    if (bookMatch || entryMatch) {
                                        cache[b].dom.root.classList.remove('stwid--filter-query');
                                        if (searchEntriesInput.checked) {
                                            for (const e of Object.values(cache[b].entries)) {
                                                if (bookMatch || String(e.comment ?? '').toLowerCase().includes(query)) {
                                                    cache[b].dom.entry[e.uid].root.classList.remove('stwid--filter-query');
                                                } else {
                                                    cache[b].dom.entry[e.uid].root.classList.add('stwid--filter-query');
                                                }
                                            }
                                        }
                                    } else {
                                        cache[b].dom.root.classList.add('stwid--filter-query');
                                    }
                                } else {
                                    cache[b].dom.root.classList.remove('stwid--filter-query');
                                    for (const e of Object.values(cache[b].entries)) {
                                        cache[b].dom.entry[e.uid].root.classList.remove('stwid--filter-query');
                                    }
                                }
                            }
                            dom.books?.classList.toggle('stwid--isFiltering', Boolean(query) || Boolean(filter.querySelector('.stwid--filterActive input')?.checked));
                        });
                        filter.append(search);
                    }
                    const searchEntries = document.createElement('label'); {
                        searchEntries.classList.add('stwid--searchEntries');
                        searchEntries.title = 'Search through entries as well (Title/Memo)';
                        const inp = document.createElement('input'); {
                            searchEntriesInput = inp;
                            inp.type = 'checkbox';
                            inp.addEventListener('click', ()=>{
                                search.dispatchEvent(new Event('input'));
                            });
                            searchEntries.append(inp);
                        }
                        searchEntries.append('Entries');
                        filter.append(searchEntries);
                    }
                    const filterActive = document.createElement('label'); {
                        filterActive.classList.add('stwid--filterActive');
                        filterActive.title = 'Only show globally active books';
                        const inp = document.createElement('input'); {
                            inp.type = 'checkbox';
                            inp.addEventListener('click', ()=>{
                                for (const b of Object.keys(cache)) {
                                    if (inp.checked) {
                                        if (selected_world_info.includes(b)) {
                                            cache[b].dom.root.classList.remove('stwid--filter-active');
                                        } else {
                                            cache[b].dom.root.classList.add('stwid--filter-active');
                                        }
                                    } else {
                                        cache[b].dom.root.classList.remove('stwid--filter-active');
                                    }
                                }
                                dom.books?.classList.toggle('stwid--isFiltering', Boolean(filter.querySelector('.stwid--search')?.value) || inp.checked);
                            });
                            filterActive.append(inp);
                        }
                        filterActive.append('Active');
                        filter.append(filterActive);
                    }
                    list.append(filter);
                }
                const books = document.createElement('div'); {
                    dom.books = books;
                    books.classList.add('stwid--books');
                    bindBookFolderDrag();
                    list.append(books);
                }
                body.append(list);
            }
            const editor = document.createElement('div'); {
                dom.editor = editor;
                editor.classList.add('stwid--editor');
                editor.addEventListener('input', ()=>{
                    if (currentEditor?.name) markLocalBookRevision(currentEditor.name);
                }, true);
                editor.addEventListener('change', ()=>{
                    if (currentEditor?.name) markLocalBookRevision(currentEditor.name);
                }, true);
                $(editor).on('input change', ()=>{
                    if (currentEditor?.name) pendingEditorSave = currentEditor.name;
                });
                editor.addEventListener('click', async(evt)=>{
                    const transferBtn = /**@type {HTMLElement}*/(evt.target)?.closest?.('.stwip--transfer');
                    if (!transferBtn || !currentEditor) return;
                    evt.preventDefault();
                    evt.stopPropagation();
                    await showWorldInfoPresetTransferPopup(currentEditor.name, currentEditor.uid, transferBtn);
                });
                body.append(editor);
            }
            drawerContent.append(body);
        }
    }
    watchWorldInfoPresetControls();
    drawerContent.querySelector('h3 > span').addEventListener('click', ()=>{
        const is = document.body.classList.toggle('stwid--');
        if (!is) {
            if (dom.activationToggle.classList.contains('stwid--active')) {
                dom.activationToggle.click();
            }
        }
        placeWorldInfoPresetControls();
    });
    const moSel = new MutationObserver(()=>queueWIChange());
    moSel.observe(document.querySelector('#world_editor_select'), { childList: true });
    const moDrawer = new MutationObserver(muts=>{
        if (drawerContent.getAttribute('style').includes('display: none;')) return;
        if (currentEditor) {
            cache[currentEditor.name].dom.entry[currentEditor.uid].root.click();
        }
    });
    moDrawer.observe(drawerContent, { attributes:true, attributeFilter:['style'] });
};
addDrawer();
loadListDebounced().finally(()=>dom.drawer.body.classList.remove('stwid--isLoading'));


let isDiscord;
const checkDiscord = async()=>{
    let newIsDiscord = window.getComputedStyle(document.body).getPropertyValue('--nav-bar-width') !== '';
    if (isDiscord != newIsDiscord) {
        isDiscord = newIsDiscord;
        document.body.classList[isDiscord ? 'remove' : 'add']('stwid--nonDiscord');
    }
    setTimeout(()=>checkDiscord(), 1000);
};
checkDiscord();

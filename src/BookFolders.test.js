import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createBookFolder,
    deleteBookFolder,
    getBookFolderId,
    getFolderBooks,
    getUnfiledBooks,
    moveBook,
    moveBookFolder,
    moveBooks,
    normalizeBookFolderState,
    reconcileBookFolders,
    renameBookFolder,
    resolveBookDrop,
    serializeBookFolderState,
    setBookFolderCollapsed,
    validateBookFolderName,
} from './BookFolders.js';

const names = ['Alpha', 'Beta', 'Gamma', 'Delta'];

const setup = ()=>{
    const state = normalizeBookFolderState(null);
    const characters = createBookFolder(state, 'Characters', 'folder-characters');
    const places = createBookFolder(state, 'Places', 'folder-places');
    assert.equal(characters.ok, true);
    assert.equal(places.ok, true);
    return state;
};

test('creates, renames, reorders, and collapses folders', ()=>{
    const state = setup();
    assert.deepEqual(state.folders.map(folder=>folder.name), ['Characters', 'Places']);
    assert.equal(renameBookFolder(state, 'folder-places', 'Locations').ok, true);
    assert.equal(state.folders.find(folder=>folder.id == 'folder-places').name, 'Locations');
    assert.equal(renameBookFolder(state, 'folder-places', 'characters').ok, false);
    assert.equal(validateBookFolderName(state, '  Unfiled ').ok, false);
    assert.equal(validateBookFolderName(state, '   ').reason, 'empty');
    assert.equal(moveBookFolder(state, 'folder-places', -1), true);
    assert.deepEqual(state.folders.map(folder=>folder.name), ['Locations', 'Characters']);
    assert.equal(setBookFolderCollapsed(state, 'folder-places', true), true);
    assert.equal(state.folders.find(folder=>folder.id == 'folder-places').collapsed, true);
    assert.equal(setBookFolderCollapsed(state, 'folder-places', false), true);
    assert.equal(state.folders.find(folder=>folder.id == 'folder-places').collapsed, false);
});

test('drag into a folder, between folders, and back to unfiled preserves order', ()=>{
    const state = setup();
    assert.equal(moveBook(state, names, 'Alpha', 'folder-characters', null), true);
    assert.equal(moveBook(state, names, 'Beta', 'folder-characters', null), true);
    assert.equal(moveBook(state, names, 'Gamma', 'folder-characters', 'Alpha'), true);
    assert.deepEqual(getFolderBooks(state, names, 'folder-characters'), ['Gamma', 'Alpha', 'Beta']);
    assert.deepEqual(getUnfiledBooks(state, names), ['Delta']);

    const between = resolveBookDrop(state, names, 'Gamma', 'folder-places', null, true);
    assert.equal(moveBook(state, names, between.bookName, between.folderId, between.beforeBookName), true);
    assert.deepEqual(getFolderBooks(state, names, 'folder-places'), ['Gamma']);
    assert.deepEqual(getFolderBooks(state, names, 'folder-characters'), ['Alpha', 'Beta']);

    assert.equal(moveBook(state, names, 'Delta', 'folder-places', null), true);
    const out = resolveBookDrop(state, names, 'Gamma', null, 'Alpha', true);
    assert.equal(out.folderId, null);
    assert.equal(out.beforeBookName, null);
    assert.equal(moveBook(state, names, 'Beta', null, null), true);
    assert.deepEqual(getUnfiledBooks(state, names), ['Beta']);
    assert.deepEqual(getFolderBooks(state, names, 'folder-places'), ['Gamma', 'Delta']);

    const ontoUnfiledBook = resolveBookDrop(state, names, 'Delta', null, 'Beta', true);
    assert.equal(moveBook(state, names, ontoUnfiledBook.bookName, ontoUnfiledBook.folderId, ontoUnfiledBook.beforeBookName), true);
    assert.deepEqual(getUnfiledBooks(state, names), ['Delta', 'Beta']);
    assert.equal(resolveBookDrop(state, names, 'Delta', null, 'Delta', true), null);
});

test('a selection of lorebooks moves together and keeps its order', ()=>{
    const state = setup();
    moveBook(state, names, 'Delta', 'folder-places', null);
    assert.equal(moveBooks(state, names, ['Gamma', 'Alpha'], 'folder-characters', null), true);
    assert.deepEqual(getFolderBooks(state, names, 'folder-characters'), ['Gamma', 'Alpha']);
    assert.equal(moveBooks(state, names, ['Alpha', 'Gamma'], 'folder-places', 'Delta'), true);
    assert.deepEqual(getFolderBooks(state, names, 'folder-places'), ['Alpha', 'Gamma', 'Delta']);
    assert.deepEqual(getFolderBooks(state, names, 'folder-characters'), []);
    assert.equal(moveBooks(state, names, ['Nope'], 'folder-characters', null), false);
    assert.equal(moveBooks(state, names, ['Gamma'], 'missing-folder', null), false);
    assert.equal(moveBooks(state, names, ['Gamma', 'Beta'], null, null), true);
    assert.deepEqual(getUnfiledBooks(state, names), ['Gamma', 'Beta']);
    assert.deepEqual(getFolderBooks(state, names, 'folder-places'), ['Alpha', 'Delta']);
    assert.equal(moveBooks(state, names, ['Missing', 'Alpha'], 'folder-characters', null), true);
    assert.deepEqual(getFolderBooks(state, names, 'folder-characters'), ['Alpha']);
});

test('deleting a folder returns its lorebooks to the unfiled list', ()=>{
    const state = setup();
    moveBook(state, names, 'Alpha', 'folder-characters', null);
    moveBook(state, names, 'Gamma', 'folder-characters', null);
    moveBook(state, names, 'Beta', 'folder-places', null);
    const worldNames = [...names];
    assert.equal(deleteBookFolder(state, worldNames, 'folder-characters'), true);
    assert.deepEqual(worldNames, names);
    assert.equal(state.folders.some(folder=>folder.id == 'folder-characters'), false);
    assert.deepEqual(getFolderBooks(state, worldNames, 'folder-places'), ['Beta']);
    assert.deepEqual(getUnfiledBooks(state, worldNames), ['Delta', 'Alpha', 'Gamma']);
    assert.deepEqual(getUnfiledBooks(state, worldNames).concat(getFolderBooks(state, worldNames, 'folder-places')).sort(), [...worldNames].sort());
});

test('missing lorebooks are dropped and new ones stay unfiled', ()=>{
    const state = setup();
    moveBook(state, names, 'Alpha', 'folder-characters', null);
    moveBook(state, names, 'Beta', 'folder-places', null);
    setBookFolderCollapsed(state, 'folder-characters', true);
    const renamed = ['Beta', 'Gamma', 'Delta', 'Epsilon'];
    assert.equal(reconcileBookFolders(state, renamed), true);
    assert.equal(state.books.Alpha, undefined);
    assert.equal(state.books.Epsilon, undefined);
    assert.deepEqual(getUnfiledBooks(state, renamed), ['Delta', 'Gamma', 'Epsilon']);
    assert.deepEqual(getFolderBooks(state, renamed, 'folder-places'), ['Beta']);
    assert.equal(state.folders.find(folder=>folder.id == 'folder-characters').collapsed, true);

    state.books.Gamma = { folderId:'deleted-folder', order:0 };
    assert.equal(reconcileBookFolders(state, renamed), true);
    assert.equal(state.books.Gamma.folderId, null);
    assert.ok(getUnfiledBooks(state, renamed).includes('Gamma'));
});

test('storage round-trip keeps folders, assignment, order, and collapsed state', ()=>{
    const state = setup();
    moveBook(state, names, 'Beta', 'folder-characters', null);
    moveBook(state, names, 'Alpha', 'folder-characters', null);
    setBookFolderCollapsed(state, 'folder-places', true);
    const saved = JSON.parse(JSON.stringify(serializeBookFolderState(state)));
    const restored = normalizeBookFolderState(saved);
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.folders.map(folder=>({ name:folder.name, collapsed:folder.collapsed })), [
        { name:'Characters', collapsed:false },
        { name:'Places', collapsed:true },
    ]);
    assert.deepEqual(saved.books.Alpha, { folderId:'folder-characters', order:1 });
    assert.deepEqual(saved.books.Beta, { folderId:'folder-characters', order:0 });
    assert.equal(Object.hasOwn(saved, 'lorebook_folder'), false);
    assert.deepEqual(getFolderBooks(restored, names, 'folder-characters'), ['Beta', 'Alpha']);
    assert.equal(restored.folders.find(folder=>folder.id == 'folder-places').collapsed, true);
});

test('corrupt folder data is ignored instead of breaking the list', ()=>{
    const state = normalizeBookFolderState({
        version: 1,
        folders: [
            null,
            { id:'', name:'Nope' },
            { id:'a', name:'Unfiled' },
            { id:'a', name:'Kept', order:2, collapsed:'yes' },
            { id:'b', name:'kept', order:0, collapsed:true },
            { name:'Missing id' },
            { id:'c', name:'  Worlds  ', order:1, collapsed:false },
        ],
        books: [],
    });
    assert.deepEqual(state.folders.map(folder=>folder.name), ['kept', 'Worlds']);
    assert.equal(state.folders[0].collapsed, true);
    assert.equal(state.folders[1].collapsed, false);
    assert.deepEqual(Object.keys(state.books), []);
});

test('a lorebook named __proto__ cannot leak into Object.prototype', ()=>{
    const state = normalizeBookFolderState(null);
    const created = createBookFolder(state, 'Odd', 'folder-odd');
    assert.equal(created.ok, true);
    assert.equal(moveBook(state, ['__proto__', 'Alpha'], '__proto__', 'folder-odd', null), true);
    assert.equal(Object.prototype.folderId, undefined);
    assert.equal(getBookFolderId(state, '__proto__'), 'folder-odd');
    const saved = serializeBookFolderState(state);
    const parsed = JSON.parse(JSON.stringify(saved));
    assert.equal(Object.getOwnPropertyDescriptor(parsed.books, '__proto__').value.folderId, 'folder-odd');
    assert.equal(Object.getPrototypeOf(parsed.books), Object.prototype);
    assert.equal(Object.prototype.folderId, undefined);
});
